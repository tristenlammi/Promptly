import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Moon, UserRound } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { porchApi, type NotificationSettings, type PushKind, type PushMode } from "@/api/porch";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { IosPushNote } from "@/components/pwa/IosPushNote";
import { useInstallPrompt } from "@/lib/installPrompt";
import { EmptyState, ItemButton, List, Section } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { ALERTS_KEY, NOTIFY_KEY } from "../cache";
import { Column, GroupTile, LoadError, PageHeader, PorchAvatar } from "../components/ui";
import { usePorch } from "../context";
import { GroupBell } from "../notify";

const KIND_WORDS: Record<PushKind, { title: string; text: string }> = {
  post: { title: "New posts", text: "From people and groups you've turned on (below)." },
  comment: { title: "Comments on your posts", text: "Someone comments on something you posted." },
  reply: { title: "Replies to your comments", text: "Someone replies to a comment of yours." },
  mention: { title: "Mentions", text: "Someone @mentions you in a post or comment." },
  tag: { title: "Tags", text: "Someone tags you in a photo. It shows only once you say yes." },
  invite: { title: "Group invites", text: "Someone invites you to a group." },
  reaction: { title: "Reactions", text: "Someone reacts to your post or comment." },
  birthday: { title: "Birthdays", text: "People in your groups, on the day." },
};

const MODE_WORDS: Record<PushMode, string> = { on: "On", summary: "Daily summary", off: "Off" };

/** On / Daily summary / Off for one kind. */
function ModeSwitch({ label, value, onChange, disabled }: { label: string; value: PushMode; onChange: (m: PushMode) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} data-mode={label} className="inline-flex w-full rounded-xl bg-[var(--surface-2)] p-1 sm:w-auto">
      {(Object.keys(MODE_WORDS) as PushMode[]).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          disabled={disabled}
          onClick={() => value !== m && onChange(m)}
          className={cn(
            "h-9 flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:opacity-60",
            value === m ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
          )}
        >
          {MODE_WORDS[m]}
        </button>
      ))}
    </div>
  );
}

