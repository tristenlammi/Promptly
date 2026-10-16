/**
 * Promptly collaboration server.
 *
 * Terminates Y.js websocket sync for Drive documents:
 *
 *   1. Verifies a short-lived collab JWT issued by the FastAPI
 *      backend (`GET /api/documents/:id/collab-token`). The token
 *      binds `{document_id, user_id, perm}` to the request so a
 *      rogue client can't swap rooms mid-flight.
 *   2. Loads + persists the binary Y.Doc to the shared Postgres
 *      `document_state` table so every replica agrees on the current
 *      state and so a restart doesn't lose in-flight edits.
 *   3. On idle, debounces a snapshot POST back to the backend so the
 *      file's HTML blob + FTS index stays within a few seconds of the
 *      live CRDT. It goes to `/api/internal/...` (404 from outside) with
 *      a dedicated internal token — no longer `SECRET_KEY` itself.
 *   4. Answers `POST /internal/drop` from the backend: when someone's
 *      access is revoked, their open sockets are cut at once instead of
 *      at the next token refresh (WP-3.2).
 *   5. Answers `POST /internal/reset` / `/internal/release` for a version
 *      restore (WP-6.2): the room is frozen, emptied and unloaded while
 *      the backend writes the restored state, and tokens from an older
 *      edit generation (`epoch`) are refused afterwards.
 *
 * Everything is scoped to a single internal docker network; the only
 * public surface is the `/api/collab/:document_id` websocket path
 * proxied through nginx.
 */
import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import { jwtVerify } from "jose";
import pkg from "pg";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deflateSync } from "node:zlib";
import { request as undiciRequest } from "undici";
import * as Y from "yjs";

const { Pool } = pkg;

// --- Config -----------------------------------------------------------

const PORT = Number(process.env.PORT || 1234);
const SECRET_KEY = process.env.SECRET_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL;
const BACKEND_INTERNAL_URL =
  process.env.BACKEND_INTERNAL_URL || "http://backend:8000";
const SNAPSHOT_DEBOUNCE_MS = Number(
  process.env.SNAPSHOT_DEBOUNCE_MS || 3000
);

if (!SECRET_KEY) {
  console.error("[collab] SECRET_KEY is required");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("[collab] DATABASE_URL is required");
  process.exit(1);
}

// The backend↔collab shared token. Set COLLAB_INTERNAL_TOKEN to choose it;
// otherwise both sides derive the same value from SECRET_KEY (an HMAC, so
// the token alone doesn't reveal the key). Must match
// backend/app/collab_internal.py.
const INTERNAL_TOKEN =
  process.env.COLLAB_INTERNAL_TOKEN ||
  createHmac("sha256", SECRET_KEY).update("promptly:collab-internal").digest("hex");

