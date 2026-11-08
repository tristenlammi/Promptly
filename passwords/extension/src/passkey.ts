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

/** Said once, at the top of the next screen. */
let notice = "";
/** What a wrong PIN or a refused new one shows, next to the box it's about. */
let pinError: HTMLElement | null = null;
let pinInput: HTMLInputElement | null = null;

const LOCKED_TEXT = "Five wrong passkey PINs in a row, so your vault is locked. Unlock it with your master password.";

function triesText(left: number): string {
  if (left <= 1) return "That PIN isn't right. One more wrong and your vault locks.";
  return `That PIN isn't right. ${left} tries left.`;
}

async function answer(a: Record<string, unknown>) {
  const r = await call({ t: "pkAnswer", ...a });
  if (r?.error === "locked" || r?.error === "choose") void render();
  else if (r?.error === "pinLocked") {
    notice = LOCKED_TEXT;
    void render();
  } else if (r?.error === "pin") pinRefused(Number(r.left) < 5 ? triesText(Number(r.left)) : "Type your passkey PIN.");
  else if (r?.error === "badPin") pinRefused(String(r.message ?? "That PIN can't be used."));
  else if (r?.error === "verify") verifyFor({ ...a, verify: undefined }, "");
  else if (r?.error === "wrong") verifyFor({ ...a, verify: undefined }, "That isn't right.");
  else window.close();
}

function pinRefused(text: string) {
  if (!pinInput || !pinError || !pinInput.isConnected) return void render();
  pinError.textContent = text;
  pinInput.value = "";
  const again = document.getElementById("pin-again") as HTMLInputElement | null;
  if (again) again.value = "";
  pinInput.focus();
}

/** For an item marked to ask for the master password before it's used. */
function verifyFor(a: Record<string, unknown>, problem: string) {
  root.replaceChildren(el("p", "This item also asks for your master password, or this browser's unlock PIN if you've set one."));
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
    if (r.ok) {
      notice = "";
      void render();
    } else err.textContent = r.error ?? "Couldn't unlock";
  });
  return form;
}

function pinField(id: string, label: string): HTMLInputElement {
  const input = el("input") as HTMLInputElement;
  input.type = "password";
  input.id = id;
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.maxLength = 12;
  input.setAttribute("aria-label", label);
  input.placeholder = label;
  return input;
}

/** The PIN box, and what it adds to an answer. Choosing one the first time is the same screen,
 *  with the box twice. Enter in a box sends the main answer. */
function pinForm(mode: "enter" | "choose", triesLeft: number, go: (pin: Record<string, string>) => void): HTMLFormElement {
  const form = el("form") as HTMLFormElement;
  form.id = "pin-form";
  const first = pinField("pin", mode === "choose" ? "Choose a passkey PIN" : "Passkey PIN");
  form.append(first);
  let again: HTMLInputElement | null = null;
  if (mode === "choose") {
    form.prepend(el("p", "Choose a passkey PIN. You'll type it each time you use or make a passkey, on all your devices. 4 to 12 digits, and not an easy one like 1234."));
    again = pinField("pin-again", "Type it again");
    form.append(again);
  }
  pinError = el("p", mode === "enter" && triesLeft < 5 ? triesText(triesLeft) : "", "err");
  pinError.id = "pin-error";
  form.append(pinError);
  pinInput = first;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!first.value) return pinRefused(mode === "choose" ? "Choose a PIN first." : "Type your passkey PIN.");
    if (again && again.value !== first.value) return pinRefused("Those two don't match.");
    go(mode === "choose" ? { pin: first.value, newPin: first.value, newPinAgain: again!.value } : { pin: first.value });
  });
  for (const i of [first, again]) {
    i?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.isTrusted) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }
  return form;
}

async function render() {
  const p = await call({ t: "pkPrompt" });
  if (p.gone) return window.close();
  root.replaceChildren();
  pinInput = null;
  pinError = null;
  const who = el("p");
  who.append("Asked by ");
  who.append(el("strong", new URL(String(p.origin)).host));
  root.append(el("h1", p.op === "create" ? "Save a passkey?" : "Sign in with a passkey?"), who);
  if (notice) {
    const n = el("p", notice, "err");
    n.id = "pk-notice";
    root.append(n);
  }
  if (!p.unlocked) {
    root.append(el("p", "Unlock your vault first."), unlockForm());
    root.append(button("Use another device or security key", () => answer({ action: "native" })), button("Cancel", () => answer({ action: "cancel" })));
    return;
  }
  const mode = p.pin === "choose" ? "choose" : "enter";
  const triesLeft = Number(p.triesLeft ?? 5);
  if (p.op === "get") {
    const candidates = p.candidates as { itemId: string; credentialId: string; title: string; userName: string }[];
    let chosen = candidates[0]?.credentialId;
    if (candidates.length > 1) {
      const list = el("div", "", "list");
      candidates.forEach((c, i) => {
        const label = el("label");
        const radio = el("input") as HTMLInputElement;
        radio.type = "radio";
        radio.name = "passkey";
        radio.value = c.credentialId;
        radio.checked = i === 0;
        radio.addEventListener("change", () => {
          chosen = c.credentialId;
          pinInput?.focus();
        });
        label.append(radio, ` ${c.title}: ${c.userName}`);
        list.append(label);
      });
      root.append(list);
    } else if (candidates[0]) {
      root.append(el("p", `As ${candidates[0].title}: ${candidates[0].userName}`));
    }
    const form = pinForm(mode, triesLeft, (pin) => {
      if (chosen) void answer({ action: "use", credentialId: chosen, ...pin });
    });
    root.append(form);
    if (candidates.length) root.append(button("Sign in", () => form.requestSubmit(), true));
  } else {
    const user = p.user as { name: string };
    root.append(el("p", `For ${user.name} on ${p.rpId}`));
    if (p.alreadySaved) {
      root.append(el("p", "You already have a passkey for this account here."));
      root.append(button("Tell the site", () => answer({ action: "create" }), true));
    } else {
      // Enter saves it the first way offered.
      let attach = !!p.existing;
      const form = pinForm(mode, triesLeft, (pin) => void answer({ action: "create", ...(attach ? { attach: true } : {}), ...pin }));
      root.append(form);
      if (p.existing) {
        root.append(
          button(
            `Add it to "${p.existing}"`,
            () => {
              attach = true;
              form.requestSubmit();
            },
            true,
          ),
        );
      }
      root.append(
        button(
          "Save as a new item",
          () => {
            attach = false;
            form.requestSubmit();
          },
          !p.existing,
        ),
      );
    }
  }
  root.append(button("Use another device or security key", () => answer({ action: "native" })), button("Cancel", () => answer({ action: "cancel" })));
  (pinInput as HTMLInputElement | null)?.focus();
}

void render();
