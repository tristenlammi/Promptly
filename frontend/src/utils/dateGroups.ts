/**
 * Group conversations into Claude.ai-style date buckets for the sidebar:
 * Today, Yesterday, Previous 7 Days, Previous 30 Days, Older.
 */
export type DateBucket =
  | "Today"
  | "Yesterday"
  | "Previous 7 Days"
  | "Previous 30 Days"
  | "Older";

export const BUCKET_ORDER: DateBucket[] = [
  "Today",
  "Yesterday",
  "Previous 7 Days",
  "Previous 30 Days",
  "Older",
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function bucketFor(timestamp: string | Date): DateBucket {
  const date = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "Previous 7 Days";
  if (diffDays <= 30) return "Previous 30 Days";
  return "Older";
}

export function groupByBucket<T extends { updated_at: string }>(
  items: T[]
): Map<DateBucket, T[]> {
  const groups = new Map<DateBucket, T[]>();
  for (const item of items) {
    const bucket = bucketFor(item.updated_at);
    const list = groups.get(bucket) ?? [];
    list.push(item);
    groups.set(bucket, list);
  }
  return groups;
}
