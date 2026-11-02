import { useQueryClient } from "@tanstack/react-query";
import { Plane, X } from "lucide-react";
import { useState } from "react";

import { authApi } from "@/api/auth";
import type { CalendarBootstrap } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";

import { BOOTSTRAP_KEY, useSetPrefs } from "../data";
import { differsFromLocal, localZone, zoneCity } from "../dates";

const KEY = "calendar:travel-dismissed";

/**
 * "Looks like you're travelling": this device's clock is on a different time
 * zone from the one saved on the account. The calendar always shows times
 * on this device's clock, so it says so, and offers to make this zone the
 * saved one or to keep home time beside the hours. Dismissed per pair of
 * zones (on this device).
 */
export function TravelNotice({ b }: { b: CalendarBootstrap }) {
  const qc = useQueryClient();
  const setPrefs = useSetPrefs();
  const here = localZone();
  // The zone saved on the account (none yet: nothing to compare with).
  const saved = useAuthStore((s) => (s.user?.settings as { timezone?: string } | undefined)?.timezone);
  const home = saved || "";
  const pair = `${here}|${home}`;
  const [gone, setGone] = useState(() => {
    try {
      return localStorage.getItem(KEY) === pair;
    } catch {
      return false;
    }
  });
  if (gone || !home || home === here || !differsFromLocal(home)) return null;
  const dismiss = () => {
    setGone(true);
    try {
      localStorage.setItem(KEY, pair);
    } catch {
      /* storage blocked */
    }
  };
  const adopt = async () => {
    try {
      const user = await authApi.updatePreferences({ timezone: here });
      useAuthStore.getState().setUser(user);
      await qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      toast.success(`Your time zone is now ${zoneCity(here)}`);
    } catch (err) {
      toast.error(extractError(err) || "Couldn't change your time zone.");
    }
  };
  const showHome = b.prefs.second_tz !== home;
  return (
    <div role="status" className="mx-3 mt-2 flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--item-accent)_8%,var(--surface))] px-3 py-2 text-sm text-[var(--text)] md:mx-4">
      <Plane className="mt-0.5 h-4 w-4 shrink-0 text-[var(--item-accent)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span>
          Looks like you're travelling. Times here are in <b>{zoneCity(here)}</b> time; your usual time zone is {zoneCity(home)}.
        </span>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <button type="button" onClick={() => void adopt()} className="font-medium text-[var(--item-accent)] hover:underline">
            Make {zoneCity(here)} my time zone
          </button>
          {showHome && (
            <button
              type="button"
              onClick={() => {
                setPrefs({ second_tz: home }).catch((err) => toast.error(extractError(err)));
                dismiss();
              }}
              className="font-medium text-[var(--item-accent)] hover:underline"
            >
              Show {zoneCity(home)} time beside the hours
            </button>
          )}
        </div>
      </div>
      <button type="button" aria-label="Dismiss" onClick={dismiss} className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
