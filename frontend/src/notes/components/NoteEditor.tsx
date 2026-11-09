import { Archive, ArchiveRestore, ArrowLeft, ArrowDownAZ, BellPlus, CalendarPlus, CheckSquare, CloudOff, Copy, FileText, Heading, ListTodo, ListX, Mic, MoreVertical, Palette, Pin, Send, ShoppingBasket, Sparkles, Square, Store, Tag, Trash2, Type, UserPlus, Users, WandSparkles } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { PhotoItem } from "@/api/photos";
import { tagColor } from "@/api/tags";
import { SendToSheet } from "@/components/share/SendToSheet";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { useAvailableModels } from "@/hooks/useProviders";
import { useEditorModel } from "@/lib/editorModel";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { noteOps } from "../actions";
import { makeCopy, openAsDocument } from "../across";
import { notesActions, runFlushers, useNotes } from "../store";
import { displayTitle, textDoc, uuid, type DocNode, type Note, type NoteAttachment, type NoteLabel } from "../types";
import { addFiles, cancelUpload, retryUpload, useNoteAttachments } from "../uploads";
import { AddImageButton } from "./AddImage";
import { AudioPlayer } from "./AudioPlayer";
import { NoteImages } from "./NoteImages";
import { Recorder } from "./Recorder";
import { BodyEditor, type BodyEditorHandle } from "./BodyEditor";
import { ListEditor } from "./ListEditor";
import { AiSheet, EventSheet, TasksSheet } from "./NoteTools";
import { ColorGrid, LabelChooser } from "./pickers";
import { MenuItem, Pop } from "./Pop";
import { ReminderChip, ReminderPicker } from "./Reminder";
import { ShareDialog } from "./ShareDialog";

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
  startWith,
}: {
  note: Note;
  variant: "dialog" | "page" | "composer";
  /** Open the recorder as soon as the note opens (the Record buttons). */
  startWith?: "record";
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
  const [pop, setPop] = useState<null | "color" | "labels" | "more" | "remind">(null);
  const [sharing, setSharing] = useState(false);
  // Across Promptly (N1.5): an AI proposal, Turn into tasks, Make an event, Send to….
  const [tool, setTool] = useState<null | "tidy" | "to_list" | "title" | "tasks" | "event" | "send">(null);
  const [busyTool, setBusyTool] = useState<null | "copy" | "document">(null);
  const navigate = useNavigate();
  useAvailableModels();
  const model = useEditorModel();
  const hasModel = !!model.providerId && !!model.modelId;
  // A fresh voice note with no title: offer a title, once (per note, per device).
  const offerKey = `notes-title-offer:${id}`;
  const [titleOfferGone, setTitleOfferGone] = useState(() => {
    try {
      return localStorage.getItem(offerKey) === "1";
    } catch {
      return false;
    }
  });
  const dismissTitleOffer = () => {
    setTitleOfferGone(true);
    try {
      localStorage.setItem(offerKey, "1");
    } catch {
      /* private mode: it just comes back next time */
    }
  };
  const colorBtn = useRef<HTMLButtonElement>(null);
  const remindBtn = useRef<HTMLButtonElement>(null);
  const labelBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const body = useRef<BodyEditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const atts = useNoteAttachments(note);
  const images = atts.filter((a) => a.kind === "image");
  const recordings = atts.filter((a) => a.kind === "audio");
  const [recording, setRecording] = useState(startWith === "record" && !note.trashed_at);

  // Opening a note someone else changed clears its "changed" dot (and
  // keeps it clear while their changes arrive here).
  useEffect(() => {
    if (!isDraft && note.changed && !note.trashed_at) notesActions.me(id, { seen: true });
  }, [id, isDraft, note.changed, note.change_seq, note.trashed_at]);

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

  // ---------------------------------------------------------- pictures and recordings
  const putFiles = (files: File[], extra?: { duration_ms?: number; peaks?: number[] }) => {
    flush();
    const n = addFiles(id, files, extra);
    if (n < files.length) toast.error(n ? "Only pictures and recordings can go in a note — the rest were left out." : "Only pictures and recordings can go in a note.");
  };
  const putPhotos = (items: PhotoItem[]) => {
    flush();
    for (const p of items)
      notesActions.attach(id, {
        id: uuid(),
        kind: "image",
        file_id: p.id,
        filename: p.filename,
        width: p.width,
        height: p.height,
        urls: { original: null, thumb: p.thumb, preview: p.thumb, play: null },
      });
  };
  const removeAttachment = (a: NoteAttachment) => {
    if (a.local) {
      cancelUpload(a.id);
      return;
    }
    notesActions.detach(id, a.id, a.kind);
    const fileId = a.file_id;
    toast.info(a.kind === "image" ? "Picture removed" : "Recording removed", {
      action: fileId
        ? {
            label: "Undo",
            onClick: () => notesActions.attach(id, { ...a, id: uuid(), file_id: fileId, local: undefined }),
          }
        : undefined,
    });
  };
  const addToNote = (text: string) => {
    flush();
    const cur = useNotes.getState().notes[id] ?? useNotes.getState().drafts[id] ?? note;
    if (cur.kind === "list") {
      let after: string | null = null;
      for (const line of text.split(/\n+/).map((l) => l.trim()).filter(Boolean)) after = notesActions.addItem(id, { text: line.slice(0, 1000) }, after ?? lastItemId(cur));
    } else {
      const extra = textDoc(text.replace(/^\[\d+:\d{2}:\d{2}\] /gm, ""))?.content ?? [];
      notesActions.patch(id, { body_doc: { type: "doc", content: [...(cur.body_doc?.content ?? []), ...extra] } });
    }
    toast.success("Added to the note");
  };

  const labelsOnNotes = Object.values(allLabels).flatMap((n) => n.labels);
  const toggleLabel = (l: NoteLabel, on: boolean) => {
    flush();
    noteOps.label([id], l, on);
  };

  // ---------------------------------------------------------- across Promptly
  const pick = (t: NonNullable<typeof tool>) => {
    flush();
    setPop(null);
    if (t === "title") dismissTitleOffer();
    setTool(t);
  };
  const offerTitle =
    editable && hasModel && !isDraft && !titleOfferGone && !title.trim() && recordings.some((a) => a.transcript_state === "done" && !!a.transcript);
  const copyNote = async () => {
    if (busyTool) return;
    flush();
    setPop(null);
    setBusyTool("copy");
    const copy = await makeCopy(note);
    setBusyTool(null);
    if (copy) navigate(`/notes/n/${copy}`, { replace: true, state: { from: "/notes" } });
  };
  const toDocument = async () => {
    if (busyTool) return;
    flush();
    setPop(null);
    setBusyTool("document");
    const href = await openAsDocument(note);
    setBusyTool(null);
    if (href) navigate(href);
  };

  const footerBtn =
    "flex h-9 w-9 items-center justify-center rounded-full note-muted note-hover hover:text-[var(--note-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40";

  const offline = pending && (sync === "offline" || sync === "retrying" || sync === "signed_out");

  // Who it's shared with (shown on the note; opens the share dialog).
  const people = note.is_owner ? note.member_ids : [note.owner_id, ...note.member_ids.filter((u) => u !== me)];
  const nameOf = (uid: string) => users[uid]?.username ?? "someone";
  const sharedShort = note.is_owner
    ? `Shared with ${people.length === 1 ? nameOf(people[0]) : `${people.length} people`}`
    : `${nameOf(note.owner_id)}'s note`;
  const sharedWords = note.is_owner
    ? `Shared with ${people.map(nameOf).join(", ")}. Change who has it`
    : `Shared with you by ${nameOf(note.owner_id)}${people.length > 1 ? `, with ${people.slice(1).map(nameOf).join(", ")}` : ""}. See who has it`;

  return (
    <div
      data-color={note.color}
      className={cn(
        "note-c flex min-h-0 flex-col",
        variant === "page" && "h-full",
        variant === "dialog" && "max-h-[min(85dvh,860px)] overflow-hidden rounded-xl",
        variant === "composer" && "overflow-hidden rounded-xl border shadow-[var(--shadow-md)]",
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
        {images.length > 0 && (
          <div className={cn("-mx-4 mb-3", variant === "page" ? "" : "-mt-3")}>
            <NoteImages images={images} editable={editable} onRemove={removeAttachment} onRetryUpload={(a) => retryUpload(a.id)} />
          </div>
        )}
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
        {offerTitle && (
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
            <button type="button" onClick={() => pick("title")} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--note-text)_9%,transparent)] px-3 font-medium note-hover">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              Suggest a title
            </button>
            <button type="button" onClick={dismissTitleOffer} className="h-7 rounded-full px-2 note-muted note-hover">
              No thanks
            </button>
          </div>
        )}

        <div className="mt-1 pb-3" data-note-editor={id}>
          {note.kind === "text" ? (
            <BodyEditor
              ref={body}
              value={note.body_doc}
              editable={editable}
              autoFocus={editable && autoFocus === "body"}
              placeholder={variant === "composer" ? "Take a note…" : "Note"}
              theirName={note.edited_by && note.edited_by !== me ? users[note.edited_by]?.username : undefined}
              noteId={id}
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

        {recordings.length > 0 && (
          <div className="flex flex-col gap-2 pb-3">
            {recordings.map((a) => (
              <AudioPlayer
                key={a.id}
                att={a}
                editable={editable}
                transcriptionOn={note.transcription ?? true}
                onRemove={() => removeAttachment(a)}
                onAddToNote={addToNote}
                onRetryTranscript={() => notesActions.transcribe(id, a.id)}
                onRetryUpload={() => retryUpload(a.id)}
              />
            ))}
          </div>
        )}

        {(note.reminder || people.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 pb-3">
            {note.reminder && (
              <ReminderChip
                reminder={note.reminder}
                className="h-7"
                onOpen={editable ? () => setPop("remind") : undefined}
                onRemove={editable ? () => notesActions.remind(id, null) : undefined}
              />
            )}
            {people.length > 0 && (
              <button
                type="button"
                onClick={() => setSharing(true)}
                aria-label={sharedWords}
                title={sharedWords}
                className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--note-text)_9%,transparent)] pl-1 pr-2.5 text-xs note-hover"
              >
                <span className="flex -space-x-1">
                  {people.slice(0, 4).map((uid) => {
                    const u = users[uid];
                    return <UserAvatar key={uid} name={u?.username ?? "?"} userId={uid} avatarUrl={u?.avatar_url} color={u?.color} size={20} className="ring-2 ring-[var(--note-bg)]" />;
                  })}
                </span>
                <span className="truncate">{sharedShort}</span>
              </button>
            )}
          </div>
        )}

        {note.document && (
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--note-text)_8%,transparent)] px-3 py-2 text-sm">
            <FileText className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              Continued as a document: <span className="font-medium">{note.document.title}</span>
            </span>
            <Link to={note.document.href} className="shrink-0 rounded-full px-3 py-1 font-medium note-hover">
              Open
            </Link>
          </div>
        )}

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
            <button
              ref={remindBtn}
              type="button"
              aria-label={note.reminder ? "Change reminder" : "Remind me"}
              title="Remind me"
              aria-expanded={pop === "remind"}
              onClick={() => setPop(pop === "remind" ? null : "remind")}
              className={footerBtn}
            >
              <BellPlus className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              aria-label={note.is_owner ? "Share" : "People on this note"}
              title={note.is_owner ? "Share" : "People"}
              onClick={() => {
                flush();
                setSharing(true);
              }}
              className={footerBtn}
            >
              {note.is_owner ? <UserPlus className="h-[18px] w-[18px]" /> : <Users className="h-[18px] w-[18px]" />}
            </button>
            <button ref={colorBtn} type="button" aria-label="Colour" title="Colour" aria-expanded={pop === "color"} onClick={() => setPop(pop === "color" ? null : "color")} className={footerBtn}>
              <Palette className="h-[18px] w-[18px]" />
            </button>
            <button ref={labelBtn} type="button" aria-label="Labels" title="Labels" aria-expanded={pop === "labels"} onClick={() => setPop(pop === "labels" ? null : "labels")} className={footerBtn}>
              <Tag className="h-[18px] w-[18px]" />
            </button>
            <AddImageButton onFiles={(f) => putFiles(f)} onPhotos={putPhotos} className={footerBtn} />
            <button type="button" aria-label="Record a voice note" title="Record" onClick={() => setRecording(true)} className={footerBtn}>
              <Mic className="h-[18px] w-[18px]" />
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

      {recording && (
        <Recorder
          onClose={() => setRecording(false)}
          onSave={(r) => {
            setRecording(false);
            putFiles([r.file], { duration_ms: r.duration_ms, peaks: r.peaks });
          }}
          onFiles={(files) => {
            setRecording(false);
            putFiles(files);
          }}
        />
      )}
      {pop === "remind" && <ReminderPicker note={note} anchor={remindBtn.current} onClose={() => setPop(null)} />}
      {sharing && <ShareDialog note={note} onClose={() => setSharing(false)} onLeft={onClose} />}
      {(tool === "tidy" || tool === "to_list" || tool === "title") && <AiSheet note={note} action={tool} onClose={() => setTool(null)} />}
      {tool === "tasks" && <TasksSheet note={note} onClose={() => setTool(null)} />}
      {tool === "event" && (
        <EventSheet
          note={note}
          onClose={() => setTool(null)}
          onGo={(href) => {
            setTool(null);
            flush();
            navigate(href);
          }}
        />
      )}
      <SendToSheet open={tool === "send"} onClose={() => setTool(null)} target={{ kind: "note", id: note.id, title: displayTitle(note) }} canGrant={false} />
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
              {note.items.length > 1 && !note.list_opts.aisles && (
                <MenuItem
                  icon={ShoppingBasket}
                  onClick={() => {
                    setPop(null);
                    flush();
                    notesActions.itemsBulk(id, "sort_aisle");
                  }}
                >
                  Sort by aisle
                </MenuItem>
              )}
              <MenuItem
                icon={Store}
                checked={!!note.list_opts.aisles}
                onClick={() => {
                  setPop(null);
                  flush();
                  notesActions.patch(id, { list_opts: { ...note.list_opts, aisles: !note.list_opts.aisles } });
                }}
              >
                Keep sorted by aisle
              </MenuItem>
            </>
          )}
          {editable && hasModel && !isDraft && note.kind === "text" && (
            <>
              <MenuItem icon={Sparkles} onClick={() => pick("tidy")}>
                Tidy up
              </MenuItem>
              <MenuItem icon={WandSparkles} onClick={() => pick("to_list")}>
                Make a list
              </MenuItem>
            </>
          )}
          {editable && hasModel && !isDraft && (
            <MenuItem icon={Heading} onClick={() => pick("title")}>
              Suggest a title
            </MenuItem>
          )}
          {!isDraft && (
            <>
              <MenuItem icon={CalendarPlus} onClick={() => pick("event")}>
                Make an event
              </MenuItem>
              <MenuItem icon={ListTodo} onClick={() => pick("tasks")}>
                Turn into tasks
              </MenuItem>
              <MenuItem icon={Send} onClick={() => pick("send")}>
                Send to…
              </MenuItem>
              <MenuItem icon={Copy} onClick={() => void copyNote()}>
                {busyTool === "copy" ? "Making a copy…" : "Make a copy"}
              </MenuItem>
              {note.is_owner && !note.document && (
                <MenuItem icon={FileText} onClick={() => void toDocument()}>
                  {busyTool === "document" ? "Making a document…" : "Open as document"}
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

function lastItemId(n: Note): string | null {
  const open = [...n.items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return open.length ? open[open.length - 1].id : null;
}
