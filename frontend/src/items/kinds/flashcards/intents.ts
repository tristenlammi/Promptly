/*
 * Hand-offs between tabs ("Study this deck", "Browse this deck", the header's
 * "Add card"): the next tab to mount reads and clears them, and a tab that's
 * already showing is told through ``onIntent``. Module state, so they live
 * only for this page.
 */
export const intents: {
  study: { deck: string | null } | null;
  cram: { deck: string | null } | null;
  browse: { query: string } | null;
  add: { deck?: string } | null;
} = { study: null, cram: null, browse: null, add: null };

type Key = keyof typeof intents;
const listeners = new Set<(k: Key) => void>();

export function take<K extends Key>(k: K): (typeof intents)[K] {
  const v = intents[k];
  intents[k] = null;
  return v;
}

/** Leave an intent and tell mounted tabs (they ``take`` it if it's theirs).
 *  True when a mounted tab took it. */
export function request<K extends Key>(k: K, v: NonNullable<(typeof intents)[K]>): boolean {
  intents[k] = v as (typeof intents)[K];
  for (const fn of [...listeners]) fn(k);
  return intents[k] === null;
}

export function onIntent(fn: (k: Key) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
