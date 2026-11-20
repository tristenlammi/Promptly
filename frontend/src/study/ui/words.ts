import type { StudyStats } from "@/api/study";

/* Small pieces of wording shared by the Study pages. Pure, so they are tested directly. */

/** Days studied, said plainly. Nothing here is lost by missing a day. */
export function statsWords(s: StudyStats): string | null {
  if (s.total === 0) return null;
  const parts: string[] = [];
  if (s.streak >= 2) parts.push(`${s.streak} days in a row`);
  parts.push(s.week === 0 ? "Not yet this week" : `${s.week} ${s.week === 1 ? "day" : "days"} this week`);
  if (s.today) parts.push("including today");
  return parts.join(" · ");
}

/** "tomorrow", "in 5 days", "in about 3 weeks": when a review comes back. */
export function reviewWhen(iso: string, now: Date = new Date()): string {
  const days = Math.max(1, Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000));
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in about ${Math.round(days / 7)} weeks`;
  return `in about ${Math.round(days / 30)} months`;
}
