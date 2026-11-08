import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  CloudOff,
  Import,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  Loader2,
  Menu,
  Mic,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Rows3,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { authApi } from "@/api/auth";
import { tagColor } from "@/api/tags";
import { NetworkStatusToast } from "@/components/layout/NetworkStatusToast";
import { confirm } from "@/components/shared/ConfirmDialog";
import { InstallFromLink } from "@/components/pwa/InstallFromLink";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAuthStore } from "@/store/authStore";
import { useUIStore } from "@/store/uiStore";
import { cn } from "@/utils/cn";

import { noteOps } from "./actions";
import { AddImageButton } from "./components/AddImage";
import { attachPhotos, Composer } from "./components/Composer";
import type { CardActions } from "./components/NoteCard";
import { NoteDialog } from "./components/NoteDialog";
import { NoteEditor } from "./components/NoteEditor";
import { NoteGrid } from "./components/NoteGrid";
import { ColorGrid, LabelChooser } from "./components/pickers";
import { Pop } from "./components/Pop";
import { ReminderPicker, reminderMoment, reminderWhen } from "./components/Reminder";
import { ShareDialog } from "./components/ShareDialog";
import { useNotesLive } from "./live";
import "./notes.css";
import { takeSharedText } from "./shareStash";
import { closeDraft, fetchNote, initNotes, keepCopy, loadLists, loadTrash, newDraft, notesActions, searchServer, useNote, useNotes } from "./store";
import { addFiles, initUploads, kindOf } from "./uploads";
import { takeNewNoteText } from "./newNote";
import { attachmentCounts, COLOR_NAMES, docText, NOTE_COLORS, textDoc, uuid, type Note, type NoteLabel } from "./types";
import { toast } from "@/store/toastStore";

type Place = { view: "home" | "archive" | "trash" | "reminders" | "label"; label?: string };

function parse(path: string): { place: Place; noteId: string | null } {
  const rest = path.replace(/^\/notes\/?/, "");
  const [a, b] = rest.split("/");
  if (a === "n" && b) return { place: { view: "home" }, noteId: b };
  if (a === "archive") return { place: { view: "archive" }, noteId: null };
  if (a === "trash") return { place: { view: "trash" }, noteId: null };
  if (a === "reminders") return { place: { view: "reminders" }, noteId: null };
  if (a === "label" && b) return { place: { view: "label", label: decodeURIComponent(b) }, noteId: null };
  return { place: { view: "home" }, noteId: null };
}

function placePath(p: Place): string {
  if (p.view === "label") return `/notes/label/${encodeURIComponent(p.label ?? "")}`;
  if (p.view === "home") return "/notes";
  return `/notes/${p.view}`;
}

const TYPE_CHIPS = [
  { key: "list", label: "Lists" },
  { key: "shared", label: "Shared" },
  { key: "image", label: "Images" },
  { key: "voice", label: "Voice" },
  { key: "reminder", label: "Reminders" },
] as const;

function matchesType(n: Note, type: string): boolean {
  if (type === "list") return n.kind === "list";
  if (type === "shared") return n.shared || !n.is_owner;
  if (type === "reminder") return !!n.reminder;
  const c = attachmentCounts(n);
  if (type === "image") return c.images > 0;
  if (type === "voice") return c.audio > 0;
  return true;
}

function searchText(n: Note): string {
  return [n.title, n.body_text ?? (n.body_doc ? docText(n.body_doc) : n.snippet ?? ""), ...n.items.map((i) => i.text), ...n.labels.map((l) => l.name)].join("\n").toLowerCase();
}

/** A label in a link: its tag id, or its name while it's new on this device. */
const labelKey = (l: Pick<NoteLabel, "id" | "name">) => l.id || `~${l.name.toLowerCase()}`;
/** Does ``key`` (from a link) name this label? A ``~name`` link made while the
 *  label was new still finds it once the server has given it an id. */
const isLabel = (l: Pick<NoteLabel, "id" | "name">, key: string | undefined) =>
  !!key && (labelKey(l) === key || (key.startsWith("~") && l.name.toLowerCase() === key.slice(1)));
const hasLabel = (n: Note, key: string | undefined) => !!key && n.labels.some((l) => isLabel(l, key));

const byOrder = (a: Note, b: Note) => a.position - b.position || a.id.localeCompare(b.id);
const byReminder = (a: Note, b: Note) =>
  (a.reminder ? reminderMoment(a.reminder).getTime() : 0) - (b.reminder ? reminderMoment(b.reminder).getTime() : 0) || byOrder(a, b);

/**
 * ``/notes`` — Promptly Notes, Keep-style: quick notes and checklists as a
 * grid of coloured cards you can pin, colour, label, archive and search.
 * Inside Promptly's layout in a browser (``embedded``); on its own as the
 * installed Notes app. Works with no connection: everything is kept on
 * the device and saved when the connection is back.
 */
