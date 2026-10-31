import {
  Bold,
  Check,
  AlertTriangle,
  ChevronDown,
  CloudSun,
  Eye,
  Hash,
  Heading,
  Heart,
  History,
  Italic,
  KeyboardOff,
  LayoutTemplate,
  Lightbulb,
  List,
  ListChecks,
  ListOrdered,
  MapPin,
  PenLine,
  Quote,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Field, ItemButton, ProgressBar, Sheet, TextInput, nowISO, todayISO, uid } from "@/items/ui";
import type { ItemHandle } from "@/items/useItem";
import { cn } from "@/utils/cn";

import { ENERGY, moodInfo } from "./constants";
import { entryWords, fmtClock, fmtFullDay, fmtShortDay, nowHHMM, promptOfDay, tagCounts, visibleTemplates } from "./lib";
import { Markdown } from "./Markdown";
import { EmotionChip, EmotionPicker, EnergyPicker, MoodPicker, TagInput } from "./Pickers";
import {
  CONFLICT_HEADING,
  FIELDS,
  changedFields,
  clearDraft,
  draftHasContent,
  fieldHolds,
  fileHolds,
  loadDraft,
  mergeConflict,
  sameField,
  saveDraft,
  useUserId,
  type EntryField,
} from "./drafts";
import { editor, useEditorRequest, type EditorRequest } from "./store";
import type { Entry, JournalData, Template } from "./types";
import { MAX_BODY } from "./types";

/*
 * The writing room. Full screen on a phone (the toolbar rides above the
 * keyboard), a quiet centred column on desktop. The draft is kept on this
 * device on every keystroke (``drafts.ts``) and committed to the file on a
 * pause in typing, on blur, on close and when the page is hidden — never a
 * save per keystroke. A commit sends only the fields that changed, never
 * overwrites text that changed elsewhere meanwhile (both are kept), and the
 * device copy stays until the file holds it.
 */

const COMMIT_IDLE_MS = 1200;

export function EditorHost({ item, isPhone }: { item: ItemHandle<JournalData>; isPhone: boolean }) {
  const req = useEditorRequest();
  if (!req || !item.canEdit) return null;
  return <Editor key={req.seq} req={req} item={item} isPhone={isPhone} />;
}

function IconBtnClose({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Dismiss" onClick={onClick} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
      <X className="h-4 w-4" />
    </button>
  );
}

function ToolBtn({
  label,
  icon: Icon,
  onClick,
  active,
  disabled,
}: {
  label: string;
  icon: typeof Bold;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled && !active}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-30 md:h-9 md:w-9",
        active && "bg-[var(--hover)] text-[var(--item-accent)]",
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}

function blankEntry(data: JournalData, req: EditorRequest): { entry: Entry; template: Template | null } {
  const tid = req.templateId === undefined ? data.settings.default_template_id : req.templateId;
  const t = (tid && data.templates.find((x) => x.id === tid)) || null;
  const day = req.date ?? todayISO();
  return {
    template: t,
    entry: {
      id: req.entryId ?? uid("e"),
      date: day,
      time: day === todayISO() ? nowHHMM() : "12:00",
      created_at: null,
      updated_at: null,
      title: "",
      body: t?.body ?? "",
      mood: req.mood ?? null,
      emotions: [],
      energy: null,
      tags: [...(t?.default_tags ?? [])],
      gratitude: [],
      location: "",
      weather: "",
      starred: false,
      template_id: t?.id ?? null,
      prompt: req.prompt ?? t?.prompts[0] ?? "",
      ai_drafted: false,
      ai_edited: false,
      word_count: 0,
    },
  };
}

function clean(e: Entry, grat: string[]): Entry {
  const gratitude = grat.map((g) => g.trim()).filter(Boolean).slice(0, 10);
  const out = { ...e, gratitude };
  return { ...out, word_count: entryWords(out) };
}

const stampLabel = () => new Date().toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

type Notice =
  | { kind: "restored" }
  | { kind: "conflict"; separate: boolean }
  | { kind: "deleted" }
  | { kind: "limit" };

