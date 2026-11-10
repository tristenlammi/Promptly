/**
 * What you've typed but not sent, per room. Kept on this device so a
 * half-written message is still there after a reload; nothing is sent
 * anywhere. Storage can be missing or full (private windows), so every
 * read and write is allowed to fail quietly and the in-memory copy carries on.
 */
const MAX_ROOMS = 50;
const mem = new Map<string, Record<string, string>>();

const keyFor = (meId: string) => `promptly:rooms:drafts:${meId}`;

function load(meId: string): Record<string, string> {
  const have = mem.get(meId);
  if (have) return have;
  let all: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(keyFor(meId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string" && v) all[k] = v;
    }
  } catch {
    all = {};
  }
  mem.set(meId, all);
  return all;
}

function persist(meId: string, all: Record<string, string>) {
  try {
    const keys = Object.keys(all);
    if (keys.length === 0) localStorage.removeItem(keyFor(meId));
    else localStorage.setItem(keyFor(meId), JSON.stringify(all));
  } catch {
    /* in memory only */
  }
}

export function getDraft(meId: string, roomId: string): string {
  return load(meId)[roomId] ?? "";
}

export function setDraft(meId: string, roomId: string, text: string) {
  const all = load(meId);
  if ((all[roomId] ?? "") === text) return;
  // Re-insert so the newest draft is last; the oldest fall off the front.
  delete all[roomId];
  if (text) all[roomId] = text.slice(0, 8000);
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ROOMS))) delete all[k];
  persist(meId, all);
}

export function clearDraft(meId: string, roomId: string) {
  setDraft(meId, roomId, "");
}
