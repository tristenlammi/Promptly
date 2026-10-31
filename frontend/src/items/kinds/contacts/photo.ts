/*
 * Contact photos: shrunk on the device (canvas) to a small JPEG data URL so a
 * photo works offline and stays inside the file (the server caps one at
 * ~60 KB and all of them together at ~3.3 MB — see models.py).
 */

/** The server's caps, in data-URL characters. */
export const PHOTO_MAX_CHARS = 82_000;
export const PHOTO_BUDGET_CHARS = 4_500_000;

const OK = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function validPhoto(v: string | null | undefined): boolean {
  return !!v && v.length <= PHOTO_MAX_CHARS && OK.test(v);
}

async function toBitmap(src: Blob | string): Promise<ImageBitmap | HTMLImageElement> {
  const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall back to <img> (some HEIC / odd files) */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * ``src`` (a File, a Blob or a data URL) as a square-cropped JPEG at most
 * ``size`` px, re-encoded until it's under ``maxChars``. Null when it can't
 * be read or won't fit.
 */
export async function shrinkPhoto(src: Blob | string, { size = 256, maxChars = 40_000 }: { size?: number; maxChars?: number } = {}): Promise<string | null> {
  try {
    const img = await toBitmap(src);
    const w = "naturalWidth" in img ? img.naturalWidth : img.width;
    const h = "naturalHeight" in img ? img.naturalHeight : img.height;
    if (!w || !h) return null;
    const side = Math.min(w, h);
    const sx = (w - side) / 2;
    const sy = (h - side) / 2;
    const limit = Math.min(maxChars, PHOTO_MAX_CHARS);
    for (let px = Math.min(size, side); px >= 64; px = Math.round(px * 0.75)) {
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#ffffff"; // transparent PNGs get a white background in JPEG
      ctx.fillRect(0, 0, px, px);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img as CanvasImageSource, sx, sy, side, side, 0, 0, px, px);
      for (const q of [0.85, 0.75, 0.65, 0.55]) {
        const url = canvas.toDataURL("image/jpeg", q);
        if (url.length <= limit && OK.test(url)) return url;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** All photos in the file, in data-URL characters. */
export function photoChars(contacts: { photo?: string | null }[]): number {
  let n = 0;
  for (const c of contacts) n += c.photo?.length ?? 0;
  return n;
}
