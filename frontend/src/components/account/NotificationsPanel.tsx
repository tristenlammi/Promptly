import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BellOff,
  BellRing,
  Check,
  Loader2,
  Smartphone,
  Trash2,
} from "lucide-react";

import {
  notificationsApi,
  type NotificationPreferences,
  type SubscriptionSummary,
} from "@/api/notifications";
import { Button } from "@/components/shared/Button";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { cn } from "@/utils/cn";

/** Account -> Notifications. Two stacked blocks:
 *
 *  1. **This device** — subscribe / unsubscribe the current browser
 *     from push. Handles permission prompts and the "server not
 *     configured" edge case. A diagnostic "Send test" button lives
 *     here too.
 *  2. **Categories** — the per-event toggles. Flipping a toggle
 *     PATCHes the backend immediately; optimistic UI with a tiny
 *     spinner on the row that's still in flight.
 *  3. **Other devices** — the rest of the user's subscribed
 *     browsers. Each row is individually unsubscribe-able.
 */
export function NotificationsPanel() {
  const push = usePushSubscription();

  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [prefsBusy, setPrefsBusy] = useState<
    keyof NotificationPreferences | null
  >(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);

  const [subs, setSubs] = useState<SubscriptionSummary[] | null>(null);
  const [subsError, setSubsError] = useState<string | null>(null);

  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  useEffect(() => {
    if (!push.serverConfigured) return;
    void (async () => {
      try {
        const [p, s] = await Promise.all([
          notificationsApi.getPreferences(),
          notificationsApi.listSubscriptions(),
        ]);
        setPrefs(p);
        setSubs(s);
      } catch (e) {
        setSubsError((e as Error)?.message ?? "Couldn't load preferences.");
      }
    })();
  }, [push.serverConfigured, push.subscribed]);

  async function toggle(key: keyof NotificationPreferences, next: boolean) {
    if (!prefs) return;
    const previous = prefs[key];
    setPrefsError(null);
    setPrefs({ ...prefs, [key]: next });
    setPrefsBusy(key);
    try {
      const fresh = await notificationsApi.updatePreferences({ [key]: next });
      setPrefs(fresh);
    } catch (e) {
      setPrefs((p) => (p ? { ...p, [key]: previous } : p));
      setPrefsError(
        (e as Error)?.message ?? "Couldn't update preference."
      );
    } finally {
      setPrefsBusy(null);
    }
  }

  async function sendTest() {
    setTestStatus(null);
    setTestBusy(true);
    try {
      const sent = await notificationsApi.sendTest();
      setTestStatus(
        sent === 0
          ? "No active subscriptions to send to."
          : `Sent to ${sent} device${sent === 1 ? "" : "s"}.`
      );
    } catch (e) {
      setTestStatus((e as Error)?.message ?? "Test failed.");
    } finally {
      setTestBusy(false);
    }
  }

  async function renameSubscription(id: string, label: string) {
    try {
      const fresh = await notificationsApi.renameSubscription(
        id,
        label.trim() || null
      );
      setSubs((list) => list?.map((s) => (s.id === id ? fresh : s)) ?? null);
    } catch (e) {
      setSubsError((e as Error)?.message ?? "Couldn't rename device.");
    }
  }

  async function removeSubscription(id: string) {
    try {
      await notificationsApi.deleteSubscription(id);
      setSubs((list) => list?.filter((s) => s.id !== id) ?? null);
    } catch (e) {
      setSubsError((e as Error)?.message ?? "Couldn't remove device.");
    }
  }

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <header className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent)]">
          <BellRing className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Get a native PWA notification when long-running tasks finish
            — exam grading, PDF exports, bulk imports, or a shared
            conversation update.
          </p>
        </div>
      </header>

      {/* -- Server not configured -- */}
      {push.serverConfigured === false && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Push notifications aren't configured on this server. Ask your
            admin to run <code>python backend/scripts/generate_vapid_keys.py</code> and add the keys to <code>.env</code>.
          </span>
        </div>
      )}

      {/* -- Browser unsupported -- */}
      {push.supported === false && push.serverConfigured !== false && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs text-[var(--text-muted)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This browser doesn't support Web Push. Try Chrome, Edge,
            Firefox, or install Promptly as a PWA on your home screen.
          </span>
        </div>
      )}

      {/* -- This device -- */}
      {push.supported && push.serverConfigured && (
        <>
          <div className="mb-4 rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Smartphone className="h-4 w-4 text-[var(--text-muted)]" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    This device
                  </div>
                  <div className="truncate text-[11px] text-[var(--text-muted)]">
                    {push.subscribed
                      ? "Subscribed — you'll receive push notifications here."
                      : push.permission === "denied"
                      ? "Notifications are blocked in your browser settings."
                      : "Not subscribed yet."}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {push.subscribed ? (
                  <>
                    <Button
                      variant="ghost"
                      onClick={sendTest}
                      disabled={testBusy}
                      leftIcon={
                        testBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )
                      }
                    >
                      Send test
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={push.unsubscribe}
                      leftIcon={<BellOff className="h-3.5 w-3.5" />}
                    >
                      Unsubscribe
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    onClick={push.subscribe}
                    disabled={push.loading || push.permission === "denied"}
                    leftIcon={<BellRing className="h-3.5 w-3.5" />}
                  >
                    Subscribe
                  </Button>
                )}
              </div>
            </div>
            {testStatus && (
              <div className="mt-2 text-[11px] text-[var(--text-muted)]">
                {testStatus}
              </div>
            )}
            {push.error && (
              <div className="mt-2 text-[11px] text-red-600 dark:text-red-400">
                {push.error}
              </div>
            )}
          </div>

          {/* -- Category toggles -- */}
          {prefs && (
            <div className="mb-4 overflow-hidden rounded-md border border-[var(--border)]">
              <CategoryRow
                title="Master switch"
                subtitle="Disable this to silence all pushes without losing your category preferences."
                checked={prefs.enabled}
                busy={prefsBusy === "enabled"}
                onChange={(v) => toggle("enabled", v)}
              />
              <div className="h-px bg-[var(--border)]" />
              <CategoryRow
                title="Study results"
                subtitle="Exam graded, unit complete, or a prerequisite unit was inserted."
                checked={prefs.study_graded}
                busy={prefsBusy === "study_graded"}
                onChange={(v) => toggle("study_graded", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Exports ready"
                subtitle="PDFs or conversation exports finished rendering."
                checked={prefs.export_ready}
                busy={prefsBusy === "export_ready"}
                onChange={(v) => toggle("export_ready", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Imports complete"
                subtitle="Bulk conversation imports finished parsing and were stored."
                checked={prefs.import_done}
                busy={prefsBusy === "import_done"}
                onChange={(v) => toggle("import_done", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Shared conversations"
                subtitle="Someone replied in a conversation shared with you."
                checked={prefs.shared_message}
                busy={prefsBusy === "shared_message"}
                onChange={(v) => toggle("shared_message", v)}
                dimmed={!prefs.enabled}
              />
            </div>
          )}
          {prefsError && (
            <div className="mb-3 text-[11px] text-red-600 dark:text-red-400">
              {prefsError}
            </div>
          )}

          {/* -- Device list -- */}
          {subs && subs.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-[var(--text-muted)]">
                Devices
              </div>
              <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                {subs.map((s) => (
                  <DeviceRow
                    key={s.id}
                    summary={s}
                    onRename={(label) => renameSubscription(s.id, label)}
                    onDelete={() => removeSubscription(s.id)}
                  />
                ))}
              </ul>
            </div>
          )}
          {subsError && (
            <div className="mt-3 text-[11px] text-red-600 dark:text-red-400">
              {subsError}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CategoryRow({
  title,
  subtitle,
  checked,
  busy,
  onChange,
  dimmed,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  busy?: boolean;
  onChange: (v: boolean) => void;
  dimmed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-2.5",
        dimmed && "opacity-60"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && (
          <div className="text-[11px] text-[var(--text-muted)]">{subtitle}</div>
        )}
      </div>
      <label className="relative inline-flex cursor-pointer items-center">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={busy}
          onChange={(e) => onChange(e.target.checked)}
        />
        <div className="h-5 w-9 rounded-full bg-[var(--border)] transition peer-checked:bg-[var(--accent)]" />
        <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
        {busy && (
          <Loader2 className="ml-2 h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
        )}
      </label>
    </div>
  );
}

function DeviceRow({
  summary,
  onRename,
  onDelete,
}: {
  summary: SubscriptionSummary;
  onRename: (label: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary.label ?? inferLabel(summary));

  const label = summary.label ?? inferLabel(summary);
  const subtitle = [
    summary.user_agent ? truncate(summary.user_agent, 48) : null,
    summary.last_used_at
      ? `Last used ${new Date(summary.last_used_at).toLocaleDateString()}`
      : "Never used",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              onRename(draft);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRename(draft);
                setEditing(false);
              }
              if (e.key === "Escape") {
                setDraft(summary.label ?? inferLabel(summary));
                setEditing(false);
              }
            }}
            className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="w-full truncate text-left font-medium hover:underline"
          >
            {label}
          </button>
        )}
        <div className="truncate text-[11px] text-[var(--text-muted)]">
          {subtitle}
        </div>
      </div>
      <button
        onClick={onDelete}
        className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--background)] hover:text-red-500"
        aria-label="Remove device"
        title="Remove device"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function inferLabel(s: SubscriptionSummary): string {
  const ua = s.user_agent ?? "";
  if (/iPhone|iPad/i.test(ua)) return "iOS device";
  if (/Android/i.test(ua)) return "Android device";
  if (/Edg\//i.test(ua)) return "Edge browser";
  if (/Firefox/i.test(ua)) return "Firefox browser";
  if (/Chrome/i.test(ua)) return "Chrome browser";
  if (/Safari/i.test(ua)) return "Safari browser";
  return "Unnamed device";
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
