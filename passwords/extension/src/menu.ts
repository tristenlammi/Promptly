// The inline menu, in an extension iframe the page can't read or restyle. It has only
// titles and usernames for this tab, never a secret, and ignores window messages
// entirely: a page can't talk to it, only a real click inside it counts.
import { ext, type Candidate } from "./rpc";

const root = document.getElementById("root")!;

/** A warning's button won't take a click sooner than this after it appears, so a double
 *  click on the row underneath can't answer it by accident. */
const WARNING_DWELL_MS = 600;

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

type MailRow = { id: string; from: string; domain: string; ago: string; matches: boolean; lookalike: string | null; pageLookalike: string | null; code: string | null; hasLink: boolean };

/** Asks before anything from a sender, or onto a page, that looks like a saved site and
 *  isn't. The warning replaces the list, and the safe way out comes first. */
function warnThenFill(m: MailRow, warning: string) {
  root.textContent = "";
  note(warning);
  root.appendChild(row("Don't fill", "", () => void render(), "Don't fill"));
  const shownAt = performance.now();
  root.appendChild(
    row(`Fill ${m.code} anyway`, "Only if you're sure you know who sent it", async () => {
      if (performance.now() - shownAt < WARNING_DWELL_MS) return;
      const out = (await call({ t: "menuMailCode", id: m.id, confirmLookalike: true })) as { ok: boolean } | null;
      if (!out?.ok) {
        root.textContent = "";
        note("To be safe, type this one in yourself.");
      }
    }, `Fill code from ${m.domain} anyway`),
  );
}

async function render() {
  root.textContent = "";
  const r = (await call({ t: "menuList" })) as { locked: boolean; candidates: Candidate[]; kinds?: string[]; mail?: MailRow[] } | null;
  if (!r) return note("Can't reach Promptly Passwords.");
  if (r.locked) {
    note("Your vault is locked.");
    root.appendChild(row("Open Promptly Passwords", "", () => call({ t: "menuOpenPopup" })));
    return;
  }
  // Shown as text and filled only on a click: what's in an email is untrusted.
  for (const m of r.mail ?? []) {
    const warn = m.lookalike ? ` Looks like ${m.lookalike}, but it isn't.` : m.pageLookalike ? ` This page looks like ${m.pageLookalike}, but it isn't.` : m.matches ? "" : " Not from this site.";
    if (m.code) {
      root.appendChild(
        row(`Code from email: ${m.code}`, `from ${m.from}, ${m.ago}.${warn}`, async () => {
          if (m.lookalike || m.pageLookalike) {
            const who = m.lookalike ? `This email is from ${m.domain}, which looks like ${m.lookalike} but isn't.` : `This page looks like ${m.pageLookalike} but isn't.`;
            return warnThenFill(m, `${who} This could be phishing.`);
          }
          const out = (await call({ t: "menuMailCode", id: m.id })) as { ok: boolean } | null;
          if (!out?.ok) note("To be safe, type this one in yourself.");
        }, `Fill code from ${m.domain}`),
      );
    }
    // A link opens at once and can't be taken back, so a lookalike gets no row at all.
    if (m.hasLink && !m.lookalike && !m.pageLookalike) {
      root.appendChild(row(`Open sign-in link from ${m.from}`, `${m.ago}.${warn}`, () => call({ t: "menuMailLink", id: m.id }), `Open sign-in link from ${m.domain}`));
    }
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
  if (kinds.includes("change-password") && r.candidates.length > 1) {
    // A new password belongs to one account, and which one isn't ours to guess.
    for (const c of r.candidates.slice(0, 3)) {
      root.appendChild(row(`New password for ${c.username || c.title}`, "Kept until the site accepts it", () => call({ t: "menuGenerate", itemId: c.id })));
    }
  } else if (kinds.includes("signup") || kinds.includes("change-password")) {
    root.appendChild(row("Generate a password", "", () => call({ t: "menuGenerate" })));
  }
  if (kinds.includes("card") || kinds.includes("identity")) {
    root.appendChild(row("Open Promptly Passwords to fill this", "Cards and addresses always ask first", () => call({ t: "menuOpenPopup" })));
  }
}

window.addEventListener("message", (e) => e.stopImmediatePropagation(), true);
render();
