import { Archive, ArchiveRestore, ArrowLeft, ArrowDownAZ, CheckSquare, CloudOff, ListX, MoreVertical, Palette, Pin, Square, Tag, Trash2, Type } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { tagColor } from "@/api/tags";
import { cn } from "@/utils/cn";

import { noteOps } from "../actions";
import { notesActions, runFlushers, useNotes } from "../store";
import type { DocNode, Note, NoteLabel } from "../types";
import { BodyEditor, type BodyEditorHandle } from "./BodyEditor";
import { ListEditor } from "./ListEditor";
import { ColorGrid, LabelChooser } from "./pickers";
import { MenuItem, Pop } from "./Pop";

function edited(n: Note, me: string | null, users: Record<string, { username: string }>): string {
  const d = new Date(n.updated_at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const when = sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  const who = n.edited_by && n.edited_by !== me ? users[n.edited_by]?.username : null;
  return `Edited ${when}${who ? ` by ${who}` : ""}`;
}

/**
 * One note, open: title, then the text or the list, then its labels and a
 * footer of actions. There's no Save button: everything saves as you type
 * (and waits on this device when there's no connection). Used as the
 * desktop dialog, the phone's full page, and the composer.
 */
export function NoteEditor({
  note,
  variant,
  onClose,
  autoFocus,
  labelId,
  closer,
}: {
  note: Note;
  variant: "dialog" | "page" | "composer";
  onClose: () => void;
  autoFocus?: "title" | "body" | "list";
  labelId?: string;
  /** Set to this editor's close (saves what's typed first), for the
   *  dialog's Escape and backdrop and the composer's click-outside. */
  closer?: React.MutableRefObject<(() => void) | null>;
}) {
  const id = note.id;
  const me = useNotes((s) => s.uid);
  const users = useNotes((s) => s.users);
  const sync = useNotes((s) => s.sync);
  const pending = useNotes((s) => s.outbox.some((q) => q.op.id === id && !q.landed));
  const allLabels = useNotes((s) => s.notes);
  const isDraft = useNotes((s) => !!s.drafts[id]);
  const trashed = !!note.trashed_at;
  const editable = !trashed;
  const [pop, setPop] = useState<null | "color" | "labels" | "more">(null);
  const colorBtn = useRef<HTMLButtonElement>(null);
  const labelBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const body = useRef<BodyEditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // ---------------------------------------------------------- title + body
  const [title, setTitle] = useState(note.title);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleFocused = useRef(false);
  const titleNext = useRef(note.title);
  useEffect(() => {
    if (!titleFocused.current && !titleTimer.current) setTitle(note.title);
  }, [note.title]);
  const bodyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyNext = useRef<DocNode | null | undefined>(undefined);
  const bodyBase = useRef<DocNode | null>(note.body_doc ?? null);

  const flush = useCallback(() => {
    runFlushers(id);
    if (titleTimer.current) {
      clearTimeout(titleTimer.current);
      titleTimer.current = null;
      notesActions.patch(id, { title: titleNext.current });
    }
    if (bodyTimer.current) {
      clearTimeout(bodyTimer.current);
      bodyTimer.current = null;
      if (bodyNext.current !== undefined) notesActions.patch(id, { body_doc: bodyNext.current }, bodyBase.current);
      bodyNext.current = undefined;
    }
  }, [id]);
  useEffect(() => () => flush(), [flush]);
  useEffect(() => {
    // Leaving the page or the app: save what's typed.
    const away = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", away);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", away);
    };
  }, [flush]);

  const fitTitle = () => {
    const t = titleRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  };
  useLayoutEffect(fitTitle, [title]);

  useEffect(() => {
    if (!autoFocus || !editable) return;
    const t = setTimeout(() => {
      if (autoFocus === "title") titleRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    flush();
    onClose();
  };
  if (closer) closer.current = close;

  const labelsOnNotes = Object.values(allLabels).flatMap((n) => n.labels);
  const toggleLabel = (l: NoteLabel, on: boolean) => {
    flush();
    noteOps.label([id], l, on);
  };

  const footerBtn =
    "flex h-9 w-9 items-center justify-center rounded-full note-muted note-hover hover:text-[var(--note-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40";

  const offline = pending && (sync === "offline" || sync === "retrying" || sync === "signed_out");

  return (
    <div
      data-color={note.color}
      className={cn(
        "note-c flex min-h-0 flex-col",
        variant === "page" && "h-full",
        variant === "dialog" && "max-h-[min(85dvh,860px)] rounded-xl",
        variant === "composer" && "rounded-xl border shadow-[var(--shadow-md)]",
      )}
    >
      {variant === "page" && (
        <div className="flex h-14 shrink-0 items-center gap-1 px-2 pt-safe">
          <button type="button" onClick={close} aria-label="Back to notes" className={footerBtn}>
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex-1" />
          {editable && (
            <>
              <button type="button" onClick={() => noteOps.pin([id], !note.pinned)} aria-label={note.pinned ? "Unpin" : "Pin"} aria-pressed={note.pinned} className={footerBtn}>
                <Pin className={cn("h-5 w-5", note.pinned && "fill-current")} />
              </button>
              {!isDraft && (
                <button
                  type="button"
                  onClick={() => {
                    noteOps.archive([id], !note.archived);
                    close();
                  }}
                  aria-label={note.archived ? "Unarchive" : "Archive"}
                  className={footerBtn}
                >
                  {note.archived ? <ArchiveRestore className="h-5 w-5" /> : <Archive className="h-5 w-5" />}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {offline && (
        <p role="status" className="mx-4 mt-2 flex items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--note-text)_8%,transparent)] px-3 py-2 text-xs">
          <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {sync === "retrying" ? "Couldn't save — retrying. Your changes are kept on this device." : sync === "signed_out" ? "Sign in again to save. Your changes are kept on this device." : "Offline — changes will save when you're back."}
        </p>
      )}
      {trashed && (
        <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--note-text)_8%,transparent)] px-3 py-2 text-sm">
          <span className="flex-1">This note is in the Trash.</span>
          <button type="button" className="rounded-full px-3 py-1 font-medium note-hover" onClick={() => noteOps.restore([id])}>
            Restore
          </button>
          <button
            type="button"
            className="rounded-full px-3 py-1 font-medium text-[var(--danger)] note-hover"
            onClick={() => {
              noteOps.forever([id]);
              onClose();
            }}
          >
            Delete forever
          </button>
        </div>
      )}

      <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 pt-3", variant === "page" && "pb-6")}>
        <div className="flex items-start gap-2">
          <textarea
            ref={titleRef}
            id={labelId}
            rows={1}
            value={title}
            readOnly={!editable}
            maxLength={300}
            placeholder="Title"
            aria-label="Title"
            onFocus={() => (titleFocused.current = true)}
            onBlur={() => {
              titleFocused.current = false;
              flush();
            }}
            onChange={(e) => {
              const v = e.target.value.replace(/\n/g, " ");
              setTitle(v);
              titleNext.current = v;
              if (titleTimer.current) clearTimeout(titleTimer.current);
              titleTimer.current = setTimeout(() => {
                titleTimer.current = null;
                notesActions.patch(id, { title: v });
              }, 500);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (note.kind === "text") body.current?.focus("start");
                else (document.querySelector<HTMLInputElement>(`[data-note-editor="${id}"] input[aria-label="New list item"]`) ?? null)?.focus();
              }
            }}
            className="min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-1 text-lg font-semibold leading-snug outline-none placeholder:text-[var(--note-muted)]"
          />
          {variant !== "page" && editable && (
            <button type="button" onClick={() => noteOps.pin([id], !note.pinned)} aria-label={note.pinned ? "Unpin" : "Pin"} aria-pressed={note.pinned} className={cn(footerBtn, "-mr-2 shrink-0")}>
              <Pin className={cn("h-4 w-4", note.pinned && "fill-current")} />
            </button>
          )}
        </div>

        <div className="mt-1 pb-3" data-note-editor={id}>
          {note.kind === "text" ? (
            <BodyEditor
              ref={body}
              value={note.body_doc}
              editable={editable}
              autoFocus={editable && autoFocus === "body"}
              placeholder={variant === "composer" ? "Take a note…" : "Note"}
              onChange={(doc, base) => {
                bodyNext.current = doc;
                bodyBase.current = base;
                if (bodyTimer.current) clearTimeout(bodyTimer.current);
                bodyTimer.current = setTimeout(() => {
                  bodyTimer.current = null;
                  notesActions.patch(id, { body_doc: bodyNext.current ?? null }, bodyBase.current);
                  bodyNext.current = undefined;
                }, 600);
              }}
              className="min-h-[3rem] text-[15px] leading-relaxed"
            />
          ) : (
            <ListEditor note={note} editable={editable} autoFocusNew={autoFocus === "list"} />
          )}
        </div>

        {note.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-3">
            {note.labels.map((l) => (
              <span key={l.id || l.name} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--note-text)_9%,transparent)] pl-2.5 pr-1 text-xs">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: tagColor(l) }} />
                {l.name}
                {editable && (
                  <button type="button" aria-label={`Remove label ${l.name}`} onClick={() => toggleLabel(l, false)} className="flex h-5 w-5 items-center justify-center rounded-full note-hover">
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className={cn("flex shrink-0 items-center gap-0.5 px-2 pb-2 pt-1", variant === "page" && "pb-[calc(8px+env(safe-area-inset-bottom,0px))]")}>
        {editable && (
          <>
            <button ref={colorBtn} type="button" aria-label="Colour" title="Colour" aria-expanded={pop === "color"} onClick={() => setPop(pop === "color" ? null : "color")} className={footerBtn}>
              <Palette className="h-[18px] w-[18px]" />
            </button>
            <button ref={labelBtn} type="button" aria-label="Labels" title="Labels" aria-expanded={pop === "labels"} onClick={() => setPop(pop === "labels" ? null : "labels")} className={footerBtn}>
              <Tag className="h-[18px] w-[18px]" />
            </button>
            {variant !== "page" && !isDraft && (
              <button
                type="button"
                aria-label={note.archived ? "Unarchive" : "Archive"}
                title={note.archived ? "Unarchive" : "Archive"}
                onClick={() => {
                  noteOps.archive([id], !note.archived);
                  close();
                }}
                className={footerBtn}
              >
                {note.archived ? <ArchiveRestore className="h-[18px] w-[18px]" /> : <Archive className="h-[18px] w-[18px]" />}
              </button>
            )}
            <button ref={moreBtn} type="button" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={pop === "more"} onClick={() => setPop(pop === "more" ? null : "more")} className={footerBtn}>
              <MoreVertical className="h-[18px] w-[18px]" />
            </button>
          </>
        )}
        <span className="min-w-0 flex-1 truncate px-2 text-right text-xs note-muted">
          {isDraft ? "" : pending ? (offline ? "Saved on this device" : "Saving…") : edited(note, me, users)}
        </span>
        {variant !== "page" && (
          <button type="button" onClick={close} className="h-9 rounded-full px-4 text-sm font-medium note-hover">
            Close
          </button>
        )}
      </div>

      {pop === "color" && (
        <Pop anchor={colorBtn.current} label="Note colour" onClose={() => setPop(null)} width={248}>
          <ColorGrid value={note.color} onPick={(c) => noteOps.color([id], c)} />
        </Pop>
      )}
      {pop === "labels" && (
        <Pop anchor={labelBtn.current} label="Labels" onClose={() => setPop(null)} width={260}>
          <LabelChooser value={note.labels} onToggle={toggleLabel} extra={labelsOnNotes} />
        </Pop>
      )}
      {pop === "more" && (
        <Pop anchor={moreBtn.current} label="More" role="menu" onClose={() => setPop(null)} width={230}>
          {note.kind === "text" ? (
            <MenuItem
              icon={CheckSquare}
              onClick={() => {
                flush();
                setPop(null);
                notesActions.patch(id, { kind: "list" });
              }}
            >
              Show checkboxes
            </MenuItem>
          ) : (
            <>
              <MenuItem
                icon={Type}
                onClick={() => {
                  setPop(null);
                  notesActions.patch(id, { kind: "text" });
                }}
              >
                Hide checkboxes
              </MenuItem>
              {note.items.some((i) => i.checked) && (
                <>
                  <MenuItem
                    icon={Square}
                    onClick={() => {
                      setPop(null);
                      notesActions.itemsBulk(id, "untick_all");
                    }}
                  >
                    Untick all
                  </MenuItem>
                  <MenuItem
                    icon={ListX}
                    onClick={() => {
                      setPop(null);
                      notesActions.itemsBulk(id, "delete_ticked");
                    }}
                  >
                    Delete ticked items
                  </MenuItem>
                </>
              )}
              {note.items.length > 1 && (
                <MenuItem
                  icon={ArrowDownAZ}
                  onClick={() => {
                    setPop(null);
                    notesActions.itemsBulk(id, "sort");
                  }}
                >
                  Sort A–Z
                </MenuItem>
              )}
            </>
          )}
          {!isDraft && (
            <MenuItem
              icon={Trash2}
              danger
              onClick={() => {
                setPop(null);
                flush();
                noteOps.trash([id]);
                onClose();
              }}
            >
              {note.is_owner ? "Delete note" : "Remove from my notes"}
            </MenuItem>
          )}
          {isDraft && (
            <MenuItem
              icon={Trash2}
              danger
              onClick={() => {
                setPop(null);
                notesActions.trash(id);
                onClose();
              }}
            >
              Discard
            </MenuItem>
          )}
        </Pop>
      )}
    </div>
  );
}
