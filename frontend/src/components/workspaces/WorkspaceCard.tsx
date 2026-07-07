import {
  Archive,
  ArchiveRestore,
  Clock,
  Columns3,
  FileText,
  LayoutGrid,
  MessageSquare,
  PenTool,
  StickyNote,
  Table2,
  Trash2,
  Users,
} from "lucide-react";

import type { WorkspaceSummary } from "@/api/workspaces";
import { formatRelativeTime } from "@/components/files/helpers";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { cn } from "@/utils/cn";

interface WorkspaceCardProps {
  workspace: WorkspaceSummary;
  onOpen: () => void;
  onDelete: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}

/** Card for a single workspace — deliberately mirrors
 * ``StudyTopicCard`` so the two features feel like siblings on the
 * sidebar. Shows title, description excerpt, conv/file counts, and
 * hover-only quick actions. */
export function WorkspaceCard({
  workspace,
  onOpen,
  onDelete,
  onArchive,
  onUnarchive,
}: WorkspaceCardProps) {
  const isArchived = Boolean(workspace.archived_at);
  // ``role`` may be absent on older cached payloads — default to
  // owner so the card still renders while TanStack refetches the
  // enriched shape.
  const isCollaborator = workspace.role === "collaborator";
  // Deterministic per-workspace accent so cards are scannable at a
  // glance — same workspace always gets the same hue. Constrained to the
  // warm terracotta→amber band so identity never fights the app palette
  // (the old full-wheel hues produced teal/blue cards that read as a
  // different product).
  const hue = hueForId(workspace.id);
  const accent = `hsl(${hue} 64% 50%)`;
  const accentSoft = `hsl(${hue} 64% 50% / 0.14)`;

  const stats = buildStats(workspace);
  // Prefer the enriched member payload (real avatars, 7.5); fall back to
  // the usernames-only strip for stale cached summaries.
  const members = workspace.member_names ?? [];
  const richMembers = workspace.members ?? [];

  return (
    <div
      className={cn(
        "group relative flex min-h-[170px] flex-col justify-between overflow-hidden rounded-card border p-4",
        "transition duration-150 will-change-transform",
        // Lift + shadow on hover — the resting border is intentionally faint,
        // so a border-colour-only hover was barely perceptible and the grid
        // felt static.
        "border-[var(--border)] bg-[var(--surface)]",
        "hover:-translate-y-0.5 hover:border-[var(--accent)]/40 hover:shadow-[var(--shadow-lg)]",
        isArchived && "opacity-80",
        isCollaborator && "border-[var(--accent)]/30"
      )}
    >
      {/* Per-workspace identity strip along the top edge. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-1"
        style={{ backgroundColor: accent }}
      />
      <button
        onClick={onOpen}
        className="absolute inset-0 rounded-card"
        aria-label={`Open ${workspace.title}`}
      />

      <div className="pointer-events-none relative">
        <div className="flex items-start gap-2">
          <div
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
            style={{ backgroundColor: accentSoft, color: accent }}
          >
            <LayoutGrid className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-[var(--text)]">
                {workspace.title}
              </h3>
              {isCollaborator && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]"
                  title={
                    workspace.shared_by
                      ? `Shared by ${workspace.shared_by.username}`
                      : "Shared with you"
                  }
                >
                  <Users className="h-2.5 w-2.5" />
                  Shared
                </span>
              )}
            </div>
            {workspace.description ? (
              <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                {workspace.description}
              </p>
            ) : isCollaborator && workspace.shared_by ? (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Shared by{" "}
                <span className="font-medium text-[var(--text)]">
                  {workspace.shared_by.username}
                </span>
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Stats + footer anchored to the card bottom so they line up
          across cards regardless of whether a description is present. */}
      <div className="relative mt-4 space-y-2">
        {/* What's inside — every item kind with a non-zero count, so a
            board-and-sheets workspace stops presenting as "chats + files". */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
          {stats.length === 0 ? (
            <span className="italic">Empty — open to add content</span>
          ) : (
            stats.map((s) => (
              <span
                key={s.label}
                className="inline-flex items-center gap-1"
                title={s.label}
              >
                <s.icon className="h-3 w-3" />
                {s.count} {s.label}
              </span>
            ))
          )}
        </div>

        <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-2">
            {richMembers.length > 1 ? (
              <span
                className="inline-flex items-center"
                title={members.join(", ")}
              >
                {richMembers.slice(0, 4).map((m, i) => (
                  <UserAvatar
                    key={m.user_id}
                    name={m.username}
                    userId={m.user_id}
                    avatarUrl={m.avatar_url}
                    color={m.avatar_color}
                    size={18}
                    className={cn(
                      "border border-[var(--surface)]",
                      i > 0 && "-ml-1.5"
                    )}
                  />
                ))}
                {richMembers.length > 4 && (
                  <span className="ml-1">+{richMembers.length - 4}</span>
                )}
              </span>
            ) : members.length > 1 ? (
              <span
                className="inline-flex items-center"
                title={members.join(", ")}
              >
                {members.slice(0, 4).map((name, i) => (
                  <span
                    key={name}
                    className={cn(
                      "inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[var(--surface)] text-[8px] font-semibold text-white",
                      i > 0 && "-ml-1.5"
                    )}
                    style={{ backgroundColor: `hsl(${hueForId(name)} 45% 52%)` }}
                  >
                    {name.slice(0, 2).toUpperCase()}
                  </span>
                ))}
                {members.length > 4 && (
                  <span className="ml-1">+{members.length - 4}</span>
                )}
              </span>
            ) : null}
            <span>Updated {formatRelativeTime(workspace.updated_at)}</span>
          </span>
        {!isCollaborator && (
          <div className="pointer-events-auto flex items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            {isArchived && onUnarchive && (
              <IconActionButton
                label="Unarchive"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnarchive();
                }}
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
              </IconActionButton>
            )}
            {!isArchived && onArchive && (
              <IconActionButton
                label="Archive"
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive();
                }}
              >
                <Archive className="h-3.5 w-3.5" />
              </IconActionButton>
            )}
            <IconActionButton
              label="Delete"
              destructive
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconActionButton>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/** Stable hue derived from a workspace id, so each workspace gets a
 *  consistent identity colour without any backend field. Constrained to
 *  the warm 8°–48° band (terracotta → amber) to stay on-palette. */
