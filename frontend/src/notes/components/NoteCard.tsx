import { Archive, ArchiveRestore, CheckCircle2, Circle, CloudOff, Mic, MoreVertical, Image as ImageIcon, Palette, Pin, PinOff, RotateCcw, Trash2, Users } from "lucide-react";
import { memo, useRef, useState } from "react";

import { tagColor } from "@/api/tags";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { cn } from "@/utils/cn";

import { grouped } from "../ops";
import { attachmentCounts, displayTitle, type Note, type NoteUser } from "../types";
import { ColorGrid } from "./pickers";
import { MenuItem, Pop } from "./Pop";

export interface CardActions {
  open: (id: string) => void;
  select: (id: string, how: "toggle" | "range") => void;
  pin: (id: string, pinned: boolean) => void;
  color: (id: string, color: string) => void;
  archive: (id: string, archived: boolean) => void;
  trash: (id: string) => void;
  labels: (id: string, anchor: HTMLElement) => void;
  restore: (id: string) => void;
  forever: (id: string) => void;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One note in the grid: its colour, title, the start of its text or list,
 *  labels and who it's shared with. Hover (or focus) shows quick actions. */
export const NoteCard = memo(function NoteCard({
  note,
  users,
  selected,
  selecting,
  trash,
  pending,
  actions,
  dragHandle,
  dropTarget,
}: {
  note: Note;
  users: Record<string, NoteUser>;
  selected: boolean;
  selecting: boolean;
  trash: boolean;
  pending: boolean;
  actions: CardActions;
  dragHandle?: Record<string, unknown>;
  dropTarget?: boolean;
}) {
  const [pop, setPop] = useState<null | "color" | "more">(null);
  const colorBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const title = note.title.trim();
  const name = displayTitle(note);
  const items = grouped(note.items).filter((i) => !i.checked);
  const shown = items.slice(0, 8);
  const unticked = note.items_total - note.items_checked;
  const moreOpen = Math.max(0, unticked - shown.length);
  const counts = attachmentCounts(note);
  const people = note.is_owner ? note.member_ids : [note.owner_id, ...note.member_ids];
  const text = note.kind === "text" ? (note.body_text ?? note.snippet ?? "") : "";
  const empty = !title && !text.trim() && !shown.length && !note.items_checked;
  const owner = users[note.owner_id];

  const tool = "flex h-8 w-8 items-center justify-center rounded-full note-muted note-hover hover:text-[var(--note-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]";

  return (
    <article
      data-note-card={note.id}
      data-color={note.color}
      aria-label={name}
      className={cn(
        "note-c group/card relative flex flex-col overflow-hidden rounded-xl border transition-shadow [-webkit-touch-callout:none] [@media(pointer:coarse)]:select-none",
        "hover:shadow-[var(--shadow-md)] focus-within:shadow-[var(--shadow-md)]",
        selected && "ring-2 ring-[var(--accent)]",
        dropTarget && "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg)]",
      )}
      {...(dragHandle ?? {})}
    >
      {/* The card itself opens the note (a stretched button under the content). */}
      <button
        type="button"
        aria-label={selecting ? `${selected ? "Unselect" : "Select"} ${name}` : `Open ${name}`}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]"
        onClick={(e) => {
          if (selecting || e.shiftKey || e.metaKey || e.ctrlKey) actions.select(note.id, e.shiftKey ? "range" : "toggle");
          else actions.open(note.id);
        }}
      />

      <div className="pointer-events-none relative z-[1] flex flex-col gap-2 px-4 pb-2 pt-3">
        {title && <h3 className="break-words pr-6 text-[15px] font-semibold leading-snug">{title}</h3>}
        {note.kind === "text" && text.trim() && (
          <p className="note-clamp whitespace-pre-wrap break-words text-sm leading-relaxed" style={{ WebkitLineClamp: 10 }}>
            {text}
          </p>
        )}
        {note.kind === "list" && (shown.length > 0 || note.items_checked > 0) && (
          <ul className="flex flex-col gap-0.5 text-sm">
            {shown.map((i) => (
              <li key={i.id} className={cn("flex items-start gap-2", i.parent_id && "pl-5")}>
                <span aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0 rounded-[3px] border border-current opacity-60" />
                <span className="min-w-0 break-words">{i.text || " "}</span>
              </li>
            ))}
            {moreOpen > 0 && <li className="note-muted pl-5 text-xs">+ {moreOpen} more</li>}
            {note.items_checked > 0 && (
              <li className="note-muted pl-5 text-xs">
                + {note.items_checked} ticked {note.items_checked === 1 ? "item" : "items"}
              </li>
            )}
          </ul>
        )}
        {empty && <p className="note-muted text-sm italic">Empty note</p>}

        {(note.labels.length > 0 || counts.images > 0 || counts.audio > 0) && (
          <div className="flex flex-wrap gap-1">
            {counts.images > 0 && (
              <span className="inline-flex h-6 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--note-text)_9%,transparent)] px-2 text-xs">
                <ImageIcon className="h-3 w-3" aria-hidden /> {counts.images}
                <span className="sr-only">{counts.images === 1 ? "image" : "images"}</span>
              </span>
            )}
            {counts.audio > 0 && (
              <span className="inline-flex h-6 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--note-text)_9%,transparent)] px-2 text-xs">
                <Mic className="h-3 w-3" aria-hidden /> {counts.audio_ms ? duration(counts.audio_ms) : counts.audio}
                <span className="sr-only">voice recording</span>
              </span>
            )}
            {note.labels.map((l) => (
              <span key={l.id || l.name} className="inline-flex h-6 max-w-[10rem] items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--note-text)_9%,transparent)] px-2 text-xs">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tagColor(l) }} />
                <span className="truncate">{l.name}</span>
              </span>
            ))}
          </div>
        )}
        {people.length > 0 && (
          <div className="flex items-center gap-1" aria-label={note.is_owner ? "Shared" : `Shared by ${owner?.username ?? "someone"}`}>
            <Users className="h-3.5 w-3.5 note-muted" aria-hidden />
            <span className="flex -space-x-1">
              {people.slice(0, 5).map((uid) => {
                const u = users[uid];
                return <UserAvatar key={uid} name={u?.username ?? "?"} userId={uid} avatarUrl={u?.avatar_url} color={u?.color} size={20} className="ring-2 ring-[var(--note-bg)]" />;
              })}
            </span>
          </div>
        )}
        {pending && (
          <span className="flex items-center gap-1 text-[11px] note-muted">
            <CloudOff className="h-3 w-3" aria-hidden /> Saved on this device
          </span>
        )}
      </div>

