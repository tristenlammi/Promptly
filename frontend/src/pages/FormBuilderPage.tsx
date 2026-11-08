import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CloudOff,
  Copy,
  Download,
  Eye,
  LayoutTemplate,
  Loader2,
  MoreHorizontal,
  Palette,
  Send,
  Share2,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { filesApi, type FileItem } from "@/api/files";
import { formsApi, type FormView } from "@/api/forms";
import { officeApi, officeEditorPath, type OfficeEditorInfo } from "@/api/office";
import { FormRenderer } from "@/components/forms/FormRenderer";
import { LookPanel } from "@/components/forms/builder/LookPanel";
import { PreviewPane } from "@/components/forms/builder/PreviewPane";
import { QuestionsTab } from "@/components/forms/builder/QuestionsTab";
import { ResponsesTab } from "@/components/forms/responses/ResponsesTab";
import { SendDialog } from "@/components/forms/builder/SendDialog";
import { SettingsTab } from "@/components/forms/builder/SettingsTab";
import { Menu, MenuItem, Switch, iconBtnCls } from "@/components/forms/builder/ui";
import { useFormDoc, type FormDoc, type SaveStatus } from "@/components/forms/builder/useFormDoc";
import { downloadAuthed, extractError } from "@/components/files/helpers";
import { ShareGrantsModal } from "@/components/files/ShareGrantsModal";
import { TopNav } from "@/components/layout/TopNav";
import { ErrorState } from "@/components/shared/Callout";
import { invalidateFileQueries } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Sheet } from "@/items/ui/Sheet";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

/**
 * The form builder, ``/files/form/:id`` (Forms WP-F1.2). The office
 * editors' header — where it lives, its name, star, Share and "…" (Make a
 * copy, Save as template, Download, Move to trash) — over three tabs,
 * Questions, Responses (WP-F1.4) and Settings, with Preview, the look and
 * the "Taking answers" switch. Everything saves as you go. Someone who can
 * only see the form gets Questions (read-only) and Responses.
 */
export function FormBuilderPage() {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const { data: view, error, isLoading } = useQuery({
    queryKey: ["form", fileId],
    queryFn: () => formsApi.get(fileId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: (count, err) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      return status !== 404 && count < 3;
    },
  });
  // Where it lives (breadcrumb) and "opened" for Recent.
  const { data: info } = useQuery({
    queryKey: ["office-info", fileId],
    queryFn: () => officeApi.info(fileId),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening the form…
      </div>
    );
  }
  if (error || !view) {
    return (
      <>
        <TopNav title="Not available" />
        <div className="mx-auto w-full max-w-xl px-4 py-10">
          <ErrorState>
            This form isn&apos;t available. It may have been deleted, moved to the trash, or it&apos;s no longer shared with
            you.{" "}
            <Link to="/forms" className="font-medium underline">
              Back to Forms
            </Link>
          </ErrorState>
        </div>
      </>
    );
  }
  return <Builder key={fileId} fileId={fileId} initial={view} info={info ?? null} />;
}

