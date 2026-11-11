import { useQueryClient } from "@tanstack/react-query";
import { Check, MoreHorizontal, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { useState } from "react";

import { calendarApi, type CalendarBootstrap, type CalLabel } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { Chip, Field, ItemButton, Sheet, TextInput } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { BOOTSTRAP_KEY, useRefreshEvents } from "../data";
import { PALETTE } from "../model";
import { Popover, Swatches } from "./ui";

/** Labels are mine alone: my own names and colours, and the label I put on
 *  an event is only ever seen by me (even on a shared event). */

const MAX_LABELS = 30;

/** Keep the bootstrap's copy of my labels in step after a change. */
function usePutLabels() {
  const qc = useQueryClient();
  return (fn: (labels: CalLabel[]) => CalLabel[]) =>
    qc.setQueryData<CalendarBootstrap>(BOOTSTRAP_KEY, (old) => (old ? { ...old, labels: fn(old.labels ?? []) } : old));
}

/** A label as a small coloured chip ("● Work"). */
export function LabelChip({ label, className }: { label: CalLabel; className?: string }) {
  return (
    <span
      data-label-chip={label.name}
      className={cn("inline-flex h-6 max-w-full items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-[var(--text)]", className)}
      style={{ background: `color-mix(in srgb, ${label.color} 18%, transparent)` }}
    >
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: label.color }} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** "Label": none, or one of mine as coloured chips — and "Edit labels…". */
export function LabelPicker({ labels, value, onChange, compact = false }: { labels: CalLabel[]; value: string | null; onChange: (id: string | null) => void; compact?: boolean }) {
  const [managing, setManaging] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      {!compact && <span className="text-xs font-medium text-[var(--text-muted)]">Label</span>}
      <div role="radiogroup" aria-label="Label" className="flex flex-wrap items-center gap-1.5">
        <Chip active={!value} onClick={() => onChange(null)}>
          None
        </Chip>
        {labels.map((l) => (
          <Chip key={l.id} active={value === l.id} onClick={() => onChange(value === l.id ? null : l.id)} icon={<span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: l.color }} />}>
            {l.name}
          </Chip>
        ))}
        <button type="button" onClick={() => setManaging(true)} className="h-8 rounded-full px-2 text-xs font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]">
          Edit labels…
        </button>
      </div>
      <LabelsSheet open={managing} onClose={() => setManaging(false)} labels={labels} />
    </div>
  );
}

/** Put my label on an event (any event I can see), or take it off. */
export function useSetEventLabel() {
  const refresh = useRefreshEvents();
  return async (eventId: string, labelId: string | null) => {
    try {
      await calendarApi.setEventLabel(eventId, labelId);
      refresh();
      return true;
    } catch (err) {
      toast.error(extractError(err));
      return false;
    }
  };
}

