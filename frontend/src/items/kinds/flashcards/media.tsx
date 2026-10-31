import { ImageOff, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";

import { apiClient } from "@/api/client";
import { filesApi } from "@/api/files";

/*
 * Card media. Images and audio live in the person's Drive (folder
 * "Flashcards media") and a card references them in its Markdown:
 *
 *   ![alt](drive:<file id>)          an image
 *   ![audio: name](drive:<file id>)  a sound (played with <audio controls>)
 *
 * Web images (``![alt](https://…)``) work too. Drive files are fetched with
 * the person's session (authenticated download → blob URL) and kept in the
 * Cache Storage, so a card seen once shows its media offline later; media
 * never seen on this device need a connection.
 *
 * Uploading uses the ordinary Files API (``filesApi.upload``) — the same
 * allowlist, sniffing and EXIF stripping as any upload.
 */

export const MEDIA_FOLDER = "Flashcards media";
const CACHE = "promptly-flashcards-media-v1";
const AUDIO_EXT = /\.(mp3|m4a|ogg|oga|wav|aac|flac|webm)(\?|#|$)/i;

export const isAudioRef = (alt: string, src: string) => /^audio\b/i.test(alt.trim()) || AUDIO_EXT.test(src);

let folderId: Promise<string> | null = null;

/** The "Flashcards media" folder at the top of My files (made once). */
async function mediaFolder(): Promise<string> {
  if (!folderId) {
    folderId = (async () => {
      const root = await filesApi.subfolders("mine", null);
      const hit = root.folders.find((f) => f.name === MEDIA_FOLDER && !f.trashed_at);
      if (hit) return hit.id;
      return (await filesApi.createFolder("mine", MEDIA_FOLDER, null)).id;
    })().catch((e) => {
      folderId = null;
      throw e;
    });
  }
  return folderId;
}

export interface Uploaded {
  id: string;
  kind: "image" | "audio";
  name: string;
  markdown: string;
}

/** Upload an image or audio file to Drive → the Markdown to insert. */
export async function uploadMedia(file: File): Promise<Uploaded> {
  const mime = (file.type || "").toLowerCase();
  const kind: "image" | "audio" | null = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") || AUDIO_EXT.test(file.name) ? "audio" : null;
  if (!kind) throw new Error("Only images and audio files can go on a card.");
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Adding media needs a connection.");
  const folder = await mediaFolder();
  const row = await filesApi.upload("mine", file, folder);
  const name = (file.name || kind).replace(/\.[^.]+$/, "").replace(/[[\]()\n]/g, "").slice(0, 60) || kind;
  const markdown = kind === "audio" ? `![audio: ${name}](drive:${row.id})` : `![${name}](drive:${row.id})`;
  return { id: row.id, kind, name, markdown };
}

/** ``![alt](https://…)`` for a pasted link, or null when it isn't one. */
export function linkMarkdown(url: string, audio: boolean): string | null {
  const u = url.trim();
  if (!/^https?:\/\/\S+$/i.test(u)) return null;
  return audio ? `![audio](${u})` : `![](${u})`;
}

const blobUrls = new Map<string, Promise<string>>();

async function driveBlobUrl(id: string): Promise<string> {
  const key = `/flashcards-media/${id}`;
  let cache: Cache | null = null;
  try {
    cache = typeof caches !== "undefined" ? await caches.open(CACHE) : null;
    const hit = await cache?.match(key);
    if (hit) return URL.createObjectURL(await hit.blob());
  } catch {
    cache = null; // private mode etc.: no offline copy
  }
  const res = await apiClient.get<Blob>(filesApi.downloadUrl(id).replace(/^\/api/, ""), { responseType: "blob", timeout: 60_000 });
  const blob = res.data;
  try {
    await cache?.put(key, new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream" } }));
  } catch {
    // Storage full — fine, it just won't be there offline.
  }
  return URL.createObjectURL(blob);
}

function useDriveUrl(id: string | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (!id) return;
    let live = true;
    let p = blobUrls.get(id);
    if (!p) {
      p = driveBlobUrl(id);
      blobUrls.set(id, p);
      p.catch(() => blobUrls.delete(id));
    }
    p.then(
      (url) => live && setState({ url, failed: false }),
      () => live && setState({ url: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  return state;
}

const ID = /^drive:([0-9a-f-]{36})$/i;

/** What a card's ``![…](…)`` renders as. */
export function CardMedia({ src, alt }: { src: string; alt: string }) {
  const m = ID.exec(src.trim());
  const { url, failed } = useDriveUrl(m ? m[1] : null);
  const audio = isAudioRef(alt, src);
  const label = alt.replace(/^audio:?\s*/i, "").trim();
  if (m && failed)
    return (
      <span className="mx-auto my-2 inline-flex items-center gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-muted)]">
        <ImageOff className="h-4 w-4" />
        {typeof navigator !== "undefined" && !navigator.onLine ? "Media needs a connection" : "Media unavailable"}
      </span>
    );
  const href = m ? url : /^https?:\/\//i.test(src) ? src : null;
  if (!href)
    return m ? <span className="mx-auto my-2 block h-24 w-40 animate-pulse rounded-xl bg-[var(--surface-2)]" aria-label="Loading media" /> : null;
  if (audio)
    return (
      <span className="my-2 flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
        <Volume2 className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
        <audio controls preload="metadata" src={href} aria-label={label || "Audio"} className="h-10 max-w-full" />
      </span>
    );
  return <img src={href} alt={alt} loading="lazy" referrerPolicy="no-referrer" className="mx-auto my-2 max-h-[40vh] max-w-full rounded-xl" />;
}
