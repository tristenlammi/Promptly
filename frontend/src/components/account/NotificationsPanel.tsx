import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BellOff,
  BellRing,
  Check,
  Loader2,
  Moon,
  Smartphone,
  Trash2,
} from "lucide-react";

import {
  notificationsApi,
  type NotificationPreferences,
  type NotificationSwitch,
  type SubscriptionSummary,
} from "@/api/notifications";
import { porchApi } from "@/api/porch";
import { Button } from "@/components/shared/Button";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { cn } from "@/utils/cn";

/** Account -> Notifications. Two stacked blocks:
 *
 *  1. **This device** — subscribe / unsubscribe the current browser
 *     from push. Handles permission prompts and the "server not
 *     configured" edge case. A diagnostic "Send test" button lives
 *     here too.
 *  2. **Quiet hours** — one setting for all of Promptly; held pushes
 *     arrive when they end (``notifications/quiet.py``).
 *  3. **Categories** — the per-event toggles. Flipping a toggle
 *     PATCHes the backend immediately; optimistic UI with a tiny
 *     spinner on the row that's still in flight. Rooms and Mail can be
 *     set to the daily summary instead of straight away.
 *  4. **Other devices** — the rest of the user's subscribed
 *     browsers. Each row is individually unsubscribe-able.
 */