export function NotesApp({ embedded = false }: { embedded?: boolean } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const uid = useAuthStore((s) => s.user?.id ?? null);
  const settings = useAuthStore((s) => s.user?.settings);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const isPhone = useIsMobile(767);
  const narrow = useIsMobile(1023);

  const ready = useNotes((s) => s.ready);
  const loaded = useNotes((s) => s.loaded);
  const loadError = useNotes((s) => s.loadError);
  const notes = useNotes((s) => s.notes);
  const users = useNotes((s) => s.users);
  const outbox = useNotes((s) => s.outbox);
  const sync = useNotes((s) => s.sync);
  const lost = useNotes((s) => s.lost);

  const { place: routePlace, noteId } = parse(location.pathname);
  // With a note open over the grid (desktop), the grid stays where it was.
  const from = (location.state as { from?: string } | null)?.from;
  const place = noteId && from ? parse(from.split("?")[0]).place : routePlace;
  const q = params.get("q") ?? "";
  const typeFilter = params.get("type");
  const colorFilter = params.get("color");
  const searching = !!(q.trim() || typeFilter || colorFilter);

  const [drawer, setDrawer] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [searchFocus, setSearchFocus] = useState(false);
  const [serverHits, setServerHits] = useState<{ q: string; ids: Set<string> } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const layout: "grid" | "list" = (settings?.notes_view as "grid" | "list" | undefined) ?? "grid";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (place.view !== "reminders") return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [place.view]);

  useEffect(() => {
    if (!uid) return;
    void initNotes(uid);
    void initUploads(uid);
  }, [uid]);
  useNotesLive(!!uid && ready);

  useEffect(() => {
    const before = document.title;
    document.title = "Notes";
    return () => {
      document.title = before;
    };
  }, []);

  useEffect(() => {
    if (place.view === "trash" && ready) void loadTrash();
  }, [place.view, ready]);

  // Leaving a note that was being started on the phone keeps it (or drops it if empty).
  const lastNote = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastNote.current;
    lastNote.current = noteId;
    if (prev && prev !== noteId && useNotes.getState().drafts[prev]) closeDraft(prev);
  }, [noteId]);

  // Shared from another app into the installed Notes app.
  useEffect(() => {
    if (!ready || params.get("shared") !== "1") return;
    void (async () => {
      const items = await takeSharedText();
      let last: string | null = null;
      let skipped = 0;
      for (const s of items) {
        const body = [s.text, s.url && !s.text.includes(s.url) ? s.url : ""].filter(Boolean).join("\n");
        const id = newDraft("text", { title: s.title.slice(0, 300), body_doc: textDoc(body), body_text: body, source: "share" });
        const files = (s.files ?? []).filter((f) => kindOf(f));
        skipped += (s.files?.length ?? 0) - files.length;
        if (files.length) {
          addFiles(id, files);
          last = id;
        } else if (closeDraft(id)) last = id;
      }
      if (skipped) toast.error("Only pictures and recordings can go in a note — the rest weren't added.");
      const next = new URLSearchParams(params);
      next.delete("shared");
      setParams(next, { replace: true });
      if (last) navigate(`/notes/n/${last}`, { state: { from: "/notes" } });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // "New list" / "New note" / "Voice note" from the installed app's shortcuts,
  // and from elsewhere in Promptly (Files' New → Note, the Ctrl+K palette;
  // words typed there come along: ``newNote.ts``).
  const newParam = params.get("new");
  useEffect(() => {
    const kind = newParam;
    if (!ready || (kind !== "list" && kind !== "note" && kind !== "voice")) return;
    const text = takeNewNoteText(kind);
    const opts: Partial<Note> = kind === "voice" ? { source: "voice" } : {};
    if (text && kind === "list") {
      const items = text
        .split(/\n|,|;/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 1000)
        .map((t) => ({ id: uuid(), parent_id: null, text: t.slice(0, 1000), checked: false }));
      Object.assign(opts, { items, items_total: items.length });
    } else if (text) {
      Object.assign(opts, { body_doc: textDoc(text), body_text: text });
    }
    const id = newDraft(kind === "list" ? "list" : "text", opts);
    navigate(`/notes/n/${id}`, { replace: true, state: { from: "/notes", focus: kind === "list" ? "list" : kind === "voice" ? undefined : "body", noBack: true, record: kind === "voice" } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, newParam]);

  // Server search: words deep in long notes and every list item.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setServerHits(null);
      return;
    }
    const t = setTimeout(async () => {
      const ids = await searchServer(term);
      if (ids) setServerHits({ q: term, ids: new Set(ids) });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // ------------------------------------------------------------ what to show
  const all = useMemo(() => Object.values(notes), [notes]);
  const live = useMemo(() => all.filter((n) => !n.trashed_at), [all]);
  const labels = useMemo(() => {
    const m = new Map<string, NoteLabel & { count: number }>();
    for (const n of live)
      for (const l of n.labels) {
        const key = labelKey(l);
        const cur = m.get(key);
        m.set(key, { ...l, count: (cur?.count ?? 0) + 1 });
      }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [live]);
  const currentLabel = place.view === "label" ? labels.find((l) => isLabel(l, place.label)) ?? null : null;
  // A ``~name`` link whose label now has its id: show the lasting link.
  useEffect(() => {
    if (place.view !== "label" || !place.label?.startsWith("~") || !currentLabel?.id || noteId) return;
    navigate({ pathname: `/notes/label/${encodeURIComponent(currentLabel.id)}`, search: location.search }, { replace: true });
  }, [place.view, place.label, currentLabel?.id, noteId, navigate, location.search]);

  const pendingIds = useMemo(() => new Set(outbox.filter((x) => !x.landed && sync !== "saving" && sync !== "idle").map((x) => x.op.id)), [outbox, sync]);

  const visible = useMemo(() => {
    let list: Note[];
    if (searching) {
      const term = q.trim().toLowerCase();
      list = live.filter((n) => {
        if (typeFilter && !matchesType(n, typeFilter)) return false;
        if (colorFilter && n.color !== colorFilter) return false;
        if (place.view === "label" && !hasLabel(n, place.label)) return false;
        if (!term) return true;
        return searchText(n).includes(term) || (serverHits?.q === q.trim() && serverHits.ids.has(n.id));
      });
    } else if (place.view === "trash") list = all.filter((n) => n.trashed_at && n.is_owner);
    else if (place.view === "archive") list = live.filter((n) => n.archived);
    else if (place.view === "reminders") return live.filter((n) => n.reminder).sort(byReminder);
    else if (place.view === "label") list = live.filter((n) => hasLabel(n, place.label));
    else list = live.filter((n) => !n.archived);
    if (place.view === "trash" && !searching) return list.sort((a, b) => (b.trashed_at ?? "").localeCompare(a.trashed_at ?? ""));
    return list.sort(byOrder);
  }, [all, live, searching, q, typeFilter, colorFilter, place.view, place.label, serverHits]);

  const sections = useMemo(() => {
    if (place.view === "trash" && !searching) return [{ key: "trash", notes: visible }];
    if (searching) return [{ key: "results", notes: visible }];
    if (place.view === "reminders") {
      const at = new Date(now);
      const groups: { key: string; title: string; notes: Note[] }[] = [
        { key: "overdue", title: "Overdue", notes: [] },
        { key: "today", title: "Today", notes: [] },
        { key: "upcoming", title: "Upcoming", notes: [] },
      ];
      for (const n of visible) groups.find((g) => g.key === reminderWhen(n.reminder!, at))!.notes.push(n);
      return groups.filter((g) => g.notes.length);
    }
    const active = visible.filter((n) => !n.archived);
    const archived = visible.filter((n) => n.archived);
    const pinned = active.filter((n) => n.pinned);
    const others = active.filter((n) => !n.pinned);
    const out: { key: string; title?: string; notes: Note[] }[] = [];
    if (pinned.length) out.push({ key: "pinned", title: "Pinned", notes: pinned });
    out.push({ key: "others", title: pinned.length ? "Others" : undefined, notes: place.view === "archive" ? [...others, ...archived] : others });
    if (place.view === "label" && archived.length) out.push({ key: "archived", title: "Archived", notes: archived });
    return out;
  }, [visible, place.view, searching, now]);

  const order = useMemo(() => sections.flatMap((s) => s.notes.map((n) => n.id)), [sections]);

  // Selection follows what's on screen.
  useEffect(() => {
    setSelected((s) => {
      const keep = new Set([...s].filter((id) => order.includes(id)));
      return keep.size === s.size ? s : keep;
    });
  }, [order]);
  useEffect(() => setSelected(new Set()), [place.view, place.label]);
  useEffect(() => {
    if (!selected.size || noteId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size, noteId]);

  // ------------------------------------------------------------ actions
  const openNote = useCallback(
    (id: string, focus?: string) => navigate(`/notes/n/${id}`, { state: { from: location.pathname + location.search, focus } }),
    [navigate, location.pathname, location.search],
  );
  const noBack = !!(location.state as { noBack?: boolean } | null)?.noBack;
  const closeNote = useCallback(() => {
    if (from && !noBack) navigate(-1);
    else navigate(placePath(place), { replace: true });
  }, [from, noBack, navigate, place]);

  const [labelFor, setLabelFor] = useState<{ ids: string[]; anchor: HTMLElement } | null>(null);
  const [remindFor, setRemindFor] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [shareFor, setShareFor] = useState<string | null>(null);
  const actions: CardActions = useMemo(
    () => ({
      open: (id) => openNote(id),
      select: (id, how) =>
        setSelected((s) => {
          const next = new Set(s);
          if (how === "range" && anchor.current && order.includes(anchor.current)) {
            const a = order.indexOf(anchor.current);
            const b = order.indexOf(id);
            for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
          } else if (next.has(id)) next.delete(id);
          else next.add(id);
          anchor.current = id;
          return next;
        }),
      pin: (id, pinned) => noteOps.pin([id], pinned),
      color: (id, c) => noteOps.color([id], c),
      archive: (id, a) => noteOps.archive([id], a),
      trash: (id) => noteOps.trash([id]),
      labels: (id, el) => setLabelFor({ ids: [id], anchor: el }),
      restore: (id) => noteOps.restore([id]),
      forever: (id) => noteOps.forever([id]),
      remind: (id, el) => setRemindFor({ id, anchor: el }),
      share: (id) => setShareFor(id),
    }),
    [openNote, order],
  );

  const onMove = useCallback(
    (id: string, overId: string, section: string) => {
      const list = sections.find((s) => s.key === section)?.notes ?? [];
      const from_ = list.findIndex((n) => n.id === id);
      const to = list.findIndex((n) => n.id === overId);
      if (from_ < 0 || to < 0) return;
      const rest = list.filter((n) => n.id !== id);
      const at = rest.findIndex((n) => n.id === overId) + (to > from_ ? 1 : 0);
      const before = rest[at - 1]?.position;
      const after = rest[at]?.position;
      const position = before === undefined ? (after ?? 0) - 1 : after === undefined ? before + 1 : (before + after) / 2;
      notesActions.me(id, { position });
    },
    [sections],
  );

  const setLayout = (v: "grid" | "list") => {
    patchSettings({ notes_view: v });
    void authApi.updatePreferences({ notes_view: v }).catch(() => undefined);
  };

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const clearSearch = () => {
    const next = new URLSearchParams(params);
    for (const k of ["q", "type", "color"]) next.delete(k);
    setParams(next, { replace: true });
  };

  const labelStart = () => (currentLabel ? { labels: [{ id: currentLabel.id, name: currentLabel.name, color: currentLabel.color }] } : {});
  const newOnPhone = (kind: "text" | "list") => {
    const id = newDraft(kind, labelStart());
    navigate(`/notes/n/${id}`, { state: { from: location.pathname + location.search, focus: kind === "list" ? "list" : "body" } });
  };
  /** The phone's Record and Image buttons: a new note with that in it. */
  const newWith = (fill?: (id: string) => void) => {
    const id = newDraft("text", fill ? labelStart() : { ...labelStart(), source: "voice" });
    fill?.(id);
    navigate(`/notes/n/${id}`, { state: { from: location.pathname + location.search, record: !fill } });
  };

  // ------------------------------------------------------------ the open note
  const openFocus = (location.state as { focus?: "title" | "body" | "list" } | null)?.focus;
  const openRecord = (location.state as { record?: boolean } | null)?.record ? ("record" as const) : undefined;
  const open = useNote(noteId);
  const [openState, setOpenState] = useState<"idle" | "loading" | "gone">("idle");
  useEffect(() => {
    if (!noteId || !ready) return;
    const k = useNotes.getState().known[noteId];
    if (useNotes.getState().drafts[noteId] || (k && !k.partial) || k?.local) {
      // We have it whole: show it now, and check for anything newer.
      setOpenState("idle");
      if (k && !k.local) void fetchNote(noteId);
      return;
    }
    setOpenState("loading");
    void fetchNote(noteId).then((r) => setOpenState(r === "gone" ? "gone" : "idle"));
  }, [noteId, ready]);
  const openFull = open && (useNotes.getState().drafts[open.id] || !useNotes.getState().known[open.id]?.partial);

  const editorPage = isPhone && noteId;
  /** "Keep a copy" of a note that's no longer shared with you. */
  const keep = (id: string | null) => {
    const copy = id ? keepCopy(id) : null;
    if (!copy) return;
    toast.success("Kept a copy in your notes");
    navigate(`/notes/n/${copy}`, { replace: true, state: { from: "/notes" } });
  };

  // ------------------------------------------------------------ pieces
  const pending = outbox.filter((x) => !x.landed).length;
  const syncNote =
    pending > 0 && (sync === "offline" || sync === "retrying" || sync === "signed_out") ? (
      <span role="status" className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text-muted)]">
        <CloudOff className="h-3.5 w-3.5" aria-hidden />
        {sync === "offline" ? "Offline" : sync === "signed_out" ? "Sign in to save" : "Couldn't save — retrying"}
        <span className="hidden sm:inline"> · {pending === 1 ? "1 change waiting" : `${pending} changes waiting`}</span>
      </span>
    ) : null;

  const rail = (
    <nav aria-label="Notes" className="flex flex-col gap-0.5 py-2">
      <RailLink to="/notes" active={!searching && place.view === "home"} icon={Lightbulb} onNavigate={() => setDrawer(false)}>
        Notes
      </RailLink>
      <RailLink to="/notes/reminders" active={!searching && place.view === "reminders"} icon={AlarmClock} onNavigate={() => setDrawer(false)}>
        Reminders
      </RailLink>
      {labels.length > 0 && <p className="mt-3 px-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Labels</p>}
      {labels.map((l) => (
        <RailLink key={labelKey(l)} to={`/notes/label/${encodeURIComponent(labelKey(l))}`} active={place.view === "label" && isLabel(l, place.label)} onNavigate={() => setDrawer(false)} dot={tagColor(l)} count={l.count}>
          {l.name}
        </RailLink>
      ))}
      <RailLink to="/tags" icon={Pencil} active={false} onNavigate={() => setDrawer(false)}>
        Edit labels
      </RailLink>
      <div className="my-2 border-t border-[var(--border)]" />
      <RailLink to="/notes/archive" active={!searching && place.view === "archive"} icon={Archive} onNavigate={() => setDrawer(false)}>
        Archive
      </RailLink>
      <RailLink to="/notes/trash" active={!searching && place.view === "trash"} icon={Trash2} onNavigate={() => setDrawer(false)}>
        Trash
      </RailLink>
      <div className="my-2 border-t border-[var(--border)]" />
      <RailLink to={KEEP_IMPORT} icon={Import} active={false} onNavigate={() => setDrawer(false)}>
        Import from Google Keep
      </RailLink>
      {embedded && isPhone && (
        <button
          type="button"
          onClick={() => {
            setDrawer(false);
            useUIStore.getState().openMobileNav();
          }}
          className="mx-2 mt-4 flex h-10 items-center gap-3 rounded-full px-3 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <Menu className="h-4 w-4" /> All of Promptly
        </button>
      )}
    </nav>
  );

  const title = searching
    ? "Search"
    : place.view === "archive"
      ? "Archive"
      : place.view === "trash"
        ? "Trash"
        : place.view === "reminders"
          ? "Reminders"
          : place.view === "label"
            ? currentLabel?.name ?? "Label"
            : "Notes";

  const searchBox = (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
      <input
        ref={searchRef}
        type="search"
        value={q}
        onChange={(e) => setParam("q", e.target.value || null)}
        onFocus={() => setSearchFocus(true)}
        onBlur={() => setTimeout(() => setSearchFocus(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && searching) {
            e.preventDefault();
            clearSearch();
            searchRef.current?.blur();
          }
        }}
        placeholder="Search your notes"
        aria-label="Search your notes"
        className="h-11 w-full rounded-full border border-transparent bg-[var(--surface-2)] pl-10 pr-10 text-[15px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:bg-[var(--surface)] [&::-webkit-search-cancel-button]:hidden"
      />
      {searching && (
        <button type="button" onClick={clearSearch} aria-label="Clear search" className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  const usedColors = NOTE_COLORS.filter((c) => c !== "default" && live.some((n) => n.color === c));
  const usedTypes = TYPE_CHIPS.filter((t) => live.some((n) => matchesType(n, t.key)));
  const chips = (searching || searchFocus) && place.view !== "trash" && (usedTypes.length > 0 || usedColors.length > 0 || labels.length > 0) && (
    <div className="flex flex-col gap-2 border-b border-[var(--border)] px-4 py-2.5" onMouseDown={(e) => e.preventDefault()}>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by type">
        {usedTypes.map((t) => (
          <Chip key={t.key} on={typeFilter === t.key} onClick={() => setParam("type", typeFilter === t.key ? null : t.key)}>
            {t.label}
          </Chip>
        ))}
        {labels.slice(0, 12).map((l) => (
          <Chip key={labelKey(l)} on={place.view === "label" && isLabel(l, place.label)} onClick={() => navigate({ pathname: place.view === "label" && isLabel(l, place.label) ? "/notes" : `/notes/label/${encodeURIComponent(labelKey(l))}`, search: params.toString() })}>
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: tagColor(l) }} />
            {l.name}
          </Chip>
        ))}
      </div>
      {usedColors.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by colour">
          {usedColors.map((c) => (
            <button
              key={c}
              type="button"
              data-color={c}
              aria-label={COLOR_NAMES[c]}
              aria-pressed={colorFilter === c}
              title={COLOR_NAMES[c]}
              onClick={() => setParam("color", colorFilter === c ? null : c)}
              className={cn("note-c note-swatch h-7 w-7 rounded-full border-2", colorFilter === c ? "border-[var(--accent)]" : "border-[var(--border)]")}
            />
          ))}
        </div>
      )}
    </div>
  );

  // ------------------------------------------------------------ selection bar
  const selIds = [...selected];
  const selNotes = selIds.map((id) => notes[id]).filter(Boolean);
  const allPinned = selNotes.length > 0 && selNotes.every((n) => n.pinned);
  const allArchived = selNotes.length > 0 && selNotes.every((n) => n.archived);
  const [selPop, setSelPop] = useState<null | "color">(null);
  const selColorBtn = useRef<HTMLButtonElement>(null);
  const selLabelBtn = useRef<HTMLButtonElement>(null);
  const done = () => setSelected(new Set());
  const selBtn = "flex h-10 w-10 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]";
  const selectionBar = selected.size > 0 && (
    <div role="toolbar" aria-label="Selected notes" className="flex h-14 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-2 pt-safe">
      <button type="button" onClick={done} aria-label="Clear selection" className={selBtn}>
        <X className="h-5 w-5" />
      </button>
      <span className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold" aria-live="polite">
        {selected.size} selected
      </span>
      {place.view === "trash" ? (
        <>
          <button type="button" aria-label="Restore" title="Restore" className={selBtn} onClick={() => (noteOps.restore(selIds), done())}>
            <RotateCcw className="h-5 w-5" />
          </button>
          <button type="button" aria-label="Delete forever" title="Delete forever" className={selBtn} onClick={() => (noteOps.forever(selIds), done())}>
            <Trash2 className="h-5 w-5" />
          </button>
        </>
      ) : (
        <>
          <button type="button" aria-label={allPinned ? "Unpin" : "Pin"} title={allPinned ? "Unpin" : "Pin"} className={selBtn} onClick={() => (noteOps.pin(selIds, !allPinned), done())}>
            {allPinned ? <PinOff className="h-5 w-5" /> : <Pin className="h-5 w-5" />}
          </button>
          <button ref={selColorBtn} type="button" aria-label="Colour" title="Colour" className={selBtn} onClick={() => setSelPop("color")}>
            <Palette className="h-5 w-5" />
          </button>
          <button ref={selLabelBtn} type="button" aria-label="Labels" title="Labels" className={selBtn} onClick={() => selLabelBtn.current && setLabelFor({ ids: selIds, anchor: selLabelBtn.current })}>
            <Tag className="h-5 w-5" />
          </button>
          <button type="button" aria-label={allArchived ? "Unarchive" : "Archive"} title={allArchived ? "Unarchive" : "Archive"} className={selBtn} onClick={() => (noteOps.archive(selIds, !allArchived), done())}>
            {allArchived ? <ArchiveRestore className="h-5 w-5" /> : <Archive className="h-5 w-5" />}
          </button>
          <button type="button" aria-label="Delete" title="Delete" className={selBtn} onClick={() => (noteOps.trash(selIds), done())}>
            <Trash2 className="h-5 w-5" />
          </button>
        </>
      )}
      {selPop === "color" && (
        <Pop anchor={selColorBtn.current} label="Colour" onClose={() => setSelPop(null)} width={248}>
          <ColorGrid
            value={selNotes.every((n) => n.color === selNotes[0]?.color) ? selNotes[0]?.color ?? null : null}
            onPick={(c) => {
              noteOps.color(selIds, c);
              setSelPop(null);
            }}
          />
        </Pop>
      )}
    </div>
  );

  // Labels for one note (a card's menu) or the selection.
  const labelPop = labelFor && (() => {
    const ns = labelFor.ids.map((id) => notes[id]).filter(Boolean);
    const every = (name: string) => ns.every((n) => n.labels.some((l) => l.name.toLowerCase() === name));
    const some = new Set(ns.flatMap((n) => n.labels.map((l) => l.name.toLowerCase())).filter((name) => !every(name)));
    const value = labels.filter((l) => every(l.name.toLowerCase()));
    return (
      <Pop anchor={labelFor.anchor} label="Labels" onClose={() => setLabelFor(null)} width={260}>
        <LabelChooser value={value} mixed={some} extra={labels} onToggle={(l, on) => noteOps.label(labelFor.ids, l, on)} />
      </Pop>
    );
  })();

  // ------------------------------------------------------------ the page
  const empty = (() => {
    if (!ready || (!loaded.main && !all.length)) {
      if (loadError) return <Empty icon={CloudOff} title="Couldn't load your notes" body={loadError} action={<button type="button" className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white" onClick={() => void loadLists()}>Try again</button>} />;
      if (ready && typeof navigator !== "undefined" && navigator.onLine === false) return <Empty icon={CloudOff} title="You're offline" body="Your notes will show once you're connected. Notes you write now are kept on this device." />;
      return (
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--text-muted)]" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your notes…
        </div>
      );
    }
    if (visible.length) return null;
    if (searching) return <Empty icon={Search} title={q.trim() ? `Nothing matches “${q.trim()}”` : "No notes match"} body="Try other words, or clear the filters." />;
    if (place.view === "trash") {
      if (!loaded.trash) return <div className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--text-muted)]" role="status"><Loader2 className="h-4 w-4 animate-spin" /> Loading the Trash…</div>;
      return <Empty icon={Trash2} title="No notes in the Trash" body="Notes you delete stay here for 30 days." />;
    }
    if (place.view === "archive") return <Empty icon={Archive} title="Archived notes appear here" body="Archive a note to put it away without deleting it." />;
    if (place.view === "reminders")
      return <Empty icon={AlarmClock} title="Notes with reminders appear here" body="Tap the bell on a note to be reminded about it. Reminders go in your Tasks too, with Done and Snooze on the reminder." />;
    if (place.view === "label") return <Empty icon={Tag} title="No notes with this label" body={currentLabel ? `Notes you label “${currentLabel.name}” appear here.` : "This label isn't on any of your notes."} />;
    return (
      <Empty
        icon={Lightbulb}
        title="Notes you add appear here"
        body={isPhone ? "Tap + to write one, or the list button for a checklist." : "Click “Take a note…” above to write one."}
        action={
          <Link to={KEEP_IMPORT} className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent-text)] hover:underline">
            <Import className="h-4 w-4" aria-hidden /> Bring your notes from Google Keep
          </Link>
        }
      />
    );
  })();

  const showComposer = !isPhone && !searching && (place.view === "home" || place.view === "label");

  const header = isPhone ? (
    <header className="flex h-16 shrink-0 items-center gap-1 bg-[var(--bg)] px-2 pt-safe">
      <button type="button" onClick={() => setDrawer(true)} aria-label="Notes menu" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]">
        <Menu className="h-5 w-5" />
      </button>
      {searchBox}
      <button type="button" onClick={() => setLayout(layout === "grid" ? "list" : "grid")} aria-label={layout === "grid" ? "Show as a list" : "Show as a grid"} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]">
        {layout === "grid" ? <Rows3 className="h-5 w-5" /> : <LayoutGrid className="h-5 w-5" />}
      </button>
    </header>
  ) : (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg)] px-4">
      {narrow && (
        <button type="button" onClick={() => setDrawer(true)} aria-label="Notes menu" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <Menu className="h-5 w-5" />
        </button>
      )}
      <h1 className="w-36 shrink-0 truncate text-lg font-semibold text-[var(--text)]">{title}</h1>
      <div className="flex max-w-2xl flex-1">{searchBox}</div>
      <div className="flex flex-1 items-center justify-end gap-1">
        {syncNote}
        <button type="button" onClick={() => setLayout(layout === "grid" ? "list" : "grid")} aria-label={layout === "grid" ? "Show as a list" : "Show as a grid"} title={layout === "grid" ? "List view" : "Grid view"} className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
          {layout === "grid" ? <Rows3 className="h-5 w-5" /> : <LayoutGrid className="h-5 w-5" />}
        </button>
      </div>
    </header>
  );

  const main = (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]", editorPage && "hidden")}>
      {selectionBar || header}
      {isPhone && (searching || syncNote) && (
        <div className="flex items-center gap-2 px-4 pb-1">
          {isPhone && <h1 className="sr-only">{title}</h1>}
          {syncNote}
        </div>
      )}
      {isPhone && !searching && !syncNote && <h1 className="sr-only">{title}</h1>}
      {chips}
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-3 pb-28 pt-4 sm:px-6", !isPhone && "pb-12")}>
        {showComposer && (
          <div className="mb-8">
            <Composer label={currentLabel ? { id: currentLabel.id, name: currentLabel.name, color: currentLabel.color } : null} />
          </div>
        )}
        {place.view === "trash" && !searching && visible.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center justify-center gap-3 text-sm text-[var(--text-muted)]">
            <span>Notes in the Trash are deleted after 30 days.</span>
            <button
              type="button"
              className="rounded-full px-3 py-1.5 font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]"
              onClick={async () => {
                const ok = await confirm({ title: "Empty the Trash?", message: "Every note in the Trash will be deleted forever. This can't be undone.", confirmLabel: "Empty Trash", danger: true });
                if (ok) notesActions.emptyTrash();
              }}
            >
              Empty Trash
            </button>
          </div>
        )}
        {empty ?? (
          <NoteGrid
            sections={sections}
            users={users}
            selected={selected}
            pending={pendingIds}
            actions={actions}
            layout={layout}
            trash={place.view === "trash" && !searching}
            onMove={searching || place.view === "trash" || place.view === "reminders" ? undefined : onMove}
          />
        )}
      </div>
      {isPhone && !selected.size && place.view !== "trash" && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex h-[calc(56px+env(safe-area-inset-bottom,0px))] items-start gap-1 border-t border-[var(--border)] bg-[var(--surface)] px-3 pb-safe pt-1">
          <button type="button" onClick={() => newOnPhone("list")} aria-label="New list" className="flex h-12 w-12 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]">
            <ListChecks className="h-6 w-6" />
          </button>
          <button type="button" onClick={() => newWith()} aria-label="New voice note" className="flex h-12 w-12 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]">
            <Mic className="h-6 w-6" />
          </button>
          <AddImageButton
            label="New picture note"
            className="flex h-12 w-12 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]"
            iconClassName="h-6 w-6"
            onFiles={(files) => newWith((id) => addFiles(id, files))}
            onPhotos={(items) => newWith((id) => attachPhotos(id, items))}
          />
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => newOnPhone("text")}
            aria-label="New note"
            className="-mt-7 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent)] text-white shadow-[var(--shadow-lg)] transition active:scale-95"
          >
            <Plus className="h-7 w-7" />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className={cn("flex overflow-hidden bg-[var(--bg)] text-[var(--text)]", embedded ? "h-full min-h-0" : "h-[100dvh] pl-safe pr-safe")}>
      {!narrow && <aside className="w-60 shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--bg)]">{rail}</aside>}
      {main}
      {editorPage &&
        (open && openFull ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <NoteEditor key={open.id} note={open} variant="page" onClose={closeNote} autoFocus={openFocus} startWith={openRecord} />
          </div>
        ) : (
          <NoteMissing state={openState} onBack={closeNote} lost={!!(noteId && lost[noteId])} onKeep={() => keep(noteId)} />
        ))}
      {!editorPage && noteId && open && openFull && <NoteDialog key={open.id} note={open} onClose={closeNote} autoFocus={openFocus} startWith={openRecord} />}
      {!editorPage && noteId && !(open && openFull) && (openState === "loading" || openState === "gone" || !open) && (
        <NoteMissingDialog state={openState} onBack={closeNote} lost={!!(noteId && lost[noteId])} onKeep={() => keep(noteId)} />
      )}
      {narrow && drawer && <Drawer onClose={() => setDrawer(false)}>{rail}</Drawer>}
      {labelPop}
      {remindFor && notes[remindFor.id] && <ReminderPicker note={notes[remindFor.id]} anchor={remindFor.anchor} onClose={() => setRemindFor(null)} />}
      {shareFor && notes[shareFor] && <ShareDialog note={notes[shareFor]} onClose={() => setShareFor(null)} />}
      {!embedded && (
        <>
          <InstallFromLink appName="Promptly Notes" iconSrc="/item-icons/notes-192.png" description="Your notes and lists, as their own app." />
          <NetworkStatusToast />
        </>
      )}
    </div>
  );
}

