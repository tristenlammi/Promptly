import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Loader2,
  Paperclip,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useAvailableModels } from "@/hooks/useProviders";
import {
  useAttachFiles,
  useCreateCustomModel,
  useCustomModel,
  useDetachFile,
  useReindexFile,
  useUpdateCustomModel,
} from "@/hooks/useCustomModels";
import { MyFilesPicker } from "./MyFilesPicker";
import { filesApi } from "@/api/files";
import type { KnowledgeFile } from "@/api/customModels";

/**
 * Create/edit drawer for a Custom Model.
 *
 * Slides in from the right over the admin tabs. In "new" mode it
 * collects the identity + base model + personality and (optionally)
 * a first batch of files; after save it switches to edit mode so the
 * admin can keep adding files + watch indexing progress.
 */
export interface CustomModelDrawerProps {
  open: boolean;
  onClose: () => void;
  /** ``null`` for create, otherwise the custom model id. */
  modelId: string | null;
}

const DEFAULT_TOP_K = 6;

export function CustomModelDrawer({
  open,
  onClose,
  modelId,
}: CustomModelDrawerProps) {
  // Gate on ``open`` here so the inner component's data-fetch hooks only
  // run while the dialog is mounted. The actual chrome is the shared
  // ``Modal`` (centred, focus-trapped) rendered by ``CustomModelModal``.
  if (!open) return null;
  return <CustomModelModal modelId={modelId} onClose={onClose} />;
}

