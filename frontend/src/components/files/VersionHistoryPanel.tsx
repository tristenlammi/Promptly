import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, BookmarkCheck, Download, History, Loader2, Pencil, Plus, RotateCcw, X } from "lucide-react";

import { versionsApi, type FileVersionRow, type VersionDiff } from "@/api/versions";
import { humanSize } from "@/components/files/helpers";
import { confirm } from "@/components/shared/ConfirmDialog";
import { reloadForRestore } from "@/lib/collabReset";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Version history for a Doc, Sheet or Whiteboard (WP-6.2) — and any uploaded
 * file, whose versions are its earlier bytes (WP-8.1): versions grouped
 * by day with who edited, what restoring one would change (a text diff for
 * documents, the changed cells for sheets, shapes for whiteboards), and —
 * for editors — Restore, a name, "keep forever" and "Save a version now".
 *
 * A restore is done by the server for everyone at once: the current state
 * is kept as a version first, and every open editor (this one included)
 * reloads onto the restored file.
 */
const SOURCE: Record<string, string> = {
  auto: "Edited",
  manual: "Saved version",
  restore: "Before a restore",
  import: "Before an import",
  pre_ai: "Before an AI change",
  shrink_guard: "Before a big deletion",
  edit: "Before an edit",
  upload: "Replaced by an upload",
  generated: "Before it was regenerated",
  dav: "Replaced from a synced device",
};

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export function VersionHistoryPanel({
  fileId,
  onClose,
  onRestored,
}: {
  fileId: string;
  onClose: () => void;
  /** A PDF (WP-6.5) has no live room to reset — its viewer reloads the
   *  file instead of the page. */
  onRestored?: () => void;
}) {
  const qc = useQueryClient();
  const key = ["file-versions", fileId];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => versionsApi.list(fileId) });
  const [selected, setSelected] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const groups = useMemo(() => {
    const out: { day: string; rows: FileVersionRow[] }[] = [];
    for (const v of data?.versions ?? []) {
      const day = dayLabel(new Date(v.created_at));
      if (out.length && out[out.length - 1].day === day) out[out.length - 1].rows.push(v);
      else out.push({ day, rows: [v] });
    }
    return out;
  }, [data]);

  const update = useMutation({
    mutationFn: (args: { id: string; label?: string | null; keep_forever?: boolean }) =>
      versionsApi.update(fileId, args.id, { label: args.label, keep_forever: args.keep_forever }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't change that version.")),
  });

  const restore = async (v: FileVersionRow) => {
    const when = new Date(v.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const ok = await confirm({
      title: "Restore this version?",
      message: `The file goes back to how it was on ${when}, for everyone. What's there now is kept as a version, and anyone with it open will see it reload.`,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    try {
      await versionsApi.restore(fileId, v.id);
      if (onRestored) {
        toast.success("Restored. What was there is kept as a version.");
        await qc.invalidateQueries({ queryKey: key });
        onRestored();
      } else {
        reloadForRestore("Restored — reloading…");
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't restore that version."));
    }
  };

  const saveNow = async () => {
    if (saving === null) return;
    try {
      await versionsApi.saveNow(fileId, saving.trim() || null);
      setSaving(null);
      toast.success("Version saved.");
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save a version."));
    }
  };

  const canEdit = !!data?.can_edit;
  // Every change to an uploaded file (a PDF save, a replace) is a version
  // already; there's no live state to keep.
  const canSaveNow = canEdit && data?.kind !== "pdf" && data?.kind !== "blob";

  return (
    <aside
      aria-label="Version history"
      className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-xl sm:w-96 print:hidden"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <History className="h-4 w-4 text-[var(--text-muted)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">Version history</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close version history"
          className="ml-auto rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {canSaveNow && (
        <div className="border-b border-[var(--border)] px-3 py-2">
          {saving === null ? (
            <button
              type="button"
              onClick={() => setSaving("")}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
            >
              <Plus className="h-3.5 w-3.5" /> Save a version now
            </button>
          ) : (
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void saveNow();
              }}
            >
              <input
                autoFocus
                value={saving}
                onChange={(e) => setSaving(e.target.value)}
                placeholder="Name (optional), e.g. Sent to the bank"
                aria-label="Version name"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
              />
              <button type="submit" className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white">
                Save
              </button>
              <button type="button" onClick={() => setSaving(null)} className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)]">
                Cancel
              </button>
            </form>
          )}
        </div>
      )}

      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center gap-2 p-3 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && !groups.length && (
          <p className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
            No earlier versions yet — they're kept automatically as the file is edited.
          </p>
        )}
        {groups.map((g) => (
          <section key={g.day}>
            <h3 className="sticky top-0 z-10 bg-[var(--surface)] px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {g.day}
            </h3>
            <ul>
              {g.rows.map((v) => {
                const open = selected === v.id;
                return (
                  <li key={v.id} className={cn("border-b border-[var(--border)]/60", open && "bg-[var(--hover)]/50")}>
                    <button
                      type="button"
                      onClick={() => setSelected(open ? null : v.id)}
                      aria-expanded={open}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-[var(--hover)]"
                    >
                      <span className="w-16 shrink-0 whitespace-nowrap pt-0.5 text-xs tabular-nums text-[var(--text-muted)]">
                        {new Date(v.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate text-sm", v.label ? "font-medium text-[var(--text)]" : "text-[var(--text)]")}>
                          {v.label || SOURCE[v.source] || "Version"}
                        </span>
                        <span className="block truncate text-[11px] text-[var(--text-muted)]">
                          {v.label ? `${SOURCE[v.source] ?? "Version"}` : ""}
                          {v.authors.length
                            ? `${v.label ? " · " : ""}${v.authors.map((a) => a.username).join(", ")}`
                            : ""}
                        </span>
                      </span>
                      {v.keep_forever && <BookmarkCheck aria-label="Kept forever" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />}
                    </button>
                    {open && (
                      <div className="space-y-2 px-3 pb-3">
                        {v.download_url && (
                          <a
                            href={v.download_url}
                            download
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
                          >
                            <Download className="h-3 w-3" /> Download this version
                            <span className="text-[var(--text-muted)]">· {humanSize(v.size_bytes)}</span>
                          </a>
                        )}
                        {canEdit && (
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => void restore(v)}
                              className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                            >
                              <RotateCcw className="h-3.5 w-3.5" /> Restore this version
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setNaming(v.id);
                                setName(v.label ?? "");
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
                            >
                              <Pencil className="h-3 w-3" /> {v.label ? "Rename" : "Name it"}
                            </button>
                            <button
                              type="button"
                              aria-pressed={v.keep_forever}
                              onClick={() => update.mutate({ id: v.id, keep_forever: !v.keep_forever })}
                              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
                            >
                              {v.keep_forever ? <BookmarkCheck className="h-3 w-3" /> : <Bookmark className="h-3 w-3" />}
                              {v.keep_forever ? "Kept forever" : "Keep forever"}
                            </button>
                          </div>
                        )}
                        {naming === v.id && (
                          <form
                            className="flex gap-1.5"
                            onSubmit={(e) => {
                              e.preventDefault();
                              update.mutate({ id: v.id, label: name.trim() || null });
                              setNaming(null);
                            }}
                          >
                            <input
                              autoFocus
                              value={name}
                              onChange={(e) => setName(e.target.value)}
                              aria-label="Name this version"
                              className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
                            />
                            <button type="submit" className="rounded-md bg-[var(--accent)] px-2 py-1 text-xs text-white">
                              Save
                            </button>
                          </form>
                        )}
                        <DiffView fileId={fileId} versionId={v.id} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}

/** What restoring this version would change. */
function DiffView({ fileId, versionId }: { fileId: string; versionId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["file-version-diff", fileId, versionId],
    queryFn: () => versionsApi.diff(fileId, versionId),
    staleTime: 30_000,
  });
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Comparing with now…
      </div>
    );
  }
  if (error || !data) return <p className="text-xs text-[var(--danger)]">Couldn't compare this version.</p>;
  return (
    <div aria-label="Changes" className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-xs">
      <Diff diff={data} />
    </div>
  );
}

function Diff({ diff }: { diff: VersionDiff }) {
  if (diff.kind === "blob" && !diff.lines) {
    if (diff.same_bytes) return <p className="text-[var(--text-muted)]">Same content as now.</p>;
    return (
      <p className="text-[var(--text-muted)]">
        This version is {humanSize(diff.size_before)}; the file now is {humanSize(diff.size_after)}.
      </p>
    );
  }
  if (diff.kind === "document" || diff.kind === "pdf" || diff.kind === "blob") {
    const lines = diff.lines ?? [];
    const added = diff.added ?? 0;
    const removed = diff.removed ?? 0;
    const pages =
      diff.kind === "pdf" && diff.pages_before !== diff.pages_after ? (
        <p className="mb-1 text-[var(--text-muted)]">
          This version has {diff.pages_before} page{diff.pages_before === 1 ? "" : "s"}; the file now has {diff.pages_after}.
        </p>
      ) : null;
    if (!added && !removed) {
      return (
        <>
          {pages}
          <p className="text-[var(--text-muted)]">
            {diff.kind === "pdf" ? "Same text as now — form entries, markup or pictures may differ." : "Same text as now."}
          </p>
        </>
      );
    }
    return (
      <>
        {pages}
        <p className="mb-1 text-[var(--text-muted)]">
          Restoring brings back <span className="text-red-500">{removed}</span> line{removed === 1 ? "" : "s"} and
          removes <span className="text-emerald-600">{added}</span> added since.
        </p>
        <div className="max-h-72 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-snug">
          {lines.map((l, i) =>
            l.op === "skip" ? (
              <div key={i} className="text-center text-[var(--text-muted)]">
                … {l.text} unchanged line{l.text === "1" ? "" : "s"} …
              </div>
            ) : (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-words rounded px-1",
                  l.op === "del" && "bg-red-500/10 text-red-700 dark:text-red-300",
                  l.op === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  l.op === "same" && "text-[var(--text-muted)]"
                )}
              >
                {l.op === "del" ? "− " : l.op === "add" ? "+ " : "  "}
                {l.text}
              </div>
            )
          )}
          {diff.truncated && <div className="text-[var(--text-muted)]">… and more</div>}
        </div>
        <p className="mt-1 text-[10px] text-[var(--text-muted)]">− in this version · + added since</p>
      </>
    );
  }
  if (diff.kind === "sheet") {
    if (!diff.changed && !diff.tabs_added.length && !diff.tabs_removed.length) {
      return <p className="text-[var(--text-muted)]">Same cells as now.</p>;
    }
    return (
      <>
        <p className="mb-1 text-[var(--text-muted)]">
          {diff.changed} cell{diff.changed === 1 ? "" : "s"} differ
          {diff.tabs_added.length ? ` · tabs added since: ${diff.tabs_added.join(", ")}` : ""}
          {diff.tabs_removed.length ? ` · tabs it brings back: ${diff.tabs_removed.join(", ")}` : ""}
        </p>
        {diff.cells.length > 0 && (
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-[10px] uppercase text-[var(--text-muted)]">
                  <th className="py-0.5 pr-2 font-medium">Cell</th>
                  <th className="py-0.5 pr-2 font-medium">This version</th>
                  <th className="py-0.5 font-medium">Now</th>
                </tr>
              </thead>
              <tbody>
                {diff.cells.map((c) => (
                  <tr key={`${c.tab}!${c.ref}`} className="border-t border-[var(--border)]/60 align-top">
                    <td className="py-0.5 pr-2 font-mono text-[var(--text-muted)]">
                      {c.tab}!{c.ref}
                    </td>
                    <td className="py-0.5 pr-2">{c.before ?? <span className="text-[var(--text-muted)]">—</span>}</td>
                    <td className="py-0.5">{c.after ?? <span className="text-[var(--text-muted)]">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {diff.truncated && <p className="text-[var(--text-muted)]">… and more</p>}
          </div>
        )}
      </>
    );
  }
  const { counts } = diff;
  if (!counts.added && !counts.removed && !counts.changed) return <p className="text-[var(--text-muted)]">Same shapes as now.</p>;
  return (
    <ul className="space-y-0.5">
      {counts.removed > 0 && (
        <li>
          Brings back {counts.removed} shape{counts.removed === 1 ? "" : "s"}:{" "}
          <span className="text-[var(--text-muted)]">{diff.removed.join(", ")}</span>
        </li>
      )}
      {counts.added > 0 && (
        <li>
          Removes {counts.added} added since: <span className="text-[var(--text-muted)]">{diff.added.join(", ")}</span>
        </li>
      )}
      {counts.changed > 0 && (
        <li>
          Puts back {counts.changed} changed shape{counts.changed === 1 ? "" : "s"}:{" "}
          <span className="text-[var(--text-muted)]">{diff.changed.join(", ")}</span>
        </li>
      )}
    </ul>
  );
}
