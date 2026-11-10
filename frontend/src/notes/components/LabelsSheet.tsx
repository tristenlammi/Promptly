import { useQueryClient } from "@tanstack/react-query";
import { Check, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { TAG_COLORS, tagColor, tagsApi } from "@/api/tags";
import { TAGS_KEY } from "@/components/tags/TagPicker";
import { Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { loadLists } from "../store";
import type { NoteLabel } from "../types";

type Row = NoteLabel & { count: number };

const COLOR_NAMES = ["Rust", "Amber", "Olive", "Green", "Teal", "Blue", "Violet", "Purple", "Rose", "Stone"];

/**
 * Edit labels without leaving Notes: rename one, give it a colour, or
 * delete it. Labels are the same tags the rest of Promptly uses, so a
 * change here shows everywhere the label is.
 */
export function LabelsSheet({ labels, onClose }: { labels: Row[]; onClose: () => void }) {
  const qc = useQueryClient();
  const changed = () => {
    void qc.invalidateQueries({ queryKey: TAGS_KEY });
    void loadLists();
  };
  return (
    <Sheet open onClose={onClose} title="Edit labels" size="sm">
      {labels.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--text-muted)]">No labels yet. Add one to a note and it shows here.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {labels.map((l) => (
            <LabelRow key={l.id || `~${l.name}`} label={l} onChanged={changed} />
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-[var(--text-muted)]">
        Labels are shared with your other apps: a change here shows everywhere the label is used.{" "}
        <Link to="/tags" onClick={onClose} className="underline hover:text-[var(--text)]">
          See everything with a label
        </Link>
      </p>
    </Sheet>
  );
}

function LabelRow({ label, onChanged }: { label: Row; onChanged: () => void }) {
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  const [mode, setMode] = useState<null | "color" | "delete">(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(label.name), [label.name]);
  useEffect(() => setColor(label.color), [label.color]);
  // A label typed moments ago may not have been saved yet.
  const fixed = !label.id;

  const rename = async () => {
    const next = name.trim().replace(/^#+/, "").slice(0, 40);
    if (!next || next === label.name) return setName(label.name);
    try {
      await tagsApi.update(label.id, { name: next });
      onChanged();
    } catch (e) {
      setName(label.name);
      toast.error(apiErrorMessage(e, "Couldn't rename it. Is there already a label with that name?"));
    }
  };
  const recolor = async (c: string | null) => {
    const was = color;
    setColor(c);
    setMode(null);
    try {
      await tagsApi.update(label.id, { color: c });
      onChanged();
    } catch (e) {
      setColor(was);
      toast.error(apiErrorMessage(e, "Couldn't change the colour."));
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await tagsApi.remove(label.id);
      onChanged();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't delete it."));
      setBusy(false);
      setMode(null);
    }
  };

  const icon = "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-40";
  return (
    <li className="rounded-xl border border-transparent focus-within:border-[var(--border)]">
      <div className="flex items-center gap-1">
        <button type="button" disabled={fixed} aria-label={`Colour of ${label.name}`} aria-expanded={mode === "color"} title="Colour" className={icon} onClick={() => setMode(mode === "color" ? null : "color")}>
          <span className="h-4 w-4 rounded-full" style={{ background: tagColor({ name: label.name, color }) }} aria-hidden />
        </button>
        <input
          value={name}
          disabled={fixed}
          maxLength={40}
          aria-label={`Name of ${label.name}`}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape" && name !== label.name) {
              e.stopPropagation();
              setName(label.name);
            }
          }}
          className="h-10 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-[15px] outline-none hover:bg-[var(--hover)] focus:bg-[var(--bg)]"
        />
        <span className="shrink-0 px-1 text-xs text-[var(--text-muted)]" title={`On ${label.count} of your notes`}>
          {label.count}
        </span>
        <button type="button" disabled={fixed} aria-label={`Delete ${label.name}`} aria-expanded={mode === "delete"} title="Delete" className={icon} onClick={() => setMode(mode === "delete" ? null : "delete")}>
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {mode === "color" && (
        <div className="flex flex-wrap gap-1 px-2 pb-2 pt-1">
          {TAG_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              aria-label={COLOR_NAMES[i] ?? `Colour ${i + 1}`}
              title={COLOR_NAMES[i]}
              aria-pressed={color === c}
              onClick={() => void recolor(c)}
              className={cn("flex h-9 w-9 items-center justify-center rounded-full border-2", color === c ? "border-[var(--text)]" : "border-transparent")}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full text-white" style={{ background: c }}>
                {color === c && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          ))}
        </div>
      )}
      {mode === "delete" && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1 text-sm">
          <p className="min-w-0 flex-1 basis-48 text-[var(--text-muted)]">Delete this label? It comes off everything it's on, in every app. Your notes stay.</p>
          <button type="button" className="h-10 rounded-full px-4 text-sm font-medium hover:bg-[var(--hover)]" onClick={() => setMode(null)}>
            Keep it
          </button>
          <button type="button" disabled={busy} className="h-10 rounded-full bg-[var(--danger)] px-4 text-sm font-medium text-white disabled:opacity-60" onClick={() => void remove()}>
            Delete label
          </button>
        </div>
      )}
    </li>
  );
}
