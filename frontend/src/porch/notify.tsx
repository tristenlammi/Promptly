/**
 * Porch's notification controls shared by its screens (WP-P1.7): a group's
 * bell (all new posts / none), "Notify me when they post" on a profile, and
 * asking for push permission in context — when you turn one of these on,
 * never on first open.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, BellRing } from "lucide-react";
import { useState } from "react";

import { porchApi, type PorchGroup } from "@/api/porch";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useInstallPrompt } from "@/lib/installPrompt";
import { ItemButton } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { ALERTS_KEY, groupKey, profileKey, updateBootstrap } from "./cache";

/** Ask this device for push permission if it can and hasn't been asked
 *  (or said no). On an iPhone in Safari, says how to get them instead;
 *  quietly does nothing otherwise. */
export function useAskForPush() {
  const push = usePushSubscription();
  const install = useInstallPrompt();
  return async (why: string) => {
    // iPhone in Safari: no push until Porch is on the Home Screen. Say so
    // instead of saying nothing.
    if (!push.loading && !push.supported && install.ios && !install.standalone) {
      toast.info("To get these on your iPhone, add Porch to your Home Screen: Share → Add to Home Screen. Porch → Settings shows how.", { duration: 10_000 });
      return;
    }
    if (push.loading || !push.supported || push.serverConfigured !== true || push.subscribed || push.permission === "denied") return;
    try {
      await push.subscribe();
      toast.success(why);
    } catch {
      toast.error("Couldn't turn on notifications on this device. You can try again in Porch → Settings.");
    }
  };
}

/** A group's bell: "All new posts" or off (the default). */
export function GroupBell({ group, size = "md", className }: { group: Pick<PorchGroup, "id" | "name" | "notify">; size?: "sm" | "md"; className?: string }) {
  const qc = useQueryClient();
  const ask = useAskForPush();
  const [busy, setBusy] = useState(false);
  const on = group.notify === "all";
  const flip = async () => {
    const next = on ? "none" : "all";
    setBusy(true);
    const patch = (n: "all" | "none") =>
      updateBootstrap(qc, (b) => ({ ...b, groups: b.groups.map((g) => (g.id === group.id ? { ...g, notify: n } : g)) }));
    patch(next);
    try {
      await porchApi.setMine(group.id, { notify: next });
      void qc.invalidateQueries({ queryKey: groupKey(group.id) });
      if (next === "all") {
        toast.success(`You'll get a notification for every new post in ${group.name}.`);
        void ask("Notifications are on for this device.");
      } else {
        toast.success(`No notifications for new posts in ${group.name}.`);
      }
    } catch (err) {
      patch(on ? "all" : "none");
      toast.error(apiErrorMessage(err, "Couldn't change that. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const Icon = on ? BellRing : BellOff;
  return (
    <button
      type="button"
      onClick={() => void flip()}
      disabled={busy}
      aria-pressed={on}
      aria-label={`Notify me of every new post in ${group.name}`}
      title={on ? "All new posts (tap to turn off)" : "No notifications for new posts (tap for all new posts)"}
      data-bell={group.id}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:opacity-60",
        size === "sm" ? "h-9 w-9" : "h-10 w-10",
        on ? "text-[var(--accent-text)] hover:bg-[var(--hover)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
        className,
      )}
    >
      <Icon className={size === "sm" ? "h-[18px] w-[18px]" : "h-5 w-5"} aria-hidden />
    </button>
  );
}

/** "Notify me when they post", on someone's profile. */
export function AlertButton({ userId, name, on }: { userId: string; name: string; on: boolean }) {
  const qc = useQueryClient();
  const ask = useAskForPush();
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    setBusy(true);
    try {
      await porchApi.setAlert(userId, !on);
      void qc.invalidateQueries({ queryKey: profileKey(userId) });
      void qc.invalidateQueries({ queryKey: ALERTS_KEY });
      if (!on) {
        toast.success(`You'll get a notification when ${name} posts.`);
        void ask("Notifications are on for this device.");
      } else {
        toast.success(`No more notifications when ${name} posts.`);
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't change that. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ItemButton
      variant={on ? "secondary" : "ghost"}
      icon={on ? <BellRing className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
      disabled={busy}
      aria-pressed={on}
      onClick={() => void flip()}
      title={on ? `You're told when ${name} posts` : `Get a notification when ${name} posts`}
    >
      {on ? "Notifying you" : "Notify me"}
      <span className="sr-only"> when {name} posts</span>
    </ItemButton>
  );
}

