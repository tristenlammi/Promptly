import { lazy, type ComponentType } from "react";

/** Heuristic: does this error look like a stale code-split chunk that no
 *  longer exists on the server (i.e. the app was redeployed under an open
 *  tab)? Covers the wording used by Chrome/Vite, Firefox, and Safari. */
export function isChunkLoadError(err: unknown): boolean {
  const msg =
    err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  return (
    /failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg)
  );
}

/**
 * ``React.lazy`` that survives stale chunk references after a redeploy.
 *
 * When the server ships a new build, the old hashed chunk filenames a
 * still-open tab points at stop existing — the dynamic import then throws
 * "Failed to fetch dynamically imported module". We treat that as "the app
 * updated under me" and do a one-time hard reload to pull the fresh
 * index.html + chunk map, which transparently recovers the navigation.
 *
 * A ``sessionStorage`` guard keyed to the chunk stops a genuinely-broken
 * chunk (or an offline user) from looping reloads forever — after one failed
 * auto-reload we let the error propagate to the boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  key: string
) {
  return lazy(async () => {
    const flag = `chunk-reload:${key}`;
    try {
      const mod = await factory();
      sessionStorage.removeItem(flag);
      return mod;
    } catch (err) {
      if (isChunkLoadError(err) && !sessionStorage.getItem(flag)) {
        sessionStorage.setItem(flag, "1");
        window.location.reload();
        // Never resolve, so React keeps the Suspense fallback up instead of
        // flashing the error boundary in the instant before the reload.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}
