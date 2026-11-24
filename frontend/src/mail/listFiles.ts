import type { ListFile, MailLayout } from "./api";

/** How many names a row shows before "+N": what fits on one line. */
export const CHIPS_SPLIT = 2;
export const CHIPS_FULL = 3;

export type FileKind = "picture" | "pdf" | "sheet" | "slides" | "doc" | "video" | "audio" | "zip" | "calendar" | "file";

const BY_EXT: Record<string, FileKind> = {
  pdf: "pdf",
  jpg: "picture", jpeg: "picture", png: "picture", gif: "picture", webp: "picture", heic: "picture", heif: "picture", bmp: "picture", svg: "picture", tif: "picture", tiff: "picture", avif: "picture",
  xls: "sheet", xlsx: "sheet", xlsm: "sheet", csv: "sheet", tsv: "sheet", ods: "sheet", numbers: "sheet",
  ppt: "slides", pptx: "slides", odp: "slides", key: "slides",
  doc: "doc", docx: "doc", odt: "doc", rtf: "doc", txt: "doc", md: "doc", pages: "doc",
  mp4: "video", mov: "video", mkv: "video", webm: "video", avi: "video", m4v: "video",
  mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", flac: "audio", aac: "audio", opus: "audio",
  zip: "zip", rar: "zip", "7z": "zip", gz: "zip", tar: "zip", tgz: "zip",
  ics: "calendar",
};

/** The name in two parts, so a long one can be cut in the middle and still show
 *  what kind of file it is: "Quarterly report fin" + "al.pdf". The end is never cut. */
export function nameParts(name: string): [string, string] {
  const clean = name.trim() || "attachment";
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 ? clean.slice(dot) : "";
  // Not an extension: a sentence with a full stop in it, or a name that ends in one.
  const real = ext.length >= 2 && ext.length <= 9 && !/\s/.test(ext);
  const stem = real ? clean.slice(0, dot) : clean;
  const tail = real ? ext : "";
  // A few letters before the dot stay too: "…al.pdf" reads better than "….pdf".
  const keep = Math.min(2, Math.max(0, stem.length - 4));
  return [stem.slice(0, stem.length - keep), stem.slice(stem.length - keep) + tail];
}

export function fileKind(name: string, mime: string): FileKind {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (BY_EXT[ext]) return BY_EXT[ext];
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "picture";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m === "text/calendar") return "calendar";
  if (m.includes("spreadsheet") || m.includes("excel")) return "sheet";
  if (m.includes("presentation") || m.includes("powerpoint")) return "slides";
  if (m.includes("word") || m.startsWith("text/")) return "doc";
  if (m.includes("zip") || m.includes("compressed")) return "zip";
  return "file";
}

/** Which names a row shows, and how many it only counts. `total` is every file in
 *  the conversation: the list is sent the first few. */
export function chipsFor(files: ListFile[] | undefined, total: number | undefined, room: number): { shown: ListFile[]; more: number } {
  const all = files ?? [];
  const shown = all.slice(0, Math.max(0, room));
  return { shown, more: Math.max(total ?? all.length, all.length) - shown.length };
}

/** The other files of the same email, for stepping through in the viewer. */
export function sameEmail(files: ListFile[], picked: ListFile): { files: ListFile[]; start: number } {
  const together = files.filter((f) => f.message_id === picked.message_id);
  return { files: together, start: Math.max(0, together.findIndex((f) => f.part === picked.part)) };
}

export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The layout in use: a phone always shows the list, then the email. */
export function layoutInUse(chosen: MailLayout | undefined, isMobile: boolean): MailLayout {
  return !isMobile && chosen === "full" ? "full" : "split";
}

const OPEN_LINK = /^[0-9a-f-]{36}\/[0-9a-zA-Z_-]{1,40}$/;

/** The open conversation named in the address (`?open=<mailbox>/<conversation>`). */
export function openInAddress(search: string): { account_id: string; key: string } | null {
  const link = new URLSearchParams(search).get("open");
  if (!link || !OPEN_LINK.test(link)) return null;
  const [account_id, key] = link.split("/");
  return { account_id, key };
}

/** The same address with that conversation open, or none. */
export function addressWith(search: string, open: { account_id: string; key: string } | null): string {
  const params = new URLSearchParams(search);
  if (open) params.set("open", `${open.account_id}/${open.key}`);
  else params.delete("open");
  // A slash is fine in a query, and it keeps the link readable and the same as the ones Promptly already makes.
  const out = params.toString().replace(/%2F/gi, "/");
  return out ? `?${out}` : "";
}
