// The window that asks: which passkey, or make one. Its own window, so a page can't
// cover it or trick a click on it. The real origin comes from the background.
import { ext } from "./rpc";

const root = document.getElementById("root")!;
const id = new URLSearchParams(location.search).get("id") ?? "";

const call = async (m: Record<string, unknown>) => {
  const r = (await ext.runtime.sendMessage({ ...m, id })) as { ok: boolean; r?: unknown; error?: string } | undefined;
  if (!r?.ok) throw new Error(r?.error ?? "No answer");
  return r.r as Record<string, unknown>;
};

const el = (tag: string, text?: string, cls?: string) => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

/** A window that opens under someone's cursor shouldn't take the click already on its way,
 *  so buttons wake up a moment after they appear. */
const WAKE_MS = 600;

function button(text: string, onClick: () => void, primary = false) {
  const b = el("button", text, primary ? "primary" : "") as HTMLButtonElement;
  b.type = "button";
  b.disabled = true;
  setTimeout(() => {
    b.disabled = false;
  }, WAKE_MS);
  b.addEventListener("click", (e) => e.isTrusted && onClick());
  return b;
}

async function answer(a: Record<string, unknown>) {
  const r = await call({ t: "pkAnswer", ...a });
  if (r?.error === "locked") void render();
  else if (r?.error === "verify") verifyFor({ ...a, verify: undefined }, "");
  else if (r?.error === "wrong") verifyFor({ ...a, verify: undefined }, "That isn't right.");
  else window.close();
}

/** For an item marked to ask for the master password before it's used. */
function verifyFor(a: Record<string, unknown>, problem: string) {
  root.replaceChildren(el("p", "This item asks for your master password, or your PIN if you've set one."));
  const form = el("form") as HTMLFormElement;
  const input = el("input") as HTMLInputElement;
  input.type = "password";
  input.setAttribute("aria-label", "Master password or PIN");
  form.append(input);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value) void answer({ ...a, verify: input.value });
  });
  root.append(form);
  const err = el("p", problem, "err");
  root.append(button("Continue", () => form.requestSubmit(), true));
  root.append(button("Cancel", () => void answer({ action: "cancel" })), err);
  input.focus();
}

function unlockForm() {
  const form = el("form") as HTMLFormElement;
  const input = el("input") as HTMLInputElement;
  input.type = "password";
  input.setAttribute("aria-label", "Master password");
  input.placeholder = "Master password";
  input.autofocus = true;
  const err = el("p", "", "err");
  form.append(input, button("Unlock", () => form.requestSubmit(), true), err);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = (await ext.runtime.sendMessage({ t: "unlock", password: input.value })) as { ok: boolean; error?: string };
    if (r.ok) void render();
    else err.textContent = r.error ?? "Couldn't unlock";
  });
  return form;
}

async function render() {
  const p = await call({ t: "pkPrompt" });
  if (p.gone) return window.close();
  root.replaceChildren();
  const who = el("p");
  who.append("Asked by ");
  who.append(el("strong", new URL(String(p.origin)).host));
  root.append(el("h1", p.op === "create" ? "Save a passkey?" : "Sign in with a passkey?"), who);
  if (!p.unlocked) {
    root.append(el("p", "Unlock your vault first."), unlockForm());
    root.append(button("Use another device or security key", () => answer({ action: "native" })), button("Cancel", () => answer({ action: "cancel" })));
    return;
  }
  if (p.op === "get") {
    for (const c of p.candidates as { itemId: string; credentialId: string; title: string; userName: string }[]) {
      root.append(button(`${c.title}: ${c.userName}`, () => answer({ action: "use", credentialId: c.credentialId }), true));
    }
  } else {
    const user = p.user as { name: string };
    root.append(el("p", `For ${user.name} on ${p.rpId}`));
    if (p.alreadySaved) {
      root.append(el("p", "You already have a passkey for this account here."));
      root.append(button("Tell the site", () => answer({ action: "create" }), true));
    } else {
      if (p.existing) root.append(button(`Add it to "${p.existing}"`, () => answer({ action: "create", attach: true }), true));
      root.append(button("Save as a new item", () => answer({ action: "create" }), !p.existing));
    }
  }
  root.append(button("Use another device or security key", () => answer({ action: "native" })), button("Cancel", () => answer({ action: "cancel" })));
}

void render();
