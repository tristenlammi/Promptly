import { useQueryClient } from "@tanstack/react-query";
import { AtSign, CalendarPlus, CornerUpLeft, Loader2, Paperclip, Pencil, Plus, SendHorizontal, Smile, Sparkles, Users, X, type LucideIcon } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";

import { roomsApi, type Attachment, type Message, type RoomUser } from "@/api/rooms";
import { Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { editMessage, sendMessage } from "../actions";
import { fileSize, plainSnippet } from "../format";
import { useRoomsStore } from "../store";
import { EmojiGrid, Popover, UserAvatar } from "./ui";

const MAX_FILE = 50 * 1024 * 1024;
const drafts = new Map<string, string>();

interface Upload {
  key: string;
  file: File;
  preview: string | null;
  progress: number;
  att: Attachment | null;
  error: string | null;
  abort: AbortController;
}

interface Candidate {
  key: string;
  insert: string;
  label: string;
  hint?: string;
  user?: RoomUser;
  special?: "promptly" | "everyone";
}

export interface ComposerHandle {
  addFiles: (files: File[]) => void;
  focus: () => void;
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    roomId: string;
    placeholder: string;
    members: RoomUser[];
    meId: string;
    isPhone: boolean;
    replyTo: Message | null;
    onCancelReply: () => void;
    editing: Message | null;
    onEdit: (m: Message | null) => void;
    users: Record<string, RoomUser>;
    /** "Plan an event" in the + menu (opens the calendar's editor in room mode). */
    onPlanEvent?: () => void;
  }
>(function Composer({ roomId, placeholder, members, meId, isPhone, replyTo, onCancelReply, editing, onEdit, users, onPlanEvent }, ref) {
  const qc = useQueryClient();
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(() => drafts.get(roomId) ?? "");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const plusBtn = useRef<HTMLButtonElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const lastTyping = useRef(0);
  const savedDraft = useRef<string | null>(null);

  // Switching rooms: keep each room's draft.
  const prevRoom = useRef(roomId);
  useEffect(() => {
    if (prevRoom.current !== roomId) {
      setText(drafts.get(roomId) ?? "");
      setUploads((u) => {
        u.forEach((x) => {
          x.abort.abort();
          if (x.preview) URL.revokeObjectURL(x.preview);
        });
        return [];
      });
      prevRoom.current = roomId;
    }
  }, [roomId]);

  useEffect(() => {
    if (!editing) drafts.set(roomId, text);
  }, [text, roomId, editing]);

  // Entering / leaving edit mode.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (editing) {
      savedDraft.current = text;
      setText(editing.body);
      requestAnimationFrame(() => {
        const el = ta.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    } else if (savedDraft.current !== null) {
      setText(savedDraft.current);
      savedDraft.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  useEffect(() => {
    if (replyTo) ta.current?.focus();
  }, [replyTo]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  const addFiles = useCallback(
    (files: File[]) => {
      if (editing) return;
      for (const file of files) {
        if (file.size > MAX_FILE) {
          toast.error(`${file.name} is over 50 MB.`);
          continue;
        }
        const key = `${Date.now()}-${Math.random()}`;
        const abort = new AbortController();
        const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
        setUploads((u) => [...u, { key, file, preview, progress: 0, att: null, error: null, abort }]);
        roomsApi
          .upload(
            roomId,
            file,
            (f) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: f } : x))),
            abort.signal,
          )
          .then((att) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, att, progress: 1 } : x))))
          .catch((err) => {
            if (abort.signal.aborted) return;
            setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: apiErrorMessage(err, "Upload failed") } : x)));
          });
      }
    },
    [roomId, editing],
  );

  useImperativeHandle(ref, () => ({ addFiles, focus: () => ta.current?.focus() }), [addFiles]);

  const removeUpload = (key: string) =>
    setUploads((u) => {
      const x = u.find((y) => y.key === key);
      x?.abort.abort();
      if (x?.preview) URL.revokeObjectURL(x.preview);
      return u.filter((y) => y.key !== key);
    });

  // ---- @-mentions ----
  const mention = useMemo(() => {
    const before = text.slice(0, caret);
    const m = /(^|\s)@([\w.-]{0,32})$/.exec(before);
    if (!m) return null;
    return { query: m[2].toLowerCase(), start: before.length - m[2].length - 1 };
  }, [text, caret]);

  const candidates = useMemo<Candidate[]>(() => {
    if (!mention) return [];
    const q = mention.query;
    const list: Candidate[] = [];
    for (const u of members) {
      if (u.id === meId) continue;
      if (!q || u.username.toLowerCase().includes(q)) list.push({ key: u.id, insert: u.username, label: u.username, user: u });
    }
    list.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)));
    const extra: Candidate[] = [];
    if ("promptly".startsWith(q)) extra.push({ key: "promptly", insert: "promptly", label: "promptly", hint: "Ask Promptly", special: "promptly" });
    if ("everyone".startsWith(q)) extra.push({ key: "everyone", insert: "everyone", label: "everyone", hint: "Notify everyone here", special: "everyone" });
    return [...extra.filter((e) => e.special === "promptly"), ...list.slice(0, 8), ...extra.filter((e) => e.special === "everyone")];
  }, [mention, members, meId]);

  const mentionKey = mention ? `${mention.start}` : null;
  const showMentions = !!mention && candidates.length > 0 && mentionDismissed !== mentionKey;

  useEffect(() => setMentionIdx(0), [mention?.query]);

  const pickMention = (c: Candidate) => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${c.insert} ${text.slice(caret)}`;
    const pos = mention.start + c.insert.length + 2;
    setText(next);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const insertAtCaret = (s: string) => {
    const el = ta.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + s + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + s.length, start + s.length);
    });
  };

  // ---- send ----
  const uploading = uploads.some((u) => !u.att && !u.error);
  const ready = uploads.filter((u) => u.att).map((u) => u.att!);
  const canSend = !uploading && (text.trim().length > 0 || (!editing && ready.length > 0));

  const submit = async () => {
    if (!canSend) return;
    const body = text.trim();
    if (editing) {
      if (body !== editing.body) {
        const ok = await editMessage(editing, body);
        if (!ok) return;
      }
      savedDraft.current = "";
      onEdit(null);
      return;
    }
    setText("");
    drafts.delete(roomId);
    uploads.forEach((u) => u.preview && URL.revokeObjectURL(u.preview));
    setUploads([]);
    const reply = replyTo?.id ?? null;
    onCancelReply();
    lastTyping.current = 0;
    void sendMessage(qc, roomId, { body, reply_to_id: reply, attachments: ready });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentions) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(candidates[mentionIdx] ?? candidates[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMentionDismissed(mentionKey);
        return;
      }
    }
    if (e.key === "Escape") {
      if (editing) {
        e.preventDefault();
        e.stopPropagation();
        onEdit(null);
      } else if (replyTo) {
        e.preventDefault();
        e.stopPropagation();
        onCancelReply();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !isPhone && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "ArrowUp" && !isPhone && !editing && text === "" && !e.altKey) {
      const win = useRoomsStore.getState().windows[roomId];
      const mine = win?.messages
        .slice()
        .reverse()
        .find((m) => m.kind === "user" && m.author_id === meId && !m.deleted && m.body && !m.meta?.event_id);
      if (mine) {
        e.preventDefault();
        onEdit(mine);
      }
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    if (!editing && e.target.value.trim() && Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now();
      void roomsApi.typing(roomId).catch(() => undefined);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const replyName = replyTo
    ? replyTo.kind === "promptly"
      ? "Promptly"
      : replyTo.author_id
        ? users[replyTo.author_id]?.username ?? "Someone"
        : "Someone"
    : "";

  const iconBtn =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] md:h-10 md:w-10";

  return (
    <div className="relative shrink-0 border-t border-[var(--border)] bg-[var(--bg)] px-2 pt-2 pb-safe-toolbar md:px-4 md:pb-3">
      {showMentions && (
        <div
          role="listbox"
          aria-label="Mention someone"
          className="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-64 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lg)] md:left-4 md:right-auto md:w-80"
        >
          {candidates.map((c, i) => (
            <button
              key={c.key}
              type="button"
              role="option"
              aria-selected={i === mentionIdx}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickMention(c)}
              className={cn(
                "flex h-11 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm md:h-9",
                i === mentionIdx ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]",
              )}
            >
              {c.user ? (
                <UserAvatar user={c.user} size={24} />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--item-accent)]">
                  {c.special === "promptly" ? <Sparkles className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
                </span>
              )}
              <span className="font-medium text-[var(--text)]">@{c.label}</span>
              {c.hint && <span className="truncate text-xs text-[var(--text-muted)]">{c.hint}</span>}
            </button>
          ))}
        </div>
      )}

      {(replyTo || editing) && (
        <div className="mb-1.5 flex items-center gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
          {editing ? <Pencil className="h-3.5 w-3.5 shrink-0" /> : <CornerUpLeft className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">
            {editing ? (
              <>Editing your message{!isPhone && " · Esc to cancel"}</>
            ) : (
              <>
                Replying to <b className="text-[var(--text)]">{replyName}</b> — {plainSnippet(replyTo!.body, 80) || "attachment"}
              </>
            )}
          </span>
          <button
            type="button"
            aria-label={editing ? "Cancel editing" : "Cancel reply"}
            onClick={() => (editing ? onEdit(null) : onCancelReply())}
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="mb-1.5 flex gap-2 overflow-x-auto pb-1">
          {uploads.map((u) => (
            <div
              key={u.key}
              className={cn(
                "relative flex h-16 shrink-0 items-center overflow-hidden rounded-xl border bg-[var(--surface)]",
                u.error ? "border-[var(--danger)]" : "border-[var(--border)]",
                u.preview ? "w-16" : "max-w-[200px] gap-2 px-3",
              )}
              title={u.error ?? u.file.name}
            >
              {u.preview ? (
                <img src={u.preview} alt={u.file.name} className="h-full w-full object-cover" />
              ) : (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-medium text-[var(--text)]">{u.file.name}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">{u.error ?? fileSize(u.file.size)}</span>
                </span>
              )}
              {!u.att && !u.error && (
                <span className="absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded-full bg-black/20">
                  <span className="block h-full bg-[var(--item-accent)] transition-[width]" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${u.file.name}`}
                onClick={() => removeUpload(u.key)}
                className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-1 transition-colors focus-within:border-[color-mix(in_srgb,var(--item-accent)_45%,var(--border))]">
        {!editing &&
          (onPlanEvent ? (
            <button
              ref={plusBtn}
              type="button"
              aria-label="Add a file or event"
              title="Add a file or event"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              onClick={() => setPlusOpen((v) => !v)}
              className={cn(iconBtn, plusOpen && "bg-[var(--hover)] !text-[var(--text)]")}
            >
              <Plus className={cn("h-5 w-5 transition-transform", plusOpen && "rotate-45")} />
            </button>
          ) : (
            <button type="button" aria-label="Attach files" onClick={() => fileInput.current?.click()} className={iconBtn}>
              <Paperclip className="h-5 w-5" />
            </button>
          ))}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onPaste={onPaste}
          placeholder={editing ? "Edit your message" : placeholder}
          aria-label={editing ? "Edit message" : placeholder}
          enterKeyHint={isPhone ? "enter" : "send"}
          className="max-h-[40vh] min-h-[44px] flex-1 resize-none bg-transparent px-1 py-[11px] text-base leading-[22px] text-[var(--text)] !outline-none placeholder:text-[var(--text-muted)] md:min-h-[40px] md:py-[9px] md:text-sm"
        />
        <button
          ref={emojiBtn}
          type="button"
          aria-label="Emoji"
          aria-expanded={emojiOpen}
          onClick={() => setEmojiOpen((v) => !v)}
          className={iconBtn}
        >
          <Smile className="h-5 w-5" />
        </button>
        {!isPhone && !editing && (
          <button type="button" aria-label="Mention someone" onClick={() => insertAtCaret(text && !/\s$/.test(text) ? " @" : "@")} className={cn(iconBtn, "hidden lg:flex")}>
            <AtSign className="h-5 w-5" />
          </button>
        )}
        <button
          type="button"
          aria-label={editing ? "Save edit" : "Send"}
          disabled={!canSend}
          onClick={() => void submit()}
          className={cn(
            iconBtn,
            canSend ? "!text-[var(--item-accent)]" : "opacity-40",
          )}
        >
          {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <SendHorizontal className="h-5 w-5" />}
        </button>
      </div>

      {onPlanEvent &&
        (() => {
          const items = (
            <div role="menu" aria-label="Add" className="flex flex-col gap-0.5 p-1">
              <PlusRow
                icon={Paperclip}
                label="Upload a file"
                hint={isPhone ? "Photos, documents, anything" : "Or drop / paste it here"}
                onClick={() => {
                  setPlusOpen(false);
                  fileInput.current?.click();
                }}
              />
              <PlusRow
                icon={CalendarPlus}
                label="Plan an event"
                hint="Everyone here gets it on their calendar"
                onClick={() => {
                  setPlusOpen(false);
                  onPlanEvent();
                }}
              />
            </div>
          );
          return isPhone ? (
            <Sheet open={plusOpen} onClose={() => setPlusOpen(false)} title="Add">
              <div className="-mx-2 pb-2">{items}</div>
            </Sheet>
          ) : (
            <Popover anchor={plusBtn.current} open={plusOpen} onClose={() => setPlusOpen(false)} width={300} align="start">
              {items}
            </Popover>
          );
        })()}

      {isPhone ? (
        <Sheet open={emojiOpen} onClose={() => setEmojiOpen(false)} title="Emoji">
          <EmojiGrid
            onPick={(e) => {
              insertAtCaret(e);
              setEmojiOpen(false);
            }}
          />
        </Sheet>
      ) : (
        <Popover anchor={emojiBtn.current} open={emojiOpen} onClose={() => setEmojiOpen(false)} width={312}>
          <EmojiGrid onPick={(e) => insertAtCaret(e)} />
        </Popover>
      )}
    </div>
  );
});

function PlusRow({ icon: Icon, label, hint, onClick }: { icon: LucideIcon; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-[var(--text)]">{label}</span>
        <span className="truncate text-xs text-[var(--text-muted)]">{hint}</span>
      </span>
    </button>
  );
}
