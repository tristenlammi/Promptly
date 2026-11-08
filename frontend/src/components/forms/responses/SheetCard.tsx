import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet, Link2Off, Loader2, MoreHorizontal, RefreshCw, Search, Table2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";

import { filesApi, type FileItem } from "@/api/files";
import { formsApi, type LinkedSheet, type ResponsesSummary } from "@/api/forms";
import { Menu, MenuItem, fieldCls } from "@/components/forms/builder/ui";
import { displayFileName, extractError } from "@/components/files/helpers";
import { Button } from "@/components/shared/Button";
import { Callout } from "@/components/shared/Callout";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Sheet } from "@/items/ui/Sheet";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

/**
 * The Sheet card on the Responses tab (Forms WP-F1.5): which sheet the
 * answers go into and how up to date it is, with Sync now and Unlink — or,
 * before one is linked, "Link to a sheet". Every answer is added to the
 * sheet as it arrives (live, even while the sheet is open), a changed answer
 * rewrites its row (found by Response #, so sorting the sheet is fine), and
 * deleting an answer here leaves the sheet alone.
 */
export function SheetCard({
  fileId,
  summary,
  canEdit,
  formTitle,
}: {
  fileId: string;
  summary: ResponsesSummary;
  canEdit: boolean;
  formTitle: string;
}) {
  const qc = useQueryClient();
  const sheet = summary.sheet;
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const canChange = canEdit && summary.can_link_sheet;

  const put = (s: LinkedSheet | null) =>
    qc.setQueryData<ResponsesSummary>(["form-summary", fileId], (cur) => (cur ? { ...cur, sheet: s } : cur));

  const syncNow = async () => {
    setSyncing(true);
    try {
      const s = await formsApi.syncSheet(fileId);
      put(s);
      if (s?.problem) toast.error(s.message ?? "The sheet couldn't be updated.");
      else toast.success("The sheet is up to date.");
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setSyncing(false);
    }
  };

  const unlink = async () => {
    const ok = await confirm({
      title: "Unlink the sheet?",
      message: `New answers won't be added to “${sheet?.title ?? "the sheet"}” any more. The sheet and everything in it stay as they are.`,
      confirmLabel: "Unlink",
    });
    if (!ok) return;
    try {
      await formsApi.unlinkSheet(fileId);
      put(null);
      toast.success("Unlinked. The sheet is still in your files.");
    } catch (e) {
      toast.error(extractError(e));
    }
  };

  if (!sheet) {
    if (!canChange) return null;
    return (
      <section
        aria-label="Answers in a sheet"
        data-testid="sheet-card"
        className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
      >
        <Table2 className="h-5 w-5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm text-[var(--text-muted)]">
          Keep every answer in a sheet, added as it comes in.
        </p>
        <Button size="sm" leftIcon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => setLinking(true)}>
          Link to a sheet
        </Button>
        <LinkSheetDialog open={linking} onClose={() => setLinking(false)} fileId={fileId} formTitle={formTitle} onLinked={put} />
      </section>
    );
  }

  const gone = sheet.problem === "deleted" || sheet.problem === "trashed" || sheet.problem === "tab_deleted" || sheet.problem === "full";
  const title = sheet.title ?? "Deleted sheet";
  return (
    <section aria-label="Linked sheet" data-testid="sheet-card" className="mt-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <FileSpreadsheet className="h-5 w-5 shrink-0 text-[var(--accent-text)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--text)]">
            {sheet.file_id && sheet.can_open && sheet.problem !== "deleted" ? (
              <Link to={`/files/sheet/${sheet.file_id}`} className="hover:underline focus-visible:underline focus-visible:outline-none" data-testid="sheet-link">
                {title}
              </Link>
            ) : (
              title
            )}
          </p>
          <p className="text-xs text-[var(--text-muted)]" data-testid="sheet-status">
            {statusLine(sheet)}
          </p>
        </div>
        {canChange && !gone && (
          <Button size="sm" onClick={() => void syncNow()} loading={syncing} leftIcon={<RefreshCw className="h-4 w-4" />} title="Bring the sheet up to date now">
            <span className="hidden sm:inline">Sync now</span>
            <span className="sr-only sm:hidden">Sync now</span>
          </Button>
        )}
        {canChange && (
          <Menu label="More sheet actions" icon={<MoreHorizontal className="h-4 w-4" />}>
            {(close) => (
              <MenuItem
                onClick={() => {
                  close();
                  void unlink();
                }}
              >
                <Link2Off className="h-4 w-4" /> Unlink sheet
              </MenuItem>
            )}
          </Menu>
        )}
      </div>
      {sheet.problem && sheet.message && (
        <Callout tone={sheet.problem === "waiting" ? "warning" : "danger"} className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="flex-1">{sheet.message}</span>
          {canChange && gone && (
            <Button size="sm" variant="secondary" className="self-start" onClick={() => setLinking(true)}>
              Make a new sheet
            </Button>
          )}
          {canChange && sheet.problem === "waiting" && (
            <Button size="sm" variant="secondary" className="self-start" loading={syncing} onClick={() => void syncNow()}>
              Try again
            </Button>
          )}
        </Callout>
      )}
      <LinkSheetDialog open={linking} onClose={() => setLinking(false)} fileId={fileId} formTitle={formTitle} onLinked={put} />
    </section>
  );
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "1 min ago" : `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function statusLine(s: LinkedSheet): string {
  const parts = [`${s.tab_name} tab`];
  if (s.synced_at) parts.push(`Updated ${ago(s.synced_at)}`);
  if (s.problem === "deleted" || s.problem === "trashed" || s.problem === "tab_deleted") return parts[0];
  if (s.pending > 0) parts.push(s.pending === 1 ? "1 answer waiting" : `${s.pending} answers waiting`);
  else if (!s.problem) parts.push("up to date");
  return parts.join(" · ");
}

// ------------------------------------------------------------------ link dialog

function LinkSheetDialog({
  open,
  onClose,
  fileId,
  formTitle,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  fileId: string;
  formTitle: string;
  onLinked: (s: LinkedSheet | null) => void;
}) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<FileItem | null>(null);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupId = useId();

  useEffect(() => {
    if (!open) return;
    setMode("new");
    setName(`${formTitle || "Untitled form"} (Responses)`);
    setPicked(null);
    setTyped("");
    setQ("");
    setError(null);
  }, [open, formTitle]);
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const sheets = useQuery({
    queryKey: ["form-sheet-pick", q],
    enabled: open && mode === "existing",
    queryFn: async (): Promise<FileItem[]> => {
      if (q) {
        const res = await filesApi.search(q, "mine", 30, true, { type: "sheet" });
        return res.hits.map((h) => h.file).filter((f) => f.source_kind === "sheet" && !f.trashed_at);
      }
      const res = await filesApi.listRecent("mine", 100, true);
      return res.files.filter((f) => f.source_kind === "sheet" && !f.trashed_at).slice(0, 30);
    },
  });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const s =
        mode === "new"
          ? await formsApi.linkSheet(fileId, { mode: "new", name: name.trim() || undefined })
          : await formsApi.linkSheet(fileId, { mode: "existing", file_id: picked!.id });
      onLinked(s);
      toast.success(s?.problem ? "Linked. The answers so far will be added in a few minutes." : "Linked. The answers so far are in the sheet.");
      onClose();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const radio = (value: "new" | "existing", label: string, hint: string) => (
    <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5", mode === value ? "border-[var(--accent)] bg-[var(--bg)]" : "border-[var(--border)] hover:bg-[var(--hover)]")}>
      <input type="radio" name={groupId} className="mt-0.5 accent-[var(--accent)]" checked={mode === value} onChange={() => setMode(value)} />
      <span>
        <span className="block text-sm font-medium text-[var(--text)]">{label}</span>
        <span className="block text-xs text-[var(--text-muted)]">{hint}</span>
      </span>
    </label>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Keep answers in a sheet"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={mode === "existing" ? !picked : !name.trim()}>
            Link sheet
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1 sm:px-5" data-testid="link-sheet-dialog">
        <p className="text-sm text-[var(--text-muted)]">
          Every answer is added as a row as it comes in, even while the sheet is open. Changed answers update their row. The sheet is yours: sort it, add columns and formulas.
        </p>
        <div role="radiogroup" aria-label="Which sheet" className="flex flex-col gap-2">
          {radio("new", "A new spreadsheet", "Made next to this form.")}
          {radio("existing", "A spreadsheet you have", "A “Form responses” tab is added to it.")}
        </div>
        {mode === "new" ? (
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Name
            <input className={fieldCls} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="relative flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              Find a spreadsheet
              <Search className="pointer-events-none absolute bottom-2.5 left-2.5 h-4 w-4" aria-hidden="true" />
              <input type="search" className={cn(fieldCls, "pl-8")} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search by name" />
            </label>
            <div className="max-h-64 overflow-y-auto rounded-md border border-[var(--border)]" role="listbox" aria-label="Spreadsheets">
              {sheets.isLoading ? (
                <p className="px-3 py-4 text-center text-sm text-[var(--text-muted)]">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
                </p>
              ) : sheets.error ? (
                <p className="px-3 py-4 text-sm text-[var(--danger)]">Couldn&apos;t load your spreadsheets. {extractError(sheets.error)}</p>
              ) : !sheets.data?.length ? (
                <p className="px-3 py-4 text-center text-sm text-[var(--text-muted)]">
                  {q ? `No spreadsheet matches “${q}”.` : "No recent spreadsheets. Search for one by name."}
                </p>
              ) : (
                sheets.data.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="option"
                    aria-selected={picked?.id === f.id}
                    onClick={() => setPicked(f)}
                    className={cn(
                      "flex w-full items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-left text-sm last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
                      picked?.id === f.id ? "bg-[var(--hover)] font-medium text-[var(--text)]" : "text-[var(--text)] hover:bg-[var(--hover)]"
                    )}
                  >
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{displayFileName(f)}</span>
                    {picked?.id === f.id && <span className="text-xs text-[var(--accent-text)]">Selected</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Sheet>
  );
}
