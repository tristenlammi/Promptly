/**
 * GIFs in a conversation.
 *
 * ``AnimatedAttachment``: a GIF or animated WebP someone uploaded. It plays
 * where it is, looping. If your device asks for less motion, or the file is
 * big, it shows its first frame with a "GIF" badge until you tap it.
 *
 * ``LibraryGifView``: a GIF from the GIF library (``meta.gif``). It loads
 * straight from the library, which is what its terms require; no referrer
 * is sent, so the library doesn't learn this server's address.
 */
import { Bookmark, Play } from "lucide-react";
import { useState } from "react";

import { roomsApi, type Attachment, type LibraryGif } from "@/api/rooms";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { LIBRARY_NAMES, prefersLessMotion } from "../gifs";

/** Above this, a GIF waits for a tap: it shouldn't eat a phone's data. */
const AUTOPLAY_BYTES = 8 * 1024 * 1024;
const MAX_W = 320;
const MAX_H = 280;

export function isAnimated(a: Pick<Attachment, "mime" | "animated">): boolean {
  // GIFs sent before the server started marking them count too.
  return a.animated === true || a.mime === "image/gif";
}

function box(w?: number | null, h?: number | null): { width: number; height: number } | null {
  if (!w || !h) return null;
  const k = Math.min(1, MAX_W / w, MAX_H / h);
  return { width: Math.max(48, Math.round(w * k)), height: Math.max(48, Math.round(h * k)) };
}

/** Save to your GIFs, with the words people see either way. */
export async function saveGif(body: { attachment_id: string } | { gif: LibraryGif }) {
  try {
    await roomsApi.saveGif(body);
    toast.success("Saved to your GIFs");
  } catch (err) {
    toast.error(apiErrorMessage(err, "Couldn't save that GIF."));
  }
}

function SaveButton({ onSave }: { onSave: () => void }) {
  return (
    <button
      type="button"
      aria-label="Save to your GIFs"
      title="Save to your GIFs"
      onClick={(e) => {
        e.stopPropagation();
        onSave();
      }}
      className="absolute right-1.5 top-1.5 hidden h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white group-hover/gif:flex"
    >
      <Bookmark className="h-4 w-4" />
    </button>
  );
}

function GifBadge({ waiting }: { waiting: boolean }) {
  return (
    <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-white">
      {waiting && <Play className="h-3 w-3 fill-current" />}
      GIF
    </span>
  );
}

export function AnimatedAttachment({ a, onOpen, saveable }: { a: Attachment; onOpen: () => void; saveable?: boolean }) {
  const [play, setPlay] = useState(() => !prefersLessMotion() && a.size <= AUTOPLAY_BYTES);
  const size = box(a.width, a.height) ?? { width: 220, height: 160 };
  return (
    <div className="group/gif relative w-fit max-w-full overflow-hidden rounded-xl bg-[var(--surface-2)]">
      <button
        type="button"
        onClick={() => (play ? onOpen() : setPlay(true))}
        aria-label={play ? `Open ${a.filename}` : `Play ${a.filename}`}
        className="block max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        style={{ width: size.width, aspectRatio: `${size.width} / ${size.height}` }}
      >
        <img
          src={play ? a.url : (a.thumb_url ?? a.url)}
          alt={a.filename}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-contain"
        />
      </button>
      <GifBadge waiting={!play} />
      {saveable && <SaveButton onSave={() => void saveGif({ attachment_id: a.id })} />}
    </div>
  );
}

export function LibraryGifView({ gif, saveable }: { gif: LibraryGif; saveable?: boolean }) {
  const [play, setPlay] = useState(() => !prefersLessMotion());
  const [broken, setBroken] = useState(false);
  const size = box(gif.width, gif.height) ?? { width: 240, height: 180 };
  const name = LIBRARY_NAMES[gif.provider];
  const label = gif.title || "GIF";
  return (
    <div className="flex max-w-full flex-col gap-0.5">
      <div className="group/gif relative w-fit max-w-full overflow-hidden rounded-xl bg-[var(--surface-2)]">
        {broken ? (
          <div className="flex items-center justify-center px-4 text-center text-xs text-[var(--text-muted)]" style={{ width: size.width, height: Math.min(size.height, 120) }}>
            This GIF isn't on {name} any more.
          </div>
        ) : play ? (
          <a
            href={gif.page_url ?? gif.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            aria-label={`Open ${label} on ${name}`}
            className="block max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{ width: size.width, aspectRatio: `${size.width} / ${size.height}` }}
          >
            <img
              src={gif.url}
              alt={label}
              loading="lazy"
              draggable={false}
              referrerPolicy="no-referrer"
              onError={() => setBroken(true)}
              className="h-full w-full object-contain"
            />
          </a>
        ) : (
          <button
            type="button"
            onClick={() => setPlay(true)}
            aria-label={`Play ${label}`}
            className={cn("flex items-center justify-center text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]")}
            style={{ width: size.width, height: Math.min(size.height, 140) }}
          >
            <Play className="h-7 w-7" />
          </button>
        )}
        {!broken && <GifBadge waiting={!play} />}
        {saveable && !broken && <SaveButton onSave={() => void saveGif({ gif })} />}
      </div>
      <span className="text-[11px] text-[var(--text-muted)]">via {name}</span>
    </div>
  );
}
