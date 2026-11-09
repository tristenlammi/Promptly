// The sidebar's count badges: what the little terracotta circle says and
// what a screen reader hears. Pure, so the vault's own nav (no main-app
// code) and the main sidebar say the same thing.

/** The number as shown: nothing for 0, "99+" past 99. */
export function badgeText(n: number | null | undefined): string {
  const v = Math.floor(Number(n) || 0);
  if (v <= 0) return "";
  return v > 99 ? "99+" : String(v);
}

/** Each row's words for its number ("3 unread"). */
const WORDS: Record<string, string> = {
  tasks: "due",
  mail: "unread",
  rooms: "unread",
  porch: "new",
};

/** What a screen reader hears for a row's badge, e.g. "3 unread". Empty for 0. */
export function badgeLabel(app: string, n: number | null | undefined): string {
  const v = Math.floor(Number(n) || 0);
  if (v <= 0) return "";
  return `${v} ${WORDS[app] ?? "new"}`;
}
