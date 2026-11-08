import { Check, Lock } from "lucide-react";
import { useEffect, useState } from "react";

import type { PorchGroup } from "@/api/porch";
import { ItemButton, Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { GroupTile, peopleCount } from "../ui";
import type { Audience } from "./model";

/** "All my groups (5)" or the groups' names, as the Share step's row says it. */
export function audienceWords(a: Audience, groups: PorchGroup[]): string {
  if (a === "all") return `All my groups (${groups.length})`;
  const names = groups.filter((g) => a.includes(g.id)).map((g) => `${g.emoji ? `${g.emoji} ` : ""}${g.name}`);
  return names.join(" · ") || "Pick groups";
}

/** The groups a choice means right now. */
export function audienceIds(a: Audience, groups: PorchGroup[]): string[] {
  return a === "all" ? groups.map((g) => g.id) : groups.filter((g) => a.includes(g.id)).map((g) => g.id);
}

/**
 * Who sees the post: ◉ All my groups (the groups you're in when you press
 * Post) or ○ Choose groups, with a box per group (emoji, name, people, 🔒
 * for private). It starts on what you used last.
 */
export function AudienceSheet({
  open,
  onClose,
  value,
  onChange,
  groups,
}: {
  open: boolean;
  onClose: () => void;
  value: Audience;
  onChange: (a: Audience) => void;
  groups: PorchGroup[];
}) {
  const [mode, setMode] = useState<"all" | "some">(value === "all" ? "all" : "some");
  const [ticked, setTicked] = useState<string[]>(value === "all" ? [] : value);
  useEffect(() => {
    if (!open) return;
    setMode(value === "all" ? "all" : "some");
    setTicked(value === "all" ? [] : value);
  }, [open, value]);
  const names = groups.map((g) => g.name).join(", ");
  const radio = (on: boolean) =>
    cn(
      "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
      on ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_8%,var(--surface))]" : "border-[var(--border)] hover:bg-[var(--hover)]",
    );
  const dot = (on: boolean) => (
    <span aria-hidden className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2", on ? "border-[var(--item-accent)]" : "border-[var(--border)]")}>
      {on && <span className="h-2.5 w-2.5 rounded-full bg-[var(--item-accent)]" />}
    </span>
  );
  const done = () => {
    onChange(mode === "all" ? "all" : ticked);
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Share to"
      footer={
        <div className="flex items-center justify-end gap-2">
          {mode === "some" && ticked.length === 0 && <span className="mr-auto text-xs text-[var(--text-muted)]">Pick at least one group.</span>}
          <ItemButton variant="primary" onClick={done} disabled={mode === "some" && ticked.length === 0}>
            Done
          </ItemButton>
        </div>
      }
    >
      <div role="radiogroup" aria-label="Who sees it" className="flex flex-col gap-2">
        <button type="button" role="radio" aria-checked={mode === "all"} onClick={() => setMode("all")} className={radio(mode === "all")}>
          {dot(mode === "all")}
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold text-[var(--text)]">All my groups ({groups.length})</span>
            <span className="text-xs text-[var(--text-muted)]">{names}: the groups you're in now.</span>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={mode === "some"} onClick={() => setMode("some")} className={radio(mode === "some")}>
          {dot(mode === "some")}
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold text-[var(--text)]">Choose groups</span>
            <span className="text-xs text-[var(--text-muted)]">One group, or a few.</span>
          </span>
        </button>
      </div>
      {mode === "some" && (
        <ul aria-label="Groups" className="mt-3 flex flex-col">
          {groups.map((g) => {
            const on = ticked.includes(g.id);
            return (
              <li key={g.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => setTicked((t) => (on ? t.filter((x) => x !== g.id) : [...t, g.id]))}
                  className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                      on ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[var(--border)] bg-[var(--surface)]",
                    )}
                  >
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <GroupTile group={g} size={32} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1 truncate text-sm font-medium text-[var(--text)]">
                      {g.name}
                      {g.visibility === "private" && g.kind !== "everyone" && (
                        <>
                          <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                          <span className="sr-only">(private)</span>
                        </>
                      )}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">{g.kind === "everyone" ? "Everyone on this Promptly" : peopleCount(g.member_count)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
