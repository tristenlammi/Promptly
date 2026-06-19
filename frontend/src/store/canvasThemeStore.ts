import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CanvasTheme = "light" | "dark";

interface CanvasThemeState {
  theme: CanvasTheme;
  setTheme: (theme: CanvasTheme) => void;
}

/**
 * The workspace canvas's light/dark preference — deliberately *separate*
 * from the app-wide theme (``themeStore``). The canvas defaults to a white
 * (light) background regardless of the app being in dark mode, because a
 * whiteboard reads best on white; users who prefer dark can flip it via
 * Excalidraw's own theme toggle and the choice sticks.
 *
 * Persisted to ``localStorage`` (per-user, per-device — same mechanism as
 * the app theme). A true cross-device "saved to profile" setting would
 * live in the backend user settings; that's a possible follow-up.
 */
export const useCanvasThemeStore = create<CanvasThemeState>()(
  persist(
    (set) => ({
      theme: "light",
      setTheme: (theme) => set({ theme }),
    }),
    { name: "promptly.canvasTheme" }
  )
);