function CustomModelModal({
  modelId,
  onClose,
}: {
  modelId: string | null;
  onClose: () => void;
}) {
  // ``effectiveId`` starts as whatever the parent passed in (``null``
  // for create, a uuid for edit) but we flip it to the newly created
  // id after a successful POST so the drawer stays open and the
  // knowledge-library section appears in place — lets the admin
  // attach files without having to re-open the model. Parent state
  // is unchanged; the close button still returns to the list cleanly.
  const [effectiveId, setEffectiveId] = useState<string | null>(modelId);
  const editing = effectiveId !== null;
  const detail = useCustomModel(effectiveId);
  // Shown once, right after the "Create" click succeeds, to signal
  // the drawer transitioned from create → edit mode and invite the
  // admin to attach files. Cleared by any subsequent Save.
  const [justCreated, setJustCreated] = useState(false);

  // For create mode we track local form state; for edit mode we
  // hydrate from the fetched detail and PATCH on save.
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [personality, setPersonality] = useState("");
  const [baseProviderId, setBaseProviderId] = useState<string | null>(null);
  const [baseModelId, setBaseModelId] = useState<string | null>(null);
  const [topK, setTopK] = useState(DEFAULT_TOP_K);

  // Hydrate from server on first successful load.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!editing) return;
    if (!detail.data) return;
    if (hydratedRef.current) return;
    const d = detail.data;
    setName(d.name);
    setDisplayName(d.display_name);
    setDescription(d.description ?? "");
    setPersonality(d.personality ?? "");
    setBaseProviderId(d.base_provider_id);
    setBaseModelId(d.base_model_id);
    setTopK(d.top_k);
    hydratedRef.current = true;
  }, [editing, detail.data]);

  const create = useCreateCustomModel();
  const update = useUpdateCustomModel();
  const [saveError, setSaveError] = useState<string | null>(null);

  const canSave =
    name.trim().length >= 2 &&
    displayName.trim().length >= 1 &&
    baseProviderId &&
    baseModelId;

  const onSave = async () => {
    setSaveError(null);
    if (!canSave) return;
    try {
      if (editing && detail.data) {
        await update.mutateAsync({
          id: detail.data.id,
          payload: {
            display_name: displayName.trim(),
            description: description.trim() ? description.trim() : null,
            personality: personality.trim() ? personality.trim() : null,
            base_provider_id: baseProviderId!,
            base_model_id: baseModelId!,
            top_k: topK,
          },
        });
        // Any explicit save after create graduates the drawer into
        // normal "edit" mode — the special "Add knowledge" header
        // copy is only meant for the brief post-create window.
        setJustCreated(false);
      } else {
        const created = await create.mutateAsync({
          name: name.trim(),
          display_name: displayName.trim(),
          description: description.trim() ? description.trim() : null,
          personality: personality.trim() ? personality.trim() : null,
          base_provider_id: baseProviderId!,
          base_model_id: baseModelId!,
          top_k: topK,
        });
        // Flip to edit mode in place. ``hydratedRef`` is pre-set so
        // the detail-query's eventual response doesn't clobber the
        // form fields we just submitted (the values will match, but
        // the admin may have already started tweaking them).
        hydratedRef.current = true;
        setEffectiveId(created.id);
        setJustCreated(true);
      }
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={false}
      widthClass="max-w-2xl"
      title={
        !editing
          ? "Create custom model"
          : justCreated
            ? "Add knowledge"
            : "Edit custom model"
      }
      description={
        !editing
          ? "Give your assistant an identity and pick the base model it runs on."
          : justCreated
            ? "Model created. Attach files below to build its knowledge library, or close when done."
            : "Changes to personality, base model, or retrieval settings take effect on the next message."
      }
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {editing ? "Done" : "Cancel"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            loading={create.isPending || update.isPending}
            onClick={onSave}
          >
            {editing ? "Save changes" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Identity
          </h3>

          {!editing && (
            <Field label="Internal name" hint="Lowercase, stable id. Cannot be changed later.">
              <input
                value={name}
                onChange={(e) =>
                  setName(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9_-]+/g, "-")
                      .replace(/^-+|-+$/g, "")
                      .slice(0, 64)
                  )
                }
                placeholder="research-assistant"
                className={inputCls}
                required
              />
            </Field>
          )}

          <Field label="Display name" hint="How this assistant appears in the model picker.">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Research Assistant"
              className={inputCls}
              maxLength={120}
              required
            />
          </Field>

          <Field label="Description" hint="Optional — shown as a subtitle.">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Deep research over attached docs, cites everything."
              className={inputCls}
              maxLength={500}
            />
          </Field>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Base model
          </h3>
          <BaseModelPicker
            providerId={baseProviderId}
            modelId={baseModelId}
            onChange={(p, m) => {
              setBaseProviderId(p);
              setBaseModelId(m);
            }}
          />
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Personality
            </h3>
            <span className="text-[11px] text-[var(--text-muted)]">
              {personality.length} chars
            </span>
          </div>
          <textarea
            value={personality}
            onChange={(e) => setPersonality(e.target.value)}
            placeholder="You are a meticulous research assistant. Always cite the retrieved documents..."
            rows={6}
            className={`${inputCls} resize-y`}
          />
          <p className="text-xs text-[var(--text-muted)]">
            Appended to the system prompt at the top (above tools + personal
            context) every time a user sends a message to this assistant.
          </p>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Retrieval
            </h3>
            <span className="text-xs text-[var(--text-muted)]">
              top_k = {topK}
            </span>
          </div>
          <input
            type="range"
            min={3}
            max={12}
            step={1}
            value={topK}
            onChange={(e) => setTopK(parseInt(e.target.value, 10))}
            className="w-full accent-[var(--accent)]"
          />
          <p className="text-xs text-[var(--text-muted)]">
            How many knowledge chunks to retrieve per message. Higher = more
            context but more tokens in the prompt.
          </p>
        </section>

        {editing && detail.data && (
          <KnowledgeSection
            modelId={detail.data.id}
            files={detail.data.files}
          />
        )}

        {saveError && (
          <div
            role="alert"
            className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            {saveError}
          </div>
        )}
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------
// Base model picker
// --------------------------------------------------------------------

function BaseModelPicker({
  providerId,
  modelId,
  onChange,
}: {
  providerId: string | null;
  modelId: string | null;
  onChange: (providerId: string, modelId: string) => void;
}) {
  const { data, isLoading } = useAvailableModels();

  // Only raw models are eligible as base models — no nesting custom
  // models inside custom models.
  const options = useMemo(
    () => (data ?? []).filter((m) => !m.is_custom),
    [data]
  );

  const value = providerId && modelId ? `${providerId}|${modelId}` : "";

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading models...
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-[var(--border)] px-3 py-3 text-xs text-[var(--text-muted)]">
        No base models available yet. Add a provider on the Connections tab
        first.
      </div>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        const [p, m] = e.target.value.split("|");
        onChange(p, m);
      }}
      className={inputCls}
    >
      <option value="">Select a base model...</option>
      {options.map((m) => (
        <option key={`${m.provider_id}|${m.model_id}`} value={`${m.provider_id}|${m.model_id}`}>
          {m.display_name} — {m.provider_name}
        </option>
      ))}
    </select>
  );
}

// --------------------------------------------------------------------
// Knowledge library section
// --------------------------------------------------------------------

