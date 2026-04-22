import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Crown,
  Loader2,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";

import { compareApi, type CompareGroupDetail } from "@/api/compare";
import { useAvailableModels } from "@/hooks/useProviders";
import type { AvailableModel } from "@/api/types";
import { CompareColumn } from "@/components/compare/CompareColumn";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

const MAX_COLUMNS = 4;
const MIN_COLUMNS = 2;

/**
 * Side-by-side compare page.
 *
 * Supports two modes in one component to avoid duplicating setup UI:
 *
 *   * ``/chat/compare/new`` — model pickers + optional seed prompt,
 *     "Start compare" button creates the group and navigates to the
 *     detail URL. Keeping setup + run in the same page means users who
 *     refresh mid-setup don't lose their picked models (form state
 *     lives in URL-less local state; acceptable since setup takes
 *     seconds).
 *   * ``/chat/compare/:id`` — live view: 2–4 columns streaming in
 *     parallel, a shared composer, crown/archive actions.
 *
 * Tools, web search, and the PDF editor are *intentionally absent* in
 * this view (see backend ``compare_router._force_compare_conversation_defaults``
 * for the server-side enforcement). We surface the tradeoff as a
 * banner up top so users aren't surprised.
 */
export function ComparePage() {
  const { id } = useParams<{ id: string }>();
  return id ? <CompareRun groupId={id} /> : <CompareSetup />;
}

// ---------------------------------------------------------------------------
// Setup mode — pick models, optionally seed a prompt, create the group.
// ---------------------------------------------------------------------------