function hueForId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return 8 + (h % 41);
}

/** Non-zero content stats for the card, most page-like kinds first.
 *  Chats come from ``conversation_count`` (not tree items); files from
 *  the pinned-file rollup. */
function buildStats(ws: WorkspaceSummary) {
  const counts = ws.item_counts ?? {};
  const defs = [
    { key: "note", one: "note", many: "notes", icon: StickyNote },
    { key: "board", one: "board", many: "boards", icon: Columns3 },
    { key: "sheet", one: "sheet", many: "sheets", icon: Table2 },
    { key: "canvas", one: "canvas", many: "canvases", icon: PenTool },
    { key: "task", one: "automation", many: "automations", icon: Clock },
  ] as const;
  const stats: { label: string; count: number; icon: typeof StickyNote }[] = [];
  for (const d of defs) {
    const n = counts[d.key] ?? 0;
    if (n > 0)
      stats.push({ label: n === 1 ? d.one : d.many, count: n, icon: d.icon });
  }
  if (ws.conversation_count > 0)
    stats.push({
      label: ws.conversation_count === 1 ? "chat" : "chats",
      count: ws.conversation_count,
      icon: MessageSquare,
    });
  if (ws.file_count > 0)
    stats.push({
      label: ws.file_count === 1 ? "file" : "files",
      count: ws.file_count,
      icon: FileText,
    });
  return stats;
}

function IconActionButton({
  label,
  destructive,
  children,
  onClick,
}: {
  label: string;
  destructive?: boolean;
  children: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "relative z-10 rounded p-1 text-[var(--text-muted)] transition",
        destructive
          ? "hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
          : "hover:bg-[var(--accent)]/10 hover:text-[var(--accent)]"
      )}
    >
      {children}
    </button>
  );
}
