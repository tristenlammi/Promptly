// The Ctrl+Shift+Space window. It only ever sees titles and usernames: it says which item and
// what to do, and the main page and Rust do the rest.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Result = { id: string; title: string; subtitle: string; kind: string; has_totp: boolean; can_type: boolean; reprompt: boolean };

const input = document.getElementById("q") as HTMLInputElement;
const list = document.getElementById("results") as HTMLUListElement;
const feedback = document.getElementById("feedback") as HTMLParagraphElement;
const targetLine = document.getElementById("target") as HTMLParagraphElement;

let token: string | null = null;
let results: Result[] = [];
let at = 0;
let req = 0;
let locked = false;
let pending: { id: string; action: string } | null = null;

function render() {
  list.textContent = "";
  results.forEach((r, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === at));
    li.dataset.id = r.id;
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = r.title || "(no name)";
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = r.subtitle;
    li.append(title, sub);
    li.addEventListener("click", () => {
      at = i;
      act("copy");
    });
    list.append(li);
  });
  list.children[at]?.scrollIntoView({ block: "nearest" });
}

function search() {
  invoke("overlay_search", { req: ++req, q: input.value }).catch(show);
}

function show(message: unknown) {
  feedback.textContent = String(message);
}

function act(action: string, confirmed = false) {
  if (locked) {
    invoke("overlay_open_main").catch(show);
    return;
  }
  const r = results[at];
  if (!r || !token) return;
  feedback.textContent = "";
  pending = confirmed ? null : { id: r.id, action };
  invoke("overlay_act", { token, id: r.id, action, confirmed }).catch(show);
}

input.addEventListener("input", () => {
  at = 0;
  pending = null;
  search();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    invoke("overlay_close").catch(show);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    at = Math.min(at + 1, results.length - 1);
    render();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    at = Math.max(at - 1, 0);
    render();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (e.repeat) return;
    const askedToConfirm = feedback.dataset.confirm === "1";
    if (askedToConfirm && pending) {
      feedback.dataset.confirm = "";
      act(pending.action, true);
      return;
    }
    if (e.ctrlKey) act("type");
    else if (e.shiftKey) act("copy-user");
    else if (e.altKey) act("totp");
    else act("copy");
  }
});

listen<{ token: string; target_title: string | null }>("quick:open", ({ payload }) => {
  token = payload.token;
  targetLine.textContent = payload.target_title ? `Typing goes to: ${payload.target_title}` : "";
  input.value = "";
  feedback.textContent = "";
  feedback.dataset.confirm = "";
  pending = null;
  at = 0;
  input.focus();
  search();
});

listen<{ req: number; results: Result[]; locked: boolean }>("quick:results", ({ payload }) => {
  if (payload.req !== req) return;
  results = payload.results;
  locked = payload.locked;
  if (locked) feedback.textContent = "Your vault is locked. Press Enter to open it.";
  else if (!feedback.dataset.confirm) feedback.textContent = "";
  render();
});

listen<{ message: string | null; mismatch: { window: string; item: string } | null }>("quick:feedback", ({ payload }) => {
  if (payload.mismatch) {
    feedback.dataset.confirm = "1";
    feedback.textContent = `This window is "${payload.mismatch.window}", but the item is "${payload.mismatch.item}". Press Enter to type anyway, or Esc to stop.`;
  } else {
    feedback.dataset.confirm = "";
    feedback.textContent = payload.message ?? "";
  }
});

listen("quick:closed", () => {
  token = null;
  results = [];
  input.value = "";
  feedback.textContent = "";
  feedback.dataset.confirm = "";
  targetLine.textContent = "";
  pending = null;
  render();
});
