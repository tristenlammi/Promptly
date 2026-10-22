import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, FileArchive, FolderArchive, Images, Loader2, Trash2, Upload, X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { importsApi, type ImportJob, type ImportReport, type ImportSource } from "@/api/imports";
import { humanSize } from "@/components/files/helpers";
import { LibraryExport } from "@/components/files/LibraryExport";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { tusUpload } from "@/lib/tusUpload";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Moving in (WP-10.1, 10.3, Part C §4.9): bring a Google Takeout, a folder of
 * photos or an Apple export across — upload its parts, let Promptly read
 * them, see what's in them, then import.
 */

interface SourceText {
  title: string;
  card: string;
  add: string;
  how: string;
  wrongFile: string;
  details: string;
  otherwise: string;
  trash: string;
  files: string;
}

const SOURCES: Record<ImportSource, SourceText> = {
  takeout: {
    title: "Google Takeout",
    card: "Google Photos (and Drive files) from takeout.google.com.",
    add: "Add every part of your Takeout",
    how:
      "At takeout.google.com choose Google Photos (and Drive, if you want your files too). Google sends one or more " +
      ".zip or .tgz parts — add all of them; a photo and its details are often in different parts.",
    wrongFile: "add the .zip or .tgz files Google Takeout gave you.",
    details: "come with Google's details (date taken, place, description)",
    otherwise: "use the date inside the photo, or its year folder",
    trash: "in Google's trash are left out",
    files: "Drive files",
  },
  folder: {
    title: "A folder of photos",
    card: "A zip of any folder — an old drive, a camera's card, another service's download.",
    add: "Add the folder as a zip",
    how:
      "Zip the folder (Windows: right-click → Send to → Compressed folder; Mac: right-click → Compress) and add the " +
      "zip — or several, for a big one. Photos and videos go by the date inside them; every other file keeps its folders.",
    wrongFile: "zip the folder first, then add the .zip.",
    details: "come with an XMP sidecar (date taken, place, description)",
    otherwise: "use the date inside the photo, or the file's own date",
    trash: "were left out",
    files: "other files",
  },
  apple: {
    title: "Apple Photos export",
    card: "An iCloud Photos download or a Photos app export.",
    add: "Add your Apple export",
    how:
      "From Photos on a Mac: select the photos, File → Export → Export Unmodified Original with “Export IPTC as XMP” " +
      "ticked, then zip that folder and add it. From iCloud: at privacy.apple.com request a copy of your iCloud Photos " +
      "and add every .zip part Apple sends.",
    wrongFile: "add the .zip files (zip a Photos export folder first).",
    details: "come with Apple's details (date taken, and place from an XMP sidecar)",
    otherwise: "use the date inside the photo, or the file's own date",
    trash: "deleted in iCloud are left out",
    files: "other files",
  },
};

const STATE_LABEL: Record<ImportJob["state"], string> = {
  collecting: "Adding parts",
  indexing: "Reading the archives…",
  ready: "Ready to import",
  importing: "Importing…",
  done: "Imported",
  failed: "Needs attention",
  cancelled: "Cancelled",
};