export function NotificationsPanel() {
  const push = usePushSubscription();
  // Porch's row only for people Porch is on for.
  const { data: porchOn } = useQuery({ queryKey: ["porch", "available"], queryFn: porchApi.available, staleTime: 5 * 60_000 });

  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [prefsBusy, setPrefsBusy] = useState<string | null>(null);
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

  /** Save a change straight away: show it first, put it back if the
   *  server says no. */
  async function save(patch: Partial<NotificationPreferences>, busyKey: string) {
    if (!prefs) return;
    const previous = prefs;
    setPrefsError(null);
    setPrefs({ ...prefs, ...patch });
    setPrefsBusy(busyKey);
    try {
      const fresh = await notificationsApi.updatePreferences(patch);
      setPrefs(fresh);
    } catch (e) {
      setPrefs(previous);
      setPrefsError(
        (e as Error)?.message ?? "Couldn't update preference."
      );
    } finally {
      setPrefsBusy(null);
    }
  }

  function toggle(key: NotificationSwitch, next: boolean) {
    void save({ [key]: next }, key);
  }

  /** "Straight away" or "In my daily summary", for a category that offers it. */
  function summaryMode(category: string): ReactNode {
    if (!prefs || !prefs.summary_capable.includes(category)) return null;
    const inSummary = prefs.summary_categories.includes(category);
    return (
      <select
        aria-label="When to tell you"
        value={inSummary ? "summary" : "instant"}
        disabled={prefsBusy === `summary:${category}`}
        onChange={(e) => {
          const rest = prefs.summary_categories.filter((c) => c !== category);
          void save(
            { summary_categories: e.target.value === "summary" ? [...rest, category] : rest },
            `summary:${category}`
          );
        }}
        className="mt-1 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-0.5 text-[11px]"
      >
        <option value="instant">Straight away</option>
        <option value="summary">In my daily summary ({prefs.summary_time})</option>
      </select>
    );
  }

  async function sendTest() {
    setTestStatus(null);
    setTestBusy(true);
    try {
      const { sent, failed, removed } = await notificationsApi.sendTest();
      const parts: string[] = [];
      if (sent) parts.push(`Sent to ${sent} device${sent === 1 ? "" : "s"} — check for it.`);
      if (failed) parts.push(`${failed} couldn't be reached.`);
      if (removed)
        parts.push(`${removed} had stopped accepting notifications and ${removed === 1 ? "was" : "were"} removed.`);
      setTestStatus(
        parts.length ? parts.join(" ") : "No devices are set up for notifications yet."
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
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent-text)]">
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

          {/* -- Quiet hours -- */}
          {prefs && (
            <QuietHours
              prefs={prefs}
              busy={prefsBusy === "quiet"}
              onSave={(patch) => void save(patch, "quiet")}
            />
          )}

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
              <CategoryRow
                title="Scheduled tasks"
                subtitle="A scheduled task finished and a new report is ready (or failed)."
                checked={prefs.task_complete}
                busy={prefsBusy === "task_complete"}
                onChange={(v) => toggle("task_complete", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Mentions"
                subtitle="Someone @-mentioned you in a workspace comment."
                checked={prefs.mention}
                busy={prefsBusy === "mention"}
                onChange={(v) => toggle("mention", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Assignments"
                subtitle="A board card was assigned to you."
                checked={prefs.assignment}
                busy={prefsBusy === "assignment"}
                onChange={(v) => toggle("assignment", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Invites"
                subtitle="Someone invited you to collaborate on a workspace."
                checked={prefs.invite}
                busy={prefsBusy === "invite"}
                onChange={(v) => toggle("invite", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Item reminders"
                subtitle="Reminders your items set — habits, medication, trips, birthdays."
                checked={prefs.item_reminder ?? true}
                busy={prefsBusy === "item_reminder"}
                onChange={(v) => toggle("item_reminder", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Rooms"
                subtitle="New messages in your rooms and conversations (each room's own setting still applies)."
                checked={prefs.room_message ?? true}
                busy={prefsBusy === "room_message"}
                onChange={(v) => toggle("room_message", v)}
                dimmed={!prefs.enabled}
                extra={(prefs.room_message ?? true) && summaryMode("room_message")}
              />
              <CategoryRow
                title="Calendar"
                subtitle="Event invitations, guests' answers, changes and your event reminders."
                checked={prefs.calendar ?? true}
                busy={prefsBusy === "calendar"}
                onChange={(v) => toggle("calendar", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Mail"
                subtitle="New email in your Inbox, and snoozed email coming back (each mailbox's own setting still applies)."
                checked={prefs.mail ?? true}
                busy={prefsBusy === "mail"}
                onChange={(v) => toggle("mail", v)}
                dimmed={!prefs.enabled}
                extra={(prefs.mail ?? true) && summaryMode("mail")}
              />
              {porchOn && (
              <CategoryRow
                title="Porch"
                subtitle="Posts, comments, mentions, tags, invites, reactions and birthdays. Choose which, and how, in Porch → Settings."
                checked={prefs.porch ?? true}
                busy={prefsBusy === "porch"}
                onChange={(v) => toggle("porch", v)}
                dimmed={!prefs.enabled}
                extra={(prefs.porch ?? true) && summaryMode("porch")}
              />
              )}
              <CategoryRow
                title="Forms"
                subtitle="New answers to your forms, and a form closing. Only how many came in, never what anyone wrote (each form's own setting still applies)."
                checked={prefs.form_response ?? true}
                busy={prefsBusy === "form_response"}
                onChange={(v) => toggle("form_response", v)}
                dimmed={!prefs.enabled}
                extra={(prefs.form_response ?? true) && summaryMode("form_response")}
              />
              <CategoryRow
                title="Calls"
                subtitle="Someone calling you in Rooms, and calls you missed."
                checked={prefs.call ?? true}
                busy={prefsBusy === "call"}
                onChange={(v) => toggle("call", v)}
                dimmed={!prefs.enabled}
                extra={
                  (prefs.call ?? true) && prefs.quiet_enabled ? (
                    <label className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                      <input
                        type="checkbox"
                        checked={prefs.call_quiet_hold ?? false}
                        disabled={prefsBusy === "call_quiet_hold"}
                        onChange={(e) => toggle("call_quiet_hold", e.target.checked)}
                        data-testid="call-quiet-hold"
                      />
                      Don&apos;t ring me during quiet hours (you&apos;ll see who called when they end)
                    </label>
                  ) : null
                }
              />
              <CategoryRow
                title="Passwords"
                subtitle="A new device asking to join your vault, or someone sharing a vault with you. These never carry anything from the vault."
                checked={prefs.passwords ?? true}
                busy={prefsBusy === "passwords"}
                onChange={(v) => toggle("passwords", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Notes"
                subtitle="Someone shared a note with you. Reminders on notes come from Tasks."
                checked={prefs.notes ?? true}
                busy={prefsBusy === "notes"}
                onChange={(v) => toggle("notes", v)}
                dimmed={!prefs.enabled}
              />
              <CategoryRow
                title="Sent from Talk"
                subtitle="Something you asked Talk to send to your phone, like an email or a place, and details a car answer had to leave out. Comes straight away, even in quiet hours."
                checked={prefs.talk_followup ?? true}
                busy={prefsBusy === "talk_followup"}
                onChange={(v) => toggle("talk_followup", v)}
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

/** One quiet-hours setting for all of Promptly: start and end in your own
 *  time zone, optionally different on Friday and Saturday nights. */
function QuietHours({
  prefs,
  busy,
  onSave,
}: {
  prefs: NotificationPreferences;
  busy: boolean;
  onSave: (patch: Partial<NotificationPreferences>) => void;
}) {
  const time = (
    label: string,
    value: string,
    key: "quiet_start" | "quiet_end" | "quiet_weekend_start" | "quiet_weekend_end"
  ) => (
    <input
      type="time"
      aria-label={label}
      value={value}
      onChange={(e) => {
        // A cleared or half-typed time isn't saved.
        if (/^\d{2}:\d{2}$/.test(e.target.value)) onSave({ [key]: e.target.value });
      }}
      className="rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-0.5 text-xs tabular-nums"
    />
  );
  return (
    <div className="mb-4 overflow-hidden rounded-md border border-[var(--border)]">
      <CategoryRow
        title="Quiet hours"
        subtitle="Notifications wait until quiet hours end, then arrive together. Calls, Calendar reminders, item reminders, Passwords and admin alerts always get through (calls can be held too, under Calls)."
        checked={prefs.quiet_enabled}
        busy={busy}
        onChange={(v) => onSave({ quiet_enabled: v })}
        icon={<Moon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />}
      />
      {prefs.quiet_enabled && (
        <div className="flex flex-col gap-2 border-t border-[var(--border)] px-3 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-32 text-[var(--text-muted)]">
              {prefs.quiet_weekend ? "Sunday to Thursday" : "Every night"}
            </span>
            {time("Quiet hours start", prefs.quiet_start, "quiet_start")}
            <span className="text-[var(--text-muted)]">to</span>
            {time("Quiet hours end", prefs.quiet_end, "quiet_end")}
          </div>
          {prefs.quiet_weekend && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-32 text-[var(--text-muted)]">Friday and Saturday</span>
              {time("Weekend quiet hours start", prefs.quiet_weekend_start ?? prefs.quiet_start, "quiet_weekend_start")}
              <span className="text-[var(--text-muted)]">to</span>
              {time("Weekend quiet hours end", prefs.quiet_weekend_end ?? prefs.quiet_end, "quiet_weekend_end")}
            </div>
          )}
          <label className="inline-flex w-fit cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={prefs.quiet_weekend}
              onChange={(e) => onSave({ quiet_weekend: e.target.checked })}
            />
            Different times on Friday and Saturday nights
          </label>
          <p className="text-[11px] text-[var(--text-muted)]">
            Times are in your time zone ({prefs.timezone.replace(/_/g, " ")}).
            {prefs.quiet_now && " Quiet hours are on right now."}
          </p>
        </div>
      )}
    </div>
  );
}

function CategoryRow({
  title,
  subtitle,
  checked,
  busy,
  onChange,
  dimmed,
  extra,
  icon,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  busy?: boolean;
  onChange: (v: boolean) => void;
  dimmed?: boolean;
  /** Under the subtitle (the daily-summary choice). */
  extra?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-2.5",
        dimmed && "opacity-60"
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && (
          <div className="text-[11px] text-[var(--text-muted)]">{subtitle}</div>
        )}
        {extra}
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
