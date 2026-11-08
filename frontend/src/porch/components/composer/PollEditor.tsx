import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PollCloses } from "@/api/porch";
import { ItemButton, Segmented, Sheet, TextInput } from "@/items/ui";

import type { PollDraft } from "./model";

export const CLOSES: { value: PollCloses; label: string; words: string }[] = [
  { value: "1d", label: "1 day", words: "Closes after 1 day" },
  { value: "3d", label: "3 days", words: "Closes after 3 days" },
  { value: "1w", label: "1 week", words: "Closes after a week" },
  { value: "never", label: "Never", words: "Stays open" },
];

const MIN = 2;
const MAX = 6;

/**
 * A poll for a text post: 2 to 6 options and when it closes. The question
 * is what the post says. Everyone who sees the post sees how people voted
 * once they've voted themselves (decision D4).
 */
export function PollEditor({
  open,
  onClose,
  value,
  onSave,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  value: PollDraft | null;
  onSave: (p: PollDraft) => void;
  onRemove: () => void;
}) {
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [closes, setCloses] = useState<PollCloses>("1w");
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!open) return;
    setOptions(value?.options.length ? [...value.options, ...Array(Math.max(0, MIN - value.options.length)).fill("")] : ["", ""]);
    setCloses(value?.closes ?? "1w");
    setError(null);
  }, [open, value]);

  const focusLast = () => window.setTimeout(() => list.current?.querySelectorAll<HTMLInputElement>("input")[options.length]?.focus(), 30);
  const save = () => {
    const filled = options.map((o) => o.trim()).filter(Boolean);
    if (filled.length < MIN) return setError("Add at least two options.");
    if (new Set(filled.map((o) => o.toLowerCase())).size !== filled.length) return setError("Two of the options are the same.");
    onSave({ options: filled, closes });
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={value ? "Change the poll" : "Add a poll"}
      footer={
        <div className="flex w-full items-center gap-2">
          {value && (
            <ItemButton
              variant="ghost"
              className="text-[var(--danger)]"
              onClick={() => {
                onRemove();
                onClose();
              }}
            >
              Remove poll
            </ItemButton>
          )}
          <span className="flex-1" />
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton variant="primary" onClick={save}>
            Done
          </ItemButton>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--text-muted)]">Your post's words are the question. Each person gets one vote and can change it until the poll closes. Everyone who sees the post sees who voted for what.</p>
        <ol ref={list} aria-label="Options" className="flex flex-col gap-2">
          {options.map((o, i) => (
            <li key={i} className="flex items-center gap-2">
              <TextInput
                value={o}
                maxLength={80}
                aria-label={`Option ${i + 1}`}
                placeholder={`Option ${i + 1}`}
                onChange={(e) => {
                  setError(null);
                  setOptions((os) => os.map((x, j) => (j === i ? e.target.value : x)));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (i === options.length - 1 && options.length < MAX) {
                      setOptions((os) => [...os, ""]);
                      focusLast();
                    } else list.current?.querySelectorAll<HTMLInputElement>("input")[i + 1]?.focus();
                  }
                }}
              />
              {options.length > MIN && (
                <button
                  type="button"
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => setOptions((os) => os.filter((_, j) => j !== i))}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ol>
        {options.length < MAX && (
          <ItemButton
            variant="secondary"
            icon={<Plus className="h-4 w-4" />}
            className="w-fit"
            onClick={() => {
              setOptions((os) => [...os, ""]);
              focusLast();
            }}
          >
            Add an option
          </ItemButton>
        )}
        <div className="flex flex-col gap-1.5">
          <span id="poll-closes" className="text-xs font-medium text-[var(--text-muted)]">
            Closes after
          </span>
          <div role="group" aria-labelledby="poll-closes">
            <Segmented className="w-full" value={closes} onChange={setCloses} options={CLOSES.map((c) => ({ value: c.value, label: c.label }))} />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
