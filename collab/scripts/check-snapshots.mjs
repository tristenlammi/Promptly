// End-to-end check for WP-3.3 editor-state snapshots: the first store keeps
// an "auto" version, a store that shrinks the document to under half keeps
// a "shrink_guard" copy of what was there, and the last client leaving
// keeps a final "auto" one.
//
// Runs inside the collab container against a throwaway document row that is
// deleted at the end (its versions cascade with it). Tokens are signed here
// and never printed. The backend writes the doc's HTML snapshot to
// data/uploads/collab-check/ on the host; delete that folder afterwards.
//
//   docker compose exec -T collab node scripts/check-snapshots.mjs
// Node 22+ has a built-in WebSocket (Hocuspocus 4 no longer ships "ws").
import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
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
   VALUES ($1, NULL, 'snapshot-check.html', 'snapshot-check.html', 'text/html', 0,
           $2, 'document', NOW(), NOW())`,
  [docId, `collab-check/${docId}.html`]
);
await pool.query(`INSERT INTO document_state (file_id, yjs_update, version) VALUES ($1, '\\x', 0)`, [docId]);

const tok = await new SignJWT({ type: "collab", document_id: docId, perm: "write", name: "checker" })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(randomUUID())
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

const versions = async () =>
  (await pool.query(
    "SELECT source, size_bytes, yjs_state FROM file_versions WHERE file_id=$1 ORDER BY created_at",
    [docId]
  )).rows;

let ok = true;
const check = (label, cond, extra = "") => {
  console.log(`${label}: ${cond ? "PASS" : "FAIL"}${extra ? ` (${extra})` : ""}`);
  ok &&= cond;
};
try {
  await sleep(800);
  // A substantial document — well above the shrink guard's floor.
  doc.getText("t").insert(0, "Quarterly plan. ".repeat(400));
  await sleep(4000); // store debounce
  let v = await versions();
  check("first store keeps an auto version", v.some((r) => r.source === "auto"), `${v.length} version(s)`);

  // More writing — stored, but inside the 10-minute auto window, so this
  // state isn't kept by "auto". Only the shrink guard can save it.
  doc.getText("t").insert(doc.getText("t").length, "Appendix. ".repeat(200));
  await sleep(4000);

  // Someone wipes almost all of it.
  const t = doc.getText("t");
  t.delete(0, t.length - 10);
  await sleep(4000);
  v = await versions();
  const guard = v.find((r) => r.source === "shrink_guard");
  check("a big shrink keeps the previous state", !!guard);
  if (guard) {
    const kept = new Y.Doc();
    Y.applyUpdate(kept, new Uint8Array(inflateSync(guard.yjs_state)));
    check(
      "the kept state includes the later writing",
      kept.getText("t").toString().includes("Appendix."),
      `${kept.getText("t").length} chars`
    );
  }

  const before = v.length;
  doc.getText("t").insert(0, "last words ");
  await sleep(300);
  ws.close();
  await sleep(2500);
  v = await versions();
  check("the last client leaving keeps a final version", v.length > before, `${before} → ${v.length}`);
} finally {
  if (ws.readyState === 1) ws.close();
  await pool.query("DELETE FROM files WHERE id=$1", [docId]);
  await pool.end();
}
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
