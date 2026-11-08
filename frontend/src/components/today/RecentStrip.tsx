import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Blocks,
  ClipboardList,
  File,
  FileText,
  Film,
  Hash,
  History,
  Image,
  LayoutGrid,
  MessageCircle,
  MessagesSquare,
  Music,
  PenTool,
  Table2,
  X,
  type LucideIcon,
} from "lucide-react";

import { recentsApi, type RecentEntry } from "@/api/recents";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * "Pick up where you left off" — the last things you opened across
 * Promptly (docs, sheets, whiteboards and slides, files, app files, chats,
 * rooms, workspace items), newest first, each opening straight back to it.
 * Hidden until there's something to show.
 */

export const RECENTS_KEY = ["today-recents"];

function iconFor(e: RecentEntry): LucideIcon {
  switch (e.kind) {
    case "document":
      return FileText;
    case "sheet":
      return Table2;
    case "whiteboard":
      return PenTool;
    case "form":
      return ClipboardList;
    case "item":
      return Blocks;
    case "chat":
      return MessagesSquare;
    case "room":
      return e.icon === "dm" ? MessageCircle : Hash;
    case "workspace_item":
      return e.icon === "sheet" ? Table2 : e.icon === "canvas" ? PenTool : e.icon === "note" ? FileText : LayoutGrid;
    default:
      return e.icon === "image" ? Image : e.icon === "video" ? Film : e.icon === "audio" ? Music : File;
  }
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

export function RecentStrip() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: RECENTS_KEY,
    queryFn: () => recentsApi.list(12),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  if (!data?.length) return null;

  const clear = async () => {
    try {
      await recentsApi.clear();
      qc.setQueryData(RECENTS_KEY, []);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't clear that."));
    }
  };

  return (
    <section aria-label="Recent" className="mb-4 md:mb-5">
      <div className="mb-2 flex items-center gap-2">
        <History className="h-4 w-4 text-[var(--accent-text)]" />
        <h2 className="flex-1 text-sm font-semibold text-[var(--text)]">Pick up where you left off</h2>
        <button
          type="button"
          onClick={() => void clear()}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          <X className="h-3 w-3" /> Clear
        </button>
      </div>
      <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {data.map((e) => {
          const Icon = iconFor(e);
          return (
            <li key={`${e.kind}:${e.id}`} className="w-48 shrink-0">
              <Link
                to={e.url}
                title={e.title}
                className="flex h-full items-start gap-2.5 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 hover:bg-[var(--hover)]"
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text)]">{e.title}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">
                    {e.detail} · {ago(e.opened_at)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