function internalAuthOk(header) {
  const presented = (header || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(presented);
  const b = Buffer.from(INTERNAL_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- DB pool ----------------------------------------------------------
//
// Strip the SQLAlchemy "+asyncpg" driver suffix if present — the backend
// DATABASE_URL is shared verbatim and node-postgres doesn't understand
// the extra qualifier.
const pgConnection = DATABASE_URL.replace("+asyncpg", "");
const pool = new Pool({ connectionString: pgConnection });

// Stringified JWT secret → Uint8Array, memoised once at startup.
const jwtSecretBytes = new TextEncoder().encode(SECRET_KEY);

// --- Room name parsing ------------------------------------------------
//
// A room name is either a bare document UUID (a Drive document — the
// original behaviour) or ``canvas:<uuid>`` (a workspace Excalidraw canvas,
// Phase 2). Parsing routes persistence to the right table and the auth
// check to the right JWT claim. We reject anything that doesn't look
// like a UUID so a typo can't touch an unintended row.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CANVAS_PREFIX = "canvas:";
const SHEET_PREFIX = "sheet:";

function parseRoom(name) {
  if (typeof name !== "string") {
    throw new Error(`Invalid room: ${name}`);
  }
  if (name.startsWith(CANVAS_PREFIX)) {
    const id = name.slice(CANVAS_PREFIX.length);
    if (!UUID_RE.test(id)) throw new Error(`Invalid canvas id: ${id}`);
    return { kind: "canvas", id };
  }
  if (name.startsWith(SHEET_PREFIX)) {
    const id = name.slice(SHEET_PREFIX.length);
    if (!UUID_RE.test(id)) throw new Error(`Invalid sheet id: ${id}`);
    return { kind: "sheet", id };
  }
  if (!UUID_RE.test(name)) {
    throw new Error(`Invalid document id: ${name}`);
  }
  return { kind: "doc", id: name };
}

// --- Snapshot debounce -------------------------------------------------
//
// Hocuspocus fires onStoreDocument on every idle batch. Re-rendering
// HTML + rewriting the file blob on every keystroke would be wasteful,
// so we coalesce updates per document. The newest update always wins:
// if three saves land in 500ms only the last one's Y.Doc state reaches
// the backend.

const snapshotTimers = new Map();
// Latest bytes per document, kept until the backend has accepted them. A
// snapshot that failed (the backend restarting during an update) used to
// be dropped, leaving the file's HTML and search text stale until the
// next edit (R-249). Now it's retried with backoff, and a newer edit
// replaces the pending bytes rather than queueing behind them.
const pendingSnapshots = new Map();
// One POST per document at a time (R-233): a slow POST could be overtaken
// by a newer one and land last, leaving an older state in the file. A flush
// that comes due while one is in flight just marks the document dirty; it
// runs again, with the newest bytes, when the first finishes.
const inFlight = new Set();
const dirtyWhileInFlight = new Set();
const SNAPSHOT_RETRY_MAX_MS = 60_000;
const SNAPSHOT_RETRY_GIVE_UP = 15;

function scheduleSnapshot(documentId, docBytes, delay = SNAPSHOT_DEBOUNCE_MS, attempt = 0) {
  pendingSnapshots.set(documentId, docBytes);
  const existing = snapshotTimers.get(documentId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    snapshotTimers.delete(documentId);
    void flushSnapshot(documentId, attempt);
  }, delay);
  snapshotTimers.set(documentId, { timer });
}

async function flushSnapshot(documentId, attempt = 0) {
  const bytes = pendingSnapshots.get(documentId);
  if (!bytes) return;
  if (inFlight.has(documentId)) {
    dirtyWhileInFlight.add(documentId);
    return;
  }
  inFlight.add(documentId);
  try {
    await sendSnapshot(documentId, bytes);
    // Only clear if nothing newer arrived while we were sending.
    if (pendingSnapshots.get(documentId) === bytes) pendingSnapshots.delete(documentId);
  } catch (err) {
    const status = err?.statusCode ?? 0;
    // 4xx: the document is gone or the request is wrong — retrying won't help.
    if ((status >= 400 && status < 500) || attempt + 1 >= SNAPSHOT_RETRY_GIVE_UP) {
      console.warn(
        `[collab] snapshot POST failed for ${documentId}, giving up:`,
        err?.message || err
      );
      if (pendingSnapshots.get(documentId) === bytes) pendingSnapshots.delete(documentId);
      return;
    }
    const delay = Math.min(SNAPSHOT_RETRY_MAX_MS, 1000 * 2 ** attempt);
    console.warn(
      `[collab] snapshot POST failed for ${documentId} (attempt ${attempt + 1}), retrying in ${delay}ms:`,
      err?.message || err
    );
    if (!snapshotTimers.has(documentId)) {
      scheduleSnapshot(documentId, pendingSnapshots.get(documentId), delay, attempt + 1);
    }
  } finally {
    inFlight.delete(documentId);
    // Newer bytes arrived while we were sending: send them now (they were
    // held back so they couldn't race this POST).
    if (dirtyWhileInFlight.delete(documentId) && pendingSnapshots.has(documentId) && !snapshotTimers.has(documentId)) {
      void flushSnapshot(documentId);
    }
  }
}

async function sendSnapshot(documentId, docBytes) {
  const url = `${BACKEND_INTERNAL_URL}/api/internal/documents/${documentId}/snapshot`;
  const body = Buffer.from(docBytes);
  const res = await undiciRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      // The internal token, on a route nginx answers 404 for from outside.
      authorization: `Bearer ${INTERNAL_TOKEN}`,
      "x-collab-internal": "1",
    },
    body,
  });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    const err = new Error(`snapshot ${res.statusCode}: ${text}`);
    err.statusCode = res.statusCode;
    throw err;
  }
  // Drain the body so the socket can be reused.
  await res.body.dump();
}

