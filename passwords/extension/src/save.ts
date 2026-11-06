// "Save this password?": in an extension frame, with a real click needed. It's told
// only the site and the username, and never holds the password.
import { ext } from "./rpc";

const root = document.getElementById("root")!;
const call = async (m: unknown) => {
  const r = (await ext.runtime.sendMessage(m)) as { ok: boolean; r?: unknown } | undefined;
  return r?.ok ? r.r : null;
};

function button(text: string, onClick: () => void, primary = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (primary) b.className = "primary";
  b.addEventListener("click", (e) => e.isTrusted && onClick());
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
  row.appendChild(button(offer.kind === "update" ? "Update" : "Save", () => call({ t: "saveAnswer", answer: offer.kind }).then(close), true));
  row.appendChild(button("Not now", () => call({ t: "saveAnswer", answer: "dismiss" }).then(close)));
  row.appendChild(button("Never for this site", () => call({ t: "saveAnswer", answer: "never" }).then(close)));
  root.appendChild(row);
}
init();