function Editor({ req, item, isPhone }: { req: EditorRequest; item: ItemHandle<JournalData>; isPhone: boolean }) {
  const data = item.data;
  const userId = useUserId();
  const fileId = item.fileId;
  const [init] = useState(() => {
    const existing = req.entryId ? data.entries.find((e) => e.id === req.entryId) ?? null : null;
    const tplOf = (e: Entry) => data.templates.find((t) => t.id === e.template_id) ?? null;
    const local = req.entryId ? loadDraft(userId, fileId, req.entryId) : null;
    if (local) {
      if (existing && fileHolds(data, local)) {
        clearDraft(userId, fileId, local.entryId); // it made it into the file after all
      } else {
        return {
          entry: local.draft,
          grat: local.grat as string[] | null,
          template: tplOf(local.draft),
          // The file's version when this device last synced with it.
          base: existing ? (local.base ?? existing) : null,
          // The file had this entry once, and doesn't any more.
          gone: !existing && !!local.base,
          restored: true,
          existing,
        };
      }
    }
    if (existing) return { entry: existing, grat: null, template: tplOf(existing), base: existing as Entry | null, gone: false, restored: false, existing };
    const b = blankEntry(data, req);
    return { entry: b.entry, grat: null, template: b.template, base: null, gone: false, restored: false, existing: null };
  });
  const existing = init.existing;
  const [draft, setDraft] = useState<Entry>(init.entry);
  const [template, setTemplate] = useState<Template | null>(init.template);
  const [grat, setGrat] = useState<string[]>(() => {
    if (init.grat) return init.grat;
    const n = Math.max(init.entry.gratitude.length, init.template?.gratitude_slots ?? 0);
    return Array.from({ length: n }, (_, i) => init.entry.gratitude[i] ?? "");
  });
  const [preview, setPreview] = useState(false);
  const [details, setDetails] = useState(false);
  const [pickTemplate, setPickTemplate] = useState(false);
  // Phone: formatting lives in a second toolbar row (Day One's "Aa").
  const [fmtOpen, setFmtOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [starters] = useState(() => !init.existing && !init.template && !init.restored);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [promptIdx, setPromptIdx] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(init.gone ? { kind: "deleted" } : init.restored ? { kind: "restored" } : null);
  const [failed, setFailedState] = useState(false);
  const [stored, setStored] = useState(!!init.base);

  // The entry as the file has it, as far as this editor knows: commits send
  // only the fields that differ from it, and a body that changed in the file
  // since (another device, the assistant) is never overwritten.
  const base = useRef<Entry | null>(init.base);
  // Committed, but the file hasn't confirmed it yet: keep the device copy.
  const sent = useRef(false);
  const sentFields = useRef<EntryField[]>([]);
  const everInFile = useRef(!!init.existing);
  // Removed from the file elsewhere: write nothing until the person decides.
  const gone = useRef(init.gone);
  const failedRef = useRef(false);
  const setFailed = (v: boolean) => {
    failedRef.current = v;
    setFailedState(v);
  };
  const deleted = useRef(false);
  // The handle changes on every save-state tick; commit reads it through a
  // ref so it stays one stable function for the editor's life.
  const itemRef = useRef(item);
  itemRef.current = item;
  const templateRef = useRef(template);
  templateRef.current = template;
  const timer = useRef<number | null>(null);
  const latest = useRef({ draft, grat });
  latest.current = { draft, grat };
  const ta = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const knownTags = useMemo(() => tagCounts(data.entries).map(([t]) => t), [data.entries]);
  const templates = useMemo(() => visibleTemplates(data), [data]);

  // ------------------------------------------------------ the device copy

  /** Keep what's in the editor on this device until the file holds it. */
  const saveLocal = useCallback(() => {
    if (deleted.current) return;
    const { draft: d, grat: g } = latest.current;
    const b = base.current;
    const tpl = templateRef.current;
    const keep = !b
      ? draftHasContent(d, g, tpl?.body, tpl?.default_tags)
      : sent.current || gone.current || failedRef.current || changedFields(clean(d, g), b).length > 0;
    if (keep) saveDraft(userId, { fileId, entryId: d.id, draft: d, grat: g, base: b });
    else clearDraft(userId, fileId, d.id);
  }, [userId, fileId]);

  // Every keystroke, debounced: a kill right after typing loses at most ~300 ms.
  useEffect(() => {
    const t = window.setTimeout(saveLocal, 300);
    return () => window.clearTimeout(t);
  }, [draft, grat, saveLocal]);

  // ---------------------------------------------------------------- commit

  const setDraftNow = (patchFields: Partial<Entry>) => {
    latest.current = { ...latest.current, draft: { ...latest.current.draft, ...patchFields } };
    setDraft((x) => ({ ...x, ...patchFields }));
  };

  const doCommit = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (deleted.current || gone.current) return;
    const it = itemRef.current;
    if (!it.canEdit) return;
    const { draft: d, grat: g } = latest.current;
    const tpl = templateRef.current;
    const b = base.current;
    if (!b && !draftHasContent(d, g, tpl?.body, tpl?.default_tags)) return;
    let next = clean(d, g);
    const cur = it.data.entries.find((x) => x.id === next.id) ?? null;
    if (b && !cur && everInFile.current) {
      // Deleted on another device / by the assistant: don't bring it back
      // silently — the text stays here and the person decides.
      gone.current = true;
      setNotice({ kind: "deleted" });
      setDirty(false);
      return;
    }
    const createMode = !cur;
    let fields: EntryField[] = createMode ? [...FIELDS] : changedFields(next, b ?? cur);
    if (!fields.length) {
      setDirty(false);
      return;
    }
    const stamp = nowISO();
    const label = stampLabel();
    let expectBody = cur ? (b ?? cur).body : "";
    if (cur && b && fields.includes("body") && cur.body !== b.body && cur.body !== next.body) {
      // The text changed somewhere else since this editor last saw it. Keep both.
      const merged = mergeConflict(cur.body, next.body, label);
      if (merged.length <= MAX_BODY) {
        next = { ...next, body: merged };
        setDraftNow({ body: merged });
        setNotice({ kind: "conflict", separate: false });
      } else {
        // Too long for one entry: ours becomes an entry of its own.
        const copyId = uid("e");
        const copy: Entry = {
          ...next,
          id: copyId,
          title: next.title ? `${next.title} (conflict copy)`.slice(0, 200) : CONFLICT_HEADING,
          created_at: stamp,
          updated_at: stamp,
        };
        it.update((dd) => {
          if (!dd.entries.some((x) => x.id === copyId)) dd.entries.push(copy);
        });
        saveDraft(userId, { fileId, entryId: copyId, draft: copy, grat: copy.gratitude, base: null });
        next = { ...next, body: cur.body };
        setDraftNow({ body: cur.body });
        fields = fields.filter((f) => f !== "body");
        setNotice({ kind: "conflict", separate: true });
      }
      expectBody = cur.body;
    }
    const values: Record<string, unknown> = {};
    for (const f of fields) values[f] = next[f];
    const id = next.id;
    if (createMode) {
      const entry: Entry = { ...next, created_at: next.created_at ?? stamp, updated_at: stamp };
      it.update((dd) => {
        if (!dd.entries.some((x) => x.id === id)) dd.entries.push(entry);
      });
      base.current = entry;
      if (!next.created_at) setDraftNow({ created_at: entry.created_at });
    } else {
      const ours = next.body;
      it.update((dd) => {
        const e = dd.entries.find((x) => x.id === id);
        if (!e) return; // deleted meanwhile: never resurrect it from a replay
        for (const f of fields) {
          if (f === "body") {
            if (e.body === expectBody || e.body === ours) e.body = ours;
            else {
              // Replayed on a newer text: keep theirs and add ours.
              const m = mergeConflict(e.body, ours, label);
              if (m.length <= MAX_BODY) e.body = m; // (else theirs stays; ours stays on this device)
            }
          } else {
            (e as unknown as Record<string, unknown>)[f] = values[f];
          }
        }
        e.word_count = entryWords(e);
        e.updated_at = stamp;
      });
      base.current = { ...cur, ...(values as Partial<Entry>) };
    }
    sent.current = true;
    sentFields.current = [...new Set([...sentFields.current, ...fields])];
    setFailed(false);
    setStored(true);
    setDirty(false);
  };

  const commit = useCallback(() => {
    doCommit();
    saveLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveLocal]);

  // Did the file take it? Only "saved" proves it (the handle's data also
  // shows changes still on their way); a change that's missing from the
  // data means the server refused it — keep the text and say so.
  useEffect(() => {
    if (!sent.current) return;
    const b = base.current;
    if (!b) return;
    const cur = item.data.entries.find((x) => x.id === b.id);
    const holds = !!cur && sentFields.current.every((f) => fieldHolds(cur, b, f));
    if (item.status === "saved" && holds) {
      sent.current = false;
      sentFields.current = [];
      everInFile.current = true;
      setFailed(false);
      saveLocal(); // clears the device copy unless there's newer typing
    } else if ((item.status === "saved" || item.status === "error") && !holds) {
      sent.current = false;
      sentFields.current = [];
      if (!cur && everInFile.current) {
        gone.current = true;
        setNotice({ kind: "deleted" });
      } else {
        setFailed(true);
        // Compare with what the file really has, so a retry sends it all.
        base.current = cur ?? null;
      }
      saveLocal();
    }
  }, [item.data, item.status, saveLocal]);

  // Changes made elsewhere while this is open (the assistant added tags, a
  // phone set the mood): take them for every field the person hasn't
  // touched here.
  useEffect(() => {
    if (sent.current || gone.current || failedRef.current) return;
    const b = base.current;
    if (!b) return;
    const cur = item.data.entries.find((x) => x.id === b.id);
    if (!cur) {
      if (everInFile.current && item.status === "saved") {
        gone.current = true;
        setNotice({ kind: "deleted" });
        saveLocal();
      }
      return;
    }
    const { draft: d, grat: g } = latest.current;
    const mine = clean(d, g);
    const adopt: Record<string, unknown> = {};
    for (const f of FIELDS) if (!sameField(cur, b, f) && sameField(mine, b, f)) adopt[f] = cur[f];
    if (!Object.keys(adopt).length) return;
    base.current = { ...b, ...(adopt as Partial<Entry>) };
    setDraftNow(adopt as Partial<Entry>);
    if ("gratitude" in adopt) {
      const next = cur.gratitude;
      setGrat((cg) => Array.from({ length: Math.max(cg.length, next.length) }, (_, i) => next[i] ?? ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.data, item.status]);

  const schedule = useCallback(
    (ms = COMMIT_IDLE_MS) => {
      setDirty(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(commit, ms);
    },
    [commit],
  );

  const patch = (p: Partial<Entry>, ms?: number) => {
    setDraft((d) => ({ ...d, ...p }));
    schedule(ms);
  };

  const close = useCallback(() => {
    commit();
    editor.close();
  }, [commit]);

  const retry = () => {
    setFailed(false);
    commit();
  };

  const saveAsNew = () => {
    gone.current = false;
    everInFile.current = false;
    base.current = null;
    setNotice(null);
    commit();
  };

  const discard = () => {
    deleted.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    clearDraft(userId, fileId, latest.current.draft.id);
    editor.close();
  };

  // Leaving the tab or the page: keep what's written (on the device at once,
  // and to the file).
  useEffect(() => {
    const onHide = () => document.hidden && commit();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", commit);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", commit);
      commit();
    };
  }, [commit]);

  // ------------------------------------------------------- viewport (phone)

  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v || !isPhone) return;
    const on = () => setVv({ h: v.height, top: v.offsetTop });
    on();
    v.addEventListener("resize", on);
    v.addEventListener("scroll", on);
    return () => {
      v.removeEventListener("resize", on);
      v.removeEventListener("scroll", on);
    };
  }, [isPhone]);

  // Phone: when the keyboard opens on a short entry, lift the writing line
  // into the visible area (the prompt and check-in scroll up out of the way;
  // they're one swipe back). Long entries keep the browser's own caret scroll.
  // (Android shrinks the layout viewport too, so compare with the tallest
  // height seen rather than window.innerHeight.)
  const tallest = useRef(0);
  if (vv && vv.h > tallest.current) tallest.current = vv.h;
  const kbOpen = !!vv && vv.h < tallest.current * 0.8;
  useEffect(() => {
    if (!isPhone || !kbOpen || !typing) return;
    const t = window.setTimeout(() => {
      const el = ta.current;
      const sc = scroller.current;
      if (!el || !sc || document.activeElement !== el) return;
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      const caretAtStart = el.selectionStart < 160;
      if (caretAtStart && top > sc.clientHeight * 0.45) sc.scrollTo({ top: sc.scrollTop + top - 12, behavior: "smooth" });
    }, 120);
    return () => window.clearTimeout(t);
  }, [isPhone, kbOpen, typing]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!existing || !existing.body) window.setTimeout(() => ta.current?.focus(), 80);
    return () => {
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosize the textarea without making the page jump.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    const top = scroller.current?.scrollTop ?? 0;
    el.style.height = "auto";
    el.style.height = `${Math.max(isPhone ? 240 : 320, el.scrollHeight)}px`;
    if (scroller.current) scroller.current.scrollTop = top;
  }, [draft.body, preview, isPhone]);

  // ------------------------------------------------------------ markdown ops

  const setBody = (body: string) => patch({ body });

  /** Replace [s, e) with text, keeping the browser's undo where possible. */
  const replaceRange = (s: number, e: number, text: string, selStart: number, selEnd: number) => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(s, e);
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }
    if (!ok) setBody(el.value.slice(0, s) + text + el.value.slice(e));
    requestAnimationFrame(() => el.setSelectionRange(selStart, selEnd));
  };

  const wrap = (mark: string) => {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e, value } = el;
    const sel = value.slice(s, e);
    if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= mark.length * 2) {
      const inner = sel.slice(mark.length, sel.length - mark.length);
      replaceRange(s, e, inner, s, s + inner.length);
    } else if (value.slice(s - mark.length, s) === mark && value.slice(e, e + mark.length) === mark) {
      replaceRange(s - mark.length, e + mark.length, sel, s - mark.length, e - mark.length);
    } else {
      replaceRange(s, e, `${mark}${sel}${mark}`, s + mark.length, e + mark.length);
    }
  };

  const prefixLines = (prefix: string | ((i: number) => string), match: RegExp) => {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e, value } = el;
    const ls = value.lastIndexOf("\n", s - 1) + 1;
    const leRaw = value.indexOf("\n", e);
    const le = leRaw === -1 ? value.length : leRaw;
    const lines = value.slice(ls, le).split("\n");
    const all = lines.every((l) => match.test(l));
    const out = lines
      .map((l, i) => {
        const bare = l.replace(/^(\s*)(#{1,6}\s|[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s|>\s?)/, "$1");
        if (all) return bare;
        return (typeof prefix === "function" ? prefix(i) : prefix) + bare;
      })
      .join("\n");
    replaceRange(ls, le, out, ls + out.length, ls + out.length);
  };

  const ops = {
    bold: () => wrap("**"),
    italic: () => wrap("*"),
    heading: () => prefixLines("## ", /^##\s/),
    bullet: () => prefixLines("- ", /^\s*[-*+]\s(?!\[)/),
    numbered: () => prefixLines((i) => `${i + 1}. `, /^\s*\d+\.\s/),
    check: () => prefixLines("- [ ] ", /^\s*[-*+]\s\[[ xX]\]\s/),
    quote: () => prefixLines("> ", /^>\s?/),
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = ev.metaKey || ev.ctrlKey;
    const k = ev.key.toLowerCase();
    const run = (fn: () => void) => {
      ev.preventDefault();
      fn();
    };
    if (mod && !ev.shiftKey && !ev.altKey && k === "b") return run(ops.bold);
    if (mod && !ev.shiftKey && !ev.altKey && k === "i") return run(ops.italic);
    if (mod && ev.altKey && (k === "2" || ev.code === "Digit2")) return run(ops.heading);
    if (mod && ev.shiftKey && (ev.code === "Digit8" || k === "*")) return run(ops.bullet);
    if (mod && ev.shiftKey && (ev.code === "Digit7" || k === "&")) return run(ops.numbered);
    if (mod && ev.shiftKey && (ev.code === "Digit9" || k === "(")) return run(ops.check);
    // Continue lists on Enter; an empty item ends the list.
    if (ev.key === "Enter" && !mod && !ev.shiftKey && !ev.nativeEvent.isComposing) {
      const el = ev.currentTarget;
      const { selectionStart: s, selectionEnd: e, value } = el;
      if (s !== e) return;
      const ls = value.lastIndexOf("\n", s - 1) + 1;
      const line = value.slice(ls, s);
      const m = line.match(/^(\s*)([-*+]\s\[[ xX]\]\s|[-*+]\s|(\d+)\.\s)/);
      if (!m) return;
      ev.preventDefault();
      if (line.trim() === m[0].trim()) {
        replaceRange(ls, s, "", ls, ls);
        return;
      }
      const next = m[3] ? `${m[1]}${Number(m[3]) + 1}. ` : m[2].includes("[") ? `${m[1]}- [ ] ` : `${m[1]}${m[2]}`;
      replaceRange(s, s, `\n${next}`, s + 1 + next.length, s + 1 + next.length);
    }
  };

  // Shortcuts for the whole room (not while a sheet is open — it owns Escape).
  useEffect(() => {
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (details || confirmDelete || pickTemplate) return;
      const mod = ev.metaKey || ev.ctrlKey;
      if (ev.key === "Escape" || (mod && ev.key === "Enter")) {
        ev.preventDefault();
        close();
      } else if (mod && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        commit();
      } else if (mod && ev.key === "/") {
        ev.preventDefault();
        setPreview((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, commit, details, confirmDelete, pickTemplate]);

  // ------------------------------------------------------------- templates

  const prompts = useMemo(() => {
    const list = [...(template?.prompts ?? [])];
    if (draft.prompt && !list.includes(draft.prompt)) list.unshift(draft.prompt);
    return list;
  }, [template, draft.prompt]);

  const applyTemplate = (t: Template) => {
    setTemplate(t);
    const body = draft.body.trim() ? `${draft.body.trimEnd()}\n\n${t.body}` : t.body;
    setGrat((g) => {
      const n = Math.max(g.length, t.gratitude_slots);
      return Array.from({ length: n }, (_, i) => g[i] ?? "");
    });
    patch({
      template_id: t.id,
      body,
      prompt: t.prompts[0] ?? draft.prompt,
      tags: [...new Set([...draft.tags, ...t.default_tags])],
    });
    window.setTimeout(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      // Caret after the first heading, ready to write.
      const nl = body.indexOf("\n\n");
      const at = nl >= 0 && body.startsWith("#") ? nl + 1 : body.length;
      el.setSelectionRange(at, at);
    }, 30);
  };

  const shufflePrompt = () => {
    if (prompts.length > 1) {
      const next = (promptIdx + 1) % prompts.length;
      setPromptIdx(next);
      patch({ prompt: prompts[next] });
    } else {
      const p = promptOfDay(data, todayISO(), Math.floor(Math.random() * 997) + 1);
      patch({ prompt: p });
    }
  };

  // ------------------------------------------------------------------ view

  const words = entryWords({ title: draft.title, body: draft.body, gratitude: grat });
  const target = template?.target_words ?? null;
  const isNewEmpty = !stored && !draft.body.trim() && !draft.title.trim();
  const mood = moodInfo(draft.mood);
  const status = failed
    ? "Not saved yet — kept on this device"
    : dirty
      ? "Writing…"
      : item.status === "saving"
        ? "Saving…"
        : item.status === "offline"
          ? "Offline — kept on this device"
          : stored
            ? "Saved"
            : "";
  const left = MAX_BODY - draft.body.length;

  const shortcut = (k: string) => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? k.replace("Ctrl", "⌘") : k);

  const formatBtns = (
    <>
      <ToolBtn disabled={preview} label={`Bold (${shortcut("Ctrl+B")})`} icon={Bold} onClick={ops.bold} />
      <ToolBtn disabled={preview} label={`Italic (${shortcut("Ctrl+I")})`} icon={Italic} onClick={ops.italic} />
      <ToolBtn disabled={preview} label={`Heading (${shortcut("Ctrl+Alt+2")})`} icon={Heading} onClick={ops.heading} />
      <ToolBtn disabled={preview} label={`List (${shortcut("Ctrl+Shift+8")})`} icon={List} onClick={ops.bullet} />
      <ToolBtn disabled={preview} label={`Numbered list (${shortcut("Ctrl+Shift+7")})`} icon={ListOrdered} onClick={ops.numbered} />
      <ToolBtn disabled={preview} label={`Checklist (${shortcut("Ctrl+Shift+9")})`} icon={ListChecks} onClick={ops.check} />
      <ToolBtn disabled={preview} label="Quote" icon={Quote} onClick={ops.quote} />
    </>
  );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={existing ? "Edit entry" : "New entry"}
      className="fixed inset-x-0 z-[60] flex flex-col bg-[var(--bg)] animate-[fadeIn_120ms_ease-out]"
      style={vv ? { top: vv.top, height: vv.h } : { top: 0, bottom: 0 }}
    >
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center gap-1 px-2 pt-safe md:px-4">
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          {isPhone ? <ChevronDown className="h-5 w-5" /> : <X className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={() => setDetails(true)}
          className="min-w-0 flex-1 rounded-lg px-2 py-1 text-left hover:bg-[var(--hover)] md:flex-none"
          aria-label={`${fmtFullDay(draft.date)}, ${fmtClock(draft.time)} — change date, time and details`}
        >
          <span className="block truncate text-sm font-semibold text-[var(--text)]">
            {isPhone ? fmtShortDay(draft.date) : fmtFullDay(draft.date)}
            <span className="ml-1.5 font-normal tabular-nums text-[var(--text-muted)]">{fmtClock(draft.time)}</span>
          </span>
          {isPhone && (
            <span className="block truncate text-[11px] tabular-nums text-[var(--text-muted)]" aria-live="polite">
              {status || (existing ? "Saved" : "New entry")} · {words.toLocaleString()} {words === 1 ? "word" : "words"}
            </span>
          )}
        </button>
        <span className="hidden flex-1 truncate px-2 text-xs text-[var(--text-muted)] md:block" aria-live="polite">
          {status}
        </span>
        <button
          type="button"
          aria-label={draft.starred ? "Unstar" : "Star"}
          aria-pressed={draft.starred}
          onClick={() => patch({ starred: !draft.starred }, 200)}
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-xl hover:bg-[var(--hover)]",
            draft.starred ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]",
          )}
        >
          <Star className={cn("h-5 w-5", draft.starred && "fill-current")} />
        </button>
        <button
          type="button"
          aria-label="Details: mood, tags, place"
          onClick={() => setDetails(true)}
          className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          <SlidersHorizontal className="h-5 w-5" />
        </button>
        <ItemButton variant="primary" size="sm" onClick={close} className="ml-1 h-10 px-3.5" icon={<Check className="h-4 w-4" />}>
          Done
        </ItemButton>
      </div>

      {/* Page */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4 px-5 pb-10 pt-2 md:pt-8" style={kbOpen && vv ? { paddingBottom: Math.round(vv.h * 0.45) } : undefined}>
          {failed && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--danger)] bg-[var(--surface)] px-3 py-2.5 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--danger)]" />
              <span className="min-w-0 flex-1 text-[var(--text)]">
                This wasn't saved to the journal (the file may be full, or the change was refused). Your text is kept on this device.
              </span>
              <ItemButton size="sm" variant="secondary" onClick={retry}>
                Try again
              </ItemButton>
            </div>
          )}
          {notice?.kind === "deleted" && (
            <div role="alert" className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm">
              <span className="flex items-center gap-2 text-[var(--text)]">
                <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
                This entry was deleted somewhere else (another device or the assistant). Your text is still here.
              </span>
              <div className="flex gap-2">
                <ItemButton size="sm" variant="primary" onClick={saveAsNew}>
                  Save it as an entry
                </ItemButton>
                <ItemButton size="sm" variant="ghost" onClick={discard}>
                  Discard
                </ItemButton>
              </div>
            </div>
          )}
          {notice && notice.kind !== "deleted" && (
            <div role="status" className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm">
              {notice.kind === "restored" ? (
                <History className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
              ) : (
                <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
              )}
              <span className="min-w-0 flex-1 text-[var(--text-muted)]">
                {notice.kind === "restored"
                  ? "Restored your unsaved text from this device."
                  : notice.kind === "limit"
                    ? `An entry holds up to ${MAX_BODY.toLocaleString()} characters, so that wasn't added. Nothing was cut — split it across two entries.`
                    : notice.separate
                      ? "This entry changed somewhere else while you were writing. Both are kept: yours is saved as a separate “Conflict copy” entry."
                      : "This entry changed somewhere else while you were writing. Both versions are kept — yours is under “Conflict copy” below."}
              </span>
              <IconBtnClose onClick={() => setNotice(null)} />
            </div>
          )}

          {(draft.ai_drafted || draft.ai_edited) && (
            <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm">
              <Sparkles className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
              <span className="min-w-0 flex-1 text-[var(--text-muted)]">
                {draft.ai_drafted ? "Drafted by the assistant" : "Edited by the assistant"} — edit it into your own words.
              </span>
              <ItemButton size="sm" variant="ghost" onClick={() => patch({ ai_drafted: false, ai_edited: false }, 200)}>
                Mark as mine
              </ItemButton>
            </div>
          )}

          {draft.prompt && (
            <div className="group flex items-start gap-3 rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_9%,var(--surface))] px-4 py-3">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-[var(--item-accent)]" />
              <p className="min-w-0 flex-1 text-[15px] leading-relaxed text-[var(--text)]">{draft.prompt}</p>
              <button type="button" aria-label="Another prompt" title="Another prompt" onClick={shufflePrompt} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
                <RefreshCw className="h-4 w-4" />
              </button>
              <button type="button" aria-label="Remove prompt" title="Remove prompt" onClick={() => patch({ prompt: "" })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <input
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value.slice(0, 200) })}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ta.current?.focus();
              }
            }}
            placeholder="Title"
            aria-label="Title"
            className="w-full bg-transparent text-[26px] font-semibold leading-tight tracking-tight text-[var(--text)] outline-none placeholder:text-[color-mix(in_srgb,var(--text-muted)_60%,transparent)] focus-visible:outline-none md:text-[30px]"
          />

          {/* Quick check-in */}
          <div className="flex flex-col gap-2">
            <div className="md:max-w-[420px]">
              <MoodPicker value={draft.mood} onChange={(m) => patch({ mood: m }, 300)} showLabels={!isPhone} compact={isPhone} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {draft.emotions.map((w) => (
                <EmotionChip key={w} word={w} onRemove={() => patch({ emotions: draft.emotions.filter((x) => x !== w) }, 300)} />
              ))}
              <button type="button" onClick={() => setDetails(true)} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] px-3 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
                <Heart className="h-3.5 w-3.5" />
                {draft.emotions.length ? "Feelings" : mood ? `${mood.label} — what does it feel like?` : "Add feelings"}
              </button>
              {draft.tags.map((t) => (
                <span key={t} className="inline-flex h-8 items-center rounded-full bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] px-2.5 text-xs font-medium text-[var(--text)]">
                  #{t}
                </span>
              ))}
              <button type="button" onClick={() => setDetails(true)} className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-[var(--border)] px-3 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
                <Hash className="h-3.5 w-3.5" /> Tag
              </button>
              {draft.energy && (
                <span className="inline-flex h-8 items-center rounded-full border border-[var(--border)] px-2.5 text-xs text-[var(--text-muted)]">
                  Energy · {ENERGY[draft.energy - 1]}
                </span>
              )}
              {draft.location && (
                <span className="inline-flex h-8 items-center gap-1 rounded-full border border-[var(--border)] px-2.5 text-xs text-[var(--text-muted)]">
                  <MapPin className="h-3 w-3" /> {draft.location}
                </span>
              )}
              {draft.weather && (
                <span className="inline-flex h-8 items-center gap-1 rounded-full border border-[var(--border)] px-2.5 text-xs text-[var(--text-muted)]">
                  <CloudSun className="h-3 w-3" /> {draft.weather}
                </span>
              )}
            </div>
          </div>

          {grat.length > 0 && (
            <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
              <p className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Grateful for</p>
              {grat.map((g, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-center text-sm font-semibold tabular-nums text-[var(--item-accent)]">{i + 1}</span>
                  <input
                    value={g}
                    onChange={(e) => {
                      const v = e.target.value.slice(0, 300);
                      setGrat((cur) => cur.map((x, j) => (j === i ? v : x)));
                      schedule();
                    }}
                    onBlur={commit}
                    placeholder={["Something small that went well…", "Someone who helped…", "Something you noticed…"][i % 3]}
                    aria-label={`Grateful for, ${i + 1}`}
                    className="h-11 min-w-0 flex-1 rounded-xl bg-transparent px-2 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:bg-[var(--hover)] focus-visible:outline-none md:text-[15px]"
                  />
                </div>
              ))}
              {grat.length < 10 && (
                <button type="button" onClick={() => setGrat((g) => [...g, ""])} className="self-start rounded-lg px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
                  + Another
                </button>
              )}
            </div>
          )}

          {starters && !template && (isNewEmpty || typing) && templates.length > 0 && (
            // Shown on a fresh entry; it stays while typing (no layout jump)
            // and goes once the text is left. Templates are also in the toolbar.
            <div className="-mx-5 flex items-center gap-2 overflow-x-auto px-5 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
              <span className="shrink-0 text-xs font-medium text-[var(--text-muted)]">Start from</span>
              {templates.slice(0, 5).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyTemplate(t)}
                  className="inline-flex h-9 shrink-0 items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 text-xs font-medium text-[var(--text)] hover:border-[var(--item-accent)]"
                >
                  {t.name}
                </button>
              ))}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPickTemplate(true)}
                className="inline-flex h-9 shrink-0 items-center rounded-full px-2 text-xs font-medium text-[var(--item-accent)]"
              >
                More…
              </button>
            </div>
          )}

          {preview ? (
            <div className="min-h-[320px]" onDoubleClick={() => setPreview(false)}>
              {draft.body.trim() ? <Markdown text={draft.body} /> : <p className="text-[var(--text-muted)]">Nothing written yet.</p>}
            </div>
          ) : (
            <textarea
              ref={ta}
              value={draft.body}
              onChange={(e) => {
                // Over the limit: refuse the change whole (never cut text silently).
                if (e.target.value.length > MAX_BODY) setNotice({ kind: "limit" });
                else setBody(e.target.value);
              }}
              onPaste={(e) => {
                const el = e.currentTarget;
                const text = e.clipboardData.getData("text/plain");
                if (el.value.length - (el.selectionEnd - el.selectionStart) + text.length > MAX_BODY) {
                  e.preventDefault();
                  setNotice({ kind: "limit" });
                }
              }}
              onFocus={() => setTyping(true)}
              onBlur={() => {
                setTyping(false);
                commit();
              }}
              onKeyDown={onKeyDown}
              placeholder={draft.prompt ? "Start anywhere…" : "What's on your mind?"}
              aria-label="Entry"
              spellCheck
              className="block w-full resize-none overflow-hidden bg-transparent text-[17px] leading-[1.75] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus-visible:outline-none md:text-[18px]"
            />
          )}
        </div>
      </div>

      {/* Toolbar — rides above the keyboard on a phone */}
      <div className="shrink-0 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_94%,transparent)] pb-safe backdrop-blur">
        {target && (
          <div className="mx-auto flex max-w-[680px] items-center gap-3 px-5 pt-2">
            <ProgressBar value={words / target} className="h-1.5" />
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
              {words >= target ? "Done — keep going if you like" : `${target - words} to go`}
            </span>
          </div>
        )}
        {isPhone && fmtOpen && !preview && (
          <div className="flex items-center justify-between border-b border-[var(--border)] px-2 py-0.5" role="toolbar" aria-label="Formatting">
            {formatBtns}
          </div>
        )}
        <div className="mx-auto flex max-w-[680px] items-center gap-0.5 px-2 py-1 md:px-4" role="toolbar" aria-label="Entry tools">
          {isPhone ? (
            <ToolBtn disabled={preview} label="Formatting" icon={Type} onClick={() => setFmtOpen((o) => !o)} active={fmtOpen && !preview} />
          ) : (
            <>
              {formatBtns}
              <span className="mx-1 h-6 w-px shrink-0 bg-[var(--border)]" aria-hidden />
            </>
          )}
          <ToolBtn label="Feelings and mood" icon={Heart} onClick={() => setDetails(true)} active={draft.emotions.length > 0} />
          <ToolBtn label="Tags" icon={Hash} onClick={() => setDetails(true)} active={draft.tags.length > 0} />
          <ToolBtn label="Templates and prompts" icon={LayoutTemplate} onClick={() => setPickTemplate(true)} />
          <ToolBtn label={preview ? `Write (${shortcut("Ctrl+/")})` : `Preview (${shortcut("Ctrl+/")})`} icon={preview ? PenLine : Eye} onClick={() => setPreview((p) => !p)} active={preview} />
          {isPhone ? (
            typing && (
              <span className="ml-auto">
                <ToolBtn label="Hide keyboard" icon={KeyboardOff} onClick={() => ta.current?.blur()} />
              </span>
            )
          ) : (
            <span className="ml-auto shrink-0 pl-2 pr-1 text-xs tabular-nums text-[var(--text-muted)]" aria-live="polite">
              {left < 10_000 && <span className={cn("mr-1", left < 1000 && "text-[var(--danger)]")}>{left.toLocaleString()} characters left ·</span>}
              {words.toLocaleString()} {words === 1 ? "word" : "words"}
            </span>
          )}
        </div>
        {isPhone && left < 10_000 && (
          <p className={cn("px-4 pb-1 text-[11px] tabular-nums", left < 1000 ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>{left.toLocaleString()} characters left in this entry</p>
        )}
      </div>

      <Sheet open={pickTemplate} onClose={() => setPickTemplate(false)} title="Templates & prompts" size="lg">
        <div className="flex flex-col gap-4 pb-2">
          <button
            type="button"
            onClick={() => {
              patch({ prompt: promptOfDay(data, todayISO(), Math.floor(Math.random() * 997) + 1) });
              setPickTemplate(false);
            }}
            className="flex items-center gap-3 rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_9%,var(--surface))] px-4 py-3 text-left"
          >
            <Lightbulb className="h-5 w-5 shrink-0 text-[var(--item-accent)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-[var(--text)]">{draft.prompt ? "A different prompt" : "Give me a prompt"}</span>
              <span className="block text-xs text-[var(--text-muted)]">A question to write about — from the reflective prompt library</span>
            </span>
          </button>
          <div className="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setPickTemplate(false);
                  applyTemplate(t);
                }}
                className="flex min-h-[56px] items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)]"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium text-[var(--text)]">{t.name}</span>
                  {t.description && <span className="line-clamp-2 block text-xs text-[var(--text-muted)]">{t.description}</span>}
                </span>
                {template?.id === t.id && <Check className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />}
              </button>
            ))}
          </div>
          {draft.body.trim() && <p className="text-xs text-[var(--text-muted)]">A template is added below what you've written — nothing is replaced.</p>}
        </div>
      </Sheet>

      <Sheet open={details} onClose={() => { setDetails(false); commit(); }} title="Details" size="lg">
        <div className="flex flex-col gap-5 pb-2">
          <Field label="How are you feeling?">
            <MoodPicker value={draft.mood} onChange={(m) => patch({ mood: m }, 300)} />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--text-muted)]">Feelings — name them precisely</span>
            <EmotionPicker value={draft.emotions} onChange={(v) => patch({ emotions: v }, 300)} mood={draft.mood} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--text-muted)]">Energy</span>
            <EnergyPicker value={draft.energy} onChange={(v) => patch({ energy: v }, 300)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--text-muted)]">Tags</span>
            <TagInput value={draft.tags} onChange={(v) => patch({ tags: v }, 300)} known={knownTags} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Place">
              <TextInput value={draft.location} maxLength={200} onChange={(e) => patch({ location: e.target.value })} placeholder="Home, a café, Lisbon…" />
            </Field>
            <Field label="Weather">
              <TextInput value={draft.weather} maxLength={120} onChange={(e) => patch({ weather: e.target.value })} placeholder="Sunny, 22°" />
            </Field>
            <Field label="Day">
              <TextInput type="date" value={draft.date} max={todayISO()} onChange={(e) => e.target.value && patch({ date: e.target.value }, 300)} />
            </Field>
            <Field label="Time">
              <TextInput type="time" value={draft.time} onChange={(e) => e.target.value && patch({ time: e.target.value.slice(0, 5) }, 300)} />
            </Field>
          </div>
          {grat.length === 0 && (
            <ItemButton variant="secondary" onClick={() => setGrat(["", "", ""])} icon={<Heart className="h-4 w-4" />}>
              Add a gratitude list
            </ItemButton>
          )}
          {stored && (
            <ItemButton variant="ghost" className="self-start text-[var(--danger)]" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDelete(true)}>
              Delete this entry
            </ItemButton>
          )}
        </div>
      </Sheet>

      <Sheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this entry?"
        size="sm"
        footer={
          <>
            <ItemButton block onClick={() => setConfirmDelete(false)}>
              Keep it
            </ItemButton>
            <ItemButton
              block
              variant="danger"
              onClick={() => {
                if (timer.current) window.clearTimeout(timer.current);
                deleted.current = true;
                clearDraft(userId, fileId, draft.id);
                const id = draft.id;
                item.update((d) => {
                  d.entries = d.entries.filter((e) => e.id !== id);
                });
                setConfirmDelete(false);
                setDetails(false);
                editor.close();
              }}
            >
              Delete
            </ItemButton>
          </>
        }
      >
        <p className="text-sm text-[var(--text-muted)]">
          It's removed from this journal. You can still get it back from Version history (⋯ menu) for a while.
        </p>
      </Sheet>
    </div>,
    document.body,
  );
}
