import { useState } from "react";
import { Loader2, Ruler } from "lucide-react";

import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

type Units = "metric" | "imperial";
type Clock = "auto" | "12h" | "24h";

/** Account → About you → Units & time: one choice for every app. New app
 *  files start with it, and changing it here updates each app's own unit
 *  settings (Trip, Body & Health, Macros, Meal Plan, Workout) and the time
 *  format Calendar and Trip use. */
export function UnitsPanel() {
  const settings = useAuthStore((s) => s.user?.settings);
  const setUser = useAuthStore((s) => s.setUser);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const [busy, setBusy] = useState<"units" | "clock" | null>(null);

  const save = async (key: "units" | "clock", value: Units | Clock) => {
    const previous = settings?.[key];
    patchSettings({ [key]: value });
    setBusy(key);
    try {
      setUser(await authApi.updatePreferences({ [key]: value }));
    } catch (err) {
      patchSettings({ [key]: previous });
      toast.error(apiErrorMessage(err, "Couldn't save that."));
    } finally {
      setBusy(null);
    }
  };

  const segment = (key: "units" | "clock", options: [string, string][], current: string) => (
    <div role="radiogroup" className="inline-flex rounded-lg border border-[var(--border)] p-0.5">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={current === value}
          disabled={busy !== null}
          onClick={() => void save(key, value as Units & Clock)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition",
            current === value ? "bg-[var(--accent-strong)] text-white" : "text-[var(--text)] hover:bg-[var(--hover)]",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <section className="mt-4 overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <span className="flex items-center gap-2">
          <Ruler className="h-4 w-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold">Units &amp; time</h3>
        </span>
        {busy && <Loader2 className="h-3 w-3 animate-spin text-[var(--text-muted)]" />}
      </header>
      <div className="space-y-4 px-4 py-4">
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
          Used by every app — Trip, Body &amp; Health, Macros, Meal Plan and Workout start with these, and changing them
          here updates each one. You can still pick something different inside an app.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-[var(--text)]">Units</span>
          {segment("units", [["metric", "Metric (kg, cm, km, °C)"], ["imperial", "Imperial (lb, in, mi, °F)"]], settings?.units ?? "")}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-[var(--text)]">Time format</span>
          {segment("clock", [["auto", "Automatic"], ["12h", "12-hour"], ["24h", "24-hour"]], settings?.clock ?? "auto")}
        </div>
      </div>
    </section>
  );
}
