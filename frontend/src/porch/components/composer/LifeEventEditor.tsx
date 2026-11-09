import { useEffect, useState } from "react";

import type { LifeEventType } from "@/api/porch";
import { Field, ItemButton, Sheet, TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { LIFE_EVENTS } from "../PostCard";
import { today, type LifeDraft } from "./model";

const ORDER: LifeEventType[] = ["new_baby", "new_job", "moved_house", "engaged", "graduated", "other"];
const HINTS: Record<LifeEventType, string> = {
  new_baby: "Max was born",
  new_job: "Started at the council",
  moved_house: "We moved to Noosa",
  engaged: "Sam and Jo are engaged",
  graduated: "Finished my nursing degree",
  other: "Ran my first marathon",
};

/**
 * A life event (new baby, new job, moved house, engaged, graduated, or
 * something else): what happened, in a few words, and the day. It shows
 * bigger in the feed and stays on your profile.
 */
export function LifeEventEditor({
  open,
  onClose,
  value,
  onSave,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  value: LifeDraft | null;
  onSave: (v: LifeDraft) => void;
  onRemove: () => void;
}) {
  const [type, setType] = useState<LifeEventType | null>(value?.type ?? null);
  const [title, setTitle] = useState(value?.title ?? "");
  const [date, setDate] = useState(value?.date ?? today());
  useEffect(() => {
    if (!open) return;
    setType(value?.type ?? null);
    setTitle(value?.title ?? "");
    setDate(value?.date ?? today());
  }, [open, value]);
  const ok = !!type && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Life event"
      footer={
        <div className="flex items-center gap-2">
          {value && (
            <ItemButton
              variant="ghost"
              className="text-[var(--danger)]"
              onClick={() => {
                onRemove();
                onClose();
              }}
            >
              Remove
            </ItemButton>
          )}
          <span className="flex-1" />
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton
            variant="primary"
            disabled={!ok}
            onClick={() => {
              if (!type) return;
              onSave({ type, title: title.trim(), date });
              onClose();
            }}
          >
            {value ? "Save" : "Add"}
          </ItemButton>
        </div>
      }
    >
      <p className="mb-3 text-sm text-[var(--text-muted)]">It shows bigger in the feed and stays on your profile, with its date.</p>
      <div role="radiogroup" aria-label="What happened" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {ORDER.map((t) => {
          const meta = LIFE_EVENTS[t];
          const Icon = meta.icon;
          const on = type === t;
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setType(t)}
              className={cn(
                "flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl border p-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                on
                  ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,var(--surface))] text-[var(--accent-text)]"
                  : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]",
              )}
            >
              <Icon className="h-5 w-5" aria-hidden />
              {t === "other" ? "Something else" : meta.label}
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex flex-col gap-3">
        <Field label="In a few words (optional)">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={type ? HINTS[type] : "What happened"} />
        </Field>
        <Field label="When">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
      </div>
    </Sheet>
  );
}
