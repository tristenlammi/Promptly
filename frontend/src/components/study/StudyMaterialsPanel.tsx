import { useRef } from "react";
import {
  CheckCircle2,
  FileText,
  Loader2,
  Plus,
  Trash2,
  AlertCircle,
  Clock,
} from "lucide-react";

import type { StudyMaterial } from "@/api/types";
import { apiClient } from "@/api/client";
import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";
import {
  useStudyMaterialsQuery,
  useAttachStudyMaterial,
  useDeleteStudyMaterial,
} from "@/hooks/useStudy";

interface StudyMaterialsPanelProps {
  projectId: string;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "ready") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Indexed
      </span>
    );
  }
  if (status === "indexing") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        Indexing…
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-red-500">
        <AlertCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
      <Clock className="h-3 w-3" />
      Pending
    </span>
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function StudyMaterialsPanel({ projectId }: StudyMaterialsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: materials, isLoading } = useStudyMaterialsQuery(projectId);
  const attachMutation = useAttachStudyMaterial();
  const deleteMutation = useDeleteStudyMaterial();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    try {
      const form = new FormData();
      form.append("file", file);
      const { data } = await apiClient.post<{ id: string }>("/files/", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await attachMutation.mutateAsync({ projectId, fileId: data.id });
    } catch {
      // Error handled by mutation
    }
  };

  const handleDelete = (mat: StudyMaterial) => {
    deleteMutation.mutate({ projectId, materialId: mat.id });
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Course materials
        </h3>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => fileInputRef.current?.click()}
          disabled={attachMutation.isPending}
        >
          Add file
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pdf,.txt,.md,.py,.js,.ts,.json,.csv,.docx"
          onChange={handleFileChange}
        />
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading…
        </div>
      ) : !materials || materials.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-6 text-center">
          <FileText className="mx-auto mb-1.5 h-6 w-6 opacity-20" />
          <p className="text-xs text-[var(--text-muted)]">
            No materials yet. Upload a PDF, syllabus, or notes to ground the
            tutor in your actual course content.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {materials.map((mat) => (
            <div
              key={mat.id}
              className={cn(
                "flex items-center gap-3 rounded-lg border bg-[var(--surface)] px-3 py-2",
                mat.indexing_status === "failed"
                  ? "border-red-200/60 dark:border-red-800/40"
                  : "border-[var(--border)]"
              )}
            >
              <FileText className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-[var(--text)]">
                  {mat.filename}
                </p>
                <div className="mt-0.5 flex items-center gap-2">
                  <StatusBadge status={mat.indexing_status} />
                  {mat.size_bytes && (
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {formatBytes(mat.size_bytes)}
                    </span>
                  )}
                  {mat.indexing_status === "failed" && mat.indexing_error && (
                    <span
                      className="truncate text-[10px] text-red-500"
                      title={mat.indexing_error}
                    >
                      {mat.indexing_error}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleDelete(mat)}
                disabled={deleteMutation.isPending}
                className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--border)]/30 hover:text-red-500 disabled:opacity-40"
                aria-label="Remove material"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
