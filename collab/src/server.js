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
 *      live CRDT. The snapshot endpoint is protected by the same
 *      `SECRET_KEY`, so no other service can forge snapshots.
 *
 * Everything is scoped to a single internal docker network; the only
 * public surface is the `/api/collab/:document_id` websocket path
 * proxied through nginx.
 */
import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import { jwtVerify } from "jose";
import pkg from "pg";
import { request as undiciRequest } from "undici";
import * as Y from "yjs";

const { Pool } = pkg;

// --- Config -----------------------------------------------------------

const PORT = Number(process.env.PORT || 1234);
const SECRET_KEY = process.env.SECRET_KEY;
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

// --- DB pool ----------------------------------------------------------
//
// Strip the SQLAlchemy "+asyncpg" driver suffix if present — the backend
// DATABASE_URL is shared verbatim and node-postgres doesn't understand
// the extra qualifier.
const pgConnection = DATABASE_URL.replace("+asyncpg", "");
const pool = new Pool({ connectionString: pgConnection });

// Stringified JWT secret → Uint8Array, memoised once at startup.
const jwtSecretBytes = new TextEncoder().encode(SECRET_KEY);

// --- Document name parsing --------------------------------------------
//
// The client connects to `/api/collab/<document_uuid>`. Hocuspocus
// hands us the trailing path segment verbatim as `documentName`. We
// reject anything that doesn't look like a UUID so a typo can't touch
// an unintended row.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertDocumentId(name) {
  if (typeof name !== "string" || !UUID_RE.test(name)) {
    throw new Error(`Invalid document id: ${name}`);
  }
  return name;
}

// --- Snapshot debounce -------------------------------------------------
//
// Hocuspocus fires onStoreDocument on every idle batch. Re-rendering
// HTML + rewriting the file blob on every keystroke would be wasteful,
// so we coalesce updates per document. The newest update always wins:
// if three saves land in 500ms only the last one's Y.Doc state reaches
// the backend.

const snapshotTimers = new Map();

function scheduleSnapshot(documentId, docBytes) {
  const existing = snapshotTimers.get(documentId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    snapshotTimers.delete(documentId);
    void sendSnapshot(documentId, docBytes).catch((err) => {
      console.warn(
        `[collab] snapshot POST failed for ${documentId}:`,
        err?.message || err
      );
    });
  }, SNAPSHOT_DEBOUNCE_MS);
  snapshotTimers.set(documentId, { timer });
}

async function sendSnapshot(documentId, docBytes) {
  const url = `${BACKEND_INTERNAL_URL}/api/documents/${documentId}/snapshot`;
  const body = Buffer.from(docBytes);
  const res = await undiciRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      // The backend accepts the shared SECRET_KEY as a bearer when
      // called from inside the docker network. The key never leaves
      // the internal hop; external clients can't reach this route
      // because nginx doesn't expose it.
      authorization: `Bearer ${SECRET_KEY}`,
      "x-collab-internal": "1",
    },
    body,
  });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new Error(`snapshot ${res.statusCode}: ${text}`);
  }
  // Drain the body so the socket can be reused.
  await res.body.dump();
}

// --- Hocuspocus server -------------------------------------------------

const server = new Server({
  port: PORT,
  // Bind to all interfaces so the container is reachable from nginx.
  address: "0.0.0.0",
  // Give us visibility into every client → server event so we can
  // see in docker logs exactly when snapshots + stores fire.
  onConnect: async ({ documentName }) => {
    console.log(`[collab] client connected to ${documentName}`);
  },
  onDisconnect: async ({ documentName }) => {
    console.log(`[collab] client disconnected from ${documentName}`);
  },
  onChange: async ({ documentName }) => {
    // Fires on every update frame the client ships. Noisy but the
    // signal we're missing today, so log at info level until the
    // store path is confirmed healthy.
    console.log(`[collab] change on ${documentName}`);
  },
  onStoreDocument: async ({ documentName }) => {
    console.log(`[collab] onStoreDocument fired for ${documentName}`);
  },
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const documentId = assertDocumentId(documentName);
        const { rows } = await pool.query(
          "SELECT yjs_update FROM document_state WHERE file_id = $1",
          [documentId]
        );
        if (rows.length === 0) {
          console.log(`[collab] fetch: no row for ${documentId}`);
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
          console.log(`[collab] fetch: empty row for ${documentId}, starting fresh`);
          return null;
        }
        console.log(`[collab] fetch: loaded ${buf.length} bytes for ${documentId}`);
        return new Uint8Array(buf);
      },
      store: async ({ documentName, state }) => {
        const documentId = assertDocumentId(documentName);
        console.log(`[collab] store: writing ${state.length} bytes for ${documentId}`);
        // ON CONFLICT upsert — the row is seeded empty by the backend
        // at document creation, but this keeps us honest if Hocuspocus
        // ever races ahead.
        await pool.query(
          `INSERT INTO document_state (file_id, yjs_update, version, updated_at)
           VALUES ($1, $2, 1, NOW())
           ON CONFLICT (file_id) DO UPDATE
             SET yjs_update = EXCLUDED.yjs_update,
                 version    = document_state.version + 1,
                 updated_at = NOW()`,
          [documentId, Buffer.from(state)]
        );
        // Debounced HTML snapshot back to the backend.
        scheduleSnapshot(documentId, state);
      },
    }),
  ],

  async onAuthenticate(data) {
    const { token, documentName } = data;
    const documentId = assertDocumentId(documentName);

    if (!token) throw new Error("Missing collab token");
    let payload;
    try {
      const result = await jwtVerify(token, jwtSecretBytes, {
        algorithms: ["HS256"],
      });
      payload = result.payload;
    } catch (err) {
      console.warn(
        `[collab] JWT verify failed for doc ${documentId}:`,
        err?.message || err
      );
      throw new Error("Invalid collab token");
    }

    if (payload.type !== "collab") {
      throw new Error("Wrong token type");
    }
    if (payload.document_id !== documentId) {
      throw new Error("Token does not match document");
    }

    const perm = payload.perm === "read" ? "read" : "write";
    return {
      user: {
        id: payload.sub,
        name: payload.name || "Anonymous",
        color: payload.color || "#D97757",
      },
      readOnly: perm === "read",
    };
  },
});

// --- Lifecycle ---------------------------------------------------------

await server.listen();
console.log(`[collab] Hocuspocus listening on :${PORT}`);

async function shutdown(signal) {
  console.log(`[collab] received ${signal}, shutting down`);
  try {
    await server.destroy();
  } catch {
    // Best effort.
  }
  try {
    await pool.end();
  } catch {
    // Best effort.
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
