import { itemIcon } from "./itemIcons";
import type { ItemModule } from "./types";

export { itemIcon };

/**
 * Every item kind's frontend, found on its own: each
 * ``src/items/kinds/<kind>/index.tsx`` default-exports an ``ItemModule``.
 * Each is its own lazy chunk — opening a budget never downloads the
 * workout tracker.
 */
const modules = import.meta.glob<{ default: ItemModule }>("./kinds/*/index.tsx");

const byKind: Record<string, () => Promise<{ default: ItemModule }>> = {};
for (const [path, load] of Object.entries(modules)) {
  const m = path.match(/\.\/kinds\/([^/]+)\/index\.tsx$/);
  if (m) byKind[m[1]] = load;
}

export function hasModule(kind: string): boolean {
  return kind in byKind;
}

export async function loadModule(kind: string): Promise<ItemModule | null> {
  const load = byKind[kind];
  if (!load) return null;
  return (await load()).default;
}

/** The kind an item file is, from its name's suffix (``Leg day.workout``). */
export function kindFromFilename(filename: string, suffixes: Record<string, string>): string | null {
  const lower = filename.toLowerCase();
  for (const [kind, suffix] of Object.entries(suffixes)) {
    if (lower.endsWith(suffix.toLowerCase())) return kind;
  }
  return null;
}
