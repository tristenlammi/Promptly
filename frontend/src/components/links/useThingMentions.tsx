import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";

import { connectionsApi, mentionMarkdown, type Thing } from "@/api/connections";
import { KIND_ICONS } from "@/components/links/LinkedSection";
import { cn } from "@/utils/cn";

/*
 * ``[[`` in a plain textarea (a room message, a chat message, a journal
 * entry): type ``[[`` and a few letters to mention anything you can see —
 * a task, an event, a file, a contact, a trip… The pick is written as
 * ``@[Title](/link/<kind>/<id>)``, which every Markdown view shows as a
 * link and the server records as a mention when the text is saved or sent.
 *
 * Usage: ``const m = useThingMentions({ref, value, onChange})``; call
 * ``m.onKeyDown(e)`` first in the textarea's key handler (it returns true
 * when it used the key), ``m.onSelect`` on select/click, and render
 * ``{m.popup}``.
 */

const TRIGGER_RE = /\[\[([^[\]\n]{0,60})$/;

export function useThingMentions({
  ref,
  value,
  onChange,
}: {
  ref: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}) {
  const [trigger, setTrigger] = useState<{ start: number; q: string } | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [hi, setHi] = useState(0);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el || document.activeElement !== el) {
      setTrigger(null);
      return;
    }
    const pos = el.selectionStart ?? value.length;
    const m = TRIGGER_RE.exec(value.slice(0, pos));
    if (!m) {
      setTrigger(null);
      setDismissed(null);
      return;
    }
    const start = pos - m[0].length;
    setTrigger(start === dismissed ? null : { start, q: m[1] });
  }, [ref, value, dismissed]);

  useEffect(update, [update]);

  const q = trigger?.q.trim() ?? "";
  const { data } = useQuery({
    queryKey: ["connections-search", q],
    queryFn: () => connectionsApi.search(q),
    enabled: Boolean(trigger) && q.length >= 1,
    staleTime: 15_000,
  });
  const results = trigger && q ? (data ?? []) : [];
  useEffect(() => setHi(0), [q]);

  const pick = useCallback(
    (t: Thing) => {
      const el = ref.current;
      if (!el || !trigger) return;
      const pos = el.selectionStart ?? value.length;
      const insert = `${mentionMarkdown(t)} `;
      const next = value.slice(0, trigger.start) + insert + value.slice(pos);
      onChange(next);
      setTrigger(null);
      const caret = trigger.start + insert.length;
      window.requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [ref, trigger, value, onChange]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!trigger) return false;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(trigger.start);
        setTrigger(null);
        return true;
      }
      if (!results.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        pick(results[Math.min(hi, results.length - 1)]);
        return true;
      }
      return false;
    },
    [trigger, results, hi, pick]
  );

  let popup: ReactNode = null;
  const el = ref.current;
  if (trigger && el) {
    const rect = el.getBoundingClientRect();
    const above = rect.top > window.innerHeight / 2;
    const width = Math.min(Math.max(rect.width, 260), 360);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    popup = createPortal(
      <div
        role="listbox"
        aria-label="Mention something"
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: "fixed",
          left,
          width,
          ...(above ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        }}
        className="z-[70] max-h-72 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 text-xs shadow-lg"
      >
        <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Mention anything
        </div>
        {!q ? (
          <div className="px-2 py-2 text-[var(--text-muted)]">Type to find a task, event, file, contact…</div>
        ) : results.length === 0 ? (
          <div className="px-2 py-2 text-[var(--text-muted)]">No matches.</div>
        ) : (
          results.map((t, i) => {
            const Icon = KIND_ICONS[t.kind] ?? Link2;
            return (
              <button
                key={`${t.kind}:${t.id}`}
                type="button"
                role="option"
                aria-selected={i === hi}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(t);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[var(--text)]",
                  i === hi && "bg-[var(--accent)]/10"
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 truncate font-medium">{t.title || "Untitled"}</span>
                <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{t.label}</span>
              </button>
            );
          })
        )}
      </div>,
      document.body
    );
  }

  return { onKeyDown, onSelect: update, popup, open: Boolean(trigger) };
}
