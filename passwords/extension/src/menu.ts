// The inline menu, in an extension iframe the page can't read or restyle. It has titles
// and usernames for this frame, and a mail code when the sender matches the site. It
// ignores window messages entirely: a page can't talk to it, and only a press it judged
// good counts (press.ts). The fragment of its address is its name: the frame that opened
// it holds the same random token, and the background only ever deals with that frame.
import { inlineCanAct, type PressGuard, pressGuard } from "./press";
import { ext, type Candidate } from "./rpc";

const root = document.getElementById("root")!;
const token = location.hash.slice(1);
const guard: PressGuard = pressGuard(root);

const call = async (m: Record<string, unknown>) => {
  const r = (await ext.runtime.sendMessage({ ...m, token })) as { ok: boolean; r?: unknown } | undefined;
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
    if (guard.take(e)) onClick();
    else refused();
  });
  return b;
}

/** It didn't count. Doesn't take the rows away: the person's looking now, and can press again. */
function refused() {
  document.getElementById("refused")?.remove();
  const d = document.createElement("div");
  d.id = "refused";
  d.className = "note";
  d.textContent = "To be safe, that click didn't count. Look at this menu first, then click again, or use the toolbar button.";
  root.prepend(d);
  guard.rendered();
}

function note(text: string) {
  const d = document.createElement("div");
  d.className = "note";
  d.textContent = text;
  root.appendChild(d);
}

function toToolbar() {
  root.textContent = "";
  note("To be safe, fill this one from the toolbar button.");
  root.appendChild(row("Open Promptly Passwords", "", () => call({ t: "menuOpenPopup" })));
  guard.rendered();
}

type MailRow = { id: string; domain: string; ago: string; code: string | null; linkHost: string | null };

/** A link goes somewhere at once and can't be taken back, and an email's sender is only
 *  what the email says it is. So it's never one click. */
function askBeforeLink(m: MailRow) {
  root.textContent = "";
  note(`An email says it's from ${m.domain}, and has a sign-in link to ${m.linkHost}. Email senders can be forged. Only open it if you just asked for it.`);
  root.appendChild(row("Don't open it", "", () => void render()));
  root.appendChild(
    row(`Open ${m.linkHost}`, "", async () => {
      const out = (await call({ t: "menuMailLink", id: m.id, confirmed: true })) as { ok: boolean } | null;
      if (!out?.ok) toToolbar();
    }, `Open sign-in link to ${m.linkHost}`),
  );
  guard.rendered();
}

async function render() {
  root.textContent = "";
  guard.rendered();
  // Nothing here can tell a person from a hidden cover, so it doesn't pretend to.
  if (!inlineCanAct()) {
    note("To fill here, click the Promptly Passwords button in your toolbar. This browser can't confirm this menu is really showing, so it can't fill from here.");
    return;
  }
  const r = (await call({ t: "menuList" })) as { locked: boolean; candidates: Candidate[]; kinds?: string[]; mail?: MailRow[]; otherMail?: string[] } | null;
  if (!r) return note("Can't reach Promptly Passwords.");
  if (r.locked) {
    note("Your vault is locked.");
    root.appendChild(row("Open Promptly Passwords", "", () => call({ t: "menuOpenPopup" })));
    guard.rendered();
    return;
  }
  // Shown as text and filled only on a click: what's in an email is untrusted.
  for (const m of r.mail ?? []) {
    if (m.code) {
      root.appendChild(
        row(`Code from email: ${m.code}`, `from ${m.domain}, ${m.ago}`, async () => {
          const out = (await call({ t: "menuMailCode", id: m.id })) as { ok: boolean } | null;
          if (!out?.ok) note("To be safe, type this one in yourself.");
        }, `Fill code from ${m.domain}`),
      );
    }
    if (m.linkHost) {
      root.appendChild(row(`Sign-in link from ${m.domain}?`, `${m.ago}. Says it's from there. Senders can be forged.`, () => askBeforeLink(m), `Sign-in link from ${m.domain}`));
    }
  }
  for (const domain of r.otherMail ?? []) {
    note(`An email from ${domain} has a code. It isn't from this site, so it's not offered here.`);
  }
  for (const c of r.candidates.slice(0, 6)) {
    root.appendChild(
      row(c.title, c.username, async () => {
        const out = (await call({ t: "menuPick", itemId: c.id })) as { ok: boolean; reason?: string } | null;
        if (!out?.ok) toToolbar();
      }, `Fill ${c.title}`),
    );
  }
  if (!r.candidates.length) note("No saved logins for this site.");
  const kinds = r.kinds ?? [];
  const generate = async (itemId?: string) => {
    const out = (await call({ t: "menuGenerate", itemId })) as { ok: boolean } | null;
    if (!out?.ok) toToolbar();
  };
  const changeable = r.candidates.filter((c) => !c.reprompt);
  if (kinds.includes("change-password") && changeable.length > 1) {
    // A new password belongs to one account, and which one isn't ours to guess.
    for (const c of changeable.slice(0, 3)) {
      root.appendChild(row(`New password for ${c.username || c.title}`, "Kept until the site accepts it", () => void generate(c.id)));
    }
  } else if (kinds.includes("signup") || kinds.includes("change-password")) {
    root.appendChild(row("Generate a password", "", () => void generate()));
  }
  if (kinds.includes("card") || kinds.includes("identity")) {
    root.appendChild(row("Open Promptly Passwords to fill this", "Cards and addresses always ask first", () => call({ t: "menuOpenPopup" })));
  }
  guard.rendered();
}

window.addEventListener("message", (e) => e.stopImmediatePropagation(), true);
void render();
