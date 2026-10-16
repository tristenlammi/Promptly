// End-to-end check for roadmap R-036: an open collab socket must not keep
// access after it's been revoked or downgraded.
//
//   docker compose exec -T collab sh -c 'cd /app && node --input-type=module' < collab/scripts/check-reauth.mjs
//
// Takes ~2 minutes. Tokens are signed inside the collab container from its
// own SECRET_KEY (never printed); a throwaway canvas room is used.
//   A "revoked"   — can only ever re-send its original short-lived token
//   B "renewed"   — re-sends a fresh write token when the server asks
//   C "demoted"   — re-sends a *read* token when asked (editor → viewer)
// After the short tokens expire, all three write; only B's edit may land.
// Node 22+ has a built-in WebSocket (Hocuspocus 4 no longer ships "ws").
import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";

const SYNC = 0, AUTH = 2, CLOSE = 7;
const canvasId = randomUUID();
const room = `canvas:${canvasId}`;
const secret = new TextEncoder().encode(process.env.SECRET_KEY || "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = (perm, sub, ttlS) =>
  new SignJWT({ type: "canvas", canvas_id: canvasId, perm, name: sub })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlS)
    .sign(secret);

function frame(type, write) {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, room);
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
}

function client(label, firstToken, onTokenRequest) {
  const doc = new Y.Doc();
  const ws = new WebSocket("ws://127.0.0.1:1234");
  const st = { label, doc, ws, closedByServer: false, syncRequests: 0 };
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    ws.send(frame(AUTH, (e) => { encoding.writeVarUint(e, 0); encoding.writeVarString(e, firstToken); }));
    ws.send(frame(SYNC, (e) => sync.writeSyncStep1(e, doc)));
  });
  ws.addEventListener("message", async ({ data }) => {
    const d = decoding.createDecoder(new Uint8Array(data));
    decoding.readVarString(d);
    const type = decoding.readVarUint(d);
    if (type === AUTH) {
      const sub = decoding.readVarUint(d);
      if (sub === 0) { // server asks: "send me your token"
        st.syncRequests++;
        const t = await onTokenRequest();
        ws.send(frame(AUTH, (e) => { encoding.writeVarUint(e, 0); encoding.writeVarString(e, t); }));
      }
    } else if (type === CLOSE) {
      st.closedByServer = true;
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
    if (origin !== "remote" && ws.readyState === 1) ws.send(frame(SYNC, (e) => sync.writeUpdate(e, u)));
  });
  return st;
}

const watcher = client("watcher", await token("write", "watcher", 600), () => token("write", "watcher", 600));
await sleep(800);
const aOld = await token("write", "A", 25);
const A = client("A-revoked", aOld, async () => aOld);
const B = client("B-renewed", await token("write", "B", 25), () => token("write", "B", 300));
const C = client("C-demoted", await token("write", "C", 25), () => token("read", "C", 300));
await sleep(1500);
for (const c of [A, B, C]) c.doc.getText("t").insert(0, `${c.label}-EARLY `);
console.log("waiting ~110s for tokens to expire and the sweep to act…");
await sleep(110_000);
for (const c of [A, B, C]) c.doc.getText("t").insert(0, `${c.label}-LATE `);
await sleep(2000);

const seen = watcher.doc.getText("t").toString();
console.log(`watcher sees: ${JSON.stringify(seen)}`);
for (const c of [A, B, C]) {
  console.log(`${c.label}: sync requests=${c.syncRequests} closedByServer=${c.closedByServer} lateEditLanded=${seen.includes(c.label + "-LATE")}`);
}
const ok =
  ["A-revoked", "B-renewed", "C-demoted"].every((l) => seen.includes(`${l}-EARLY`)) &&
  !seen.includes("A-revoked-LATE") &&
  seen.includes("B-renewed-LATE") &&
  !seen.includes("C-demoted-LATE");
console.log(ok ? "PASS: revoked and demoted sockets lost write access; renewed socket kept it"
               : "FAIL: see per-client lines above");
for (const c of [watcher, A, B, C]) c.ws.close();
process.exit(ok ? 0 : 1);
