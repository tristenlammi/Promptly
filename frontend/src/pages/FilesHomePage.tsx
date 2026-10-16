import { FileText, LayoutTemplate, Loader2, MessageSquareText, Presentation, Shapes, Table2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { FileItem } from "@/api/files";
import { officeApi, type OfficeKind } from "@/api/office";
import { askAboutFiles, ASK_MAX_FILES } from "@/components/files/askAbout";
import { DriveItemIcon } from "@/components/files/DriveItemIcon";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { displayFileName, extractError, formatRelativeTime, kindLabel, openFile } from "@/components/files/helpers";
import { TemplatePickerModal } from "@/components/files/TemplatePickerModal";
import { TopNav } from "@/components/layout/TopNav";
import { useRecentFiles } from "@/hooks/useFiles";
import { toast } from "@/store/toastStore";
import { useUploadStore } from "@/store/uploadStore";
import { cn } from "@/utils/cn";

/**
 * Files › Home (``/files/home``, Part C §2.2): make something, ask about
 * your files, and pick up where you left off — Recent includes files
 * shared with you and workspace files you opened or edited.
 */
export function FilesHomePage() {
  const navigate = useNavigate();
  const { data, isLoading } = useRecentFiles("mine", 20);
  const recent = data?.files ?? [];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [question, setQuestion] = useState("");
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [creating, setCreating] = useState<OfficeKind | "presentation" | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const startUploads = useUploadStore((s) => s.startUploads);

  const create = async (kind: OfficeKind) => {
    if (creating) return;
    setCreating(kind);
    try {
      openFile(await officeApi.create({ kind }), navigate);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setCreating(null);
    }
  };
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < ASK_MAX_FILES) next.add(id);
      return next;
    });
  const ask = () => {
    const files = recent.filter((f) => picked.has(f.id));
    if (!files.length) return;
    askAboutFiles(files, navigate, question.trim());
  };

  const tiles: { label: string; icon: typeof FileText; tint: string; onClick: () => void; busy?: boolean }[] = [
    { label: "Document", icon: FileText, tint: "text-sky-600 bg-sky-500/10", onClick: () => void create("document"), busy: creating === "document" },
    { label: "Spreadsheet", icon: Table2, tint: "text-emerald-600 bg-emerald-500/10", onClick: () => void create("sheet"), busy: creating === "sheet" },
    { label: "Whiteboard", icon: Shapes, tint: "text-violet-600 bg-violet-500/10", onClick: () => void create("whiteboard"), busy: creating === "whiteboard" },
    {
      label: "Presentation", icon: Presentation, tint: "text-orange-600 bg-orange-500/10", busy: creating === "presentation",
      onClick: () => {
        if (creating) return;
        setCreating("presentation");
        void officeApi.createPresentation().then(({ path }) => navigate(path)).catch((e) => toast.error(extractError(e))).finally(() => setCreating(null));
      },
    },
    { label: "From template", icon: LayoutTemplate, tint: "text-amber-600 bg-amber-500/10", onClick: () => setTemplatesOpen(true) },
    { label: "Upload", icon: Upload, tint: "text-[var(--text-muted)] bg-[var(--hover)]", onClick: () => fileInput.current?.click() },
  ];

  return (
    <>
      <TopNav title="Home" actions={<FilesTopNavSearch />} />
      <DriveSubNav />
      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-8 px-4 py-6 sm:px-6">
          <section aria-label="Create">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
              {tiles.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={t.onClick}
                  className="flex items-center gap-2.5 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-left text-sm font-medium transition hover:border-[var(--accent)]/50 hover:bg-[var(--hover)]"
                >
                  <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md", t.tint)}>
                    {t.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <t.icon className="h-4 w-4" />}
                  </span>
                  {t.label}
                </button>
              ))}
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) startUploads({ files, scope: "mine", folderId: null, onConflict: "ask" });
              }}
            />
          </section>

          <section aria-label="Ask" className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                ask();
              }}
            >
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={
                  picked.size
                    ? `Ask about the ${picked.size} file${picked.size === 1 ? "" : "s"} you picked…`
                    : "Ask about your files — tick some below first…"
                }
                aria-label="Ask about your files"
                className="min-w-0 flex-1 rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
              />
              <button
                type="submit"
                disabled={picked.size === 0}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                <MessageSquareText className="h-4 w-4" />
                Ask
              </button>
            </form>
            <p className="mt-1.5 text-xs text-[var(--text-muted)]">
              Opens a chat with those files attached. You can also select files anywhere in Files and choose
              “Ask about these”.
            </p>
          </section>

          <section aria-label="Recent">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Recent</h2>
              <Link to="/files/recent" className="text-xs text-[var(--accent-text)] hover:underline">
                See all
              </Link>
            </div>
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            )}
            {!isLoading && recent.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">Nothing yet — files you open or edit show up here.</p>
            )}
            {recent.length > 0 && (
              <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
                {recent.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={picked.has(f.id)}
                      onChange={() => toggle(f.id)}
                      aria-label={`Pick ${displayFileName(f)} to ask about`}
                      className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!openFile(f, navigate)) setPreview(f);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <DriveItemIcon file={f} tile />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{displayFileName(f)}</span>
                        <span className="block truncate text-xs text-[var(--text-muted)]">
                          {kindLabel(f)}
                          {f.scope === "shared" || f.sharing?.role === "grantee"
                            ? ` · shared by ${f.sharing?.owner?.username ?? "someone"}`
                            : ""}
                        </span>
                      </span>
                    </button>
                    <span className="hidden shrink-0 text-xs text-[var(--text-muted)] sm:block">
                      {f.modified_at || f.updated_at ? formatRelativeTime(f.modified_at ?? f.updated_at ?? "") : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      <TemplatePickerModal open={templatesOpen} folderId={null} onClose={() => setTemplatesOpen(false)} />
      <FilePreviewModal
        open={!!preview}
        file={preview}
        siblings={recent}
        onClose={() => setPreview(null)}
        onSelect={setPreview}
      />
    </>
  );
}