function CompareSetup() {
  const navigate = useNavigate();
  const { data: available = [], isLoading: modelsLoading } =
    useAvailableModels();

  const [columns, setColumns] = useState<Array<string | null>>([null, null]);
  const [title, setTitle] = useState("");
  const [seed, setSeed] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const byKey = useMemo(() => {
    const map = new Map<string, AvailableModel>();
    for (const m of available) {
      map.set(`${m.provider_id}::${m.model_id}`, m);
    }
    return map;
  }, [available]);

  // When a user first arrives at /compare/new pre-fill the first two
  // slots with distinct providers (if possible) so they see a sensible
  // default rather than two empty selects.
  useEffect(() => {
    if (!available.length) return;
    setColumns((prev) => {
      if (prev.some(Boolean)) return prev;
      const seen = new Set<string>();
      const chosen: Array<string | null> = [];
      for (const m of available) {
        if (chosen.length >= 2) break;
        if (seen.has(m.provider_id)) continue;
        seen.add(m.provider_id);
        chosen.push(`${m.provider_id}::${m.model_id}`);
      }
      while (chosen.length < 2) chosen.push(null);
      return chosen;
    });
  }, [available]);

  const createMut = useMutation({
    mutationFn: () => {
      const specs = columns.map((k) => {
        if (!k) throw new Error("Every column needs a model.");
        const m = byKey.get(k);
        if (!m) throw new Error("One of the selected models is no longer available.");
        return { provider_id: m.provider_id, model_id: m.model_id };
      });
      return compareApi.create({
        columns: specs,
        title: title.trim() || null,
        seed_prompt: seed.trim() || null,
      });
    },
    onSuccess: (group: CompareGroupDetail) => {
      navigate(`/chat/compare/${group.id}`);
    },
    onError: (e: Error) => setSubmitError(e.message || "Couldn't start compare."),
  });

  const addColumn = () => {
    setColumns((c) => (c.length >= MAX_COLUMNS ? c : [...c, null]));
  };
  const removeColumn = (i: number) => {
    setColumns((c) => (c.length <= MIN_COLUMNS ? c : c.filter((_, j) => j !== i)));
  };

  const canSubmit =
    !createMut.isPending &&
    columns.length >= MIN_COLUMNS &&
    columns.every(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <button
          type="button"
          onClick={() => navigate("/chat")}
          className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to chat
        </button>
        <h1 className="text-lg font-semibold text-[var(--text)]">
          New compare
        </h1>
      </header>

      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
        <CompareTradeoffBanner />

        <section className="space-y-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Columns ({columns.length}/{MAX_COLUMNS})
          </label>
          <div className="space-y-2">
            {columns.map((value, i) => (
              <div key={i} className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                    "bg-[var(--surface)] text-xs font-semibold text-[var(--text-muted)]"
                  )}
                >
                  {i + 1}
                </span>
                <select
                  value={value ?? ""}
                  onChange={(e) =>
                    setColumns((c) => {
                      const next = [...c];
                      next[i] = e.target.value || null;
                      return next;
                    })
                  }
                  className={cn(
                    "flex-1 rounded-md border px-3 py-2 text-sm",
                    "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
                    "focus:border-[var(--accent)] focus:outline-none"
                  )}
                  disabled={modelsLoading}
                >
                  <option value="">
                    {modelsLoading ? "Loading models…" : "Pick a model"}
                  </option>
                  {available.map((m) => (
                    <option
                      key={`${m.provider_id}::${m.model_id}`}
                      value={`${m.provider_id}::${m.model_id}`}
                    >
                      {m.display_name} · {m.provider_name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeColumn(i)}
                  disabled={columns.length <= MIN_COLUMNS}
                  className={cn(
                    "inline-flex h-8 w-8 items-center justify-center rounded-md",
                    "text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]",
                    "disabled:cursor-not-allowed disabled:opacity-30"
                  )}
                  title={
                    columns.length <= MIN_COLUMNS
                      ? "At least 2 columns are required"
                      : "Remove column"
                  }
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addColumn}
            disabled={columns.length >= MAX_COLUMNS}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs",
              "border-dashed border-[var(--border)] text-[var(--text-muted)]",
              "hover:border-[var(--accent)] hover:text-[var(--text)]",
              "disabled:cursor-not-allowed disabled:opacity-40"
            )}
          >
            <Plus className="h-3 w-3" />
            Add column
          </button>
        </section>

        <section className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Title (optional)
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Write a React testing guide"
            className={cn(
              "w-full rounded-md border px-3 py-2 text-sm",
              "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
              "focus:border-[var(--accent)] focus:outline-none"
            )}
            maxLength={200}
          />
        </section>

        <section className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            First prompt (optional)
          </label>
          <textarea
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="Leave blank to start empty and use the composer once the compare opens."
            rows={5}
            className={cn(
              "w-full rounded-md border px-3 py-2 text-sm leading-relaxed",
              "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
              "focus:border-[var(--accent)] focus:outline-none"
            )}
          />
        </section>

        {submitError && (
          <div className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {submitError}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => createMut.mutate()}
            disabled={!canSubmit}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium",
              "bg-[var(--accent)] text-white hover:opacity-90",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {createMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Start compare
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run mode — live view, shared composer, parallel streams.
// ---------------------------------------------------------------------------

function CompareRun({ groupId }: { groupId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  // Map<conversationId, streamId>. Non-null values mean the column is
  // currently streaming. We clear an entry from ``onStreamEnded`` so
  // the assistant bubble "finalises" by swapping from the in-flight
  // streaming view to the refetched persisted row.
  const [activeStreams, setActiveStreams] = useState<Record<string, string | null>>(
    {}
  );

  const { data: group, isLoading, isError, refetch } = useQuery({
    queryKey: ["compare-group", groupId],
    queryFn: () => compareApi.get(groupId),
  });

  const sendMut = useMutation({
    mutationFn: (content: string) => compareApi.send(groupId, content),
    onSuccess: (resp) => {
      const next: Record<string, string | null> = {};
      for (const col of resp.columns) {
        next[col.conversation_id] = col.stream_id;
      }
      setActiveStreams(next);
      // Refresh the conversation rows so the persisted user messages
      // appear in every column immediately.
      if (group) {
        for (const col of group.columns) {
          qc.invalidateQueries({
            queryKey: ["conversation", col.conversation_id],
          });
        }
      }
    },
    onError: (e: Error) =>
      setSendError(e.message || "Couldn't send prompt to compare columns."),
  });

  const crownMut = useMutation({
    mutationFn: (conversationId: string) =>
      compareApi.crown(groupId, conversationId),
    onSuccess: () => {
      refetch();
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const archiveMut = useMutation({
    mutationFn: () => compareApi.archiveToggle(groupId),
    onSuccess: () => {
      refetch();
      qc.invalidateQueries({ queryKey: ["compare-groups"] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => compareApi.delete(groupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["compare-groups"] });
      navigate("/chat");
    },
  });

  const onStreamEnded = useCallback(
    (conversationId: string) => {
      setActiveStreams((prev) => {
        if (!prev[conversationId]) return prev;
        const next = { ...prev };
        next[conversationId] = null;
        return next;
      });
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
    [qc]
  );

  const canSend =
    !!group &&
    !group.archived_at &&
    !group.crowned_conversation_id &&
    !sendMut.isPending &&
    draft.trim().length > 0;

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    setSendError(null);
    sendMut.mutate(text);
    setDraft("");
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading compare…
      </div>
    );
  }
  if (isError || !group) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-[var(--text-muted)]">
        Couldn't load this compare.
        <button
          type="button"
          onClick={() => navigate("/chat")}
          className="rounded-md border border-[var(--border)] px-3 py-1 text-xs hover:border-[var(--accent)]"
        >
          Back to chat
        </button>
      </div>
    );
  }

  const isLocked = Boolean(group.crowned_conversation_id || group.archived_at);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <button
          type="button"
          onClick={() => navigate("/chat")}
          className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
          title="Back to chat"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-[var(--text)]">
            {group.title || "Compare"}
          </h1>
          <div className="text-[11px] text-[var(--text-muted)]">
            {group.columns.length} columns ·{" "}
            {group.crowned_conversation_id
              ? "Winner crowned"
              : group.archived_at
              ? "Archived"
              : "Active"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => archiveMut.mutate()}
          disabled={archiveMut.isPending}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
            "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
          )}
        >
          {group.archived_at ? "Unarchive" : "Archive"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Delete this compare and all its non-crowned columns?")) {
              deleteMut.mutate();
            }
          }}
          disabled={deleteMut.isPending}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
            "border-red-500/40 text-red-500 hover:bg-red-500/10"
          )}
        >
          <Trash2 className="h-3 w-3" />
          Delete
        </button>
      </header>

      <div className="border-b border-[var(--border)] px-4 py-2">
        <CompareTradeoffBanner compact />
      </div>

      {group.crowned_conversation_id && (
        <div
          className={cn(
            "flex items-center gap-2 border-b px-4 py-2 text-xs",
            "border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--text)]"
          )}
        >
          <Crown className="h-4 w-4 text-[var(--accent)]" />
          A winner has been crowned. The other columns are archived and can be
          re-opened from the compare archive. Continue chatting in the crowned
          conversation from the sidebar.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden p-3">
        <div
          className={cn(
            "grid h-full min-h-0 gap-3",
            group.columns.length === 2 && "grid-cols-1 md:grid-cols-2",
            group.columns.length === 3 && "grid-cols-1 md:grid-cols-3",
            group.columns.length === 4 && "grid-cols-1 md:grid-cols-2 xl:grid-cols-4"
          )}
        >
          {group.columns.map((col) => {
            const label = [col.model_display_name || col.model_id, col.provider_name]
              .filter(Boolean)
              .join(" · ");
            return (
              <CompareColumn
                key={col.conversation_id}
                conversationId={col.conversation_id}
                headerLabel={label || "Column"}
                isCrowned={col.is_crowned}
                crownDisabled={isLocked && !col.is_crowned}
                onCrown={() => {
                  if (col.is_crowned) return;
                  if (
                    window.confirm(
                      "Crown this column as the winner? The other columns will be archived but you can still open them from the compare archive."
                    )
                  ) {
                    crownMut.mutate(col.conversation_id);
                  }
                }}
                activeStreamId={activeStreams[col.conversation_id] ?? null}
                onStreamEnded={() => onStreamEnded(col.conversation_id)}
              />
            );
          })}
        </div>
      </div>

      <div className="border-t border-[var(--border)] p-3">
        {sendError && (
          <div className="mb-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-600 dark:text-red-400">
            {sendError}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // On mobile the Enter key should insert a newline; send
              // is handled exclusively by the send button.
              if (isMobile) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canSend) handleSend();
              }
            }}
            placeholder={
              isLocked
                ? "Compare locked — crown a winner to continue in a single chat."
                : "Prompt sent to every column at once…"
            }
            rows={2}
            disabled={isLocked}
            className={cn(
              "flex-1 resize-none rounded-md border px-3 py-2 text-sm",
              "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
              "focus:border-[var(--accent)] focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              "inline-flex h-10 items-center gap-1 rounded-md px-3 text-sm font-medium",
              "bg-[var(--accent)] text-white hover:opacity-90",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {sendMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function CompareTradeoffBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2",
        "border-amber-500/40 bg-amber-500/10 text-xs text-[var(--text)]",
        compact && "py-1.5"
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div className={cn("leading-relaxed", compact && "truncate")}>
        Tools, web search, and the PDF editor are disabled in compare mode so
        every column runs on an equal footing. Crown a winner to return to a
        full-featured single chat.
      </div>
    </div>
  );
}
