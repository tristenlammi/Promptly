import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark" | "system";

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** Resolves "system" to the currently-preferred OS theme. */
  resolved: () => "light" | "dark";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      setTheme: (theme) => set({ theme }),
      resolved: () => {
        const t = get().theme;
        if (t === "system") return systemPrefersDark() ? "dark" : "light";
        return t;
      },
    }),
    { name: "promptly.theme" }
  )
);

/** Apply the resolved theme to <html>. Call on app mount and on theme change. */
export function applyTheme(): void {
  const resolved = useThemeStore.getState().resolved();
  const root = document.documentElement;
  if (resolved === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}