// --- Editor-state snapshots (WP-3.3) -----------------------------------
//
// Every store used to overwrite the whole Y.Doc with nothing kept. Now each
// store, in the same transaction:
//   * shrink guard — before a state under half the size of the stored one
//     (above a small floor) replaces it, the stored one is kept;
//   * auto — at most every 10 minutes of editing, the new state is kept.
// A last-disconnect snapshot catches the end of a session. Retention is
// the backend's nightly prune (app/files/versions.py).

const SHRINK_FLOOR_BYTES = 2048;
const AUTO_EVERY_MS = 10 * 60 * 1000;
// Who edited since the last snapshot, per room — stamped on the next one.
const recentAuthors = new Map();

// Who edited since the last store, per room — their Recent shows the file
// as edited (file_activity, WP-3.4).
const editorsSinceStore = new Map();

function noteAuthor(documentName, userId) {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return;
  if (!recentAuthors.has(documentName)) recentAuthors.set(documentName, new Set());
  recentAuthors.get(documentName).add(userId);
  if (!editorsSinceStore.has(documentName)) editorsSinceStore.set(documentName, new Set());
  editorsSinceStore.get(documentName).add(userId);
}

async function recordEdited(client, documentName, fileId) {
  const ids = [...(editorsSinceStore.get(documentName) || [])];
  editorsSinceStore.delete(documentName);
  if (!fileId || !ids.length) return;
  // Best-effort: Recent must never cost a store.
  await client.query("SAVEPOINT file_activity");
  try {
    await client.query(
      `INSERT INTO file_activity (user_id, file_id, kind, at)
       SELECT u.id, $2, 'edited', NOW() FROM users u WHERE u.id = ANY($1::uuid[])
       ON CONFLICT (user_id, file_id, kind) DO UPDATE SET at = EXCLUDED.at`,
      [ids, fileId]
    );
    await client.query("RELEASE SAVEPOINT file_activity");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT file_activity");
    console.warn(`[collab] file_activity: ${err.message}`);
  }
}

function takeAuthors(documentName, document) {
  const set = new Set(recentAuthors.get(documentName) || []);
  if (document) {
    for (const connection of document.getConnections()) {
      const id = connection.context?.user?.id;
      if (!connection.readOnly && typeof id === "string" && UUID_RE.test(id)) set.add(id);
    }
  }
  recentAuthors.delete(documentName);
  return [...set];
}

function versionKind(kind) {
  return kind === "canvas" ? "whiteboard" : kind === "sheet" ? "sheet" : "document";
}

async function insertVersion(client, { kind, fileId, state, data, source, authors }) {
  const bytes = Buffer.from(state || []);
  if (!bytes.length && data == null) return false;
  const hash = createHash("sha256")
    .update(bytes)
    .update(data == null ? "" : JSON.stringify(data))
    .digest("hex");
  const { rows } = await client.query(
    "SELECT content_hash FROM file_versions WHERE file_id = $1 ORDER BY created_at DESC LIMIT 1",
    [fileId]
  );
  if (rows[0]?.content_hash === hash) return false; // nothing new
  await client.query(
    `INSERT INTO file_versions
       (id, file_id, kind, yjs_state, data, author_ids, source, size_bytes, content_hash, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::uuid[], $6, $7, $8, NOW())`,
    [
      fileId,
      kind,
      bytes.length ? deflateSync(bytes) : null,
      data == null ? null : JSON.stringify(data),
      authors || [],
      source,
      bytes.length,
      hash,
    ]
  );
  return true;
}

