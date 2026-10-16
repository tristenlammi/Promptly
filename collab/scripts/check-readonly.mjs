// End-to-end check for roadmap R-021: does the collab server really drop
// edits from a read-only (perm: "read") connection?
//
// Runs inside the collab container. Tokens are signed here from the
// container's own SECRET_KEY and never printed. Uses a throwaway canvas
// room, so no real document is touched.
// Node 22+ has a built-in WebSocket (Hocuspocus 4 no longer ships "ws").
import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";

const SYNC = 0;
const AUTH = 2;
const canvasId = randomUUID();
const room = `canvas:${canvasId}`;
const secret = new TextEncoder().encode(process.env.SECRET_KEY || "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token(perm, sub) {
  return new SignJWT({ type: "canvas", canvas_id: canvasId, perm, name: sub })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(secret);
}

function frame(type, write) {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, room);
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
}

function client(tok, label) {
  const doc = new Y.Doc();
  const ws = new WebSocket("ws://127.0.0.1:1234");
  const state = { doc, ws, scope: null };
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    ws.send(frame(AUTH, (e) => { encoding.writeVarUint(e, 0); encoding.writeVarString(e, tok); }));
    ws.send(frame(SYNC, (e) => sync.writeSyncStep1(e, doc)));
  });
  ws.addEventListener("message", ({ data }) => {
    const d = decoding.createDecoder(new Uint8Array(data));
    decoding.readVarString(d);
    const type = decoding.readVarUint(d);
    if (type === AUTH) {
      const sub = decoding.readVarUint(d);
      state.scope = sub === 2 ? decoding.readVarString(d) : `denied(${sub})`;
    } else if (type === SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarString(reply, room);
      encoding.writeVarUint(reply, SYNC);
      const before = encoding.length(reply);
      sync.readSyncMessage(d, reply, doc, "remote");
      if (encoding.length(reply) > before) ws.send(encoding.toUint8Array(reply));
    }
  });
  doc.on("update", (u, origin) => {
    if (origin !== "remote" && ws.readyState === 1) {
      ws.send(frame(SYNC, (e) => sync.writeUpdate(e, u)));
    }
  });
  ws.addEventListener("error", (err) => console.log(`[${label}] ws error`, err.message));
  return state;
}

const watcher = client(await token("write", "watcher"), "watcher");
await sleep(800);
const viewer = client(await token("read", "viewer"), "viewer");
await sleep(800);
viewer.doc.getText("t").insert(0, "FROM-VIEWER ");
await sleep(1000);
const writer = client(await token("write", "writer"), "writer");
await sleep(800);
writer.doc.getText("t").insert(0, "FROM-WRITER ");
await sleep(1000);

const seen = watcher.doc.getText("t").toString();
console.log(`viewer was told scope=${viewer.scope}; writer scope=${writer.scope}`);
console.log(`watcher sees: ${JSON.stringify(seen)}`);
const control = seen.includes("FROM-WRITER");
const leaked = seen.includes("FROM-VIEWER");
console.log(
  !control ? "INCONCLUSIVE: control write did not propagate"
  : leaked ? "VULNERABLE: a read-only connection edited the document"
  : "ENFORCED: read-only edit was dropped, normal edit went through"
);
for (const c of [watcher, viewer, writer]) c.ws.close();
process.exit(0);
