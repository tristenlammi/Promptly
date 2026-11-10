import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CheckSquare,
  ChefHat,
  ClipboardList,
  File as FileIcon,
  Folder,
  House,
  CircleDashed,
  Image as ImageIcon,
  Images,
  Lock,
  Plane,
  StickyNote,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { FileItem } from "@/api/files";
import { crossApi, type ShareKind } from "@/api/crossapp";
import { openFile } from "@/components/files/helpers";

const FilePreviewModal = lazy(() => import("@/components/files/FilePreviewModal").then((m) => ({ default: m.FilePreviewModal })));

/**
 * Something sent to the room with "Send to…" (the message's ``meta.share``):
 * a file, folder, photo, album, task, recipe, trip, form, note or Porch post,
 * drawn from the live thing as *you* can see it. If you can't open it, a
 * neutral card says so — the message itself never carries its name. A
 * form's card is for answering it ("Fill in"), for anyone the form lets
 * answer; it never opens the form itself (Forms WP-F1.7 — the one card
 * Porch posts show too).
 */

export const SHARE_ICONS: Record<ShareKind, LucideIcon> = {
  file: FileIcon,
  folder: Folder,
  photo: ImageIcon,
  album: Images,
  task: CheckSquare,
  recipe: ChefHat,
  trip: Plane,
  form: ClipboardList,
  note: StickyNote,
  porch_post: House,
  porch_story: CircleDashed,
};

export const shareKey = (messageId: string) => ["rooms", "share-card", messageId] as const;

export function ShareCard({ messageId, kind, label }: { messageId: string; kind: ShareKind; label?: string }) {
  const navigate = useNavigate();
  const [preview, setPreview] = useState<FileItem | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: shareKey(messageId),
    queryFn: () => crossApi.card(messageId),
    staleTime: 60_000,
    retry: 1,
  });
  const Icon = SHARE_ICONS[kind] ?? FileIcon;
  const shell =
    "mt-1 flex w-full max-w-md items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2.5 text-left shadow-[var(--shadow-sm)]";

  if (isLoading) {
    return (
      <div className={shell} aria-busy="true">
        <span className="h-12 w-12 shrink-0 animate-pulse rounded-xl bg-[var(--hover)]" />
        <span className="flex-1 space-y-2">
          <span className="block h-3 w-2/3 animate-pulse rounded bg-[var(--hover)]" />
          <span className="block h-2.5 w-1/3 animate-pulse rounded bg-[var(--hover)]" />
        </span>
      </div>
    );
  }
  const card = data?.card ?? null;
  if (isError || !card) {
    return (
      <div className={shell}>
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--hover)] text-[var(--text-muted)]">
          <Lock className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-[var(--text)]">{kind === "porch_post" ? "Porch post" : kind === "porch_story" ? "Porch story" : "Shared item"}</span>
          <span className="block text-xs text-[var(--text-muted)]">
            {isError
              ? "Couldn't load this."
              : kind === "note"
                ? "This note isn't shared with you."
                : kind === "porch_post"
                  ? "This post isn't shared with you."
                : kind === "porch_story"
                  ? "This story has ended."
                : `You don't have access to ${data?.label ?? label ?? "it"}.`}
          </span>
        </span>
      </div>
    );
  }

  const open = () => {
    if (card.href) {
      navigate(card.href);
      return;
    }
    if (card.file && !openFile(card.file, navigate)) setPreview(card.file);
  };

  return (
    <>
      <button type="button" onClick={open} className={`${shell} transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]`}>
        {card.thumb || card.image_url ? (
          <img
            src={card.thumb ?? card.image_url ?? undefined}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-12 w-12 shrink-0 rounded-xl bg-[var(--hover)] object-cover"
          />
        ) : (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent-text)]">
            {card.emoji ? <span className="text-2xl leading-none">{card.emoji}</span> : <Icon className="h-5 w-5" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-[var(--text)]">{card.title}</span>
          <span className="block truncate text-xs text-[var(--text-muted)]">{card.subtitle}</span>
          {card.description && <span className="mt-0.5 line-clamp-2 block text-xs text-[var(--text-muted)]">{card.description}</span>}
        </span>
        <span
          className={
            card.action
              ? "inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-semibold text-white"
              : "inline-flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1 text-xs font-semibold text-[var(--accent-text)]"
          }
        >
          {card.action ?? "Open"} <ArrowUpRight className="h-3.5 w-3.5" />
        </span>
      </button>
      {preview && (
        <Suspense fallback={null}>
          <FilePreviewModal open file={preview} onClose={() => setPreview(null)} />
        </Suspense>
      )}
    </>
  );
}