async function guardAndSnapshot(client, { kind, fileId, prev, next, data, documentName, document }) {
  if (!fileId) return;
  const vkind = versionKind(kind);
  const prevLen = prev ? prev.length : 0;
  if (prevLen >= SHRINK_FLOOR_BYTES && next.length < prevLen * 0.5) {
    await insertVersion(client, {
      kind: vkind,
      fileId,
      state: prev,
      data,
      source: "shrink_guard",
      authors: [],
    });
    console.warn(
      `[collab] shrink guard: kept ${prevLen} bytes of ${documentName} before a ${next.length}-byte store`
    );
  }
  const { rows } = await client.query(
    `SELECT created_at FROM file_versions
      WHERE file_id = $1 AND source = 'auto'
      ORDER BY created_at DESC LIMIT 1`,
    [fileId]
  );
  const last = rows[0]?.created_at ? new Date(rows[0].created_at).getTime() : 0;
  if (Date.now() - last >= AUTO_EVERY_MS) {
    await insertVersion(client, {
      kind: vkind,
      fileId,
      state: next,
      data,
      source: "auto",
      authors: takeAuthors(documentName, document),
    });
  }
}

/** The end of a session: keep what's there if it changed. */
async function snapshotOnLastDisconnect(documentName, document) {
  if (isFrozen(documentName) || (document && retired.has(document))) return; // a restore is replacing it
  const { kind, id } = parseRoom(documentName);
  const state = Y.encodeStateAsUpdate(document);
  const client = await pool.connect();
  try {
    let fileId = id;
    let data = null;
    if (kind !== "doc") {
      const table = kind === "canvas" ? "workspace_canvas" : "spreadsheets";
      const cols = kind === "sheet" ? "file_id, data" : "file_id";
      const { rows } = await client.query(`SELECT ${cols} FROM ${table} WHERE id = $1`, [id]);
      if (!rows[0]) return;
      fileId = rows[0].file_id;
      data = rows[0].data ?? null;
    }
    await insertVersion(client, {
      kind: versionKind(kind),
      fileId,
      state,
      data,
      source: "auto",
      authors: takeAuthors(documentName, null),
    });
  } catch (err) {
    console.warn(`[collab] last-disconnect snapshot failed for ${documentName}:`, err?.message || err);
  } finally {
    client.release();
  }
}

// --- Version restore: frozen rooms and edit generations (WP-6.2) --------
//
// While the backend restores a version, the room must not store, take new
// connections or keep old ones: ``frozen`` holds those rooms (with an
// expiry, in case the backend never releases). Afterwards every token
// carries the file's ``collab_epoch``; one from before the restore is
// refused, so an editor holding the replaced state reloads instead of
// merging it back in.
const FREEZE_MS = 30_000;
const frozen = new Map();
// The in-memory rooms a reset replaced. Hocuspocus can't cancel a store it
// has already debounced, so a late one for a retired room is ignored —
// even after the release.
const retired = new WeakSet();

function isFrozen(room) {
  const until = frozen.get(room);
  if (!until) return false;
  if (Date.now() > until) {
    frozen.delete(room);
    return false;
  }
  return true;
}

async function currentEpoch(room) {
  const { kind, id } = parseRoom(room);
  const sql =
    kind === "doc"
      ? "SELECT collab_epoch FROM files WHERE id = $1"
      : `SELECT f.collab_epoch FROM ${kind === "sheet" ? "spreadsheets" : "workspace_canvas"} t
           JOIN files f ON f.id = t.file_id WHERE t.id = $1`;
  try {
    const { rows } = await pool.query(sql, [id]);
    return rows[0] ? Number(rows[0].collab_epoch) || 0 : 0;
  } catch (err) {
    console.warn(`[collab] epoch lookup failed for ${room}:`, err?.message || err);
    return null; // unknown — don't lock anyone out over it
  }
}

async function checkEpoch(payload, room) {
  const want = await currentEpoch(room);
  if (want === null) return;
  const have = typeof payload.epoch === "number" ? payload.epoch : 0;
  if (have !== want) throw new Error("This file was restored to an earlier version — reload");
}

