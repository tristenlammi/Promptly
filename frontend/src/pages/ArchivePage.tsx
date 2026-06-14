import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, MessageSquare, RotateCcw, Search, Trash2 } from "lucide-react";

import type { ConversationSummary } from "@/api/types";
import { TopNav } from "@/components/layout/TopNav";
import { confirm } from "@/components/shared/ConfirmDialog";
import {
  useArchivedConversationsQuery,
  useDeleteConversation,
  useUnarchiveConversation,
} from "@/hooks/useConversations";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

/**
 * Dedicated Archive page. Lists chats the user has archived (hidden from
 * the sidebar + global search) and lets them read, restore, or
 * permanently delete each one. Permanent deletion is intentionally
 * gated behind a confirm dialog and only reachable from here — the
 * sidebar's per-row action is the reversible Archive, never a hard
 * delete.
 */
export function ArchivePage() {
  const navigate = useNavigate();
  const { data, isLoading } = useArchivedConversationsQuery();
  const unarchive = useUnarchiveConversation();
  const remove = useDeleteConversation();
  const [query, setQuery] = useState("");
  // Track which row is mid-action so we can disable just that row.
  const [busyId, setBusyId] = useState<string | null>(null);

  const archived = useMemo(() => data ?? [], [data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return archived;
    return archived.filter((c) =>
      (c.title || "Untitled chat").toLowerCase().includes(q)
    );
  }, [archived, query]);

  const handleRestore = async (conv: ConversationSummary) => {
    setBusyId(conv.id);
    try {
      await unarchive.mutateAsync(conv.id);
      toast.success("Chat restored to your sidebar");
    } catch {
      toast.error("Couldn't restore this chat. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteForever = async (conv: ConversationSummary) => {
    const title = conv.title?.trim() || "Untitled chat";
    const ok = await confirm({
      title: "Delete forever?",
      message: `"${title}" and all of its messages will be permanently deleted. This can't be undone.`,
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    setBusyId(conv.id);
    try {
      await remove.mutateAsync(conv.id);
      toast.success("Chat permanently deleted");
    } catch {
      toast.error("Couldn't delete this chat. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <TopNav
        title="Archive"
        subtitle="Chats you've archived are kept here, out of your sidebar and search. Restore them anytime, or delete them forever."
      />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {/* Search filter — client-side over the archived list (archived
              chats are deliberately excluded from the global palette). */}
          {archived.length > 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-input border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <Search className="h-4 w-4 text-[var(--text-muted)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search archived chats…"
                className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-[var(--text-muted)]"
              />
            </div>
          )}

          {isLoading && (
            <div className="text-sm text-[var(--text-muted)]">Loading…</div>
          )}

          {!isLoading && archived.length === 0 && (
            <EmptyState
              title="No archived chats"
              description="Archive a chat from the sidebar (the orange archive button) and it'll show up here."
            />
          )}

          {!isLoading && archived.length > 0 && filtered.length === 0 && (
            <EmptyState
              title="No matches"
              description={`Nothing archived matches "${query.trim()}".`}
            />
          )}

          {filtered.length > 0 && (
            <ul className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
              {filtered.map((conv) => (
                <ArchiveRow
                  key={conv.id}
                  conv={conv}
                  busy={busyId === conv.id}
                  onOpen={() => navigate(`/chat/${conv.id}`)}
                  onRestore={() => void handleRestore(conv)}
                  onDeleteForever={() => void handleDeleteForever(conv)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function ArchiveRow({
  conv,
  busy,
  onOpen,
  onRestore,
  onDeleteForever,
}: {
  conv: ConversationSummary;
  busy: boolean;
  onOpen: () => void;
  onRestore: () => void;
  onDeleteForever: () => void;
}) {
  const title = conv.title?.trim() || "Untitled chat";
  return (
    <li
      className={cn(
        "group flex items-center gap-3 px-3 py-2.5 transition",
        busy ? "opacity-60" : "hover:bg-[var(--hover)]"
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        title="Open chat"
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)]/10 text-[var(--accent)]">
          <MessageSquare className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--text)]">
            {title}
          </span>
          <span className="block truncate text-xs text-[var(--text-muted)]">
            Archived {formatRelative(conv.archived_at)}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onRestore}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--hover-strong)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
          title="Restore to sidebar"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Restore
        </button>
        <button
          type="button"
          onClick={onDeleteForever}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[var(--danger)] transition hover:bg-[var(--danger-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          title="Delete forever"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>
    </li>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-[var(--border)] px-6 py-16 text-center">
      <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
        <Archive className="h-5 w-5" />
      </span>
      <p className="text-sm font-medium text-[var(--text)]">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-[var(--text-muted)]">
        {description}
      </p>
    </div>
  );
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "recently";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "recently";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