export function ImportsPage() {
  const navigate = useNavigate();
  const { data: jobs = [], isLoading } = useQuery({ queryKey: ["imports"], queryFn: importsApi.list });
  const start = async (source: ImportSource) => {
    try {
      const job = await importsApi.create(source);
      navigate(`/files/import/${job.id}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't start an import."));
    }
  };
  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <h1 className="text-lg font-semibold text-[var(--text)]">Import &amp; export</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Bring your photos, videos and files across from another service. They land in your Files and Photos with
        their dates, places and albums — and importing the same thing twice doesn't make copies.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {(Object.keys(SOURCES) as ImportSource[]).map((source) => {
          const Icon = source === "folder" ? FolderArchive : Images;
          return (
            <button
              key={source}
              type="button"
              onClick={() => void start(source)}
              className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition hover:border-[var(--accent)]"
            >
              <Icon className="h-6 w-6 text-[var(--accent-text)]" />
              <p className="mt-2 text-sm font-medium text-[var(--text)]">{SOURCES[source].title}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">{SOURCES[source].card}</p>
            </button>
          );
        })}
      </div>
      {!isLoading && jobs.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-semibold text-[var(--text)]">Your imports</h2>
          <ul className="mt-2 divide-y divide-[var(--border)] rounded-card border border-[var(--border)]" aria-label="Your imports">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link to={`/files/import/${j.id}`} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-[var(--hover)]">
                  <FileArchive className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <span className="flex-1">
                    {SOURCES[j.source].title} · {j.parts.length} {j.parts.length === 1 ? "part" : "parts"}
                    <span className="block text-xs text-[var(--text-muted)]">{new Date(j.created_at).toLocaleString()}</span>
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">{STATE_LABEL[j.state]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <LibraryExport />
    </div>
  );
}

interface Sending {
  name: string;
  sent: number;
  total: number;
  abort: AbortController;
}

export function ImportJobPage() {
  const { importId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const key = ["import", importId];
  const { data: job, error } = useQuery({
    queryKey: key,
    queryFn: () => importsApi.get(importId),
    refetchInterval: (q) => {
      const s = (q.state.data as ImportJob | undefined)?.state;
      return s === "indexing" || s === "importing" ? 2000 : false;
    },
  });
  const [sending, setSending] = useState<Sending[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  if (error) return <p className="p-6 text-sm text-[var(--text-muted)]">This import isn't there any more.</p>;
  if (!job) return <p className="p-6 text-sm text-[var(--text-muted)]">Loading…</p>;
  const canAdd = job.state === "collecting" || job.state === "ready" || job.state === "failed";
  const text = SOURCES[job.source];

  const send = async (files: FileList | File[]) => {
    let added = 0;
    for (const file of Array.from(files)) {
      if (!/\.(zip|tgz|tar\.gz|tar)$/i.test(file.name)) {
        toast.error(`${file.name}: ${text.wrongFile}`);
        continue;
      }
      const abort = new AbortController();
      const row: Sending = { name: file.name, sent: 0, total: file.size, abort };
      setSending((cur) => [...cur, row]);
      try {
        await tusUpload({
          file,
          metadata: { filename: file.name, import_job: job.id },
          signal: abort.signal,
          onProgress: (sent, total) => setSending((cur) => cur.map((s) => (s === row || s.name === file.name ? { ...s, sent, total } : s))),
        });
        added += 1;
        refresh();
      } catch (e) {
        if ((e as DOMException)?.name !== "AbortError") toast.error(`${file.name}: ${apiErrorMessage(e, "couldn't upload")}`);
      } finally {
        setSending((cur) => cur.filter((s) => s.name !== file.name));
      }
    }
    // The parts are in: read them straight away rather than wait for a
    // click that's easy to miss after a long upload. Adding another part
    // later just reads them all again.
    if (added > 0) {
      await importsApi
        .check(job.id)
        .then(refresh)
        .catch((e) => toast.error(apiErrorMessage(e, "Couldn't read them.")));
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <Link to="/files/import" className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
        <ArrowLeft className="h-3.5 w-3.5" /> Imports
      </Link>
      <div className="mt-2 flex items-center gap-2">
        <h1 className="flex-1 text-lg font-semibold text-[var(--text)]">{text.title}</h1>
        <span role="status" className="text-xs text-[var(--text-muted)]">{STATE_LABEL[job.state]}</span>
      </div>

      {canAdd && (
        <section aria-label="Parts" className="mt-4 rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm text-[var(--text)]">1. {text.add}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {text.how} Big parts upload in pieces and carry on if the connection drops.
          </p>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void send(e.dataTransfer.files);
            }}
            className="mt-3 flex flex-col items-center gap-2 rounded-md border border-dashed border-[var(--border)] p-6 text-center"
          >
            <Upload className="h-5 w-5 text-[var(--text-muted)]" />
            <p className="text-xs text-[var(--text-muted)]">Drop the parts here, or</p>
            <input ref={picker} type="file" multiple accept=".zip,.tgz,.tar,.gz" hidden onChange={(e) => e.target.files && void send(e.target.files)} />
            <Button size="sm" variant="secondary" onClick={() => picker.current?.click()}>
              Choose files
            </Button>
          </div>
          {(job.parts.length > 0 || sending.length > 0) && (
            <ul className="mt-3 space-y-1.5 text-xs" aria-label="Uploaded parts">
              {job.parts.map((p) => (
                <li key={p.n} className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="text-[var(--text-muted)]">{humanSize(p.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => void importsApi.removePart(job.id, p.n).then(refresh)}
                    className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--hover)]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
              {sending.map((s) => (
                <li key={s.name} className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="w-24 overflow-hidden rounded bg-[var(--hover)]">
                    <span className="block h-1.5 bg-[var(--accent)]" style={{ width: `${s.total ? (100 * s.sent) / s.total : 0}%` }} />
                  </span>
                  <button type="button" aria-label={`Stop ${s.name}`} onClick={() => s.abort.abort()} className="rounded p-0.5 hover:bg-[var(--hover)]">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {job.parts.length > 0 && sending.length === 0 && job.state !== "ready" && (
            <div className="mt-4">
              <p className="mb-2 text-sm text-[var(--text)]">2. Each upload is checked when it finishes — or check them again now</p>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void importsApi.check(job.id).then(refresh).catch((e) => toast.error(apiErrorMessage(e, "Couldn't read them.")))}
              >
                Check the archives
              </Button>
            </div>
          )}
        </section>
      )}

      {job.state === "indexing" && (
        <p className="mt-4 flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading every part and matching photos with their details…
        </p>
      )}
      {job.error && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-md bg-[var(--hover)] p-3 text-sm text-[var(--text)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /> {job.error}
        </p>
      )}
      {job.report && job.state !== "importing" && job.state !== "done" && <Report report={job.report} text={text} />}
      {job.report && (job.state === "ready" || (job.state === "failed" && job.progress)) && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-[var(--text)]">3. Bring it in</p>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void importsApi.start(job.id).then(refresh).catch((e) => toast.error(apiErrorMessage(e, "Couldn't start the import.")))}
          >
            {job.state === "failed" ? "Carry on importing" : "Import"}
          </Button>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Photos go to your Photos folder by the month they were taken; anything you already have isn't copied again. You
            can leave this page — you'll get a notification when it's done.
          </p>
        </div>
      )}
      {job.progress && (job.state === "importing" || job.state === "done" || job.state === "cancelled") && (
        <Progress job={job} />
      )}

      <div className="mt-6 flex gap-2">
        {job.state !== "importing" && job.state !== "done" && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={async () => {
              if (!(await confirm({ title: "Cancel this import?", message: "Its uploaded parts are deleted. Nothing in your Files changes.", confirmLabel: "Cancel import", danger: true }))) return;
              await importsApi.cancel(job.id);
              void qc.invalidateQueries({ queryKey: ["imports"] });
              navigate("/files/import");
            }}
          >
            Cancel import
          </Button>
        )}
      </div>
    </div>
  );
}

const STAGE: Record<string, string> = { photos: "Photos and videos", albums: "Albums", drive: "Drive files" };

function Progress({ job }: { job: ImportJob }) {
  const p = job.progress!;
  const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
  const done = job.state === "done";
  return (
    <section aria-label="Import progress" className="mt-4 rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      {done ? (
        <p className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" /> It's in.
        </p>
      ) : (
        <>
          <p className="text-sm text-[var(--text)]">
            {STAGE[(p as { stage?: string }).stage ?? "photos"] ?? "Importing"} — {p.done.toLocaleString()} of {p.total.toLocaleString()}
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded bg-[var(--hover)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="new" value={p.imported.toLocaleString()} />
        <Stat label="already there" value={p.duplicates.toLocaleString()} />
        {(job.source === "takeout" || (p.albums ?? 0) > 0) && <Stat label="albums made" value={(p.albums ?? 0).toLocaleString()} />}
        <Stat label="couldn't import" value={p.failed.toLocaleString()} />
      </div>
      {done && (
        <p className="mt-3 flex flex-wrap gap-3 text-sm">
          <Link to="/files/photos" className="text-[var(--accent-text)] hover:underline">Open Photos</Link>
          {(job.source === "takeout" || (p.albums ?? 0) > 0) && <Link to="/files/photos/albums" className="text-[var(--accent-text)] hover:underline">Albums</Link>}
          {(p.drive ?? 0) > 0 && (
            <Link to="/files" className="text-[var(--accent-text)] hover:underline">
              Your {SOURCES[job.source].files} are in “{job.report?.files_root ?? "Google Drive"}”
            </Link>
          )}
        </p>
      )}
      {(p.failures?.length ?? 0) > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-[var(--text)]">What couldn't be imported</summary>
          <ul className="mt-1 space-y-0.5 text-[var(--text-muted)]">
            {p.failures!.map((f, i) => (
              <li key={i} className="truncate">
                {f.name} — {f.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-[var(--hover)] px-3 py-2">
      <p className="text-lg font-semibold text-[var(--text)]">{value}</p>
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      {hint && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

function Report({ report: r, text }: { report: ImportReport; text: SourceText }) {
  const total = r.photos + r.videos;
  const pct = total ? Math.round((100 * r.with_details) / total) : 0;
  return (
    <section aria-label="What's in it" className="mt-4 rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-sm font-medium text-[var(--text)]">What's in it</p>
      <div className={cn("mt-3 grid gap-2", "grid-cols-2 sm:grid-cols-4")}>
        <Stat label="photos" value={r.photos.toLocaleString()} />
        <Stat label="videos" value={r.videos.toLocaleString()} />
        <Stat label="albums" value={r.albums.length.toLocaleString()} />
        <Stat label={text.files} value={r.drive_files.toLocaleString()} />
      </div>
      <ul className="mt-3 space-y-1 text-xs text-[var(--text-muted)]">
        {r.years && <li>From {r.years[0]} to {r.years[1]} · {humanSize(r.bytes)} in all</li>}
        <li>
          {pct}% {text.details}
          {total - r.with_details > 0 ? ` — the other ${total - r.with_details} ${text.otherwise}` : ""}
        </li>
        {r.favorites > 0 && <li>{r.favorites} favourites become starred</li>}
        {r.archived > 0 && <li>{r.archived} archived photos stay archived</li>}
        {r.files_root && r.drive_files > 0 && <li>Files that aren't photos keep their folders in “{r.files_root}”</li>}
        {r.skipped.trash > 0 && <li>{r.skipped.trash} {text.trash}</li>}
        {r.skipped.unsupported > 0 && <li>{r.skipped.unsupported} files of a kind Promptly doesn't take are left out</li>}
        {r.other_products.length > 0 && <li>Not imported: {r.other_products.join(", ")}</li>}
      </ul>
      {r.albums.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-[var(--text)]">Albums</summary>
          <ul className="mt-1 columns-2 text-[var(--text-muted)]">
            {r.albums.map((a) => (
              <li key={a.title}>
                {a.title} · {a.count}
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.unmatched_sample.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-[var(--text)]">Some without Google's details</summary>
          <ul className="mt-1 text-[var(--text-muted)]">
            {r.unmatched_sample.map((n) => (
              <li key={n} className="truncate">
                {n}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
