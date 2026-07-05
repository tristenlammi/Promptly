import { useNavigate } from "react-router-dom";
import {
  AtSign,
  Bell,
  CheckCheck,
  Clock,
  Loader2,
  Mail,
  UserCheck,
  X,
} from "lucide-react";

import {
  useInbox,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
} from "@/hooks/useInbox";
import type { NotificationRow } from "@/api/notifications";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { relativeTime } from "@/components/tasks/RunStatusChip";
import { cn } from "@/utils/cn";

/**
 * The notification inbox — the durable "3 things need your attention"
 * list behind the sidebar bell. Push nudges in real time; this is where
 * mentions, card assignments, invites, and automation outcomes wait to
 * be caught up on. Click-through marks the row read and follows its
 * deep link.
 */
const CATEGORY_ICON: Record<string, typeof Bell> = {
  mention: AtSign,
  assignment: UserCheck,
  invite: Mail,
  task_complete: Clock,
};

export function InboxPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useInbox();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  if (!open) return null;

  const items = data?.items ?? [];
  const unread = data?.unread_count ?? 0;

  const activate = (n: NotificationRow) => {
    if (!n.read_at) markRead.mutate(n.id);
    if (n.url) {
      onClose();
      navigate(n.url);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-card border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Bell className="h-4 w-4 text-[var(--text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--text)]">Inbox</h2>
          {unread > 0 && (
            <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-white">
              {unread}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
                title="Mark everything read"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close inbox"
              className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">
              Nothing yet — mentions, card assignments, invites, and
              automation results land here.
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {items.map((n) => {
                const Icon = CATEGORY_ICON[n.category] ?? Bell;
                const unreadRow = !n.read_at;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => activate(n)}
                      className={cn(
                        "flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-[var(--hover)]",
                        unreadRow && "bg-[var(--accent)]/[0.04]"
                      )}
                    >
                      {n.actor ? (
                        <UserAvatar
                          name={n.actor.username}
                          avatarUrl={n.actor.avatar_url}
                          color={n.actor.avatar_color}
                          size={28}
                        />
                      ) : (
                        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "block text-sm text-[var(--text)]",
                            unreadRow && "font-medium"
                          )}
                        >
                          {n.title}
                        </span>
                        {n.body && (
                          <span className="mt-0.5 line-clamp-2 block text-xs text-[var(--text-muted)]">
                            {n.body}
                          </span>
                        )}
                        <span className="mt-0.5 block text-[11px] text-[var(--text-muted)]/70">
                          {relativeTime(n.created_at)}
                        </span>
                      </span>
                      {unreadRow && (
                        <span
                          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]"
                          aria-label="Unread"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
