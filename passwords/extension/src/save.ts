// "Save this password?": in an extension frame, with a real press needed. It's told only
// the site and the username, and never holds the password. An answer that changes the
// vault counts only on a press this frame judged good (press.ts). A browser that can't
// judge one sends the person to the toolbar popup, which a page can't cover.
import { inlineCanAct, pressGuard } from "./press";
import { ext } from "./rpc";

const root = document.getElementById("root")!;
const token = location.hash.slice(1);
const guard = pressGuard(root);

const call = async (m: Record<string, unknown>) => {
  const r = (await ext.runtime.sendMessage({ ...m, token })) as { ok: boolean; r?: unknown } | undefined;
  return r?.ok ? r.r : null;
};

function refused() {
  document.getElementById("refused")?.remove();
  const d = document.createElement("div");
  d.id = "refused";
  d.className = "sub";
  d.textContent = guard.why() === "hidden" ? "That click didn't count, as this wasn't fully in view. Click again." : "That click came as this opened, so it didn't count. Click again.";
  root.appendChild(d);
  guard.rendered();
}

function button(text: string, onClick: () => void, primary = false, gated = true) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (primary) b.className = "primary";
  b.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    if (!gated || guard.take(e)) onClick();
    else refused();
  });
  return b;
}

async function init() {
  const offer = (await call({ t: "saveOffer" })) as { kind: "save" | "update"; username: string; host: string } | null;
  if (!offer) return;
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = offer.kind === "update" ? `Update your password for ${offer.host}?` : `Save this login for ${offer.host}?`;
  root.appendChild(title);
  if (offer.username) {
    const u = document.createElement("div");
    u.className = "sub";
    u.textContent = offer.username;
    root.appendChild(u);
  }
  const row = document.createElement("div");
  row.className = "buttons";
  const close = () => root.replaceChildren();
  if (inlineCanAct()) {
    row.appendChild(button(offer.kind === "update" ? "Update" : "Save", () => call({ t: "saveAnswer", answer: offer.kind }).then(close), true));
    row.appendChild(button("Never for this site", () => call({ t: "saveAnswer", answer: "never" }).then(close)));
  } else {
    const how = document.createElement("div");
    how.className = "sub";
    how.textContent = "To save it, click the Promptly Passwords button in your toolbar.";
    root.appendChild(how);
  }
  // Doing nothing can't hurt, so this one needs no such care.
  row.appendChild(button("Not now", () => call({ t: "saveAnswer", answer: "dismiss" }).then(close), false, false));
  root.appendChild(row);
  guard.rendered();
}
void init();