/** Whether this device gets notifications at all. */
function ThisDevice() {
  const push = usePushSubscription();
  const install = useInstallPrompt();
  // iPhone in Safari can't get push until Porch is on the Home Screen.
  if (install.ios && !install.standalone && push.serverConfigured !== false) return <IosPushNote appName="Porch" what="Porch notifications" />;
  if (push.loading || !push.supported || push.serverConfigured !== true || push.subscribed) return null;
  if (push.permission === "denied") {
    return (
      <p className="rounded-xl bg-[var(--surface-2)] p-3 text-sm text-[var(--text-muted)]">
        This browser blocks notifications from Promptly. Allow them in the browser's site settings to get Porch notifications here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-[var(--surface-2)] p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-[var(--text)]">Notifications aren't on for this device yet.</p>
      <ItemButton
        size="sm"
        variant="primary"
        icon={<Bell className="h-4 w-4" />}
        onClick={() =>
          void push.subscribe().then(
            () => toast.success("Notifications are on for this device."),
            () => toast.error("Couldn't turn on notifications. Try again."),
          )
        }
      >
        Turn on for this device
      </ItemButton>
    </div>
  );
}

/** ``/porch/settings``: Porch's notifications, kind by kind. */
export function SettingsPage() {
  const { b } = usePorch();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: NOTIFY_KEY, queryFn: porchApi.notifications });
  const alerts = useQuery({ queryKey: ALERTS_KEY, queryFn: porchApi.alerts });
  const [busy, setBusy] = useState<string | null>(null);
  const kindsId = useId();
  const s = q.data;

  const patch = async (key: string, body: Parameters<typeof porchApi.setNotifications>[0], done?: string) => {
    setBusy(key);
    const before = qc.getQueryData<NotificationSettings>(NOTIFY_KEY);
    if (before && body.modes) qc.setQueryData<NotificationSettings>(NOTIFY_KEY, { ...before, modes: { ...before.modes, ...body.modes } as NotificationSettings["modes"] });
    try {
      qc.setQueryData(NOTIFY_KEY, await porchApi.setNotifications(body));
      if (done) toast.success(done);
    } catch (err) {
      if (before) qc.setQueryData(NOTIFY_KEY, before);
      toast.error(apiErrorMessage(err, "Couldn't save that. Try again."));
    } finally {
      setBusy(null);
    }
  };

  const stopAlert = async (id: string, name: string) => {
    try {
      await porchApi.setAlert(id, false);
      void qc.invalidateQueries({ queryKey: ALERTS_KEY });
      toast.success(`No more notifications when ${name} posts.`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't change that. Try again."));
    }
  };

  if (q.isPending) {
    return (
      <Column>
        <PageHeader title="Notifications" back />
        <p className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">Loading…</p>
      </Column>
    );
  }
  if (q.isError || !s) {
    return (
      <Column>
        <PageHeader title="Notifications" back />
        <LoadError what="Couldn't load your notification settings." onRetry={() => void q.refetch()} />
      </Column>
    );
  }
  const off = !s.account.push_enabled || !s.account.porch;
  const a = s.account;

  return (
    <Column>
      <PageHeader title="Notifications" back />
      <div className="flex flex-col gap-6 px-4 pt-2 md:px-0">
        {off ? (
          <div role="status" className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-start gap-2 text-sm text-[var(--text)]">
              <BellOff className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
              {a.push_enabled ? "Porch notifications are off in your account." : "All notifications are off in your account."}
            </span>
            {a.push_enabled ? (
              <ItemButton size="sm" variant="primary" disabled={busy === "account"} onClick={() => void patch("account", { porch: true }, "Porch notifications are on.")}>
                Turn on
              </ItemButton>
            ) : (
              <Link to="/account/notifications" className="text-sm font-medium text-[var(--accent-text)] hover:underline">
                Open Account → Notifications
              </Link>
            )}
          </div>
        ) : (
          <ThisDevice />
        )}

        <Section title="What to tell you" hint={`"Daily summary" collects them into one notification at ${a.summary_time}, with counts only.`}>
          <div id={kindsId} className={cn("flex flex-col divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]", off && "opacity-70")}>
            {s.kinds.map((k) => (
              <div key={k} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--text)]">{KIND_WORDS[k].title}</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {KIND_WORDS[k].text}
                    {s.defaults[k] === "summary" && " Starts in your daily summary."}
                  </p>
                </div>
                <ModeSwitch label={KIND_WORDS[k].title} value={s.modes[k]} disabled={busy === k} onChange={(m) => void patch(k, { modes: { [k]: m } })} />
              </div>
            ))}
          </div>
        </Section>

        <Section title="New posts from groups" hint="The bell: a notification for every new post in that group. Off by default.">
          <List>
            {b.groups.map((g) => (
              <div key={g.id} className="flex items-center gap-3 px-3 py-2">
                <GroupTile group={g} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text)]">{g.name}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{g.notify === "all" ? "All new posts" : "Off"}</span>
                </span>
                <GroupBell group={g} />
              </div>
            ))}
          </List>
        </Section>

        <Section title="New posts from people" hint="Turn this on from someone's profile: Notify me.">
          {alerts.isPending ? (
            <p className="px-1 text-sm text-[var(--text-muted)]">Loading…</p>
          ) : alerts.isError ? (
            <LoadError what="Couldn't load these." onRetry={() => void alerts.refetch()} />
          ) : alerts.data.length === 0 ? (
            <EmptyState icon={UserRound} title="Nobody yet" text="Open someone's profile and tap Notify me to hear when they post." />
          ) : (
            <List>
              {alerts.data.map((u) => (
                <div key={u.id} className="flex items-center gap-3 px-3 py-2">
                  <Link to={`/porch/u/${u.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                    <PorchAvatar user={u} size={36} />
                    <span className="truncate text-sm font-medium text-[var(--text)]">{u.name}</span>
                  </Link>
                  <ItemButton size="sm" variant="secondary" onClick={() => void stopAlert(u.id, u.name)} aria-label={`Stop notifications when ${u.name} posts`}>
                    Stop
                  </ItemButton>
                </div>
              ))}
            </List>
          )}
        </Section>

        <Section title="Quiet hours">
          <Link
            to="/account/notifications"
            className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            <Moon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
            <span className="min-w-0 flex-1">
              {a.quiet_enabled ? `Quiet hours: ${a.quiet_start}–${a.quiet_end}` : "Quiet hours are off"}
              <span className="block text-xs text-[var(--text-muted)]">Set in Account → Notifications, for all of Promptly. What arrives then waits until they end.</span>
            </span>
          </Link>
        </Section>
      </div>
    </Column>
  );
}
