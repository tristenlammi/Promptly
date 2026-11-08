// End-to-end check for Forms' ``POST /internal/sheet-cells`` (WP-F1.5):
//   * the internal token is required, and formulas are refused;
//   * a room no editor has opened is seeded from ``spreadsheets.data``
//     first, then written and stored (``live: false``, the state handed back);
//   * a room an editor has open gets the cells live (``live: true``) — the
//     write reaches a second Y client like any other edit — and is stored
//     on the usual debounce;
//   * ``expect`` refuses a write when the row moved (a sort), with the state.
//
// Runs inside the collab container against a throwaway file + sheet row that
// are deleted at the end. Tokens are signed here and never printed:
//   docker cp collab/scripts/check-sheet-cells.mjs <collab>:/app/check.mjs
//   docker exec -w /app <collab> node check.mjs
// Node 22+ has a built-in WebSocket (Hocuspocus 4 no longer ships "ws").
import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { SignJWT } from "jose";
import { createHmac, randomUUID } from "node:crypto";
import pkg from "pg";

const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace("+asyncpg", "") });
const SYNC = 0;
const AUTH = 2;
const BASE = "http://127.0.0.1:1234";
const fileId = randomUUID();
const sheetId = randomUUID();
const room = `sheet:${sheetId}`;
const TAB = "frm01";
const secret = new TextEncoder().encode(process.env.SECRET_KEY || "");
const internal =
  process.env.COLLAB_INTERNAL_TOKEN ||
  createHmac("sha256", process.env.SECRET_KEY || "").update("promptly:collab-internal").digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (v) => ({ v, m: v, ct: { fa: "@", t: "s" } });

