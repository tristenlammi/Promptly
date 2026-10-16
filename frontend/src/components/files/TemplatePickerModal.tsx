import { useQuery } from "@tanstack/react-query";
import { FileText, Loader2, Shapes, Table2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { officeApi, officeEditorPath, type OfficeKind, type OfficeTemplate } from "@/api/office";
import { Modal } from "@/components/shared/Modal";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { extractError } from "./helpers";

const KIND_META: Record<OfficeKind, { label: string; icon: typeof FileText; tint: string }> = {
  document: { label: "Documents", icon: FileText, tint: "text-sky-600 bg-sky-500/10" },
  sheet: { label: "Spreadsheets", icon: Table2, tint: "text-emerald-600 bg-emerald-500/10" },
  whiteboard: { label: "Whiteboards", icon: Shapes, tint: "text-violet-600 bg-violet-500/10" },
};

/** "New → From template…" (WP-3.4): the caller's Templates folder, grouped
 *  by kind. Picking one makes a copy in the current folder and opens it. */
export function TemplatePickerModal({
  open,
  folderId,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** Where the new file goes (null = My files). */
  folderId: string | null;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["office-templates"],
    queryFn: () => officeApi.templates(),
    enabled: open,
    staleTime: 30_000,
  });

  const pick = async (t: OfficeTemplate) => {
    if (busy) return;
    setBusy(t.id);
    try {
      const file = await officeApi.create({ template_id: t.id, folder_id: folderId });
      onCreated?.();
      onClose();
      const path = officeEditorPath(file);
      if (path) navigate(path);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusy(null);
    }
  };

  const groups = (["document", "sheet", "whiteboard"] as OfficeKind[]).map((kind) => ({
    kind,
    items: (data?.templates ?? []).filter((t) => t.kind === kind),
  }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New from template"
      description="A copy is made in this folder — the template stays as it is."
      widthClass="max-w-2xl"
    >
      {isLoading && (
        <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading templates…
        </div>
      )}
      {error && <div className="py-4 text-sm text-red-500">{extractError(error)}</div>}
      {data && (
        <div className="space-y-5">
          {groups.map(({ kind, items }) =>
            items.length === 0 ? null : (
              <section key={kind}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  {KIND_META[kind].label}
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {items.map((t) => {
                    const Icon = KIND_META[kind].icon;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        disabled={!!busy}
                        onClick={() => void pick(t)}
                        className={cn(
                          "flex items-center gap-2.5 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-left text-sm transition",
                          "hover:border-[var(--accent)]/50 hover:bg-[var(--hover)] disabled:opacity-60"
                        )}
                      >
                        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md", KIND_META[kind].tint)}>
                          {busy === t.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                        </span>
                        <span className="min-w-0 truncate">{t.title}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )
          )}
          {data.templates.length === 0 && (
            <p className="text-sm text-[var(--text-muted)]">
              Your Templates folder is empty. Use “Save as template” on any document, sheet or whiteboard.
            </p>
          )}
          <div className="border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)]">
            Templates live in your{" "}
            <button
              type="button"
              className="font-medium text-[var(--accent)] hover:underline"
              onClick={() => {
                onClose();
                navigate(`/files/folder/${data.folder_id}`);
              }}
            >
              Templates folder
            </button>
            . Add one with “Save as template” from any document, sheet or whiteboard.
          </div>
        </div>
      )}
    </Modal>
  );
}