// --- Token verification & live re-authorisation -----------------------

/** Verify a collab JWT for ``documentName``; throws on anything wrong. */
async function verifyRoomToken(token, documentName) {
  const { kind, id } = parseRoom(documentName);
  if (!token) throw new Error("Missing collab token");
  let payload;
  try {
    const result = await jwtVerify(token, jwtSecretBytes, {
      algorithms: ["HS256"],
    });
    payload = result.payload;
  } catch (err) {
    console.warn(
      `[collab] JWT verify failed for room ${documentName}:`,
      err?.message || err
    );
    throw new Error("Invalid collab token");
  }

  // Each room kind has its own token shape: documents mint
  // ``type=collab``/``document_id``; canvases ``type=canvas``/``canvas_id``;
  // sheets ``type=sheet``/``sheet_id``.
  if (kind === "canvas") {
    if (payload.type !== "canvas") throw new Error("Wrong token type");
    if (payload.canvas_id !== id) throw new Error("Token does not match canvas");
  } else if (kind === "sheet") {
    if (payload.type !== "sheet") throw new Error("Wrong token type");
    if (payload.sheet_id !== id) throw new Error("Token does not match sheet");
  } else {
    if (payload.type !== "collab") throw new Error("Wrong token type");
    if (payload.document_id !== id) {
      throw new Error("Token does not match document");
    }
  }
  return payload;
}

/** Stop a connection's writes immediately, then close it. */
function cutOff(connection) {
  connection.readOnly = true;
  try {
    connection.close({ code: 4401, reason: "Unauthorized" });
  } catch {
    // Already gone.
  }
}

// Tokens live 5 minutes and access is only checked when a token is
// minted, so without this a socket opened before a member was removed
// (or demoted to viewer) kept full access for as long as it stayed open
// (roadmap R-036). Every sweep asks connections whose token is close to
// expiry to re-send their current one (handled by ``onTokenSync``), and
// cuts off any that are past expiry by more than the grace period —
// i.e. clients that couldn't get a fresh token because access was revoked.
const REAUTH_SWEEP_MS = 30_000;
const REAUTH_LEAD_S = 20; // ask this long before expiry
const EXPIRY_GRACE_S = 45; // tolerate a slow reply before cutting off

function reauthSweep() {
  const now = Math.floor(Date.now() / 1000);
  for (const document of server.hocuspocus.documents.values()) {
    for (const connection of document.getConnections()) {
      const exp = connection.context?.tokenExp;
      if (typeof exp !== "number") continue;
      if (now > exp + EXPIRY_GRACE_S) {
        console.warn(
          `[collab] token expired for ${document.name}; cutting off connection`
        );
        cutOff(connection);
      } else if (now >= exp - REAUTH_LEAD_S) {
        connection.requestToken();
      }
    }
  }
}

// --- Hocuspocus server -------------------------------------------------