function Builder({ fileId, initial, info }: { fileId: string; initial: FormView; info: OfficeEditorInfo | null }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isPhone = useIsMobile();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<FormView>(initial);
  const [file, setFile] = useState<FileItem>(initial.file);
  const canEdit = view.access === "edit";
  const doc = useFormDoc(fileId, initial, {
    readOnly: !canEdit,
    onFile: (f) => {
      setFile(f);
      invalidateFileQueries(qc);
    },
    onRemote: (v) => setView((cur) => ({ ...v, form: { ...v.form, definition: cur.form.definition } })),
  });
  const tabs: Tab[] = canEdit ? ["questions", "responses", "settings"] : ["questions", "responses"];
  const asked = params.get("tab");
  const tab: Tab = tabs.includes(asked as Tab) ? (asked as Tab) : "questions";
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t !== "questions") next.set("tab", t);
    else next.delete("tab");
    setParams(next, { replace: true });
  };
  const [answerCount, setAnswerCount] = useState(initial.form.response_count);
  const [previewOpen, setPreviewOpen] = useState(() => !isPhone && window.innerWidth >= 1280);
  const [lookOpen, setLookOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  useEffect(() => {
    document.title = `${doc.def.title || "Untitled form"} · Forms`;
  }, [doc.def.title]);

  const setAccepting = async (on: boolean) => {
    const before = view;
    setView({ ...view, form: { ...view.form, settings: { ...view.form.settings, accepting: on } } });
    try {
      setView(await formsApi.updateSettings(fileId, { accepting: on }));
      qc.invalidateQueries({ queryKey: ["forms-home"] });
    } catch (e) {
      setView(before);
      toast.error(extractError(e));
    }
  };

  const viewForPanels: FormView = { ...view, form: { ...view.form, definition: doc.def } };
  const accepting = view.form.settings.accepting;
  const closedBy =
    accepting && view.form.settings.close_at && new Date(view.form.settings.close_at).getTime() <= Date.now()
      ? "Closed: past its closing time"
      : accepting && view.form.settings.max_responses !== null && view.form.response_count >= view.form.settings.max_responses
        ? "Closed: it has all its answers"
        : null;

  const preview = previewOpen && (
    <PreviewPane
      definition={doc.def}
      assetUrls={doc.assetUrls}
      settings={view.form.settings}
      variant={isPhone ? "full" : "side"}
      onClose={() => setPreviewOpen(false)}
    />
  );

  return (
    <>
      <TopNav
        title={<BuilderTitle info={info} file={file} doc={doc} canEdit={canEdit} />}
        actions={
          <BuilderActions
            fileId={fileId}
            file={file}
            isOwner={view.is_owner}
            canEdit={canEdit}
            doc={doc}
            isPhone={isPhone}
            previewOpen={previewOpen}
            onPreview={() => setPreviewOpen((o) => !o)}
            onLook={() => setLookOpen(true)}
            onShare={() => setShareOpen(true)}
            onSend={() => setSendOpen(true)}
            onFile={(f) => {
              setFile(f);
              invalidateFileQueries(qc);
            }}
            onTrashed={() => navigate("/forms")}
            navigateTo={(p) => navigate(p)}
          />
        }
      />
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-2 sm:px-4">
        <div role="tablist" aria-label="Form" className="flex">
            {tabs.map((t, i) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`form-tab-${t}`}
                aria-selected={tab === t}
                aria-controls={tab === t ? `form-panel-${t}` : undefined}
                onClick={() => setTab(t)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
                    setTab(next);
                    document.getElementById(`form-tab-${next}`)?.focus();
                  }
                }}
                tabIndex={tab === t ? 0 : -1}
                className={cn(
                  "relative h-11 px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
                  tab === t ? "text-[var(--text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]"
                )}
              >
                {t === "questions" ? "Questions" : t === "settings" ? "Settings" : (
                  <>
                    Responses
                    {answerCount > 0 && <span className="tabular-nums text-[var(--text-muted)]">{` (${answerCount.toLocaleString()})`}</span>}
                  </>
                )}
                {tab === t && <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[var(--accent)]" />}
              </button>
            ))}
          </div>
        {!canEdit && (
          <p className="hidden py-2.5 text-xs text-[var(--text-muted)] md:block">
            You can see this form and its answers. Ask its owner if you need to change it, or make a copy.
          </p>
        )}
        <span className="flex-1" />
        {canEdit && (
          <div className="flex items-center gap-2 py-1">
            {closedBy && <span className="hidden text-xs text-amber-700 dark:text-amber-400 sm:inline">{closedBy}</span>}
            <Switch checked={accepting} onChange={(v) => void setAccepting(v)} label={accepting ? "Taking answers" : "Closed"} className="items-center" />
          </div>
        )}
      </div>
      <SaveBanner status={doc.status} onRetry={() => void doc.saveNow()} />
      {tab === "responses" ? (
        <div id="form-panel-responses" role="tabpanel" aria-labelledby="form-tab-responses" className="flex min-h-0 flex-1 flex-col">
          <ResponsesTab fileId={fileId} canEdit={canEdit} onSend={() => setSendOpen(true)} onCount={setAnswerCount} />
        </div>
      ) : tab === "questions" ? (
        <div id="form-panel-questions" role="tabpanel" aria-labelledby="form-tab-questions" className="flex min-h-0 flex-1 flex-col">
          {canEdit ? (
            <QuestionsTab
              doc={doc}
              fileId={fileId}
              readOnly={!canEdit}
              onOpenLook={() => setLookOpen(true)}
              aside={!isPhone ? preview : undefined}
            />
          ) : (
            <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
              <FormRenderer
                definition={doc.def}
                assetUrls={doc.assetUrls}
                mode="preview"
                showRemaining={view.form.settings.show_remaining}
                notice="Preview — answers aren't saved"
                onSubmit={() => {
                  toast.info("This is a preview, so nothing was sent.");
                }}
              />
            </div>
          )}
        </div>
      ) : (
        <div id="form-panel-settings" role="tabpanel" aria-labelledby="form-tab-settings" className="flex min-h-0 flex-1 flex-col">
          <SettingsTab view={viewForPanels} onView={(v) => setView({ ...v, form: { ...v.form, definition: doc.def } })} doc={doc} fileId={fileId} />
        </div>
      )}
      {isPhone && preview}
      <Sheet open={lookOpen} onClose={() => setLookOpen(false)} title="Look" size="lg">
        <LookPanel doc={doc} fileId={fileId} />
      </Sheet>
      {canEdit && (
        <SendDialog
          open={sendOpen}
          onClose={() => setSendOpen(false)}
          fileId={fileId}
          view={viewForPanels}
          onView={(v) => setView({ ...v, form: { ...v.form, definition: doc.def } })}
          isOwner={view.is_owner}
          onAccepting={setAccepting}
          onOpenSettings={() => {
            setSendOpen(false);
            setTab("settings");
          }}
          onShare={() => {
            setSendOpen(false);
            setShareOpen(true);
          }}
        />
      )}
      {view.is_owner && (
        <ShareGrantsModal
          open={shareOpen}
          resource={{
            type: "file",
            id: file.id,
            name: doc.def.title || "Untitled form",
            supports_edit: true,
            roles: ["view", "edit"],
            links: false,
          }}
          onClose={() => setShareOpen(false)}
          onChanged={() => undefined}
        />
      )}
    </>
  );
}