function KnowledgeSection({
  modelId,
  files,
}: {
  modelId: string;
  files: KnowledgeFile[];
}) {
  const attach = useAttachFiles();
  const detach = useDetachFile();
  const reindex = useReindexFile();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const excludeIds = useMemo(
    () => new Set(files.map((f) => f.user_file_id)),
    [files]
  );

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!e.dataTransfer.files?.length) return;
    await uploadAndAttach(Array.from(e.dataTransfer.files));
  };

  const uploadAndAttach = async (picked: File[]) => {
    if (picked.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await Promise.all(
        picked.map((f) => filesApi.upload("mine", f, null, "chat"))
      );
      await attach.mutateAsync({
        id: modelId,
        fileIds: uploaded.map((u) => u.id),
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Knowledge library
        </h3>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Paperclip className="h-3.5 w-3.5" />}
            onClick={() => setPickerOpen(true)}
          >
            From My Files
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]">
            <Upload className="h-3.5 w-3.5" />
            Upload
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files ? Array.from(e.target.files) : [];
                e.target.value = "";
                uploadAndAttach(picked);
              }}
            />
          </label>
        </div>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="rounded-card border border-dashed border-[var(--border)] px-3 py-3 text-xs text-[var(--text-muted)]"
      >
        Drag files here to upload and attach, or use the buttons above. Files
        you attach are chunked, embedded, and queried at chat time.
      </div>

      {uploading && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Uploading...
        </div>
      )}

      {uploadError && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {uploadError}
        </div>
      )}

      {files.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)]">
          No files attached yet.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {files.map((f) => (
            <li
              key={f.user_file_id}
              className="rounded-card border border-[var(--border)] px-3 py-2 text-sm"
            >
              {/* Top row: icon · filename · action buttons */}
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <span className="flex-1 truncate">
                  {f.filename ?? f.user_file_id}
                </span>
                {f.indexing_status === "failed" && (
                  <button
                    type="button"
                    aria-label="Retry indexing"
                    onClick={() =>
                      reindex.mutate({ id: modelId, fileId: f.user_file_id })
                    }
                    className="rounded-md p-1 text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Detach file"
                  onClick={() =>
                    detach.mutate({ id: modelId, fileId: f.user_file_id })
                  }
                  className="rounded-md p-1 text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* Progress bar + status label — shown below the filename */}
              <FileProgressBar file={f} />
            </li>
          ))}
        </ul>
      )}

      <MyFilesPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        excludeIds={excludeIds}
        onConfirm={(ids) => attach.mutate({ id: modelId, fileIds: ids })}
      />
    </section>
  );
}

/**
 * Thin progress bar + status label rendered below each knowledge file row.
 *
 * The drawer polls the detail endpoint every 3 s while any file is still
 * indexing (handled by ``useCustomModel``'s ``refetchInterval``). Because
 * ``chunk_count`` is computed live from ``COUNT(KnowledgeChunk.id)`` on
 * the backend, the counter increments naturally as embedding progresses —
 * no extra endpoint needed.
 *
 * Statuses:
 *  queued    — empty grey bar, "Queued" label.
 *  embedding — pulsing sky bar, "Embedding… N chunks so far" (live count).
 *  ready     — solid green bar, "Ready · N chunks".
 *  failed    — solid red bar, "Failed — <error>".
 */
function FileProgressBar({ file }: { file: KnowledgeFile }) {
  const s = file.indexing_status;

  type Config = { track: string; fill: string; fillCls: string; labelCls: string; label: string };
  const cfg: Config = (() => {
    if (s === "embedding") {
      return {
        track: "bg-sky-500/20",
        fill: "bg-sky-400",
        fillCls: "w-full animate-pulse",
        labelCls: "text-sky-600 dark:text-sky-400",
        label: `Embedding…${file.chunk_count ? ` ${file.chunk_count} chunks so far` : ""}`,
      };
    }
    if (s === "ready") {
      return {
        track: "bg-emerald-500/20",
        fill: "bg-emerald-500",
        fillCls: "w-full",
        labelCls: "text-emerald-600 dark:text-emerald-400",
        label: `Ready${file.chunk_count ? ` · ${file.chunk_count} chunks` : ""}`,
      };
    }
    if (s === "failed") {
      return {
        track: "bg-red-500/20",
        fill: "bg-red-500/70",
        fillCls: "w-full",
        labelCls: "text-red-500 dark:text-red-400",
        label: `Failed${file.indexing_error ? ` — ${file.indexing_error}` : ""}`,
      };
    }
    // queued (default)
    return {
      track: "bg-slate-400/20",
      fill: "bg-slate-400/40",
      fillCls: "w-0",
      labelCls: "text-[var(--text-muted)]",
      label: "Queued",
    };
  })();

  return (
    <div className="mt-1.5 pl-6">
      {/* Bar */}
      <div className={`h-1 w-full overflow-hidden rounded-full ${cfg.track}`}>
        <div className={`h-full rounded-full transition-all ${cfg.fill} ${cfg.fillCls}`} />
      </div>
      {/* Label */}
      <p className={`mt-1 truncate text-[11px] ${cfg.labelCls}`}>{cfg.label}</p>
    </div>
  );
}

// --------------------------------------------------------------------
// Small shared UI
// --------------------------------------------------------------------

const inputCls =
  "w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]/60";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-0.5 block text-[11px] text-[var(--text-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}
