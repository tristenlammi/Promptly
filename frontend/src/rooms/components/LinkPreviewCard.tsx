/**
 * A link's preview: the page's name, a line about it and its picture.
 *
 * This server fetched the page once and keeps its own small copy of the
 * picture, so showing the card contacts nobody: your device only talks to
 * the site if you tap through. The sender can take the card off.
 */
import { X } from "lucide-react";

import { roomsApi, type LinkPreview } from "@/api/rooms";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { useRoomsStore } from "../store";

export async function removePreview(messageId: string) {
  try {
    useRoomsStore.getState().upsertMessage(await roomsApi.removePreview(messageId));
  } catch (err) {
    toast.error(apiErrorMessage(err, "Couldn't remove the preview."));
  }
}

export function LinkPreviewCard({ preview, messageId, own }: { preview: LinkPreview; messageId: string; own: boolean }) {
  // A wide picture goes across the top; a square or tall one sits small on the right.
  const wide = preview.image && !!preview.w && !!preview.h && preview.w / preview.h >= 1.3 && preview.w >= 300;
  const picture = preview.image && preview.image_url ? preview.image_url : null;
  return (
    <div className="group/prev relative mt-1 w-full max-w-[420px]">
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "flex overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
          wide ? "flex-col" : "items-stretch",
        )}
      >
        {picture && wide && (
          <img
            src={picture}
            alt=""
            loading="lazy"
            draggable={false}
            className="max-h-[220px] w-full bg-[var(--surface-2)] object-cover"
            style={{ aspectRatio: `${preview.w} / ${preview.h}` }}
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 border-l-[3px] border-[var(--accent)] px-3 py-2">
          {preview.site && <span className="truncate text-xs text-[var(--text-muted)]">{preview.site}</span>}
          <span className="line-clamp-2 break-words text-sm font-semibold leading-snug text-[var(--text)]">{preview.title}</span>
          {preview.description && <span className="line-clamp-2 break-words text-xs leading-snug text-[var(--text-muted)]">{preview.description}</span>}
        </span>
        {picture && !wide && <img src={picture} alt="" loading="lazy" draggable={false} className="h-[76px] w-[76px] shrink-0 self-center bg-[var(--surface-2)] object-cover" />}
      </a>
      {own && (
        <button
          type="button"
          aria-label="Remove the preview"
          title="Remove the preview"
          onClick={() => void removePreview(messageId)}
          className="absolute right-1.5 top-1.5 hidden h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white group-hover/prev:flex"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