let ok = true;
function check(label, good, detail = "") {
  console.log(`${good ? "PASS" : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
  ok &&= !!good;
}

async function post(body, token = internal) {
  const res = await fetch(`${BASE}/internal/sheet-cells`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // not JSON
  }
  return { status: res.status, json };
}

async function storedDoc() {
  const { rows } = await pool.query("SELECT yjs_update FROM spreadsheets WHERE id=$1", [sheetId]);
  const d = new Y.Doc();
  if (rows[0]?.yjs_update?.length) Y.applyUpdate(d, new Uint8Array(rows[0].yjs_update));
  return d;
}

await pool.query(
  `INSERT INTO files (id, user_id, filename, original_filename, mime_type, size_bytes,
                      storage_path, source_kind, created_at, updated_at)
   VALUES ($1, NULL, 'sheet-cells-check.sheet', 'sheet-cells-check.sheet',
           'application/vnd.promptly.sheet+json', 0, '', 'sheet', NOW(), NOW())`,
  [fileId]
);
await pool.query(
  `INSERT INTO spreadsheets (id, workspace_id, file_id, title, data, yjs_update, version, data_version,
                             created_at, updated_at)
   VALUES ($1, NULL, $2, 'check', $3, '\\x', 0, 0, NOW(), NOW())`,
  [sheetId, fileId, JSON.stringify([{ id: TAB, name: "Form responses", celldata: [{ r: 0, c: 0, v: text("Response #") }] }])]
);

let ws = null;
try {
  // --- auth and validation -------------------------------------------------
  check("wrong token is refused", (await post({ room, cells: {} }, "nope")).status === 403);
  check(
    "a formula is refused",
    (await post({ room, cells: { [`${TAB}!1,1`]: { v: "1", f: "=1+1" } } })).status === 400
  );

  // --- closed, never-seeded room --------------------------------------------
  const first = await post({ room, cells: { [`${TAB}!1,0`]: text("1") }, expect: { [`${TAB}!1,0`]: "" } });
  check("closed room write", first.status === 200 && first.json?.live === false, JSON.stringify({ status: first.status, live: first.json?.live }));
  check("closed room hands back its state", typeof first.json?.state === "string" && first.json.state.length > 0);
  let d = await storedDoc();
  check("closed room stored, seeded from data first",
    d.getMap("meta").get("seeded") === true &&
      d.getMap("cells").get(`${TAB}!0,0`)?.v === "Response #" &&
      d.getMap("cells").get(`${TAB}!1,0`)?.v === "1");

  // --- an editor opens it --------------------------------------------------
  const tok = await new SignJWT({ type: "sheet", sheet_id: sheetId, perm: "write", name: "checker", epoch: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(randomUUID())
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(secret);
  const doc = new Y.Doc();
  const frame = (type, write) => {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, room);
    encoding.writeVarUint(e, type);
    write(e);
    return encoding.toUint8Array(e);
  };
  ws = new WebSocket("ws://127.0.0.1:1234");
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    ws.send(frame(AUTH, (e) => { encoding.writeVarUint(e, 0); encoding.writeVarString(e, tok); }));
    ws.send(frame(SYNC, (e) => sync.writeSyncStep1(e, doc)));
  });
  ws.addEventListener("message", ({ data }) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    decoding.readVarString(dec);
    if (decoding.readVarUint(dec) !== SYNC) return;
    const reply = encoding.createEncoder();
    encoding.writeVarString(reply, room);
    encoding.writeVarUint(reply, SYNC);
    const before = encoding.length(reply);
    sync.readSyncMessage(dec, reply, doc, "remote");
    if (encoding.length(reply) > before) ws.send(encoding.toUint8Array(reply));
  });
  doc.on("update", (u, origin) => {
    if (origin !== "remote" && ws.readyState === 1) ws.send(frame(SYNC, (e) => sync.writeUpdate(e, u)));
  });
  await sleep(1000);
  check("the editor loaded the room", doc.getMap("cells").get(`${TAB}!1,0`)?.v === "1");

  // The editor sorts: row 1 now holds response 2's place.
  doc.getMap("cells").set(`${TAB}!1,0`, text("2"));
  await sleep(300);

  // --- open room: live write -----------------------------------------------
  let seenAt = 0;
  const t0 = Date.now();
  doc.getMap("cells").observe((e) => {
    if (e.keysChanged.has(`${TAB}!2,0`) && !seenAt) seenAt = Date.now();
  });
  const live = await post({ room, cells: { [`${TAB}!2,0`]: text("3"), [`${TAB}!2,1`]: text("=IMPORTXML(\"x\")") }, expect: { [`${TAB}!2,0`]: "" } });
  check("open room write", live.status === 200 && live.json?.live === true, JSON.stringify({ status: live.status, live: live.json?.live }));
  await sleep(500);
  check("the open editor got it live", !!seenAt && doc.getMap("cells").get(`${TAB}!2,0`)?.v === "3", seenAt ? `${seenAt - t0} ms` : "never");
  check("formula-looking text arrives as text", (() => {
    const c = doc.getMap("cells").get(`${TAB}!2,1`);
    return c && c.f === undefined && c.ct?.fa === "@" && c.v === "=IMPORTXML(\"x\")";
  })());

  // --- expect: the row moved -----------------------------------------------
  const stale = await post({ room, cells: { [`${TAB}!1,1`]: text("edited") }, expect: { [`${TAB}!1,0`]: "1" } });
  check("a moved row is refused with the state", stale.status === 409 && typeof stale.json?.state === "string");
  await sleep(300);
  check("…and nothing was written", doc.getMap("cells").get(`${TAB}!1,1`) === undefined);

  // --- stored on the debounce while open, and at once after ---------------
  await sleep(3500);
  d = await storedDoc();
  check("open room stored on the debounce", d.getMap("cells").get(`${TAB}!2,0`)?.v === "3");
  ws.close();
  ws = null;
  await sleep(1500);
  const after = await post({ room, cells: { [`${TAB}!3,0`]: text("4") } });
  check("closed again: written and stored at once", after.status === 200 && after.json?.live === false);
  d = await storedDoc();
  check("…and in Postgres", d.getMap("cells").get(`${TAB}!3,0`)?.v === "4" && d.getMap("cells").get(`${TAB}!1,0`)?.v === "2");
} finally {
  if (ws) ws.close();
  await sleep(200);
  await pool.query("DELETE FROM file_versions WHERE file_id=$1", [fileId]).catch(() => {});
  await pool.query("DELETE FROM file_activity WHERE file_id=$1", [fileId]).catch(() => {});
  await pool.query("DELETE FROM spreadsheets WHERE id=$1", [sheetId]);
  await pool.query("DELETE FROM files WHERE id=$1", [fileId]);
  await pool.end();
}
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