/** Make, rename, recolour and delete my labels. */
export function LabelsSheet({ open, onClose, labels }: { open: boolean; onClose: () => void; labels: CalLabel[] }) {
  const put = usePutLabels();
  const refresh = useRefreshEvents();
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[1]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<CalLabel | null>(null);
  const [colouring, setColouring] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim() || adding) return;
    setAdding(true);
    try {
      const made = await calendarApi.createLabel({ name: name.trim(), color });
      put((ls) => [...ls, made]);
      setName("");
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setAdding(false);
    }
  };
  const update = async (l: CalLabel, body: { name?: string; color?: string }) => {
    put((ls) => ls.map((x) => (x.id === l.id ? { ...x, ...body } : x)));
    try {
      const saved = await calendarApi.updateLabel(l.id, body);
      put((ls) => ls.map((x) => (x.id === l.id ? saved : x)));
    } catch (err) {
      put((ls) => ls.map((x) => (x.id === l.id ? l : x)));
      toast.error(extractError(err));
    }
  };
  const remove = async (l: CalLabel) => {
    setDeleting(null);
    try {
      await calendarApi.deleteLabel(l.id);
      put((ls) => ls.filter((x) => x.id !== l.id));
      refresh();
    } catch (err) {
      toast.error(extractError(err));
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Labels"
      size="md"
      footer={
        <ItemButton block variant="primary" onClick={onClose}>
          Done
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4 pb-2 pt-1">
        <p className="text-xs text-[var(--text-muted)]">Colour-code your events. Your labels are only for you — nobody else sees them, even on events you share.</p>
        {labels.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No labels yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {labels.map((l) => (
              <li key={l.id} className="flex flex-col gap-2 px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Colour for ${l.name}`}
                    aria-expanded={colouring === l.id}
                    onClick={() => setColouring(colouring === l.id ? null : l.id)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-[var(--hover)]"
                  >
                    <span className="h-5 w-5 rounded-full" style={{ background: l.color }} />
                  </button>
                  <LabelName label={l} onSave={(n) => void update(l, { name: n })} />
                  <button
                    type="button"
                    aria-label={`Delete ${l.name}`}
                    onClick={() => setDeleting(l)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {colouring === l.id && (
                  <div className="pb-1 pl-11">
                    <Swatches
                      value={l.color}
                      onChange={(c) => {
                        setColouring(null);
                        void update(l, { color: c });
                      }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {labels.length < MAX_LABELS ? (
          <form
            className="flex flex-col gap-3 rounded-xl border border-dashed border-[var(--border)] p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Field label="New label">
              <div className="flex gap-2">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kids, Gym, Family" maxLength={40} aria-label="New label name" className="min-w-0 flex-1" />
                <ItemButton type="submit" variant="primary" icon={<Plus className="h-4 w-4" />} disabled={!name.trim() || adding}>
                  Add
                </ItemButton>
              </div>
            </Field>
            <Swatches value={color} onChange={setColor} />
          </form>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">You have {MAX_LABELS} labels — delete one to add another.</p>
        )}
      </div>
      <Sheet
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete "${deleting.name}"?` : "Delete label?"}
        size="sm"
        footer={
          <>
            <ItemButton block data-autofocus onClick={() => setDeleting(null)}>
              Cancel
            </ItemButton>
            <ItemButton block variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete
            </ItemButton>
          </>
        }
      >
        <p className="text-sm text-[var(--text-muted)]">The events with it stay; they just won't have this label any more.</p>
      </Sheet>
    </Sheet>
  );
}

/** A label's name, saved when you leave the box or press Enter. */
function LabelName({ label, onSave }: { label: CalLabel; onSave: (name: string) => void }) {
  const [v, setV] = useState(label.name);
  const commit = () => {
    const n = v.trim();
    if (!n) setV(label.name);
    else if (n !== label.name) onSave(n);
  };
  return (
    <TextInput
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      maxLength={40}
      aria-label={`Name of ${label.name}`}
      className="min-w-0 flex-1"
    />
  );
}

/** The side panel's "Labels": each with a tick to show or hide its events,
 *  its colour, and add / rename / recolour / delete. */
export function LabelsSection({ b }: { b: CalendarBootstrap }) {
  const labels = b.labels ?? [];
  const put = usePutLabels();
  const [managing, setManaging] = useState(false);
  const [menu, setMenu] = useState<{ label: CalLabel; at: DOMRect } | null>(null);
  const toggle = async (l: CalLabel) => {
    put((ls) => ls.map((x) => (x.id === l.id ? { ...x, hidden: !l.hidden } : x)));
    try {
      await calendarApi.updateLabel(l.id, { hidden: !l.hidden });
    } catch (err) {
      put((ls) => ls.map((x) => (x.id === l.id ? { ...x, hidden: l.hidden } : x)));
      toast.error(extractError(err));
    }
  };
  const recolour = async (l: CalLabel, color: string) => {
    put((ls) => ls.map((x) => (x.id === l.id ? { ...x, color } : x)));
    try {
      await calendarApi.updateLabel(l.id, { color });
    } catch (err) {
      put((ls) => ls.map((x) => (x.id === l.id ? { ...x, color: l.color } : x)));
      toast.error(extractError(err));
    }
  };
  return (
    <section className="flex flex-col gap-0.5" aria-label="Labels">
      <div className="flex items-center justify-between pl-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Labels</h3>
        <button
          type="button"
          onClick={() => setManaging(true)}
          aria-label="Edit labels"
          title="Edit labels"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>
      {labels.map((l) => (
        <div key={l.id} className="group flex h-9 items-center gap-1 rounded-lg pr-1 hover:bg-[var(--hover)]">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2">
            <input type="checkbox" className="sr-only" checked={!l.hidden} onChange={() => void toggle(l)} aria-label={`Show events labelled ${l.name}`} />
            <span
              aria-hidden
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2"
              style={{ borderColor: l.color, background: l.hidden ? "transparent" : l.color }}
            >
              {!l.hidden && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{l.name}</span>
          </label>
          <button
            type="button"
            aria-label={`Options for ${l.name}`}
            data-cal-keep-popover
            onClick={(e) => setMenu(menu?.label.id === l.id ? null : { label: l, at: e.currentTarget.getBoundingClientRect() })}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-100 hover:bg-[var(--hover-strong,var(--hover))] hover:text-[var(--text)] md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setManaging(true)} className="mt-1 flex h-9 items-center gap-2 rounded-lg px-2 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
        {labels.length ? <Plus className="h-4 w-4" /> : <Tag className="h-4 w-4" />}
        {labels.length ? "New label" : "Add a label"}
      </button>
      {menu && (
        <Popover anchor={menu.at} onClose={() => setMenu(null)} width={248} z={80}>
          <div className="flex flex-col gap-2 p-3">
            <span className="text-xs font-medium text-[var(--text-muted)]">Colour</span>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((c) => (
                <button key={c} type="button" aria-label={c} onClick={() => void recolour(menu.label, c)} className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: c }}>
                  {(labels.find((x) => x.id === menu.label.id)?.color ?? "").toLowerCase() === c.toLowerCase() && <Check className="h-3.5 w-3.5 text-white" />}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                setManaging(true);
              }}
              className="-mx-1 mt-1 flex h-9 items-center rounded-lg px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"
            >
              Rename or delete…
            </button>
          </div>
        </Popover>
      )}
      <LabelsSheet open={managing} onClose={() => setManaging(false)} labels={labels} />
    </section>
  );
}

/** An open event's label (mine): the chip, and a way to pick another. */
export function EventLabel({ labels, labelId, onPick }: { labels: CalLabel[]; labelId: string | null; onPick: (id: string | null) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const label = labelId ? labels.find((l) => l.id === labelId) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        {label ? <LabelChip label={label} /> : <span className="text-[var(--text-muted)]">No label</span>}
        <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className="rounded-md px-1 text-xs font-medium text-[var(--item-accent)] hover:underline">
          {open ? "Done" : label ? "Change" : "Add a label"}
        </button>
      </div>
      {open && (
        <LabelPicker
          compact
          labels={labels}
          value={labelId}
          onChange={(id) => {
            void onPick(id).then((ok) => ok && setOpen(false));
          }}
        />
      )}
    </div>
  );
}
