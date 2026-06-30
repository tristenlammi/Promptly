import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CanvasTheme = "light" | "dark";

interface CanvasThemeState {
  theme: CanvasTheme;
  /**
   * True once the user has flipped Excalidraw's *own* theme toggle, diverging
   * from the app theme. While false, the canvas follows the app theme; once
   * true, the user's manual choice sticks and persists across sessions.
   */
  overridden: boolean;
  /** Follow the app theme (only takes effect while not overridden). */
  followApp: (theme: CanvasTheme) => void;
  /**
   * User flipped Excalidraw's toggle. Diverging from the app theme sets the
   * sticky override; choosing the app theme again clears it (resume following).
   */
  setManual: (chosen: CanvasTheme, appTheme: CanvasTheme) => void;
}

/**
 * The workspace canvas's light/dark preference.
 *
 * Default behaviour: the board **follows the app theme** — switch the app to
 * dark and the whiteboard goes dark with it, so it never sits as a bright
 * island in a dark UI. If the user prefers a different look they can flip
 * Excalidraw's own theme toggle inside the board; that manual choice is then
 * remembered (``overridden``) and persists across sessions, and the canvas
 * stops auto-following until they clear it by matching the app theme again.
 *
 * Persisted to ``localStorage`` (per-user, per-device — same mechanism as the
 * app theme). A true cross-device "saved to profile" setting would live in the
 * backend user settings; that's a possible follow-up.
 */
export const useCanvasThemeStore = create<CanvasThemeState>()(
  persist(
    (set) => ({
      theme: "light",
      overridden: false,
      followApp: (theme) =>
        set((s) => (s.overridden ? s : { theme })),
      setManual: (chosen, appTheme) =>
        // Re-syncing to the app theme clears the override so the board resumes
        // following; diverging from it sets the sticky override.
        set(
          chosen === appTheme
            ? { theme: chosen, overridden: false }
            : { theme: chosen, overridden: true }
        ),
    }),
    { name: "promptly.canvasTheme" }
  )
);
