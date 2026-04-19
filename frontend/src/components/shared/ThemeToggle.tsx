import { useEffect } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { applyTheme, useThemeStore, type Theme } from "@/store/themeStore";
import { cn } from "@/utils/cn";

const OPTIONS: Array<{ value: Theme; icon: typeof Sun; label: string }> = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
];

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  useEffect(() => {
    applyTheme();
  }, [theme]);

  // Also re-apply when the OS preference changes (if user picked "system").
  useEffect(() => {
    if (theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [theme]);

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-input border border-[var(--border)] p-0.5"
      role="tablist"
      aria-label="Colour theme"
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => setTheme(opt.value)}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-full transition",
              active
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
