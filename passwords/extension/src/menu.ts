// The inline menu, in an extension iframe the page can't read or restyle. It has only
// titles and usernames for this tab, never a secret, and ignores window messages
// entirely: a page can't talk to it, only a real click inside it counts.
import { ext, type Candidate } from "./rpc";

const root = document.getElementById("root")!;

const call = async (m: unknown) => {
  const r = (await ext.runtime.sendMessage(m)) as { ok: boolean; r?: unknown } | undefined;
  return r?.ok ? r.r : null;
};

function row(text: string, sub: string, onClick: () => void, name?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "row";
  if (name) b.setAttribute("aria-label", name);
  const t = document.createElement("span");
  t.className = "title";
  t.textContent = text;
  b.appendChild(t);
  if (sub) {
    const s = document.createElement("span");
    s.className = "sub";
    s.textContent = sub;
    b.appendChild(s);
  }
  b.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    onClick();
  });
  return b;
}

function note(text: string) {
  const d = document.createElement("div");
  d.className = "note";
  d.textContent = text;
  root.appendChild(d);
}

async function render() {
  root.textContent = "";
  const r = (await call({ t: "menuList" })) as { locked: boolean; candidates: Candidate[]; kinds?: string[] } | null;
  if (!r) return note("Can't reach Promptly Passwords.");
  if (r.locked) {
    note("Your vault is locked.");
    root.appendChild(row("Open Promptly Passwords", "", () => call({ t: "menuOpenPopup" })));
    return;
  }
  for (const c of r.candidates.slice(0, 6)) {
    root.appendChild(
      row(c.title, c.username, async () => {
        const out = (await call({ t: "menuPick", itemId: c.id })) as { ok: boolean; reason?: string } | null;
        if (!out?.ok) {
          root.textContent = "";
          note("To be safe, fill this one from the toolbar button.");
          root.appendChild(row("Open Promptly Passwords", "", () => call({ t: "menuOpenPopup" })));
        }
      }, `Fill ${c.title}`),
    );
  }
  if (!r.candidates.length) note("No saved logins for this site.");
  const kinds = r.kinds ?? [];
  if (kinds.includes("signup") || kinds.includes("change-password")) {
    root.appendChild(row("Generate a password", "", () => call({ t: "menuGenerate" })));
  }
  if (kinds.includes("card") || kinds.includes("identity")) {
    root.appendChild(row("Open Promptly Passwords to fill this", "Cards and addresses always ask first", () => call({ t: "menuOpenPopup" })));
  }
}

window.addEventListener("message", (e) => e.stopImmediatePropagation(), true);
render();
