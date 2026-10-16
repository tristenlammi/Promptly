// End-to-end check for WP-3.4 Recent: a live edit through collab records
// an "edited" row in file_activity for the editor, in the store transaction.
//
// Usage (inside the collab container, against an existing whiteboard):
//   docker compose exec -T collab node --input-type=module - < collab/scripts/check-activity.mjs
// with CANVAS_ID and USER_ID in the environment (-e). The script adds one
// small element to the board. Tokens are signed here and never printed.
// Node 22+ has a built-in WebSocket (Hocuspocus 4 no longer ships "ws").
import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { SignJWT } from "jose";
import pkg from "pg";

const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace("+asyncpg", "") });
const canvasId = process.env.CANVAS_ID;
const userId = process.env.USER_ID;
const room = `canvas:${canvasId}`;
const secret = new TextEncoder().encode(process.env.SECRET_KEY || "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { rows } = await pool.query("SELECT file_id FROM workspace_canvas WHERE id = $1", [canvasId]);
const fileId = rows[0]?.file_id;
const before = (
  await pool.query("SELECT at FROM file_activity WHERE user_id=$1 AND file_id=$2 AND kind='edited'", [userId, fileId])
).rows[0]?.at;

const tok = await new SignJWT({ type: "canvas", canvas_id: canvasId, perm: "write", name: "checker" })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(userId)
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
  ws.send(frame(2, (e) => { encoding.writeVarUint(e, 0); encoding.writeVarString(e, tok); }));
  ws.send(frame(0, (e) => sync.writeSyncStep1(e, doc)));
});
ws.addEventListener("message", ({ data }) => {
  const d = decoding.createDecoder(new Uint8Array(data));
  decoding.readVarString(d);
  if (decoding.readVarUint(d) !== 0) return;
  const reply = encoding.createEncoder();
  encoding.writeVarString(reply, room);
  encoding.writeVarUint(reply, 0);
  const n = encoding.length(reply);
  sync.readSyncMessage(d, reply, doc, "remote");
  if (encoding.length(reply) > n) ws.send(encoding.toUint8Array(reply));
});
doc.on("update", (u, origin) => {
  if (origin !== "remote" && ws.readyState === 1) ws.send(frame(0, (e) => sync.writeUpdate(e, u)));
});

let ok = false;
try {
  await sleep(1000);
  const els = doc.getMap("elements");
  const had = els.size;
  els.set("activitycheck0000001", { id: "activitycheck0000001", type: "text", isDeleted: true, version: 1 });
  await sleep(4000);
  const after = (
    await pool.query("SELECT at FROM file_activity WHERE user_id=$1 AND file_id=$2 AND kind='edited'", [userId, fileId])
  ).rows[0]?.at;
  ok = !!after && (!before || after > before);
  console.log(`board had ${had} element(s); edited activity: ${ok ? "PASS" : "FAIL"}`);
} finally {
  ws.close();
  await pool.end();
}
process.exit(ok ? 0 : 1);
