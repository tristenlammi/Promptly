import { createContext, useCallback, useContext, type ReactNode } from "react";

/** Where Photos lives: ``/files/photos`` inside Files, ``/photos`` in the
 *  standalone Promptly Photos app. The same pages render in both, so every
 *  link inside Photos is built from this base, never hard-coded. Links that
 *  leave Photos (to Files, to Import) stay absolute. */
export const FILES_PHOTOS_BASE = "/files/photos";
export const APP_PHOTOS_BASE = "/photos";

const PhotosBaseContext = createContext<string>(FILES_PHOTOS_BASE);

export function PhotosBaseProvider({ base, children }: { base: string; children: ReactNode }) {
  return <PhotosBaseContext.Provider value={base}>{children}</PhotosBaseContext.Provider>;
}

/** The current Photos base, e.g. ``/photos``. */
export function usePhotosBase(): string {
  return useContext(PhotosBaseContext);
}

/** Join a Photos base with a sub-path: ``"/albums/1"``, ``"?view=x"`` or ``""``.
 *  The standalone app's timeline is ``/photos/`` (with the slash): its
 *  manifest scope is ``/photos/``, and ``/photos`` alone would fall outside
 *  it — an installed app would then show the "left the app" URL bar. */
export function joinPhotosPath(base: string, sub = ""): string {
  const root = base === APP_PHOTOS_BASE ? `${base}/` : base;
  if (!sub) return root;
  if (sub.startsWith("?") || sub.startsWith("#")) return root + sub;
  return base + (sub.startsWith("/") ? sub : `/${sub}`);
}

/** ``const p = usePhotosPath(); p("/albums")`` → ``/photos/albums`` in the app,
 *  ``/files/photos/albums`` inside Files. */
export function usePhotosPath(): (sub?: string) => string {
  const base = usePhotosBase();
  return useCallback((sub = "") => joinPhotosPath(base, sub), [base]);
}