/** Moving in from Google Keep (N1.6): a Keep import on the Import page. */
const KEEP_IMPORT = "/files/import?start=keep";

function RailLink({ to, active, icon: Icon, dot, count, children, onNavigate }: { to: string; active: boolean; icon?: React.ComponentType<{ className?: string }>; dot?: string; count?: number; children: ReactNode; onNavigate: () => void }) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "mr-2 flex h-11 items-center gap-4 rounded-r-full pl-5 pr-3 text-sm transition-colors",
        active ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] font-semibold text-[var(--text)]" : "text-[var(--text)] hover:bg-[var(--hover)]",
      )}
    >
      {Icon ? <Icon className="h-[18px] w-[18px] shrink-0 text-[var(--text-muted)]" /> : <Tag className="h-[18px] w-[18px] shrink-0" style={{ color: dot }} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && <span className="text-xs text-[var(--text-muted)]">{count}</span>}
    </Link>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors",
        on ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]",
      )}
    >
      {children}
    </button>
  );
}

function Empty({ icon: Icon, title, body, action }: { icon: React.ComponentType<{ className?: string }>; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-20 text-center">
      <Icon className="h-16 w-16 text-[var(--text-muted)] opacity-40" />
      <p className="text-lg font-medium text-[var(--text)]">{title}</p>
      {body && <p className="text-sm text-[var(--text-muted)]">{body}</p>}
      {action}
    </div>
  );
}

