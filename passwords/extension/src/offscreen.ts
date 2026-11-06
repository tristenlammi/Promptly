// Chromium only. A service worker has no document, so it can't touch the clipboard. This
// page exists for a moment to do it, on the background's word, and then it's closed.
// An offscreen page can't take focus, so it uses execCommand rather than navigator.clipboard.
import { ext } from "./rpc";

function write(text: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  try {
    return document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}

/** Only works if the person turned on the clipboardRead permission. */
function read(): string | null {
  let text: string | null = null;
  const onPaste = (e: ClipboardEvent) => {
    text = e.clipboardData?.getData("text/plain") ?? null;
    e.preventDefault();
  };
  document.addEventListener("paste", onPaste);
  const box = document.createElement("textarea");
  document.body.appendChild(box);
  box.focus();
  try {
    document.execCommand("paste");
    return text;
  } finally {
    document.removeEventListener("paste", onPaste);
    box.remove();
  }
}

ext.runtime.onMessage.addListener((m: { t?: string; op?: string; text?: string }, sender, reply) => {
  if (sender.id !== ext.runtime.id || m?.t !== "offscreenClip") return false;
  reply(m.op === "read" ? { text: read() } : { ok: write(m.text ?? "") });
  return false;
});