const server = new Server({
  port: PORT,
  // Bind to all interfaces so the container is reachable from nginx.
  address: "0.0.0.0",
  // Connection lifecycle only. Per-keystroke ("change") and per-store lines
  // used to be logged too — megabytes a day from one busy document, on a
  // disk Postgres shares. Set COLLAB_DEBUG=1 to see stores again.
  onConnect: async ({ documentName }) => {
    console.log(`[collab] client connected to ${documentName}`);
  },
  // Whoever changes a document is its author — for snapshots and for
  // Recent's "edited" (file_activity). Only noting them on disconnect left
  // a live session's edits unattributed until the socket closed.
  onChange: async ({ documentName, context }) => {
    if (context?.perm === "write") noteAuthor(documentName, context?.user?.id);
  },
  // "The comments changed" pings (WP-4.5, R-227): an editor that adds,
  // resolves or deletes a comment tells the room, and everyone else
  // refetches the threads from the backend. Only that one tiny message
  // is relayed — the comments themselves never pass through here.
  onStateless: async ({ connection, document, payload }) => {
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg?.type !== "comments-changed") return;
    document.broadcastStateless(JSON.stringify({ type: "comments-changed" }), (c) => c !== connection);
  },
  onDisconnect: async ({ documentName, document, clientsCount, context }) => {
    console.log(`[collab] client disconnected from ${documentName}`);
    if (context?.perm === "write") noteAuthor(documentName, context?.user?.id);
    if (clientsCount === 0 && document) await snapshotOnLastDisconnect(documentName, document);
  },
  // ``POST /internal/drop {user_id, room?}`` — the backend cuts someone's
  // sockets the moment their access is revoked (a grant removed, a member
  // removed or made a viewer). They reconnect, re-checked from scratch.
  async onRequest({ request, response }) {
    if (!request.url || !request.url.startsWith("/internal/")) return;
    const reply = (code, body) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const known = ["/internal/drop", "/internal/reset", "/internal/release", "/internal/state"];
    if (request.method !== "POST" || !known.includes(request.url)) {
      reply(404, { error: "not found" });
      throw null;
    }
    if (!internalAuthOk(request.headers.authorization)) {
      reply(403, { error: "forbidden" });
      throw null;
    }
    if (["/internal/reset", "/internal/release", "/internal/state"].includes(request.url)) {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 4096) break;
      }
      let room = null;
      try {
        ({ room = null } = JSON.parse(raw || "{}"));
        parseRoom(room);
      } catch {
        reply(400, { error: "room required" });
        throw null;
      }
      if (request.url === "/internal/release") {
        frozen.delete(room);
        reply(200, { ok: true });
        throw null;
      }
      if (request.url === "/internal/state") {
        // The live state, read-only — what "now" is for a version diff or a
        // "save a version now" while the debounced store hasn't run yet.
        const open = server.hocuspocus.documents.get(room);
        reply(200, { state: open ? Buffer.from(Y.encodeStateAsUpdate(open)).toString("base64") : null });
        throw null;
      }
      // Reset: freeze, tell everyone, take the live state, empty and unload.
      frozen.set(room, Date.now() + FREEZE_MS);
      const document = server.hocuspocus.documents.get(room);
      let state = null;
      if (document) {
        try {
          document.broadcastStateless(JSON.stringify({ type: "reset" }));
        } catch {
          // best effort — the epoch check catches anyone who missed it
        }
        retired.add(document);
        state = Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64");
        for (const connection of document.getConnections()) cutOff(connection);
        try {
          await server.hocuspocus.unloadDocument(document);
        } catch (err) {
          console.warn(`[collab] unload during reset of ${room}:`, err?.message || err);
        }
        server.hocuspocus.documents.delete(room);
      }
      // A queued HTML snapshot of the old state must not land after the
      // restore and overwrite it.
      if (room && !room.includes(":")) {
        const t = snapshotTimers.get(room);
        if (t) clearTimeout(t.timer);
        snapshotTimers.delete(room);
        pendingSnapshots.delete(room);
      }
      recentAuthors.delete(room);
      console.log(`[collab] reset ${room} for a restore`);
      reply(200, { state });
      throw null;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 4096) break;
    }
    let userId = null;
    let room = null;
    try {
      ({ user_id: userId, room = null } = JSON.parse(body || "{}"));
    } catch {
      // fall through to the 400
    }
    if (typeof userId !== "string" || !UUID_RE.test(userId)) {
      reply(400, { error: "user_id required" });
      throw null;
    }
    let dropped = 0;
    for (const document of server.hocuspocus.documents.values()) {
      if (room && document.name !== room) continue;
      for (const connection of document.getConnections()) {
        if (connection.context?.user?.id === userId) {
          cutOff(connection);
          dropped += 1;
        }
      }
    }
    if (dropped) console.log(`[collab] dropped ${dropped} connection(s) for a revoked user`);
    reply(200, { dropped });
    throw null;
  },
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const { kind, id } = parseRoom(documentName);
        // Table + key column are constants derived from the parsed kind
        // (never user input), so interpolating them is safe.
        const table =
          kind === "canvas"
            ? "workspace_canvas"
            : kind === "sheet"
              ? "spreadsheets"
              : "document_state";
        const idCol = kind === "doc" ? "file_id" : "id";
        const { rows } = await pool.query(
          `SELECT yjs_update FROM ${table} WHERE ${idCol} = $1`,
          [id]
        );
        if (rows.length === 0) {
          console.log(`[collab] fetch: no row for ${documentName}`);
          return null;
        }
        // pg returns a Buffer for BYTEA columns; Hocuspocus wants a
        // Uint8Array. Buffer is already a Uint8Array subclass but we
        // normalise defensively so nothing downstream gets surprised.
        //
        // Return ``null`` for an *empty* buffer too — not just for a
        // missing row. The backend's ``POST /api/documents`` seeds a
        // zero-byte ``document_state`` row so the collab service and
        // the UserFile row exist in lockstep, but ``Y.applyUpdate``
        // can't decode an empty Uint8Array (it throws "Unexpected
        // end of array"). Treating empty as "no saved state" lets
        // Hocuspocus start from a fresh Y.Doc for the first session.
        const buf = rows[0].yjs_update;
        if (!buf || buf.length === 0) {
          console.log(`[collab] fetch: empty row for ${documentName}, starting fresh`);
          return null;
        }
        if (process.env.COLLAB_DEBUG === "1") {
          console.log(`[collab] fetch: loaded ${buf.length} bytes for ${documentName}`);
        }
        return new Uint8Array(buf);
      },
      store: async ({ documentName, state, document }) => {
        if (isFrozen(documentName) || (document && retired.has(document))) return; // a restore replaced it (WP-6.2)
        const { kind, id } = parseRoom(documentName);
        if (process.env.COLLAB_DEBUG === "1") {
          console.log(`[collab] store: writing ${state.length} bytes for ${documentName}`);
        }
        if (kind === "canvas" || kind === "sheet") {
          const table = kind === "canvas" ? "workspace_canvas" : "spreadsheets";
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const cols = kind === "sheet" ? "yjs_update, file_id, data" : "yjs_update, file_id";
            const { rows } = await client.query(
              `SELECT ${cols} FROM ${table} WHERE id = $1 FOR UPDATE`,
              [id]
            );
            if (rows[0]) {
              await guardAndSnapshot(client, {
                kind,
                fileId: rows[0].file_id,
                prev: rows[0].yjs_update,
                next: state,
                data: rows[0].data ?? null,
                documentName,
                document,
              });
            }
            await client.query(
              `UPDATE ${table}
                 SET yjs_update = $2, version = version + 1, updated_at = NOW()
               WHERE id = $1`,
              [id, Buffer.from(state)]
            );
            const dataLen = kind === "sheet" ? "COALESCE(octet_length(t.data::text), 0)" : "0";
            await client.query(
              `UPDATE files f
                  SET size_bytes = octet_length(t.yjs_update) + ${dataLen},
                      modified_at = NOW()
                 FROM ${table} t
                WHERE t.id = $1 AND f.id = t.file_id`,
              [id]
            );
            if (rows[0]) await recordEdited(client, documentName, rows[0].file_id);
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
          } finally {
            client.release();
          }
          return;
        }
        // Document path — *merge* with what's stored, never overwrite.
        // (Never while frozen for a restore — checked at the top.)
        // A user whose live connection dropped can still press Save; the
        // backend merges their editor's CRDT state into this row (R-022).
        // Overwriting it with our in-memory copy would throw those edits
        // away, so we merge them in and pull them into the live document
        // (which also sends them to everyone connected). The backend only
        // ever writes a *fresh* state at creation, so merging can't
        // resurrect or duplicate anything.
        const client = await pool.connect();
        let merged = state;
        try {
          await client.query("BEGIN");
          const { rows } = await client.query(
            "SELECT yjs_update FROM document_state WHERE file_id = $1 FOR UPDATE",
            [id]
          );
          const prev = rows[0]?.yjs_update;
          if (prev && prev.length > 0) {
            const stored = new Uint8Array(prev);
            if (document) {
              // Re-applying what the live doc already has is a no-op (and
              // emits nothing); anything only the stored copy has — an
              // offline Save, including deletions — lands in the live doc
              // and reaches every connected editor.
              Y.applyUpdate(document, stored, "store-merge");
              merged = Y.encodeStateAsUpdate(document);
            } else {
              merged = Y.mergeUpdates([stored, state]);
            }
          }
          await guardAndSnapshot(client, {
            kind,
            fileId: id,
            prev: prev && prev.length ? prev : null,
            next: merged,
            data: null,
            documentName,
            document,
          });
          await client.query(
            `INSERT INTO document_state (file_id, yjs_update, version, updated_at)
             VALUES ($1, $2, 1, NOW())
             ON CONFLICT (file_id) DO UPDATE
               SET yjs_update = EXCLUDED.yjs_update,
                   version    = document_state.version + 1,
                   updated_at = NOW()`,
            [id, Buffer.from(merged)]
          );
          await recordEdited(client, documentName, id);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
        scheduleSnapshot(id, merged);
      },
    }),
  ],

  async onAuthenticate(data) {
    const { token, documentName } = data;
    if (isFrozen(documentName)) throw new Error("This file is being restored — reload in a moment");
    const payload = await verifyRoomToken(token, documentName);
    await checkEpoch(payload, documentName);
    const perm = payload.perm === "read" ? "read" : "write";
    // Read-only MUST be set on ``connectionConfig``. Whatever this hook
    // *returns* is only merged into the connection's ``context`` — an
    // earlier version returned ``readOnly`` there, so Hocuspocus never saw
    // it and every viewer / read-only grantee could edit or wipe documents,
    // canvases and sheets with a hand-built client (roadmap R-021). With
    // ``connectionConfig.readOnly`` set, Hocuspocus drops their document
    // updates server-side.
    data.connectionConfig.readOnly = perm === "read";
    return {
      user: {
        id: payload.sub,
        name: payload.name || "Anonymous",
        color: payload.color || "#D97757",
        // Signed profile-picture URL (null = initials chip). Pure
        // pass-through — clients put it in awareness for presence chips.
        avatar: payload.avatar || null,
      },
      // Seconds since epoch. The re-auth sweep below uses it to keep a
      // long-lived socket from outliving the access it was opened with.
      tokenExp: typeof payload.exp === "number" ? payload.exp : null,
      // Snapshots credit editors only (WP-3.3).
      perm,
    };
  },

  // A client re-sends its *current* token when the server asks (see the
  // sweep below). Clients refresh that token from the backend ~30 s before
  // expiry, and the backend re-checks access on every refresh — so this is
  // where a revoked or downgraded member actually loses access.
  async onTokenSync({ token, connection, documentName }) {
    try {
      const payload = await verifyRoomToken(token, documentName);
      await checkEpoch(payload, documentName);
      connection.readOnly = payload.perm === "read";
      connection.context.tokenExp =
        typeof payload.exp === "number" ? payload.exp : null;
    } catch (err) {
      console.warn(
        `[collab] re-auth failed for ${documentName}: ${err?.message || err}`
      );
      cutOff(connection);
    }
  },
});

// --- Lifecycle ---------------------------------------------------------

await server.listen();
console.log(`[collab] Hocuspocus listening on :${PORT}`);
const reauthTimer = setInterval(reauthSweep, REAUTH_SWEEP_MS);

async function shutdown(signal) {
  console.log(`[collab] received ${signal}, shutting down`);
  clearInterval(reauthTimer);
  try {
    await server.destroy();
  } catch {
    // Best effort.
  }
  // destroy() stores every open document, which schedules snapshots on a
  // debounce that would never fire — send them now (bounded, best effort).
  for (const { timer } of snapshotTimers.values()) clearTimeout(timer);
  snapshotTimers.clear();
  await Promise.race([
    Promise.allSettled(
      [...pendingSnapshots.entries()].map(([id, bytes]) => sendSnapshot(id, bytes))
    ),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
  try {
    await pool.end();
  } catch {
    // Best effort.
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