const LOST_TITLE = "This note isn't shared with you any more";
const LOST_BODY = "Its owner took you off it, or deleted it. You can keep a copy of what you last saw.";

function NoteMissing({ state, onBack, lost, onKeep }: { state: "idle" | "loading" | "gone"; onBack: () => void; lost?: boolean; onKeep?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 items-center px-2 pt-safe">
        <button type="button" onClick={onBack} className="rounded-full px-3 py-2 text-sm font-medium hover:bg-[var(--hover)]">
          ← Notes
        </button>
      </div>
      {lost ? (
        <Empty
          icon={Lightbulb}
          title={LOST_TITLE}
          body={LOST_BODY}
          action={
            <button type="button" onClick={onKeep} className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">
              Keep a copy
            </button>
          }
        />
      ) : state === "gone" ? (
        <Empty icon={Lightbulb} title="This note isn't here any more" body="It was deleted, or it's no longer shared with you." />
      ) : state === "loading" ? (
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--text-muted)]" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Opening the note…
        </div>
      ) : (
        <Empty icon={CloudOff} title="This note isn't on this device yet" body="Connect to open it." />
      )}
    </div>
  );
}

function NoteMissingDialog({ state, onBack, lost, onKeep }: { state: "idle" | "loading" | "gone"; onBack: () => void; lost?: boolean; onKeep?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <button type="button" aria-label="Close" onClick={onBack} className="fixed inset-0 bg-black/45" />
      <div role="dialog" aria-modal="true" aria-label="Note" className="relative w-full max-w-md rounded-xl bg-[var(--surface)] p-2 shadow-[var(--shadow-lg)]">
        {lost ? (
          <Empty
            icon={Lightbulb}
            title={LOST_TITLE}
            body={LOST_BODY}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" onClick={onBack} className="rounded-full px-4 py-2 text-sm font-medium hover:bg-[var(--hover)]">
                  Back to notes
                </button>
                <button type="button" onClick={onKeep} className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">
                  Keep a copy
                </button>
              </div>
            }
          />
        ) : state === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--text-muted)]" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /> Opening the note…
          </div>
        ) : (
          <Empty
            icon={state === "gone" ? Lightbulb : CloudOff}
            title={state === "gone" ? "This note isn't here any more" : "This note isn't on this device yet"}
            body={state === "gone" ? "It was deleted, or it's no longer shared with you." : "Connect to open it."}
            action={
              <button type="button" onClick={onBack} className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">
                Back to notes
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}

function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      back?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close menu" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Notes menu" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-[var(--surface)] pt-safe shadow-xl">
        <p className="px-5 pb-1 pt-4 text-lg font-semibold">Notes</p>
        {children}
      </div>
    </div>
  );
}