type Tab = "questions" | "responses" | "settings";

function statusWords(s: SaveStatus): { text: string; tone: "ok" | "busy" | "bad" } {
  switch (s.kind) {
    case "saved":
      return { text: "Saved", tone: "ok" };
    case "saving":
    case "pending":
      return { text: "Saving…", tone: "busy" };
    case "offline":
      return { text: "Not saved: you're offline", tone: "bad" };
    case "invalid":
      return { text: "Not saved", tone: "bad" };
    case "error":
      return { text: "Not saved", tone: "bad" };
    case "gone":
      return { text: "Not saved", tone: "bad" };
  }
}

function SaveBanner({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status.kind !== "offline" && status.kind !== "error" && status.kind !== "gone") return null;
  return (
    <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-[var(--text)]">
      {status.kind === "offline" ? <CloudOff className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1">
        {status.kind === "offline"
          ? "Not saved: you're offline. Your changes are kept on this device and save when you're back."
          : status.kind === "gone"
            ? "This form was moved to the trash or is no longer shared with you, so changes can't be saved."
            : `Not saved: ${status.message} Your changes are kept on this device.`}
      </span>
      {status.kind !== "gone" ? (
        <button type="button" onClick={onRetry} className="shrink-0 rounded-md px-2 py-1 font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]">
          Try again
        </button>
      ) : (
        <Link to="/forms" className="shrink-0 rounded-md px-2 py-1 font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]">
          Back to Forms
        </Link>
      )}
    </div>
  );
}

function BuilderTitle({ info, file, doc, canEdit }: { info: OfficeEditorInfo | null; file: FileItem; doc: FormDoc; canEdit: boolean }) {
  const crumb = "truncate text-[var(--text-muted)] hover:text-[var(--text)] hover:underline";
  const words = statusWords(doc.status);
  const isOwner = info?.is_owner ?? true;
  return (
    <span className="flex min-w-0 items-center gap-1 text-sm">
      <Link to="/forms" className={cn(crumb, "hidden sm:inline")}>
        Forms
      </Link>
      {/* The folder it's in (not the Forms folder: "Forms" already leads home). */}
      {isOwner && info?.path?.length && !(info.path.length === 1 && info.path[0].name === "Forms") ? (
        <span className="hidden min-w-0 items-center gap-1 md:flex">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          <Link to={`/files/folder/${info.path[info.path.length - 1].id}`} className={cn(crumb, "max-w-[10rem]")}>
            {info.path[info.path.length - 1].name}
          </Link>
        </span>
      ) : !isOwner ? (
        <span className="hidden min-w-0 items-center gap-1 md:flex">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          <Link to="/files/shared" className={crumb}>
            Shared with me
          </Link>
        </span>
      ) : null}
      <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] sm:block" />
      {canEdit ? (
        <input
          aria-label="Form name"
          value={doc.def.title}
          maxLength={300}
          onChange={(e) => doc.update((d) => ({ ...d, title: e.target.value }), { coalesce: "form:title" })}
          onBlur={() => {
            if (!doc.def.title.trim()) doc.update((d) => ({ ...d, title: "Untitled form" }));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          className="min-w-0 max-w-[16rem] flex-1 truncate rounded bg-transparent px-1 py-0.5 font-semibold text-[var(--text)] outline-none hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:ring-1 focus:ring-[var(--accent)]"
        />
      ) : (
        <span className="truncate font-semibold text-[var(--text)]">{file.filename.replace(/\.form$/i, "")}</span>
      )}
      {canEdit && (
        <span
          className={cn(
            "ml-1 inline-flex shrink-0 items-center gap-1 text-xs",
            words.tone === "bad" ? "text-amber-700 dark:text-amber-400" : "text-[var(--text-muted)]"
          )}
          role="status"
          aria-live="polite"
          data-save-status={doc.status.kind}
          title={doc.status.kind === "invalid" ? doc.status.message : undefined}
        >
          {words.tone === "ok" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : words.tone === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
          <span className={cn(words.tone !== "bad" && "hidden sm:inline")}>{words.text}</span>
        </span>
      )}
    </span>
  );
}

function BuilderActions({
  fileId,
  file,
  isOwner,
  canEdit,
  doc,
  isPhone,
  previewOpen,
  onPreview,
  onLook,
  onShare,
  onSend,
  onFile,
  onTrashed,
  navigateTo,
}: {
  fileId: string;
  file: FileItem;
  isOwner: boolean;
  canEdit: boolean;
  doc: FormDoc;
  isPhone: boolean;
  previewOpen: boolean;
  onPreview: () => void;
  onLook: () => void;
  onShare: () => void;
  onSend: () => void;
  onFile: (f: FileItem) => void;
  onTrashed: () => void;
  navigateTo: (path: string) => void;
}) {
  const starred = !!file.starred_at;
  const toggleStar = async () => {
    try {
      onFile(starred ? await filesApi.unstarFile(file.id) : await filesApi.starFile(file.id));
    } catch (e) {
      toast.error(extractError(e));
    }
  };
  const makeCopy = async () => {
    try {
      await doc.saveNow();
      const { file: copy } = await filesApi.copyFileToMine(file.id);
      toast.success(`Made “${copy.filename.replace(/\.form$/i, "")}”`);
      const path = officeEditorPath(copy);
      if (path) navigateTo(path);
    } catch (e) {
      toast.error(extractError(e));
    }
  };
  const saveAsTemplate = async () => {
    try {
      await doc.saveNow();
      await officeApi.saveAsTemplate(file.id);
      toast.success("Saved to your Templates");
    } catch (e) {
      toast.error(extractError(e));
    }
  };
  const trash = async () => {
    try {
      await doc.saveNow();
      await filesApi.trashFile(fileId);
      toast.info("Form moved to the trash. It stopped taking answers.", {
        action: {
          label: "Undo",
          onClick: () =>
            void filesApi
              .restoreFile(fileId)
              .then(() => {
                toast.success("Form restored. It's closed: switch on “Taking answers” to open it again.");
                navigateTo(`/files/form/${fileId}`);
              })
              .catch((e) => toast.error(extractError(e))),
        },
      });
      onTrashed();
    } catch (e) {
      toast.error(extractError(e));
    }
  };
  const download = () => void doc.saveNow().then(() => downloadAuthed(file)).catch((e) => toast.error(extractError(e)));

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {canEdit && !isPhone && (
        <button type="button" className={iconBtnCls} onClick={doc.undo} disabled={!doc.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
          <Undo2 className="h-4 w-4" />
        </button>
      )}
      <button
        type="button"
        className={cn(iconBtnCls, previewOpen && !isPhone && "bg-[var(--accent)]/10 text-[var(--accent-text)]")}
        aria-pressed={isPhone ? undefined : previewOpen}
        onClick={onPreview}
        title="Preview"
      >
        <Eye className="h-4 w-4" />
        <span className="hidden lg:inline">Preview</span>
      </button>
      {canEdit && !isPhone && (
        <button type="button" className={iconBtnCls} onClick={onLook} aria-label="Look" title="Colour, header picture and font">
          <Palette className="h-4 w-4" />
        </button>
      )}
      {isOwner && !isPhone && (
        <button type="button" className={iconBtnCls} aria-pressed={starred} title={starred ? "Remove star" : "Star"} aria-label={starred ? "Remove star" : "Star"} onClick={() => void toggleStar()}>
          <Star className={cn("h-4 w-4", starred && "fill-amber-400 text-amber-400")} />
        </button>
      )}
      {isOwner && !isPhone && (
        <button type="button" className={iconBtnCls} onClick={onShare} title="Add collaborators" aria-label="Share">
          <Share2 className="h-4 w-4" />
        </button>
      )}
      {canEdit && (
        <button
          type="button"
          onClick={onSend}
          className="ml-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          Send
        </button>
      )}
      <Menu label="More" icon={<MoreHorizontal className="h-4 w-4" />}>
        {(close) => (
          <>
            {isPhone && canEdit && (
              <>
                <MenuItem onClick={() => { doc.undo(); close(); }} disabled={!doc.canUndo}>
                  <Undo2 className="h-4 w-4" /> Undo
                </MenuItem>
                <MenuItem onClick={() => { onLook(); close(); }}>
                  <Palette className="h-4 w-4" /> Look
                </MenuItem>
              </>
            )}
            {isPhone && isOwner && (
              <>
                <MenuItem onClick={() => { onShare(); close(); }}>
                  <Share2 className="h-4 w-4" /> Share
                </MenuItem>
                <MenuItem onClick={() => { void toggleStar(); close(); }}>
                  <Star className="h-4 w-4" /> {starred ? "Remove star" : "Star"}
                </MenuItem>
              </>
            )}
            <MenuItem onClick={() => { void makeCopy(); close(); }}>
              <Copy className="h-4 w-4" /> Make a copy
            </MenuItem>
            {canEdit && (
              <MenuItem onClick={() => { void saveAsTemplate(); close(); }}>
                <LayoutTemplate className="h-4 w-4" /> Save as template
              </MenuItem>
            )}
            <MenuItem onClick={() => { download(); close(); }}>
              <Download className="h-4 w-4" /> Download (.zip)
            </MenuItem>
            {isOwner && (
              <MenuItem danger onClick={() => { void trash(); close(); }}>
                <Trash2 className="h-4 w-4" /> Move to trash
              </MenuItem>
            )}
          </>
        )}
      </Menu>
    </div>
  );
}