      {/* Select (top left) and pin (top right). */}
      {!trash && (
        <button
          type="button"
          aria-label={selected ? `Unselect ${name}` : `Select ${name}`}
          aria-pressed={selected}
          onClick={() => actions.select(note.id, "toggle")}
          className={cn(
            "absolute -left-0.5 -top-0.5 z-[2] flex h-8 w-8 items-center justify-center rounded-full text-[var(--note-text)] transition",
            selected || selecting ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover/card:opacity-100",
          )}
        >
          {selected ? <CheckCircle2 className="h-5 w-5 fill-[var(--accent)] text-white" /> : <Circle className="h-5 w-5 opacity-60" />}
        </button>
      )}
      {!trash && !selecting && (
        <button
          type="button"
          aria-label={note.pinned ? `Unpin ${name}` : `Pin ${name}`}
          aria-pressed={note.pinned}
          onClick={() => actions.pin(note.id, !note.pinned)}
          className={cn(tool, "absolute right-1 top-1 z-[2]", note.pinned ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover/card:opacity-100 max-md:hidden")}
        >
          {note.pinned ? <Pin className="h-4 w-4 fill-current" /> : <Pin className="h-4 w-4" />}
        </button>
      )}

      {/* Quick actions along the bottom. */}
      {!selecting && (
        <div
          className={cn(
            "relative z-[2] flex items-center gap-0.5 px-1.5 pb-1.5 transition-opacity",
            pop ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover/card:opacity-100 max-md:hidden",
          )}
        >
          {trash ? (
            <>
              <button type="button" className={tool} aria-label={`Restore ${name}`} title="Restore" onClick={() => actions.restore(note.id)}>
                <RotateCcw className="h-4 w-4" />
              </button>
              <button type="button" className={tool} aria-label={`Delete ${name} forever`} title="Delete forever" onClick={() => actions.forever(note.id)}>
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <button ref={colorBtn} type="button" className={tool} aria-label={`Colour of ${name}`} title="Colour" aria-expanded={pop === "color"} onClick={() => setPop(pop === "color" ? null : "color")}>
                <Palette className="h-4 w-4" />
              </button>
              <button type="button" className={tool} aria-label={note.archived ? `Unarchive ${name}` : `Archive ${name}`} title={note.archived ? "Unarchive" : "Archive"} onClick={() => actions.archive(note.id, !note.archived)}>
                {note.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
              </button>
              <button ref={moreBtn} type="button" className={tool} aria-label={`More for ${name}`} title="More" aria-haspopup="menu" aria-expanded={pop === "more"} onClick={() => setPop(pop === "more" ? null : "more")}>
                <MoreVertical className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      )}
      {pop === "color" && (
        <Pop anchor={colorBtn.current} label="Note colour" onClose={() => setPop(null)} width={248}>
          <ColorGrid
            value={note.color}
            onPick={(c) => {
              actions.color(note.id, c);
              setPop(null);
            }}
          />
        </Pop>
      )}
      {pop === "more" && (
        <Pop anchor={moreBtn.current} label={`More for ${name}`} role="menu" onClose={() => setPop(null)} width={210}>
          <MenuItem
            icon={note.pinned ? PinOff : Pin}
            onClick={() => {
              setPop(null);
              actions.pin(note.id, !note.pinned);
            }}
          >
            {note.pinned ? "Unpin" : "Pin"}
          </MenuItem>
          <MenuItem
            onClick={() => {
              const a = moreBtn.current;
              setPop(null);
              if (a) actions.labels(note.id, a);
            }}
          >
            {note.labels.length ? "Change labels" : "Add label"}
          </MenuItem>
          <MenuItem
            icon={Trash2}
            danger
            onClick={() => {
              setPop(null);
              actions.trash(note.id);
            }}
          >
            {note.is_owner ? "Delete note" : "Remove from my notes"}
          </MenuItem>
        </Pop>
      )}
    </article>
  );
});
