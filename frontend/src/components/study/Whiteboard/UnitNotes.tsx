import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, Loader2, Sparkles } from "lucide-react";

import { studyApi } from "@/api/study";
import type { StudyBoardBlock } from "@/api/types";
import { useStudyStore } from "@/store/studyStore";
import { cn } from "@/utils/cn";

interface UnitNotesProps {
  sessionId: string;
  initialNotes: string | null;
  visible: boolean;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Debounced auto-save cadence. Much snappier than the old 30s
 *  Excalidraw debounce because a textarea flush is cheap. */
const AUTO_SAVE_MS = 1_500;

/**
 * Plain-text scratchpad for the current unit. Replaces the old
 * Excalidraw whiteboard. Features:
 *   - Debounced auto-save of ``notes_md`` to the study session.
 *   - Flush-on-unmount so we never lose unsaved edits.
 *   - Save-status badge (Saving / Saved / Couldn't save).
 *
 * Intentionally dumb — no rich text, no toolbar, no markdown preview.
 * The AI tutor is the thing doing structured pedagogy; this is just
 * somewhere for the student to jot down their own thoughts.
 */
function boardBlockToText(block: StudyBoardBlock): string | null {
  const p = block.payload;
  switch (block.kind) {
    case "term":
      return `- **${p.term ?? ""}**: ${p.def ?? ""}`;
    case "note":
      return `- ${p.text ?? ""}`;
    case "callout":
      return `- ${p.label ? `[${p.label}] ` : ""}${p.text ?? ""}`;
    case "concept_node":
      return `- ${p.label ?? ""}${p.note ? ` — ${p.note}` : ""}`;
    case "worked_example":
      return `- Example: ${p.title ?? ""}`;
    case "concept_map":
      return p.title ? `- Concept map: ${p.title}` : null;
    default:
      return null;
  }
}

export function UnitNotes({ sessionId, initialNotes, visible }: UnitNotesProps) {
  const [value, setValue] = useState<string>(initialNotes ?? "");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const boardBlocks = useStudyStore((s) => s.boardBlocks);

  const saveTimerRef = useRef<number | null>(null);
  const latestValueRef = useRef<string>(initialNotes ?? "");
  const isDirtyRef = useRef(false);
  const savedValueRef = useRef<string>(initialNotes ?? "");

  // Re-seed when the session changes (e.g. navigating between units).
  useEffect(() => {
    setValue(initialNotes ?? "");
    latestValueRef.current = initialNotes ?? "";
    savedValueRef.current = initialNotes ?? "";
    isDirtyRef.current = false;
    setStatus("idle");
  }, [sessionId, initialNotes]);

  const persist = useCallback(
    async (notes: string) => {
      setStatus("saving");
      try {
        await studyApi.updateNotes(sessionId, notes);
        savedValueRef.current = notes;
        isDirtyRef.current = latestValueRef.current !== notes;
        setStatus("saved");
        window.setTimeout(() => {
          setStatus((s) => (s === "saved" ? "idle" : s));
        }, 1200);
      } catch {
        setStatus("error");
      }
    },
    [sessionId]
  );

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      if (!isDirtyRef.current) return;
      const snapshot = latestValueRef.current;
      if (snapshot === savedValueRef.current) {
        isDirtyRef.current = false;
        return;
      }
      void persist(snapshot);
    }, AUTO_SAVE_MS);
  }, [persist]);

  // Flush on unmount / session switch so nothing gets lost.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (
        isDirtyRef.current &&
        latestValueRef.current !== savedValueRef.current
      ) {
        void studyApi.updateNotes(sessionId, latestValueRef.current);
      }
    };
  }, [sessionId]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setValue(next);
      latestValueRef.current = next;
      isDirtyRef.current = next !== savedValueRef.current;
      scheduleSave();
    },
    [scheduleSave]
  );

  const handleSeedFromBoard = useCallback(() => {
    if (boardBlocks.length === 0) return;
    const lines = boardBlocks
      .map(boardBlockToText)
      .filter((l): l is string => l !== null);
    if (lines.length === 0) return;
    const seeded = `## Board summary\n\n${lines.join("\n")}`;
    const next = value.trim()
      ? `${value.trimEnd()}\n\n${seeded}`
      : seeded;
    setValue(next);
    latestValueRef.current = next;
    isDirtyRef.current = next !== savedValueRef.current;
    scheduleSave();
  }, [boardBlocks, value, scheduleSave]);

  const helperText = useMemo(() => {
    if (value.trim().length === 0) {
      return "Jot down key ideas, questions for the tutor, or your own summary — it's just for you.";
    }
    return null;
  }, [value]);

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col",
        !visible && "invisible pointer-events-none"
      )}
      aria-hidden={!visible}
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-1.5 text-xs text-[var(--text-muted)]">
        <span className="opacity-70">Your notes for this unit</span>
        <div className="flex items-center gap-3">
          {boardBlocks.length > 0 && (
            <button
              type="button"
              onClick={handleSeedFromBoard}
              className="inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text)]"
              title="Add board blocks as bullet notes"
            >
              <Sparkles className="h-3 w-3" />
              Seed from board
            </button>
          )}
          <StatusBadge status={status} />
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <textarea
          value={value}
          onChange={handleChange}
          placeholder="Write anything you want to remember about this unit…"
          spellCheck
          className={cn(
            "h-full w-full resize-none border-0 bg-[var(--surface)] px-4 py-3",
            "text-sm leading-relaxed text-[var(--text)] placeholder:text-[var(--text-muted)]/60",
            "focus:outline-none focus:ring-0"
          )}
        />
        {helperText && (
          <div className="pointer-events-none absolute inset-x-4 bottom-3 text-[11px] text-[var(--text-muted)]/60">
            {helperText}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: SaveStatus }) {
  if (status === "idle") {
    return <span className="opacity-60">Auto-saves as you type</span>;
  }
  if (status === "saving") {
    return (
      <span className="inline-flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--accent)]">
        <Check className="h-3 w-3" /> Saved
      </span>
    );
  }
  return (
    <span className="text-red-500 dark:text-red-400">
      Couldn't save notes
    </span>
  );
}
