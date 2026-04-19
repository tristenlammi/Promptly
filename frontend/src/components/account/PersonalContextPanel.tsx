import { useEffect, useMemo, useState } from "react";
import { Loader2, MapPin, RotateCcw } from "lucide-react";

import { authApi } from "@/api/auth";
import { Button } from "@/components/shared/Button";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

/** Self-service panel for the per-user "personal context" the chat
 * system prompt silently injects every turn (location + timezone).
 *
 * The point of this panel — and the prompt block it drives — is to
 * make the AI just *know* the user is on the Sunshine Coast without
 * the user having to retell it, and without the AI loudly thanking
 * them for sharing it. The backend phrasing handles the "stay quiet
 * about it" half; this UI handles the "tell us once, never think
 * about it again" half.
 *
 * Storage is the same ``users.settings`` JSONB column used by the
 * other chat preferences. Submitting an empty value clears the
 * field server-side rather than persisting an empty string.
 */
export function PersonalContextPanel() {
  const user = useAuthStore((s) => s.user);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);

  // Pull the cached values into local state so the inputs stay
  // controlled and the user can type freely without round-tripping
  // every keystroke. Saved on blur / explicit submit.
  const [location, setLocation] = useState<string>(
    typeof user?.settings?.location === "string" ? user.settings.location : ""
  );
  const [timezone, setTimezone] = useState<string>(
    typeof user?.settings?.timezone === "string" ? user.settings.timezone : ""
  );
  const [busy, setBusy] = useState<"location" | "timezone" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the cached user changes (e.g. /me refresh from
  // another tab).
  useEffect(() => {
    if (!user?.settings) return;
    if (typeof user.settings.location === "string") {
      setLocation(user.settings.location);
    }
    if (typeof user.settings.timezone === "string") {
      setTimezone(user.settings.timezone);
    }
  }, [user?.settings]);

  // Browser-detected zone — used as the initial default when the
  // user hasn't picked one yet, and exposed as a "Use my computer's
  // timezone" shortcut button. Falls back to UTC if Intl can't tell
  // us (effectively never on modern browsers).
  const detectedZone = useMemo<string>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  // Best-effort full IANA list. ``supportedValuesOf`` ships in every
  // current Chromium / Firefox / Safari but TS doesn't know about it
  // yet — fall back to a curated short list so the dropdown still
  // works on older runtimes.
  const zones = useMemo<string[]>(() => {
    try {
      const fn = (
        Intl as unknown as {
          supportedValuesOf?: (key: string) => string[];
        }
      ).supportedValuesOf;
      if (typeof fn === "function") {
        const list = fn("timeZone");
        if (Array.isArray(list) && list.length > 10) return list;
      }
    } catch {
      // fall through
    }
    return FALLBACK_ZONES;
  }, []);

  // Generic preference-PATCH helper. The auth router treats an
  // empty string as "remove this key" so we can route both Save
  // and Reset through the same path.
  async function persist(
    key: "location" | "timezone",
    value: string,
    busyKey: "location" | "timezone"
  ) {
    setError(null);
    setBusy(busyKey);
    const previous = user?.settings?.[key];
    patchSettings({ [key]: value });
    try {
      const fresh = await authApi.updatePreferences({ [key]: value });
      setUser(fresh);
    } catch (err) {
      patchSettings({ [key]: previous as never });
      if (busyKey === "location") {
        setLocation(typeof previous === "string" ? previous : "");
      } else {
        setTimezone(typeof previous === "string" ? previous : "");
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const trimmedLocation = location.trim();
  const trimmedTimezone = timezone.trim();
  const savedLocation =
    typeof user?.settings?.location === "string"
      ? user.settings.location
      : "";
  const savedTimezone =
    typeof user?.settings?.timezone === "string"
      ? user.settings.timezone
      : "";
  const locationDirty = trimmedLocation !== savedLocation;
  const timezoneDirty = trimmedTimezone !== savedTimezone;

  // Live preview of what the AI will silently see this turn. Mirrors
  // the backend formatter in ``app/chat/personal_context.py`` closely
  // enough that what the user reads here matches what the model gets.
  const preview = useMemo(() => {
    const tz = trimmedTimezone || null;
    const loc = trimmedLocation;
    if (!tz && !loc) return null;
    let dateLine = "";
    let timeLine = "";
    if (tz) {
      try {
        const now = new Date();
        dateLine = new Intl.DateTimeFormat(undefined, {
          weekday: "long",
          day: "2-digit",
          month: "long",
          year: "numeric",
          timeZone: tz,
        }).format(now);
        timeLine = new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZone: tz,
          timeZoneName: "short",
        }).format(now);
      } catch {
        // Invalid timezone — leave the lines blank, the dropdown
        // will already show the validation hint via the server.
      }
    }
    return { dateLine, timeLine, location: loc, timezone: tz };
  }, [trimmedLocation, trimmedTimezone]);

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">
            <MapPin className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold">Personal context</h3>
        </div>
        {busy && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving
          </span>
        )}
      </header>

      <div className="space-y-5 px-4 py-4">
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
          Tell the assistant where and when you are, once. It'll silently
          factor in your local date, time, and region on every reply —
          no need to repeat it in chat, and the AI won't make a fuss
          about knowing.
        </p>

        {/* ---- Location ---- */}
        <div className="space-y-1.5">
          <label
            htmlFor="pc-location"
            className="block text-xs font-semibold text-[var(--text)]"
          >
            Location
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="pc-location"
              type="text"
              value={location}
              maxLength={120}
              onChange={(e) => setLocation(e.target.value)}
              onBlur={() => {
                if (locationDirty) {
                  void persist("location", trimmedLocation, "location");
                }
              }}
              placeholder="e.g. Sunshine Coast, QLD, Australia"
              className={cn(
                "min-w-[220px] flex-1 rounded-input border bg-[var(--bg)] px-3 py-2 text-sm",
                "border-[var(--border)] text-[var(--text)]",
                "placeholder:text-[var(--text-muted)]",
                "focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              )}
            />
            {savedLocation && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setLocation("");
                  void persist("location", "", "location");
                }}
                disabled={busy === "location"}
                className="text-xs"
              >
                <RotateCcw className="mr-1 h-3 w-3" />
                Clear
              </Button>
            )}
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            Free-form. City + region + country reads best, but anything
            short works.
          </p>
        </div>

        {/* ---- Timezone ---- */}
        <div className="space-y-1.5">
          <label
            htmlFor="pc-timezone"
            className="block text-xs font-semibold text-[var(--text)]"
          >
            Timezone
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="pc-timezone"
              value={timezone}
              onChange={(e) => {
                const next = e.target.value;
                setTimezone(next);
                void persist("timezone", next, "timezone");
              }}
              disabled={busy === "timezone"}
              className={cn(
                "min-w-[220px] flex-1 rounded-input border bg-[var(--bg)] px-3 py-2 text-sm",
                "border-[var(--border)] text-[var(--text)]",
                "focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]",
                "disabled:cursor-not-allowed disabled:opacity-60"
              )}
            >
              <option value="">— Not set —</option>
              {/* Surface the detected zone at the top so it's a
                  one-click pick for the common case. */}
              {detectedZone && !zones.includes(detectedZone) && (
                <option value={detectedZone}>
                  {detectedZone} (detected)
                </option>
              )}
              {zones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                  {tz === detectedZone ? " (detected)" : ""}
                </option>
              ))}
            </select>
            {detectedZone && timezone !== detectedZone && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTimezone(detectedZone);
                  void persist("timezone", detectedZone, "timezone");
                }}
                disabled={busy === "timezone"}
                className="text-xs"
                title={`Use this computer's timezone (${detectedZone})`}
              >
                Use detected
              </Button>
            )}
            {savedTimezone && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTimezone("");
                  void persist("timezone", "", "timezone");
                }}
                disabled={busy === "timezone"}
                className="text-xs"
              >
                <RotateCcw className="mr-1 h-3 w-3" />
                Clear
              </Button>
            )}
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            We pre-fill with your browser's timezone ({detectedZone}).
            Pick a different one if you want the AI to think in another
            timezone.
          </p>
        </div>

        {/* ---- Live preview ---- */}
        {preview && (
          <div
            className={cn(
              "rounded-input border border-dashed border-[var(--border)] bg-black/[0.02] px-3 py-2.5 text-xs",
              "dark:bg-white/[0.03]"
            )}
          >
            <p className="mb-1.5 font-semibold text-[var(--text-muted)]">
              What the AI will silently know:
            </p>
            <ul className="space-y-0.5 text-[var(--text)]">
              {preview.dateLine && <li>Today: {preview.dateLine}</li>}
              {preview.timeLine && (
                <li>
                  Local time: {preview.timeLine}
                  {preview.timezone ? ` (${preview.timezone})` : ""}
                </li>
              )}
              {preview.location && <li>Location: {preview.location}</li>}
            </ul>
          </div>
        )}

        {timezoneDirty && busy !== "timezone" && (
          <p className="text-[11px] text-[var(--text-muted)]">
            Timezone changes save instantly when you pick from the menu.
          </p>
        )}

        {locationDirty && busy !== "location" && (
          <p className="text-[11px] text-[var(--text-muted)]">
            Location saves when the field loses focus.
          </p>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-input border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            Failed to save: {error}
            <Button
              size="sm"
              variant="ghost"
              className="ml-2"
              onClick={() => setError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

// Curated fallback for browsers without ``Intl.supportedValuesOf``.
// Covers the major regions our user base is likely to span without
// turning into a 400-entry monstrosity. Anyone outside this list can
// still type their zone via the location field — the dropdown is
// just a nice-to-have for the common case.
const FALLBACK_ZONES: string[] = [
  "UTC",
  "Australia/Brisbane",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Perth",
  "Australia/Adelaide",
  "Pacific/Auckland",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "America/Buenos_Aires",
];
