// End-to-end check for roadmap R-022: a Save made while a client was cut
// off from live sync (merged into document_state by the backend) must not
// be thrown away by the collab server's next store — it must reach the
// live document, exactly once.
//
// Runs inside the collab container against a throwaway document row that
// is deleted at the end. Tokens are signed here and never printed. The
// backend writes the doc's HTML snapshot to data/uploads/collab-check/ on
// the host; delete that folder afterwards.
// Node 22+ has a built-in WebSocket (Hocuspocus 4 no longer ships "ws").
import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import pkg from "pg";

const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace("+asyncpg", "") });
const SYNC = 0;
const AUTH = 2;
const docId = randomUUID();
const room = docId;
const secret = new TextEncoder().encode(process.env.SECRET_KEY || "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await pool.query(
  `INSERT INTO files (id, user_id, filename, original_filename, mime_type, size_bytes,
                      storage_path, source_kind, created_at, updated_at)
   VALUES ($1, NULL, 'merge-check.html', 'merge-check.html', 'text/html', 0,
           $2, 'document', NOW(), NOW())`,
  [docId, `collab-check/${docId}.html`]
);
await pool.query(
  `INSERT INTO document_state (file_id, yjs_update, version) VALUES ($1, '\\x', 0)`,
  [docId]
);

const tok = await new SignJWT({ type: "collab", document_id: docId, perm: "write", name: "checker" })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject("checker")
  .setIssuedAt()
  .setExpirationTime("2m")
  .sign(secret);

function frame(type, write) {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, room);
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
}

const doc = new Y.Doc();
const ws = new WebSocket("ws://127.0.0.1:1234");
ws.binaryType = "arraybuffer";
ws.addEventListener("open", () => {
  ws.send(frame(AUTH, (e) => { encoding.writeVarUint(e, 0); encoding.writeVarString(e, tok); }));
  ws.send(frame(SYNC, (e) => sync.writeSyncStep1(e, doc)));
});
ws.addEventListener("message", ({ data }) => {
  const d = decoding.createDecoder(new Uint8Array(data));
  decoding.readVarString(d);
  if (decoding.readVarUint(d) !== SYNC) return;
  const reply = encoding.createEncoder();
  encoding.writeVarString(reply, room);
  encoding.writeVarUint(reply, SYNC);
  const before = encoding.length(reply);
  sync.readSyncMessage(d, reply, doc, "remote");
  if (encoding.length(reply) > before) ws.send(encoding.toUint8Array(reply));
});
doc.on("update", (u, origin) => {
  if (origin !== "remote" && ws.readyState === 1) ws.send(frame(SYNC, (e) => sync.writeUpdate(e, u)));
});

const text = () => doc.getText("t").toString();
let ok = true;
try {
  await sleep(800);
  doc.getText("t").insert(0, "LIVE ");
  await sleep(3500); // let the store debounce flush

  // What the backend does on an offline Save: a client that had synced,
  // typed while cut off, and saved — merged into the stored state.
  const { rows } = await pool.query("SELECT yjs_update FROM document_state WHERE file_id=$1", [docId]);
  const offline = new Y.Doc();
  Y.applyUpdate(offline, new Uint8Array(rows[0].yjs_update));
  offline.getText("t").insert(offline.getText("t").length, "OFFLINE ");
  const merged = Y.mergeUpdates([new Uint8Array(rows[0].yjs_update), Y.encodeStateAsUpdate(offline)]);
  await pool.query("UPDATE document_state SET yjs_update=$2 WHERE file_id=$1", [docId, Buffer.from(merged)]);

  // A later live edit triggers the next store.
  doc.getText("t").insert(doc.getText("t").length, "AFTER");
  await sleep(4500);

  const live = text();
  const stored = new Y.Doc();
  const after = await pool.query("SELECT yjs_update FROM document_state WHERE file_id=$1", [docId]);
  Y.applyUpdate(stored, new Uint8Array(after.rows[0].yjs_update));
  const db = stored.getText("t").toString();
  const once = (s, w) => s.split(w).length - 1 === 1;
  for (const [label, s] of [["live client", live], ["stored state", db]]) {
    const good = ["LIVE", "OFFLINE", "AFTER"].every((w) => once(s, w));
    console.log(`${label}: ${good ? "PASS" : "FAIL"} -> ${JSON.stringify(s)}`);
    ok &&= good;
  }
} finally {
  ws.close();
  await pool.query("DELETE FROM files WHERE id=$1", [docId]);
  await pool.end();
}
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
