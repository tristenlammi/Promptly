import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";

import { mediaApi, type MediaInfo, type MediaPatch } from "@/api/files";
import { extractError } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";

/**
 * A photo's or video's own details (WP-7.3): when and where it was taken,
 * its size, the camera, a video's length, a Live Photo's pair. The owner
 * can correct the date and the place — the original file is never changed.
 */
const SOURCE: Record<string, string> = {
  exif: "from the photo",
  quicktime: "from the video",
  sidecar: "from the export",
  client: "from the file's date",
  upload: "when it was uploaded",
  edited: "edited",
};

export function isMediaFile(mime: string | null | undefined): boolean {
  const m = (mime ?? "").toLowerCase();
  return (m.startsWith("image/") && m !== "image/svg+xml") || m.startsWith("video/");
}

function taken(info: MediaInfo): string {
  if (!info.taken_at) return "—";
  const opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
  // The clock where it was taken, as Photos shows it (a zone-less ISO reads
  // as that wall time): its own offset, else the owner's zone.
  if (info.taken_local) return new Date(info.taken_local).toLocaleString(undefined, opts);
  return new Date(info.taken_at).toLocaleString(undefined, opts);
}

/** "2 dogs, a cat" */
function animalsText(species: string[]): string {
  const counts = new Map<string, number>();
  for (const s of species) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts]
    .map(([s, n]) => (n === 1 ? `${/^[aeiou]/.test(s) ? "an" : "a"} ${s}` : `${n} ${s === "sheep" || s === "fish" ? s : `${s}s`}`))
    .join(", ")
    .replace(/^./, (c) => c.toUpperCase());
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s} s`;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MediaDetails({ fileId }: { fileId: string }) {
  const qc = useQueryClient();
  const key = ["file-media", fileId];
  const { data: info } = useQuery({ queryKey: key, queryFn: () => mediaApi.get(fileId), retry: false });
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const save = useMutation({
    mutationFn: (patch: MediaPatch) => mediaApi.patch(fileId, patch),
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      setEditing(false);
    },
    onError: (e) => toast.error(extractError(e)),
  });

  if (!info) return null;
  if (!info.extracted && !info.taken_at) {
    return <p className="mt-3 text-[11px] text-[var(--text-muted)]">Reading the photo's details…</p>;
  }

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{value}</dd>
    </div>
  );

  if (editing) {
    return (
      <form
        className="mt-3 space-y-2 rounded-md border border-[var(--border)] p-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          const patch: MediaPatch = {};
          if (when) patch.taken_at = new Date(when).toISOString();
          if (lat.trim() && lon.trim()) {
            patch.lat = Number(lat);
            patch.lon = Number(lon);
          }
          save.mutate(patch);
        }}
      >
        <label className="block">
          <span className="text-[var(--text-muted)]">Taken</span>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="mt-0.5 h-8 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2"
          />
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          <label>
            <span className="text-[var(--text-muted)]">Latitude</span>
            <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" placeholder="51.5007"
              className="mt-0.5 h-8 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2" />
          </label>
          <label>
            <span className="text-[var(--text-muted)]">Longitude</span>
            <input value={lon} onChange={(e) => setLon(e.target.value)} inputMode="decimal" placeholder="-0.1246"
              className="mt-0.5 h-8 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <button type="submit" className="rounded bg-[var(--accent)] px-2.5 py-1 text-white disabled:opacity-50" disabled={save.isPending}>
            Save
          </button>
          <button type="button" className="rounded border border-[var(--border)] px-2.5 py-1" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {info.location && (
            <button type="button" className="rounded border border-[var(--border)] px-2.5 py-1"
              onClick={() => save.mutate({ hide_location: true })}>
              Remove place
            </button>
          )}
          {(info.taken_at_source === "edited" || info.location?.edited || (!info.location && info.has_original_location)) && (
            <button type="button" className="rounded border border-[var(--border)] px-2.5 py-1"
              onClick={() => save.mutate({ reset_taken_at: true, reset_location: true })}>
              Back to the original
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <dl aria-label="Photo details" className="mt-3 space-y-2 border-t border-[var(--border)] pt-3 text-xs">
      <div className="flex items-center">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {info.kind === "video" ? "Video" : "Photo"}
        </span>
        {info.can_edit && (
          <button
            type="button"
            onClick={() => {
              setWhen(toLocalInput(info.taken_at ?? null));
              setLat(info.location ? String(info.location.lat) : "");
              setLon(info.location ? String(info.location.lon) : "");
              setEditing(true);
            }}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-label="Edit date and place"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
        )}
      </div>
      {row("Taken", <>{taken(info)} <span className="text-[var(--text-muted)]">· {SOURCE[info.taken_at_source ?? ""] ?? ""}</span></>)}
      {info.location &&
        row(
          "Place",
          <>
            {info.place && (
              <span className="block" title={info.place.attribution}>
                {info.place.label}
              </span>
            )}
            <a
              href={`https://www.openstreetmap.org/?mlat=${info.location.lat}&mlon=${info.location.lon}#map=15/${info.location.lat}/${info.location.lon}`}
              target="_blank"
              rel="noreferrer noopener"
              className={info.place ? "text-xs text-[var(--accent-text)] hover:underline" : "text-[var(--accent-text)] hover:underline"}
            >
              {info.location.lat.toFixed(5)}, {info.location.lon.toFixed(5)}
            </a>
            {info.place && <span className="block text-[10px] text-[var(--text-muted)]">{info.place.attribution}</span>}
          </>
        )}
      {info.description && row("Description", info.description)}
      {info.faces && info.faces.length > 0 && row("Faces", `${info.faces.length} found`)}
      {info.animals && info.animals.length > 0 && row("Animals", animalsText(info.animals.map((a) => a.species)))}
      {info.caption && row("Described as", info.caption.text)}
      {info.text &&
        row(
          "Text in it",
          <span className="line-clamp-4 whitespace-pre-line break-words" title={info.text}>
            {info.text}
          </span>,
        )}
      {info.width && info.height ? row("Dimensions", `${info.width} × ${info.height}`) : null}
      {info.camera && row("Camera", info.camera)}
      {info.duration_ms ? row("Length", `${duration(info.duration_ms)}${info.codec ? ` · ${info.codec.toUpperCase()}` : ""}`) : null}
      {info.live_pair_file_id && row("Live Photo", "Paired with its video")}
      {info.motion_embedded && row("Motion", "Has a short video inside")}
    </dl>
  );
}
