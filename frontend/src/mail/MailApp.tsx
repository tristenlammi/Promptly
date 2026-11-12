import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  AlarmClock, Archive, ArrowLeft, CalendarPlus, Check, CheckCheck, CheckSquare, ChevronDown, ChevronUp, Download, Forward, Inbox, ListFilter, Loader2, Mail, MailOpen, Paperclip, Pen, Plus, Reply, ReplyAll, Search, Send, Settings, Sparkles, Star, Tag, Trash2, UserPlus, X, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";

import { ModelSelector } from "@/components/chat/ModelSelector";
import { ContextMenu, type ContextMenuItem } from "@/components/files/ContextMenu";
import { Skeleton } from "@/components/shared/Skeleton";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { PromptlyMenuButton } from "@/components/layout/PromptlyNavDrawer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Sheet as SharedSheet } from "@/items/ui";
import "@/items/ui/items.css";
import { showsPromptlyNav } from "@/lib/appLaunch";
import { useSelectedModel } from "@/store/modelStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { mailApi, personName, shortWhen, type Person, type InviteAnswer, type KnownPerson, type MailAccount, type MailInvite, type Conversation, type MailLabel, type Message, type ThreadAction, type ThreadRow } from "./api";
import { AccountPicker, AccountSheet, MailboxSheet } from "./AccountSheet";
import { AliasNotes, replyAlias, sendAsNote, useThreadAliases } from "./Aliases";
import { asParagraphs, Composer, draftId, type Draft } from "./Composer";
import { AttachmentViewer, SaveToFiles, useSavedAttachments } from "./AttachmentViewer";
import { readComposeLink } from "./composeLink";
import { useThreadDrag } from "./DragMove";
import { LabelPicker, LabelPill, LabelsSheet, NewLabelSheet, RuleSheet, type LabelTarget } from "./Labels";
import { labelRows, labelsInside, readFolded, saveFolded, unfolded } from "./labelTree";
import { MessageBody } from "./MessageBody";
import { EditMailboxSheet, EventSheet, MailSettingsSheet, SnoozeSheet } from "./Sheets";

const ROLES: { role: string; label: string; icon: LucideIcon }[] = [
  { role: "inbox", label: "Inbox", icon: Inbox },
  { role: "snoozed", label: "Snoozed", icon: AlarmClock },
  { role: "sent", label: "Sent", icon: Send },
  { role: "archive", label: "Archive", icon: Archive },
  { role: "trash", label: "Trash", icon: Trash2 },
];
const UNDO_MS = 5000;
const LEAVE_MS = 200;
// As many as the server takes at once.
const MAX_PICKED = 500;
const NONE: ReadonlySet<string> = new Set();
// Drafts open side by side. More than this and none of them has room.
const MAX_DRAFTS = 3;

interface Filters {
  unread: boolean;
  files: boolean;
  from: string;
  since: "" | "week" | "month" | "year";
}
const NO_FILTERS: Filters = { unread: false, files: false, from: "", since: "" };
const SINCE_DAYS = { week: 7, month: 31, year: 365 };

type ThreadPages = InfiniteData<{ threads: ThreadRow[]; next: string | null }>;
// Small enough to show the moment you ask, and take back if the mailbox says no.
const SHOWN_AT_ONCE: ReadonlySet<ThreadAction> = new Set<ThreadAction>(["star", "unstar", "read", "unread", "no_reply"]);

function flagged(row: ThreadRow, action: ThreadAction): ThreadRow {
  if (action === "star") return { ...row, starred: true };
  if (action === "unstar") return { ...row, starred: false };
  if (action === "read") return { ...row, unread: 0 };
  if (action === "unread") return { ...row, unread: Math.max(1, row.unread) };
  if (action === "no_reply") return { ...row, needs_reply: false };
  return row;
}

const SHORTCUTS: [string, string][] = [
  ["c", "Write a new email"],
  ["/", "Search"],
  ["j  k", "Next and previous conversation"],
  ["r", "Reply"],
  ["a", "Reply all"],
  ["f", "Forward"],
  ["s", "Star, or remove the star"],
  ["u", "Mark as unread and go back to the list"],
  ["e", "Archive"],
  ["#  Delete", "Move to Trash"],
  ["Ctrl+A", "Select everything in the list"],
  ["Ctrl+Enter", "Send what you're writing"],
  ["Esc", "Put away what you're writing, clear a selection, or close a conversation"],
  ["?", "Show this list"],
];

interface View {
  role: string;
  account?: string;
  label?: string;
  needsReply?: boolean;
}

const OPEN_LINK = /^[0-9a-f-]{36}\/[0-9a-zA-Z_-]{1,40}$/;
const SWIPE_AT = 0.35;

interface Open {
  account_id: string;
  key: string;
}

type People = Record<string, KnownPerson>;

const idOf = (row: Open) => `${row.account_id}/${row.key}`;
const conversations = (n: number) => `${n} conversation${n === 1 ? "" : "s"}`;

/** The contact's own picture when you know them, otherwise their initial. */
function Avatar({ person, people }: { person: Person; people: People }) {
  const known = people[person.addr.toLowerCase()];
  return <UserAvatar name={known?.name || personName(person)} avatarUrl={known?.photo ?? undefined} color="#D97757" size={36} className="shrink-0" />;
}

function shownName(person: Person, people: People): string {
  return people[person.addr.toLowerCase()]?.name || personName(person);
}

export function MailApp() {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const { data: overview, isLoading } = useQuery({ queryKey: ["mail-overview"], queryFn: mailApi.overview, refetchInterval: 20_000 });
  const [view, setView] = useState<View>({ role: "inbox" });
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  // What you're writing: several at once, one open and the rest minimised along the bottom.
  const [drafts, setDrafts] = useState<{ id: string; n: number; draft: Draft }[]>([]);
  const [activeDraft, setActiveDraft] = useState<string | null>(null);
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  const draftCount = useRef(0);
  const [selectMode, setSelectMode] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [help, setHelp] = useState(false);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [folded, setFolded] = useState(readFolded);
  const [menu, setMenu] = useState<{ row: ThreadRow; x: number; y: number } | null>(null);
  const [placeMenu, setPlaceMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  // Picked with Ctrl or Shift, to act on together. What's left the list drops out by itself.
  const [picked, setPicked] = useState<ReadonlySet<string>>(NONE);
  const anchor = useRef<string | null>(null);
  const [labelling, setLabelling] = useState<LabelTarget[] | null>(null);
  const [ruleFor, setRuleFor] = useState<LabelTarget | null>(null);
  const [snoozing, setSnoozing] = useState<Open[] | null>(null);
  const [editing, setEditing] = useState<MailAccount | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hidden = useRef(new Set<string>());
  // Closing up before it's gone, so the list settles rather than jumps.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [hiddenTick, setHiddenTick] = useState(0);
  const leavingTimers = useRef(new Map<string, number>());
  const [naming, setNaming] = useState<ThreadRow[] | null>(null);
  const accounts = useMemo(() => overview?.accounts ?? [], [overview]);
  const location = useLocation();
  const undoTimer = useRef<number | null>(null);
  const undoToast = useRef<string | null>(null);
  // Moves still inside their undo time, by conversation: call one to send it now.
  const waiting = useRef(new Map<string, (closing?: boolean) => void>());
  const [prefill, setPrefill] = useState<string | null>(null);
  const [eventFor, setEventFor] = useState<(Open & { subject: string }) | null>(null);
  const labels = useMemo(() => overview?.labels ?? [], [overview]);

  /** Start writing, or go back to what you'd started: one draft per email you're answering. */
  const write = useCallback((d: Draft) => {
    const id = draftId(d);
    const has = draftsNow.current.some((x) => x.id === id);
    if (!has && draftsNow.current.length >= MAX_DRAFTS) {
      toast.info("That's three on the go. Send or close one first.");
      return;
    }
    draftCount.current += 1;
    const n = draftCount.current;
    if (!has) setDrafts((v) => [...v, { id, n, draft: d }]);
    // Already open, and this one arrives with words in it: those are what you asked for.
    else if (d.html) setDrafts((v) => v.map((x) => (x.id === id ? { id, n, draft: d } : x)));
    setActiveDraft(id);
  }, []);
  const closeDraft = useCallback((id: string) => {
    setDrafts((v) => v.filter((x) => x.id !== id));
    setActiveDraft((a) => (a === id ? null : a));
  }, []);

  // Arrived from a notification, Today, Ctrl+K or a task, maybe with a draft from Chat.
  useEffect(() => {
    const link = new URLSearchParams(location.search).get("open");
    if (link && OPEN_LINK.test(link)) {
      const [account_id, key] = link.split("/");
      setOpen({ account_id, key });
      const hash = new URLSearchParams(location.hash.slice(1)).get("draft");
      if (hash) {
        setPrefill(hash);
        window.history.replaceState(window.history.state, "", location.pathname + location.search);
      }
    }
  }, [location.search, location.hash, location.pathname]);

  // A new draft from a link (Passwords' account deletion request): filled in, never sent.
  const composed = useRef("");
  useEffect(() => {
    if (!overview) return;
    const link = readComposeLink(location.search, location.hash);
    if (!link || composed.current === location.key) return;
    composed.current = location.key;
    window.history.replaceState(window.history.state, "", location.pathname);
    const from = accounts.find((a) => a.id === link.from)?.id ?? accounts[0]?.id ?? "";
    write({ account_id: from, to: link.to, subject: link.subject, html: asParagraphs(link.body) });
  }, [overview, accounts, write, location.search, location.hash, location.pathname, location.key]);

  useEffect(() => {
    const t = window.setTimeout(() => setSearch(typed.trim()), 250);
    return () => window.clearTimeout(t);
  }, [typed]);

  const listKey = ["mail-threads", view.role, view.account, view.label, view.needsReply, search];
  const list = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) => mailApi.threads({ role: view.role, account: view.account, label: view.label, needs_reply: view.needsReply || undefined, q: search || undefined, before: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    refetchInterval: 20_000,
    enabled: accounts.length > 0,
  });
  const allRows = useMemo(
    () => (list.data?.pages.flatMap((p) => p.threads) ?? []).filter((t) => !hidden.current.has(`${t.account_id}/${t.key}`)),
    [list.data, hiddenTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Narrowing down what a search found. It works on what's loaded: more arrives as you scroll.
  const filtering = !!search && (filters.unread || filters.files || !!filters.from || !!filters.since);
  const rows = useMemo(() => {
    if (!filtering) return allRows;
    const since = filters.since ? Date.now() - SINCE_DAYS[filters.since] * 86_400_000 : 0;
    return allRows.filter((t) => (!filters.unread || t.unread > 0)
      && (!filters.files || t.attachments)
      && (!filters.from || t.from.addr.toLowerCase() === filters.from)
      && (!since || new Date(t.at).getTime() >= since));
  }, [allRows, filtering, filters]);
  const senders = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of allRows) if (t.from.addr && !seen.has(t.from.addr.toLowerCase())) seen.set(t.from.addr.toLowerCase(), personName(t.from));
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [allRows]);

  const pickedRows = useMemo(() => rows.filter((r) => picked.has(idOf(r))), [rows, picked]);

  // A selection belongs to the list you made it in.
  useEffect(() => {
    setPicked(NONE);
    setSelectMode(false);
    anchor.current = null;
  }, [view.role, view.label, view.account, view.needsReply, search]);
  useEffect(() => {
    if (!search) setFilters(NO_FILTERS);
  }, [search]);
  // Once what you picked has been dealt with, tapping opens emails again.
  const hadPicked = useRef(false);
  useEffect(() => {
    if (hadPicked.current && picked.size === 0) setSelectMode(false);
    hadPicked.current = picked.size > 0;
  }, [picked]);

  // Older mail arrives as you get near the end of the list.
  const scroller = useRef<HTMLDivElement>(null);
  const older = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = older.current;
    if (!el || !hasNextPage || isFetchingNextPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((seen) => {
      if (seen.some((x) => x.isIntersecting)) void fetchNextPage();
    }, { root: scroller.current, rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, rows.length, open, isMobile]);

  // Names and pictures from your Contacts, for whoever's on screen.
  const addresses = useMemo(() => [...new Set(rows.map((r) => r.from.addr.toLowerCase()))].sort(), [rows]);
  const { data: people = {} as People } = useQuery({
    queryKey: ["mail-known-people", addresses],
    queryFn: () => mailApi.knownPeople(addresses),
    enabled: addresses.length > 0,
    staleTime: 5 * 60_000,
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["mail-threads"] });
    void qc.invalidateQueries({ queryKey: ["mail-overview"] });
    void qc.invalidateQueries({ queryKey: ["mail-conversation"] });
  }, [qc]);

  /** A star or a read mark shows straight away. Call what this gives back to undo that. */
  const showNow = useCallback((many: Open[], action: ThreadAction) => {
    const ids = new Set(many.map(idOf));
    const before = [...qc.getQueriesData({ queryKey: ["mail-threads"] }), ...qc.getQueriesData({ queryKey: ["mail-conversation"] })];
    // An answer already on its way would put the old mark back.
    void qc.cancelQueries({ queryKey: ["mail-threads"] });
    void qc.cancelQueries({ queryKey: ["mail-conversation"] });
    qc.setQueriesData<ThreadPages>({ queryKey: ["mail-threads"] }, (old) => (old
      ? { ...old, pages: old.pages.map((page) => ({ ...page, threads: page.threads.map((t) => (ids.has(idOf(t)) ? flagged(t, action) : t)) })) }
      : old));
    // Not "unread": the open conversation would only mark itself read again.
    if (action === "star" || action === "unstar" || action === "read") {
      for (const at of many) {
        qc.setQueryData<Conversation>(["mail-conversation", at.account_id, at.key], (old) => (old
          ? { ...old, messages: old.messages.map((m, i) => (action === "read" ? { ...m, seen: true } : action === "unstar" ? { ...m, starred: false } : i === old.messages.length - 1 ? { ...m, starred: true } : m)) }
          : old));
      }
    }
    return () => {
      for (const [key, data] of before) qc.setQueryData(key, data);
    };
  }, [qc]);

  const act = useCallback(async (row: Open, action: ThreadAction) => {
    const takeBack = SHOWN_AT_ONCE.has(action) ? showNow([row], action) : null;
    try {
      await mailApi.act(row.account_id, row.key, action);
      refresh();
    } catch (e) {
      takeBack?.();
      toast.error(apiErrorMessage(e, "Couldn't do that."));
    }
  }, [refresh, showNow]);

  const leave = useCallback((id: string) => {
    setLeaving((v) => new Set(v).add(id));
    leavingTimers.current.set(id, window.setTimeout(() => {
      leavingTimers.current.delete(id);
      hidden.current.add(id);
      setHiddenTick((n) => n + 1);
    }, LEAVE_MS));
  }, []);

  const stay = useCallback((id: string) => {
    // The server can answer before the row has finished closing.
    const timer = leavingTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    leavingTimers.current.delete(id);
    hidden.current.delete(id);
    setHiddenTick((n) => n + 1);
    setLeaving((v) => {
      const next = new Set(v);
      next.delete(id);
      return next;
    });
  }, []);

  /** Off the list at once. It only really happens once the undo has passed. */
  const moveAway = useCallback((what: Open | Open[], action: "archive" | "trash", label: string) => {
    const many = Array.isArray(what) ? what : [what];
    const ids = many.map(idOf);
    const id = ids.join(",");
    ids.forEach(leave);
    setPicked(NONE);
    setOpen((o) => (o && many.some((r) => r.key === o.key) ? null : o));
    let shown = "";
    const send = (closing = false) => {
      window.clearTimeout(timer);
      waiting.current.delete(id);
      toast.dismiss(shown);
      if (closing) {
        mailApi.actManyAsPageCloses(many, action);
        return;
      }
      void (async () => {
        try {
          await mailApi.actMany(many, action);
          // Kept off the list until the new list is here, or it flashes back.
          await qc.invalidateQueries({ queryKey: ["mail-threads"] });
          void qc.invalidateQueries({ queryKey: ["mail-overview"] });
          void qc.invalidateQueries({ queryKey: ["mail-conversation"] });
        } catch (e) {
          toast.error(apiErrorMessage(e, "Couldn't do that."));
        } finally {
          ids.forEach(stay);
        }
      })();
    };
    const timer = window.setTimeout(() => send(), UNDO_MS);
    waiting.current.set(id, send);
    shown = toast.success(label, {
      action: {
        label: "Undo",
        onClick: () => {
          window.clearTimeout(timer);
          waiting.current.delete(id);
          ids.forEach(stay);
        },
      },
    });
  }, [qc, leave, stay]);

  const sendAway = useCallback((chosen: Open[], action: "archive" | "trash") => {
    const n = chosen.length;
    moveAway(chosen, action, action === "archive" ? (n > 1 ? `Archived ${conversations(n)}` : "Archived") : (n > 1 ? `Moved ${conversations(n)} to Trash` : "Moved to Trash"));
  }, [moveAway]);

  // Going to look for it means you've finished with Undo, and it has to be there.
  useEffect(() => {
    for (const send of [...waiting.current.values()]) send();
  }, [view.role, view.label, view.account]);

  // Closing the app or leaving it on a phone mustn't lose what you just did.
  useEffect(() => {
    const closing = () => {
      for (const send of [...waiting.current.values()]) send(true);
    };
    const hiddenNow = () => {
      if (document.visibilityState === "hidden") closing();
    };
    window.addEventListener("pagehide", closing);
    document.addEventListener("visibilitychange", hiddenNow);
    return () => {
      window.removeEventListener("pagehide", closing);
      document.removeEventListener("visibilitychange", hiddenNow);
    };
  }, []);

  /** Into a label, or back to the Inbox, straight away: undo puts it back where it was. */
  const moveNow = useCallback(async (many: (Open & { labels: string[] })[], labelId: string | null, words: string, cameFrom: "inbox" | "archive" | "trash", fromLabel?: string) => {
    const ids = many.map(idOf);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    if (undoToast.current) toast.dismiss(undoToast.current);
    undoToast.current = null;
    ids.forEach(leave);
    setPicked(NONE);
    setOpen((o) => (o && many.some((r) => r.key === o.key) ? null : o));
    const put = async (which: Open[], label: string | null, action: ThreadAction) => {
      if (label) await mailApi.labelMany(which, label);
      else await mailApi.actMany(which, action);
    };
    const settled = async () => {
      await qc.invalidateQueries({ queryKey: ["mail-threads"] });
      void qc.invalidateQueries({ queryKey: ["mail-overview"] });
    };
    try {
      await put(many, labelId, "inbox");
      await settled();
    } catch (e) {
      ids.forEach(stay);
      toast.error(apiErrorMessage(e, "Couldn't move that."));
      return;
    }
    ids.forEach(stay);
    const shown = toast.success(words, {
      action: {
        label: "Undo",
        onClick: () => {
          if (undoToast.current === shown) {
            if (undoTimer.current) window.clearTimeout(undoTimer.current);
            undoToast.current = null;
          }
          // Each back where it was, which isn't always the same place.
          const places = new Map<string | null, Open[]>();
          for (const row of many) {
            const place = row.labels[0] ?? fromLabel ?? null;
            places.set(place, [...(places.get(place) ?? []), row]);
          }
          void (async () => {
            for (const [place, which] of places) await put(which, place, cameFrom);
            await settled();
          })().catch((e) => toast.error(apiErrorMessage(e, "Couldn't put that back.")));
        },
      },
    });
    undoToast.current = shown;
    undoTimer.current = window.setTimeout(() => {
      toast.dismiss(shown);
      if (undoToast.current === shown) undoToast.current = null;
    }, UNDO_MS);
  }, [leave, stay, qc]);

  const sent = useCallback((id: string, seconds: number, snapshot: Draft) => {
    closeDraft(draftId(snapshot));
    refresh();
    let shown = "";
    const timer = window.setTimeout(() => { toast.dismiss(shown); refresh(); }, seconds * 1000);
    shown = toast.info("Sending…", {
      // Undo is there for exactly as long as the email is held back.
      duration: seconds * 1000 + 1000,
      action: {
        label: "Undo",
        onClick: () => {
          window.clearTimeout(timer);
          void mailApi.undoSend(id).then(() => { write(snapshot); refresh(); }).catch((e) => toast.error(apiErrorMessage(e, "Too late: that's already gone.")));
        },
      },
    });
  }, [refresh, write, closeDraft]);

  const snooze = useCallback(async (many: Open[], when: Date) => {
    setSnoozing(null);
    setPicked(NONE);
    setOpen((o) => (o && many.some((r) => r.key === o.key) ? null : o));
    try {
      for (const at of many) await mailApi.snooze(at.account_id, at.key, when);
      toast.success(`Snoozed until ${when.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`);
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't snooze that."));
      refresh();
    }
  }, [refresh]);

  const cameFrom: "inbox" | "archive" | "trash" = view.role === "archive" || view.role === "trash" ? view.role : "inbox";
  const moveToLabel = useCallback((many: (Open & { labels: string[] })[], labelId: string, known?: string) => {
    const name = known ?? labels.find((l) => l.id === labelId)?.name ?? "label";
    void moveNow(many, labelId, many.length > 1 ? `Moved ${conversations(many.length)} to ${name}` : `Moved to ${name}`, cameFrom, view.label);
  }, [moveNow, labels, cameFrom, view.label]);

  const toInbox = useCallback((many: (Open & { labels: string[] })[], fromLabel?: string) => {
    void moveNow(many, null, many.length > 1 ? `Moved ${conversations(many.length)} to Inbox` : "Moved to Inbox", cameFrom, fromLabel);
  }, [moveNow, cameFrom]);

  // Dragging one of those you've picked brings the rest with it.
  const dropped = useCallback((row: ThreadRow, target: string) => {
    const chosen = picked.has(idOf(row)) ? pickedRows : [row];
    const [kind, value] = target.split(":");
    if (kind === "label") moveToLabel(chosen, value);
    else if (kind === "new") setNaming(chosen);
    else if (value === "inbox") toInbox(chosen, view.label);
    else if (value === "archive") sendAway(chosen, "archive");
    else if (value === "trash") sendAway(chosen, "trash");
    else if (value === "snoozed") setSnoozing(chosen);
  }, [picked, pickedRows, moveToLabel, toInbox, sendAway, view.label]);
  const { dragging, hover, startDrag, card } = useThreadDrag(dropped, (row) => (picked.has(idOf(row)) && pickedRows.length > 1 ? conversations(pickedRows.length) : personName(row.from)));

  const newMessage = useCallback((): Draft => ({ account_id: view.account ?? accounts[0]?.id ?? "", to: "", subject: "" }), [view.account, accounts]);

  // The keys people already know.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // What you're writing has its own keys. Everywhere else, the list's still work.
      if (target.closest("input, textarea, select, [contenteditable], [data-mail-composer]")) return;
      // These keys are for the list. A menu or sheet on top has its own, and Delete
      // there must never reach the emails underneath.
      if (document.querySelector('[role="menu"], [role="dialog"]')) return;
      // Reading an email, Ctrl+A is for its words.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && (!open || picked.size > 0) && rows.length > 0) {
        e.preventDefault();
        if (rows.length > MAX_PICKED) toast.info(`That's the first ${MAX_PICKED}: the most at one time.`);
        setPicked(new Set(rows.slice(0, MAX_PICKED).map(idOf)));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setHelp(true);
        return;
      }
      // Esc puts away what you're writing first. It's kept, along the bottom.
      if (e.key === "Escape" && activeDraft) {
        setActiveDraft(null);
        return;
      }
      const canTrash = view.role !== "trash" || !!view.label;
      if (pickedRows.length > 0) {
        if (e.key === "Escape") setPicked(NONE);
        else if (e.key === "e") sendAway(pickedRows, "archive");
        else if ((e.key === "#" || e.key === "Delete") && canTrash) sendAway(pickedRows, "trash");
        if (["Escape", "e", "#", "Delete"].includes(e.key)) return;
      }
      if (open && e.key === "Delete" && canTrash) {
        moveAway(open, "trash", "Moved to Trash");
        return;
      }
      const index = open ? rows.findIndex((r) => r.key === open.key) : -1;
      if (e.key === "j" || e.key === "k") {
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + (e.key === "j" ? 1 : -1)))];
        if (next) {
          setOpen({ account_id: next.account_id, key: next.key });
          document.querySelector(`[data-mail-row="${CSS.escape(idOf(next))}"]`)?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "c" && accounts[0]) {
        e.preventDefault();
        write(newMessage());
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("mail-search")?.focus();
      } else if (e.key === "Escape") {
        setOpen(null);
      } else if (open && e.key === "e") {
        moveAway(open, "archive", "Archived");
      } else if (open && e.key === "#") {
        moveAway(open, "trash", "Moved to Trash");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, accounts, newMessage, write, activeDraft, moveAway, sendAway, picked, pickedRows, view.role, view.label]);

  if (isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" /></div>;

  if (accounts.length === 0) {
    return (
      <div className="relative flex h-full flex-col items-center justify-center gap-3 bg-[var(--bg,transparent)] px-6 text-center">
        {isMobile && showsPromptlyNav("mail") && <PromptlyMenuButton className="absolute left-2 top-2" />}
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent)]/15"><Mail className="h-7 w-7 text-[var(--accent-text)]" /></span>
        <h1 className="text-xl font-semibold text-[var(--text)]">All your email, in one calm place</h1>
        <p className="max-w-sm text-sm text-[var(--text-muted)]">Connect any mailbox: Gmail, Proton, Fastmail, your work address. Your mail stays where it is, and you can add as many as you like.</p>
        <button type="button" onClick={() => setAdding(true)} className="mt-2 inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90"><Plus className="h-4 w-4" />Add a mailbox</button>
        {adding && <AccountSheet onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} />}
      </div>
    );
  }

  const showRole = (role: string) => { setView((v) => ({ ...v, role, label: undefined, needsReply: false })); setOpen(null); setTyped(""); setLabelsOpen(false); };
  const showLabel = (label: string) => { setView((v) => ({ ...v, label, needsReply: false })); setOpen(null); setTyped(""); setLabelsOpen(false); };
  const picker = (
    <AccountPicker
      accounts={accounts}
      folders={overview?.folders ?? []}
      current={view.account}
      onPick={(id) => { setView((v) => ({ ...v, account: id })); setOpen(null); }}
      onAdd={() => setAdding(true)}
      onManage={() => setManaging(true)}
      onSettings={() => setSettingsOpen(true)}
    />
  );
  const shownLabel = labels.find((l) => l.id === view.label);
  const icon = "h-4 w-4";
  const markAllRead = async (place: { role?: string; labels?: string[] }) => {
    try {
      const marked = await mailApi.markAllRead({ ...place, account: view.account });
      if (marked > 0) toast.success(`Marked ${conversations(marked)} as read.`);
      else toast.info("Nothing unread there.");
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't mark those as read."));
    }
  };
  const markAllItem = (place: { role?: string; labels?: string[] }): ContextMenuItem => ({ label: "Mark all as read", icon: <CheckCheck className={icon} />, onClick: () => void markAllRead(place) });
  // What's on screen is a whole place, unless it's search results or just what needs a reply.
  const markAllHere: ContextMenuItem[] = search || view.needsReply ? [] : [markAllItem(view.label ? { labels: [view.label] } : { role: view.role })];
  const openPlaceMenu = (e: ReactMouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    setPlaceMenu({ x: e.clientX, y: e.clientY, items });
  };

  /** Pick out conversations with Ctrl or Shift, as in a file list. A plain click just opens one. */
  const clickRow = (e: ReactMouseEvent, row: ThreadRow) => {
    const id = idOf(row);
    const adding = e.ctrlKey || e.metaKey;
    let next: Set<string>;
    if (e.shiftKey) {
      const to = rows.findIndex((r) => idOf(r) === id);
      const start = anchor.current ?? (open ? idOf(open) : id);
      const found = rows.findIndex((r) => idOf(r) === start);
      const from = found < 0 ? to : found;
      const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1).map(idOf);
      next = new Set(adding ? [...picked, ...range] : range);
    } else if (adding || (isMobile && (picked.size > 0 || selectMode))) {
      next = new Set(picked);
      // The one you're reading is where it started.
      if (next.size === 0 && open && idOf(open) !== id) next.add(idOf(open));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
    } else {
      setPicked(NONE);
      anchor.current = id;
      setOpen({ account_id: row.account_id, key: row.key });
      return;
    }
    if (next.size > MAX_PICKED) toast.info(`That's the first ${MAX_PICKED}: the most at one time.`);
    setPicked(new Set([...next].slice(0, MAX_PICKED)));
    setOpen(null);
  };

  const pickedItems = (): ContextMenuItem[] => {
    const chosen = pickedRows;
    const backToInbox = !view.label && (view.role === "archive" || view.role === "trash");
    const flag = (action: ThreadAction) => () => {
      const takeBack = showNow(chosen, action);
      void mailApi.actMany(chosen, action).then(refresh).catch((e) => { takeBack(); toast.error(apiErrorMessage(e, "Couldn't do that.")); });
    };
    const firstLabels = chosen[0]?.labels ?? [];
    return [
      ...(chosen.some((r) => r.unread > 0) ? [{ label: "Mark as read", icon: <MailOpen className={icon} />, onClick: flag("read") }] : []),
      ...(chosen.some((r) => r.unread === 0) ? [{ label: "Mark as unread", icon: <Mail className={icon} />, onClick: flag("unread") }] : []),
      ...(chosen.some((r) => !r.starred) ? [{ label: "Star", icon: <Star className={icon} />, onClick: flag("star") }] : []),
      ...(chosen.some((r) => r.starred) ? [{ label: "Remove star", icon: <Star className={`${icon} fill-current`} />, onClick: flag("unstar") }] : []),
      ...(view.role === "snoozed" && !view.label ? [] : [{ label: "Snooze…", icon: <AlarmClock className={icon} />, onClick: () => setSnoozing(chosen) }]),
      // Ticked in the list only if they're all there already.
      { label: "Move to label…", icon: <Tag className={icon} />, onClick: () => setLabelling(chosen.map((r) => ({ account_id: r.account_id, key: r.key, from: r.from, subject: r.subject, labels: chosen.every((c) => c.labels[0] === firstLabels[0]) ? firstLabels : [] }))) },
      backToInbox
        ? { label: "Move to Inbox", icon: <Inbox className={icon} />, onClick: () => toInbox(chosen) }
        : { label: "Archive", icon: <Archive className={icon} />, onClick: () => sendAway(chosen, "archive") },
      ...(view.role === "trash" && !view.label ? [] : [{ label: "Move to Trash", icon: <Trash2 className={icon} />, destructive: true, onClick: () => sendAway(chosen, "trash") }]),
    ];
  };

  const menuItems = (row: ThreadRow): ContextMenuItem[] => {
    const at = { account_id: row.account_id, key: row.key };
    const target: LabelTarget = { ...at, from: row.from, subject: row.subject, labels: row.labels };
    const backToInbox = !view.label && (view.role === "archive" || view.role === "trash");
    return [
      row.unread > 0
        ? { label: "Mark as read", icon: <MailOpen className={icon} />, onClick: () => void act(at, "read") }
        : { label: "Mark as unread", icon: <Mail className={icon} />, onClick: () => void act(at, "unread") },
      ...markAllHere,
      // A phone has no Ctrl or Shift. Once one's picked, tapping picks more.
      ...(isMobile ? [{ label: "Select", icon: <CheckSquare className={icon} />, onClick: () => { setSelectMode(true); setPicked(new Set([idOf(row)])); anchor.current = idOf(row); } }] : []),
      row.starred
        ? { label: "Remove star", icon: <Star className={icon} />, onClick: () => void act(at, "unstar") }
        : { label: "Star", icon: <Star className={icon} />, onClick: () => void act(at, "star") },
      ...(row.needs_reply ? [{ label: "No reply needed", icon: <Check className={icon} />, onClick: () => void act(at, "no_reply") }] : []),
      view.role === "snoozed" && !view.label
        ? { label: "Back to Inbox now", icon: <Inbox className={icon} />, onClick: () => void mailApi.unsnooze(at.account_id, at.key).then(refresh) }
        : { label: "Snooze…", icon: <AlarmClock className={icon} />, onClick: () => setSnoozing([at]) },
      { label: "Add to calendar…", icon: <CalendarPlus className={icon} />, onClick: () => setEventFor({ ...at, subject: row.subject }) },
      { label: "Turn into a task", icon: <CheckSquare className={icon} />, onClick: () => void mailApi.addTask(at.account_id, at.key).then(() => toast.success("Added to Tasks.")).catch((e) => toast.error(apiErrorMessage(e, "Couldn't add that task."))) },
      ...(people[row.from.addr.toLowerCase()] ? [] : [{ label: "Add to Contacts", icon: <UserPlus className={icon} />, onClick: () => void mailApi.addContact(row.from.name, row.from.addr).then(() => { toast.success("Added to Contacts."); void qc.invalidateQueries({ queryKey: ["mail-known-people"] }); }).catch((e) => toast.error(apiErrorMessage(e, "Couldn't add that contact."))) }]),
      { label: "Move to label…", icon: <Tag className={icon} />, onClick: () => setLabelling([target]) },
      { label: "Make a rule from this…", icon: <ListFilter className={icon} />, onClick: () => setRuleFor(target) },
      backToInbox
        ? { label: "Move to Inbox", icon: <Inbox className={icon} />, onClick: () => void act(at, "inbox") }
        : { label: "Archive", icon: <Archive className={icon} />, onClick: () => moveAway(at, "archive", "Archived") },
      ...(view.role === "trash" && !view.label ? [] : [{ label: "Move to Trash", icon: <Trash2 className={icon} />, destructive: true, onClick: () => moveAway(at, "trash", "Moved to Trash") }]),
    ];
  };

  /** On a row as you point at it, on a computer. A phone has swipes and press and hold. */
  const quickActions = (row: ThreadRow): QuickAction[] => {
    const at = { account_id: row.account_id, key: row.key };
    const backToInbox = !view.label && (view.role === "archive" || view.role === "trash");
    return [
      backToInbox
        ? { label: "Move to Inbox", icon: Inbox, onClick: () => void act(at, "inbox") }
        : { label: "Archive", icon: Archive, onClick: () => moveAway(at, "archive", "Archived") },
      ...(view.role === "trash" && !view.label ? [] : [{ label: "Move to Trash", icon: Trash2, onClick: () => moveAway(at, "trash", "Moved to Trash") }]),
      row.unread > 0
        ? { label: "Mark as read", icon: MailOpen, onClick: () => void act(at, "read") }
        : { label: "Mark as unread", icon: Mail, onClick: () => void act(at, "unread") },
      view.role === "snoozed" && !view.label
        ? { label: "Back to Inbox now", icon: Inbox, onClick: () => void mailApi.unsnooze(at.account_id, at.key).then(refresh) }
        : { label: "Snooze", icon: AlarmClock, onClick: () => setSnoozing([at]) },
    ];
  };

  const unreadInbox = (overview?.folders ?? []).filter((f) => f.role === "inbox" && (!view.account || f.account_id === view.account)).reduce((n, f) => n + f.unread, 0);
  const problem = accounts.find((a) => a.status === "error");

  // Somewhere an email can land: not where it already is.
  const dropTarget = (id: string, name: string, colour?: string) => {
    const here = view.label ? id === `label:${view.label}` : id === `role:${view.role}`;
    return dragging && !here ? { "data-mail-drop": id, "data-mail-drop-name": name, "data-mail-drop-colour": colour } : {};
  };
  const dropStyle = (id: string, colour = "#D97757"): CSSProperties | undefined => {
    if (hover === id) return { backgroundColor: `${colour}33`, boxShadow: `inset 0 0 0 1.5px ${colour}`, transform: "scale(1.02)" };
    return undefined;
  };
  const CAN_LAND = new Set(["inbox", "snoozed", "archive", "trash"]);
  const chip = (on: boolean) => `inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs md:h-7 ${on ? "border-transparent bg-[var(--accent)]/15 font-medium text-[var(--text)]" : "border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--hover)]"}`;

  const rail = (
    <nav aria-label="Mail folders" className="flex w-60 shrink-0 flex-col border-r border-[var(--border)] p-3">
      <div className="mb-2 shrink-0">{picker}</div>
      <div data-mail-rail-scroll className="promptly-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-0.5">
      <button type="button" onClick={() => write(newMessage())} className="mb-3 inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--accent-strong)] text-sm font-medium text-white hover:opacity-90"><Pen className="h-4 w-4" />Compose</button>
      {ROLES.map(({ role, label, icon: Icon }) => (
        <button key={role} type="button" onClick={() => showRole(role)} onContextMenu={(e) => openPlaceMenu(e, [markAllItem({ role })])} aria-current={!view.label && view.role === role ? "page" : undefined} {...(CAN_LAND.has(role) ? dropTarget(`role:${role}`, role === "snoozed" ? "Snooze" : `Move to ${label}`) : {})} style={dropStyle(`role:${role}`)} className={`flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-[background-color,box-shadow,transform,opacity] duration-150 ease-out ${dragging && !CAN_LAND.has(role) ? "opacity-40 " : ""}${!view.label && view.role === role ? "bg-[var(--accent)]/15 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}>
          <Icon className="h-4 w-4" /><span className="flex-1 text-left">{label}</span>
          {role === "inbox" && unreadInbox > 0 && <span className="text-xs font-medium text-[var(--accent-text)]">{unreadInbox}</span>}
        </button>
      ))}
      <div className="mb-1 mt-5 flex shrink-0 items-center justify-between pl-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Labels</p>
        <button type="button" onClick={() => setLabelsOpen(true)} aria-label="Manage labels and rules" title="Manage labels and rules" className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--hover)]"><Settings className="h-3.5 w-3.5" /></button>
      </div>
      {/* Dragging an email opens everything, so any label can take it. */}
      {unfolded(labelRows(labels), dragging ? new Set() : folded).map((r) => {
        const l = r.label;
        const key = r.path.toLowerCase();
        const isFolded = folded.has(key) && !dragging;
        const count = isFolded ? r.unreadInside : (l?.unread ?? 0);
        const padding = { paddingLeft: `${0.625 + r.depth * 0.875}rem` };
        return (
          <div key={r.path} className="relative shrink-0">
            {l ? (
              <button type="button" onClick={() => showLabel(l.id)} onContextMenu={(e) => openPlaceMenu(e, [markAllItem({ labels: [l.id, ...(isFolded ? labelsInside(labels, r.path).map((x) => x.id) : [])] }), { label: "Manage labels and rules…", icon: <Settings className={icon} />, onClick: () => setLabelsOpen(true) }])} aria-current={view.label === l.id ? "page" : undefined} aria-label={l.name} title={l.name} {...dropTarget(`label:${l.id}`, `Move to ${l.name}`, l.color)} style={{ ...padding, ...dropStyle(`label:${l.id}`, l.color) }} className={`flex h-8 w-full items-center gap-2.5 rounded-lg text-sm transition-[background-color,box-shadow,transform] duration-150 ease-out ${r.hasChildren ? "pr-8" : "pr-2.5"} ${view.label === l.id ? "bg-[var(--accent)]/15 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}>
                <span style={{ backgroundColor: l.color }} className="h-2 w-2 shrink-0 rounded-full" /><span className="min-w-0 flex-1 truncate text-left">{r.name}</span>
                {count > 0 && <span className="text-xs font-medium text-[var(--accent-text)]">{count}</span>}
              </button>
            ) : (
              // Only a heading: there's a label inside it, but none called this.
              <div onContextMenu={(e) => openPlaceMenu(e, [markAllItem({ labels: labelsInside(labels, r.path).map((x) => x.id) })])} style={padding} title={r.path} className="flex h-8 w-full items-center gap-2.5 pr-8 text-sm text-[var(--text-muted)]">
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                {count > 0 && <span className="text-xs font-medium text-[var(--accent-text)]">{count}</span>}
              </div>
            )}
            {r.hasChildren && (
              <button
                type="button"
                aria-expanded={!isFolded}
                aria-label={`${isFolded ? "Show" : "Hide"} labels inside ${r.path}`}
                onClick={() => {
                  const next = new Set(folded);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  setFolded(next);
                  saveFolded(next);
                }}
                className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--hover)]"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${isFolded ? "-rotate-90" : ""}`} />
              </button>
            )}
          </div>
        );
      })}
      {labels.length === 0 && !dragging && <p className="px-2.5 py-1 text-xs text-[var(--text-muted)]">Drag an email here to start a label, or right-click one to make a rule.</p>}
      <div className={`grid shrink-0 transition-[grid-template-rows,opacity] duration-150 ease-out ${dragging ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
        <div className="min-h-0 overflow-hidden">
          <div {...(dragging ? { "data-mail-drop": "new:", "data-mail-drop-name": "Move to a new label" } : {})} style={dropStyle("new:")} className="mt-1 flex h-8 items-center gap-2.5 rounded-lg border border-dashed border-[var(--border)] px-2.5 text-sm text-[var(--text-muted)] transition-[background-color,box-shadow,transform] duration-150 ease-out"><Plus className="h-3.5 w-3.5" />New label</div>
        </div>
      </div>
      </div>
    </nav>
  );

  const listPane = (
    <section aria-label="Conversations" className={`flex min-h-0 flex-col ${isMobile ? "w-full flex-1" : "w-96 shrink-0 border-r border-[var(--border)]"}`}>
      {isMobile && <div className="px-2 pt-2">{picker}</div>}
      <div className="flex items-center gap-2 p-3">
        {/* Inside Promptly on a phone: its menu (AppLayout's drawer). Not in the installed Mail app. */}
        {isMobile && showsPromptlyNav("mail") && <PromptlyMenuButton className="-ml-1" />}
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-[var(--hover)] px-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input id="mail-search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search your mail" aria-label="Search your mail" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
          {typed && <button type="button" onClick={() => setTyped("")} aria-label="Clear search" className="-mr-2 flex h-10 w-9 shrink-0 items-center justify-center"><X className="h-4 w-4 text-[var(--text-muted)]" /></button>}
        </div>
        {/* A phone has no Ctrl or Shift, so picking several gets a button of its own. */}
        {isMobile && rows.length > 0 && (
          <button type="button" onClick={() => { if (selectMode) setPicked(NONE); setSelectMode((v) => !v); }} aria-pressed={selectMode} aria-label="Select conversations" title="Select" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${selectMode ? "bg-[var(--accent)]/15 text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}><CheckSquare className="h-5 w-5" /></button>
        )}
      </div>
      {search && (
        <div role="group" aria-label="Narrow down the search" className="promptly-scroll flex shrink-0 items-center gap-1.5 overflow-x-auto px-3 pb-2">
          <button type="button" aria-pressed={filters.unread} onClick={() => setFilters((f) => ({ ...f, unread: !f.unread }))} className={chip(filters.unread)}>Unread</button>
          <button type="button" aria-pressed={filters.files} onClick={() => setFilters((f) => ({ ...f, files: !f.files }))} className={chip(filters.files)}><Paperclip className="h-3 w-3" />Has attachment</button>
          <select aria-label="From" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} className={`${chip(!!filters.from)} max-w-[11rem] cursor-pointer appearance-none truncate outline-none`}>
            <option value="">From anyone</option>
            {senders.map(([addr, name]) => <option key={addr} value={addr}>{name}</option>)}
          </select>
          <select aria-label="Date" value={filters.since} onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value as Filters["since"] }))} className={`${chip(!!filters.since)} cursor-pointer appearance-none outline-none`}>
            <option value="">Any time</option>
            <option value="week">Past week</option>
            <option value="month">Past month</option>
            <option value="year">Past year</option>
          </select>
          {filtering && <button type="button" onClick={() => setFilters(NO_FILTERS)} className="h-10 shrink-0 px-1.5 text-xs font-medium text-[var(--accent-text)] md:h-7">Clear</button>}
        </div>
      )}
      {(pickedRows.length > 0 || (isMobile && selectMode)) && (
        <div role="toolbar" aria-label="Selected conversations" className="promptly-scroll flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--border)] px-3 pb-2">
          <button type="button" onClick={() => { setPicked(NONE); setSelectMode(false); }} aria-label="Clear selection" title="Clear selection (Esc)" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-8 md:w-8"><X className="h-4 w-4" /></button>
          {pickedRows.length > 0
            ? <span className="min-w-[5.5rem] flex-1 truncate pl-1 text-sm font-medium text-[var(--text)]">{pickedRows.length} selected</span>
            : <span className="min-w-0 flex-1 truncate pl-1 text-sm text-[var(--text-muted)]">Tap the ones you want</span>}
          {pickedRows.length > 0 && pickedItems().map((item) => (
            <button key={item.label} type="button" onClick={item.onClick} aria-label={item.label} title={item.label} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] md:h-8 md:w-8">{item.icon}</button>
          ))}
        </div>
      )}
      {problem && <p className="mx-3 mb-2 rounded-lg bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--text)]"><strong>{problem.email}:</strong> {problem.status_detail}</p>}
      {(overview?.failed ?? []).map((f) => (
        <div key={f.id} role="alert" className="mx-3 mb-2 rounded-lg bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--text)]">
          <p><strong>{f.subject || "(No subject)"}:</strong> {f.error}</p>
          <div className="mt-1 flex gap-3 font-medium">
            <button type="button" onClick={() => void mailApi.retrySend(f.id).then(refresh)} className="text-[var(--accent-text)]">Try again</button>
            <button type="button" onClick={() => void mailApi.dismissSend(f.id).then(refresh)} className="text-[var(--text-muted)]">Dismiss</button>
          </div>
        </div>
      ))}
      {overview?.sorting && !view.label && view.role === "inbox" && !search && (
        <div className="flex gap-1.5 px-3 pb-2">
          <button type="button" aria-pressed={!view.needsReply} onClick={() => setView((v) => ({ ...v, needsReply: false }))} className={`h-10 rounded-full px-3 text-xs md:h-7 ${!view.needsReply ? "bg-[var(--accent)]/15 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}>Everything</button>
          <button type="button" aria-pressed={!!view.needsReply} onClick={() => setView((v) => ({ ...v, needsReply: true }))} className={`inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-xs md:h-7 ${view.needsReply ? "bg-[var(--accent)]/15 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}>
            <Sparkles className="h-3 w-3 text-[var(--accent-text)]" />Needs a reply{(overview.needs_reply ?? 0) > 0 && <span className="font-medium text-[var(--accent-text)]">{overview.needs_reply}</span>}
          </button>
        </div>
      )}
      {shownLabel && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 pb-2 text-sm font-medium text-[var(--text)]">
          <span style={{ backgroundColor: shownLabel.color }} className="h-2.5 w-2.5 shrink-0 rounded-full" /><span className="min-w-0 flex-1 truncate">{shownLabel.name}</span>
          <button type="button" onClick={() => showRole("inbox")} aria-label="Back to Inbox" className="-my-2 flex h-10 w-10 shrink-0 items-center justify-center text-[var(--text-muted)] md:my-0 md:h-6 md:w-6"><X className="h-4 w-4" /></button>
        </div>
      )}
      <div onContextMenu={(e) => { if (!e.defaultPrevented && markAllHere.length) openPlaceMenu(e, markAllHere); }} ref={scroller} aria-busy={list.isLoading || undefined} className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
        {list.isLoading && (
          <div>
            <p className="sr-only" role="status">Getting your mail…</p>
            {[72, 55, 64, 48, 70, 58, 66, 52].map((w, i) => (
              <div key={i} aria-hidden className="flex gap-3 border-b border-[var(--border)] px-3 py-3">
                <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2 py-0.5">
                  <div className="flex items-center justify-between gap-3"><Skeleton className="h-3.5 w-28" /><Skeleton className="h-3 w-8" /></div>
                  <Skeleton className="h-3.5 w-3/5" />
                  <div style={{ width: `${w}%` }}><Skeleton className="h-3 w-full" /></div>
                </div>
              </div>
            ))}
          </div>
        )}
        {!list.isLoading && rows.length === 0 && (
          <p className="p-8 text-center text-sm text-[var(--text-muted)]">
            {filtering ? (list.hasNextPage ? "Nothing matches those filters yet. Looking through older mail…" : "Nothing matches those filters.") : search ? "Nothing found." : view.needsReply ? "Nothing's waiting on you." : view.role === "snoozed" ? "Nothing snoozed. Snooze an email to bring it back when you can deal with it." : shownLabel?.fetching ? "Fetching this label's mail from your mailbox. It'll appear here as it arrives." : view.label ? `Nothing here yet. ${isMobile ? "Press and hold an email and choose Move to label" : "Drag an email onto this label"}, or make a rule.` : accounts.some((a) => !a.last_sync_at) ? "Fetching your mail for the first time. This can take a few minutes." : "Nothing here. Enjoy the quiet."}
          </p>
        )}
        {rows.map((row, i) => (
          <div key={`${row.account_id}/${row.key}`} data-mail-row={idOf(row)}>
          {row.related && !rows[i - 1]?.related && <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Related</p>}
          <div style={{ gridTemplateRows: leaving.has(`${row.account_id}/${row.key}`) ? "0fr" : "1fr", transitionDuration: `${LEAVE_MS}ms` }} className={`grid transition-[grid-template-rows,opacity] ease-out ${leaving.has(`${row.account_id}/${row.key}`) ? "opacity-0" : "opacity-100"}`}>
          <div className={`min-h-0 overflow-hidden transition-opacity duration-150 ${dragging && (idOf(dragging) === idOf(row) || (picked.has(idOf(dragging)) && picked.has(idOf(row)))) ? "opacity-40" : ""}`}>
          <ThreadItem key={`${row.account_id}/${row.key}`} quick={isMobile || row.related || pickedRows.length > 0 ? undefined : quickActions(row)} onDragStart={isMobile ? undefined : startDrag} row={row} selected={open?.key === row.key || picked.has(idOf(row))} picked={picked.has(idOf(row))} colour={accounts.length > 1 ? accounts.find((a) => a.id === row.account_id)?.color : undefined} people={people} labels={row.labels.filter((id) => id !== view.label).flatMap((id) => labels.filter((l) => l.id === id))} onOpen={(e) => clickRow(e, row)} onMenu={(x, y) => { if (!picked.has(idOf(row))) setPicked(NONE); setMenu({ row, x, y }); }} onSwipe={isMobile && pickedRows.length === 0 ? (a) => (a === "archive" ? moveAway(row, "archive", "Archived") : moveAway(row, "trash", "Moved to Trash")) : undefined} />
          </div>
          </div>
          </div>
        ))}
        {list.hasNextPage && (
          <div ref={older}>
            <button type="button" onClick={() => void list.fetchNextPage()} className="flex min-h-10 w-full items-center justify-center gap-2 p-3 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]">{list.isFetchingNextPage ? <><Loader2 className="h-4 w-4 animate-spin" />Getting older mail…</> : "Show older"}</button>
          </div>
        )}
      </div>
      {isMobile && (
        <button type="button" onClick={() => write(newMessage())} aria-label="Compose" className="absolute bottom-[7.5rem] right-4 z-10 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-strong)] text-white shadow-lg"><Pen className="h-5 w-5" /></button>
      )}
    </section>
  );

  const reading = open ? (
    <ConversationPane
      key={open.key}
      open={open}
      showBack={isMobile}
      labels={labels}
      mine={accounts.map((a) => a.email.toLowerCase())}
      prefill={prefill}
      onPrefilled={() => setPrefill(null)}
      onAddEvent={(subject) => setEventFor({ ...open, subject })}
      onLabel={(t) => setLabelling([t])}
      onSnooze={() => setSnoozing([open])}
      onUnsnooze={() => void mailApi.unsnooze(open.account_id, open.key).then(refresh)}
      onBack={() => setOpen(null)}
      onAct={(action) => void act(open, action)}
      onMove={(action, label) => moveAway(open, action, label)}
      onWrite={write}
      markRead={() => { void qc.invalidateQueries({ queryKey: ["mail-overview"] }); void qc.invalidateQueries({ queryKey: ["mail-threads"] }); }}
    />
  ) : (
    !isMobile && (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
        {pickedRows.length > 0
          ? <><CheckSquare className="h-8 w-8 opacity-40" /><p className="text-sm">{conversations(pickedRows.length)} selected</p></>
          : <><Mail className="h-8 w-8 opacity-40" /><p className="text-sm">Pick a conversation to read.</p></>}
      </div>
    )
  );

  // What you're writing. On a computer it's docked along the bottom, above the Ask bar,
  // so the mail behind it stays in reach. On a phone the open one covers the screen.
  const minimisedDrafts = drafts.filter((d) => d.id !== activeDraft);
  const dock = drafts.length > 0 && (
    <div className={isMobile ? "contents" : "pointer-events-none absolute bottom-0 right-4 top-[6%] z-30 flex max-w-[calc(100%-2rem)] flex-row-reverse items-end gap-3"}>
      {drafts.map((d) => (
        <Composer
          key={`${d.id}:${d.n}`}
          draft={d.draft}
          accounts={accounts}
          minimised={d.id !== activeDraft}
          slot={minimisedDrafts.indexOf(d)}
          onClose={() => closeDraft(d.id)}
          onMinimise={() => setActiveDraft((a) => (a === d.id ? null : a))}
          onExpand={() => setActiveDraft(d.id)}
          onSent={sent}
        />
      ))}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--bg,transparent)]">
      <div className="relative flex min-h-0 flex-1">
        {!isMobile && rail}
        {(!isMobile || !open) && listPane}
        {reading && <div className="flex min-w-0 flex-1 flex-col">{reading}</div>}
        {!isMobile && dock}
      </div>
      <AskBar open={open} accounts={accounts} viewing={view.account} compactModel={isMobile} />
      {isMobile && !open && (
        <nav aria-label="Mail folders" className="flex border-t border-[var(--border)] pb-[env(safe-area-inset-bottom)]">
          {ROLES.filter((r) => r.role !== "snoozed").map(({ role, label, icon: Icon }) => (
            <button key={role} type="button" onClick={() => showRole(role)} className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${!view.label && view.role === role ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]"}`}><Icon className="h-5 w-5" />{label}</button>
          ))}
          <button type="button" onClick={() => setLabelsOpen(true)} className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${view.label ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]"}`}><Tag className="h-5 w-5" />Labels</button>
        </nav>
      )}
      {isMobile && dock}
      <SharedSheet open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" size="sm">
        <dl className="space-y-1 pb-2">
          {SHORTCUTS.map(([keys, does]) => (
            <div key={keys} className="flex items-center gap-3 py-1 text-sm">
              <dt className="w-24 shrink-0"><kbd className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-xs text-[var(--text)]">{keys}</kbd></dt>
              <dd className="min-w-0 flex-1 text-[var(--text)]">{does}</dd>
            </div>
          ))}
        </dl>
      </SharedSheet>
      {eventFor && <EventSheet accountId={eventFor.account_id} threadKey={eventFor.key} subject={eventFor.subject} onClose={() => setEventFor(null)} />}
      {snoozing && <SnoozeSheet onPick={(when) => void snooze(snoozing, when)} onClose={() => setSnoozing(null)} />}
      {settingsOpen && <MailSettingsSheet onClose={() => setSettingsOpen(false)} />}
      {editing && <EditMailboxSheet account={editing} onClose={() => setEditing(null)} />}
      {managing && (
        <MailboxSheet
          accounts={accounts}
          current={view.account}
          onPick={(id) => { setView((v) => ({ ...v, account: id })); setOpen(null); setManaging(false); }}
          onAdd={() => { setManaging(false); setAdding(true); }}
          onEdit={(a) => { setManaging(false); setEditing(a); }}
          onClose={() => setManaging(false)}
          onRemoved={(id) => { setView((v) => (v.account === id ? { ...v, account: undefined } : v)); setOpen(null); refresh(); }}
        />
      )}
      {adding && <AccountSheet onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} />}
      {menu && <ContextMenu open x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={picked.has(idOf(menu.row)) && pickedRows.length > 1 ? pickedItems() : menuItems(menu.row)} />}
      {placeMenu && <ContextMenu open x={placeMenu.x} y={placeMenu.y} onClose={() => setPlaceMenu(null)} items={placeMenu.items} />}
      {labelsOpen && <LabelsSheet labels={labels} current={view.label} top={isMobile ? <button type="button" onClick={() => showRole("snoozed")} className="mb-1 flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"><AlarmClock className="h-4 w-4 text-[var(--text-muted)]" />Snoozed</button> : undefined} onPick={showLabel} onClose={() => setLabelsOpen(false)} onRemoved={(id) => { if (view.label === id) showRole("inbox"); }} />}
      {labelling && (
        <LabelPicker
          target={labelling[0]}
          labels={labels}
          onMove={(id) => { moveToLabel(labelling, id); setLabelling(null); }}
          onToInbox={() => { toInbox(labelling); setLabelling(null); }}
          onClose={() => setLabelling(null)}
          onMakeRule={labelling.length === 1 ? () => { setRuleFor(labelling[0]); setLabelling(null); } : undefined}
        />
      )}
      {naming && <NewLabelSheet labels={labels} onMade={(id) => { void qc.invalidateQueries({ queryKey: ["mail-overview"] }); moveToLabel(naming, id, "your new label"); setNaming(null); }} onClose={() => setNaming(null)} />}
      {card}
      {ruleFor && <RuleSheet target={ruleFor} labels={labels} onClose={() => setRuleFor(null)} />}
    </div>
  );
}

interface QuickAction {
  label: string;
  icon: typeof Archive;
  onClick: () => void;
}

function ThreadItem({ row, selected, picked, colour, people, labels, onOpen, onMenu, onSwipe, onDragStart, quick }: { quick?: QuickAction[]; onDragStart?: (e: ReactPointerEvent<HTMLElement>, row: ThreadRow) => void; row: ThreadRow; selected: boolean; picked: boolean; colour?: string; people: People; labels: MailLabel[]; onOpen: (e: ReactMouseEvent) => void; onMenu: (x: number, y: number) => void; onSwipe?: (action: "archive" | "trash") => void }) {
  const unread = row.unread > 0;
  // Press and hold on a phone is the right-click of a computer.
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const held = useRef(false);
  // Swipe right to archive, left to delete. Only once you're clearly going sideways.
  const [slide, setSlide] = useState(0);
  const sideways = useRef(false);
  const shell = useRef<HTMLDivElement>(null);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  return (
    <div ref={shell} className="group/row relative overflow-hidden">
    {slide !== 0 && (
      <div aria-hidden className={`absolute inset-0 flex items-center px-5 text-white ${slide > 0 ? "justify-start bg-[var(--accent-strong)]" : "justify-end bg-[var(--danger)]"}`}>
        {slide > 0 ? <Archive className="h-5 w-5" /> : <Trash2 className="h-5 w-5" />}
      </div>
    )}
    <button
      type="button"
      onClick={(e) => { if (held.current) held.current = false; else onOpen(e); }}
      // Shift would otherwise select the text between the two rows.
      onMouseDown={(e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault(); }}
      onPointerDown={onDragStart ? (e) => onDragStart(e, row) : undefined}
      onContextMenu={(e) => { e.preventDefault(); cancelPress(); onMenu(e.clientX, e.clientY); }}
      onTouchStart={(e) => {
        const t = e.touches[0];
        held.current = false;
        const timer = window.setTimeout(() => { press.current = null; held.current = true; navigator.vibrate?.(12); onMenu(t.clientX, t.clientY); }, 500);
        press.current = { timer, x: t.clientX, y: t.clientY };
        origin.current = { x: t.clientX, y: t.clientY };
        sideways.current = false;
      }}
      onTouchMove={(e) => {
        const t = e.touches[0];
        if (press.current && (Math.abs(t.clientX - press.current.x) > 10 || Math.abs(t.clientY - press.current.y) > 10)) cancelPress();
        const dx = t.clientX - origin.current.x;
        const dy = t.clientY - origin.current.y;
        if (onSwipe && !sideways.current && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.5) sideways.current = true;
        if (sideways.current) setSlide(dx);
      }}
      onTouchEnd={() => {
        cancelPress();
        const width = shell.current?.offsetWidth ?? 1;
        if (sideways.current) {
          held.current = true;
          if (Math.abs(slide) > width * SWIPE_AT) onSwipe?.(slide > 0 ? "archive" : "trash");
          window.setTimeout(() => { held.current = false; }, 300);
        }
        sideways.current = false;
        setSlide(0);
      }}
      onTouchCancel={() => { cancelPress(); sideways.current = false; setSlide(0); }}
      aria-current={selected ? "true" : undefined}
      aria-pressed={picked ? true : undefined}
      style={{ WebkitTouchCallout: "none", transform: slide ? `translateX(${slide}px)` : undefined, touchAction: "pan-y" }}
      className={`relative flex w-full gap-3 border-b border-[var(--border)] px-3 py-3 text-left transition-colors ${selected ? "bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg,var(--surface)))]" : "bg-[var(--bg,var(--surface))] hover:bg-[var(--hover)]"}`}>
      {picked
        ? <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white"><Check className="h-5 w-5" /></span>
        : <Avatar person={row.from} people={people} />}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold text-[var(--text)]" : "text-[var(--text)]"}`}>{shownName(row.from, people)}{row.count > 1 && <span className="ml-1 font-normal text-[var(--text-muted)]">{row.count}</span>}</span>
          {colour && <span style={{ backgroundColor: colour }} className="h-2 w-2 shrink-0 rounded-full" />}
          <span className={`shrink-0 text-xs ${unread ? "font-medium text-[var(--accent-text)]" : "text-[var(--text-muted)]"}`}>{shortWhen(row.at)}</span>
        </span>
        <span className={`block truncate text-sm ${unread ? "font-medium text-[var(--text)]" : "text-[var(--text-muted)]"}`}>{row.subject || "(No subject)"}</span>
        <span className="flex items-center gap-1.5">
          {row.needs_reply && <span className="shrink-0 rounded-full bg-[var(--accent)]/15 px-1.5 py-px text-xs font-medium text-[var(--accent-text)]">Reply</span>}
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">{row.summary || row.snippet}</span>
          {labels.slice(0, 2).map((l) => <LabelPill key={l.id} label={l} />)}
          {row.attachments && <Paperclip className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />}
          {row.starred && <Star className="h-3 w-3 shrink-0 fill-[var(--accent)] text-[var(--accent-text)]" />}
        </span>
      </span>
    </button>
    {quick && (
      <div role="group" aria-label="Quick actions" className={`absolute bottom-2 right-2 flex items-center gap-0.5 rounded-lg border border-[var(--border)] p-0.5 opacity-0 shadow-sm transition-opacity duration-100 focus-within:opacity-100 group-hover/row:opacity-100 ${selected ? "bg-[var(--surface)]" : "bg-[var(--bg,var(--surface))]"}`}>
        {quick.map((q) => (
          <button key={q.label} type="button" aria-label={q.label} title={q.label} onClick={q.onClick} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]">
            <q.icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    )}
    </div>
  );
}

function ConversationPane({ open, showBack, labels, mine, prefill, onPrefilled, onAddEvent, onLabel, onSnooze, onUnsnooze, onBack, onAct, onMove, onWrite, markRead }: {
  open: Open;
  showBack: boolean;
  labels: MailLabel[];
  mine: string[];
  prefill: string | null;
  onPrefilled: () => void;
  onAddEvent: (subject: string) => void;
  onLabel: (t: LabelTarget) => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
  onBack: () => void;
  onAct: (a: ThreadAction) => void;
  onMove: (a: "archive" | "trash", label: string) => void;
  onWrite: (d: Draft) => void;
  markRead: () => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["mail-conversation", open.account_id, open.key],
    queryFn: () => mailApi.conversation(open.account_id, open.key),
    // A reply on its way: look again soon, so it settles into the conversation as sent.
    refetchInterval: (q) => (q.state.data?.messages.some((m) => m.outgoing && m.outgoing.status !== "failed") ? 3000 : false),
  });
  const aliasInfo = useThreadAliases(open.account_id, open.key);
  const marked = useRef(false);
  useEffect(() => {
    if (!data || marked.current || data.messages.every((m) => m.seen)) return;
    marked.current = true;
    void mailApi.act(open.account_id, open.key, "read").then(markRead).catch(() => undefined);
  }, [data, open, markRead]);

  const addresses = useMemo(() => [...new Set((data?.messages ?? []).map((m) => m.from.addr.toLowerCase()))].sort(), [data]);
  const { data: people = {} as People } = useQuery({ queryKey: ["mail-known-people", addresses], queryFn: () => mailApi.knownPeople(addresses), enabled: addresses.length > 0, staleTime: 5 * 60_000 });
  // A reply Chat drafted: open it ready to check and send.
  useEffect(() => {
    if (!data || !prefill) return;
    const newest = data.messages.findLast((m) => !m.outgoing) ?? data.messages[data.messages.length - 1];
    const own = mine.includes(newest.from.addr.toLowerCase());
    onWrite({
      account_id: open.account_id, to: own ? newest.to.map((p) => p.addr).join(", ") : newest.reply_to || newest.from.addr,
      subject: data.subject.toLowerCase().startsWith("re:") ? data.subject : `Re: ${data.subject}`, reply_to: newest.id, thread_key: open.key,
      html: asParagraphs(prefill), quoting: "Drafted in Chat. Check it before sending. The email you're replying to will be quoted below this.",
    });
    onPrefilled();
  }, [data, prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  // r, a, f, s and u, as people know them. Filled in below, once the conversation's here.
  const keys = useRef<Record<string, (() => void) | undefined>>({});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable], [data-mail-composer]")) return;
      if (document.querySelector('[role="menu"], [role="dialog"]')) return;
      const run = keys.current[e.key];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [showAll, setShowAll] = useState(false);

  if (isLoading) return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" /></div>;
  if (isError || !data) return <p className="p-6 text-sm text-[var(--text-muted)]">Couldn't open this conversation.</p>;
  // What a reply answers: the newest email that's really in the mailbox, not one still on its way.
  const last = data.messages.findLast((m) => !m.outgoing) ?? data.messages[data.messages.length - 1];
  const starred = data.messages.some((m) => m.starred);
  const isMine = (addr: string) => mine.includes(addr.toLowerCase());
  const others = (people: { addr: string }[]) => people.map((p) => p.addr).filter((a) => a && !isMine(a));
  // Replying to your own message means writing to whoever you sent it to.
  const whoTo = (m: Message) => {
    const to = isMine(m.from.addr) ? others(m.to) : [m.reply_to || m.from.addr];
    return { to, rest: [...new Set([...others(m.to), ...others(m.cc)])].filter((a) => !to.includes(a)) };
  };
  const everyoneElse = whoTo(last).rest;
  const reSubject = data.subject.toLowerCase().startsWith("re:") ? data.subject : `Re: ${data.subject}`;
  const viaAlias = replyAlias(aliasInfo, data.messages.map((m) => m.id));
  const reply = (m: Message, all: boolean) => {
    const who = whoTo(m);
    onWrite({
      account_id: open.account_id, to: who.to.join(", "), cc: all ? who.rest.join(", ") : "", subject: reSubject, reply_to: m.id, thread_key: open.key,
      quoting: `The email you're replying to will be quoted below this.`,
      ...(viaAlias && viaAlias.send_as !== "refused" ? { from_alias: viaAlias.address, from_alias_note: sendAsNote(viaAlias.send_as, viaAlias.send_as_text) } : {}),
    });
  };
  const forward = (m: Message) => onWrite({
    account_id: open.account_id, to: "", subject: data.subject.toLowerCase().startsWith("fwd:") ? data.subject : `Fwd: ${data.subject}`, forward_of: m.id, thread_key: open.key,
    quoting: m.attachments.length ? `The original email and its ${m.attachments.length === 1 ? "attachment" : `${m.attachments.length} attachments`} will be included below this.` : "The original email will be included below this.",
  });
  keys.current = {
    r: () => reply(last, false),
    a: () => reply(last, true),
    f: () => forward(last),
    s: () => onAct(starred ? "unstar" : "star"),
    u: () => { onAct("unread"); onBack(); },
  };
  // A long conversation you've already read: the first and the newest, the rest a tap away.
  // A reply still on its way is never tucked away.
  const settled = data.messages.filter((m) => !m.outgoing);
  const middle = settled.slice(1, -1);
  const tucked = !showAll && middle.length >= 2 && middle.every((m) => m.seen);
  const shown = tucked ? [settled[0], last, ...data.messages.filter((m) => m.outgoing)] : data.messages;
  const answer = "inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-[var(--border)] px-4 text-sm text-[var(--text)] transition-colors hover:border-[var(--accent)]";
  const action = "inline-flex h-10 shrink-0 items-center gap-1.5 md:h-8 whitespace-nowrap rounded-lg border border-[var(--border)] px-2.5 text-xs text-[var(--text)] transition-colors hover:border-[var(--accent)]";
  const iconButton = "flex h-10 w-10 shrink-0 items-center justify-center md:h-9 md:w-9 rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]";
  return (
    <>
      <header className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-2">
        {showBack && <button type="button" onClick={onBack} aria-label="Back" className={iconButton}><ArrowLeft className="h-5 w-5" /></button>}
        <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold text-[var(--text)]">{data.subject || "(No subject)"}</h2>
        <button type="button" onClick={() => onAct(starred ? "unstar" : "star")} aria-label={starred ? "Remove star" : "Star"} title={starred ? "Remove star (s)" : "Star (s)"} className={iconButton}><Star className={`h-[18px] w-[18px] ${starred ? "fill-[var(--accent)] text-[var(--accent-text)]" : ""}`} /></button>
        <button type="button" onClick={() => onLabel({ account_id: open.account_id, key: open.key, from: data.messages[0].from, subject: data.subject, labels: data.labels })} aria-label="Label" title="Label" className={iconButton}><Tag className="h-[18px] w-[18px]" /></button>
        <button type="button" onClick={onSnooze} aria-label="Snooze" title="Snooze" className={iconButton}><AlarmClock className="h-[18px] w-[18px]" /></button>
        <button type="button" onClick={() => onMove("archive", "Archived")} aria-label="Archive" className={iconButton}><Archive className="h-[18px] w-[18px]" /></button>
        <button type="button" onClick={() => onMove("trash", "Moved to Trash")} aria-label="Move to Trash" className={iconButton}><Trash2 className="h-[18px] w-[18px]" /></button>
      </header>
      <div className="promptly-scroll flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--border)] px-3 py-2">
        <button type="button" onClick={() => reply(last, false)} className={action}><Reply className="h-3.5 w-3.5" />Reply</button>
        {everyoneElse.length > 0 && <button type="button" onClick={() => reply(last, true)} className={action}><ReplyAll className="h-3.5 w-3.5" />Reply all</button>}
        <button type="button" onClick={() => forward(last)} className={action}><Forward className="h-3.5 w-3.5" />Forward</button>
        <button type="button" onClick={() => onAddEvent(data.subject)} className={action}><CalendarPlus className="h-3.5 w-3.5" />Add to calendar</button>
        <button type="button" onClick={() => void mailApi.addTask(open.account_id, open.key).then(() => toast.success("Added to Tasks.")).catch((e) => toast.error(apiErrorMessage(e, "Couldn't add that task.")))} className={action}><CheckSquare className="h-3.5 w-3.5" />Make a task</button>
      </div>
      <div className="promptly-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {data.summary && (
          <p className="flex gap-2 rounded-xl bg-[var(--accent)]/10 px-3 py-2.5 text-sm text-[var(--text)]">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" /><span className="min-w-0">{data.summary}</span>
          </p>
        )}
        {data.snoozed_until && (
          <p className="flex items-center gap-2 rounded-lg bg-[var(--accent)]/10 px-3 py-2 text-xs text-[var(--text)]">
            <AlarmClock className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" /><span className="flex-1">Snoozed until {new Date(data.snoozed_until).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
            <button type="button" onClick={onUnsnooze} className="font-medium text-[var(--accent-text)]">Back to Inbox</button>
          </p>
        )}
        <AliasNotes info={aliasInfo} accountId={open.account_id} threadKey={open.key} />
        {data.labels.length > 0 && <div className="flex flex-wrap gap-1.5">{labels.filter((l) => data.labels.includes(l.id)).map((l) => <LabelPill key={l.id} label={l} />)}</div>}
        {shown.map((m, i) => (
          <div key={m.id} className="space-y-3">
            <MessageCard
              message={m}
              people={people}
              startOpen={m === last || !m.seen || !!m.outgoing}
              // The newest one's answers are the row underneath it.
              onReply={m === last || m.outgoing ? undefined : (all) => reply(m, all)}
              onForward={m === last || m.outgoing ? undefined : () => forward(m)}
              replyAll={whoTo(m).rest.length > 0}
            />
            {tucked && i === 0 && (
              <button type="button" onClick={() => setShowAll(true)} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] px-3 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
                <ChevronDown className="h-3.5 w-3.5" />Show {middle.length} earlier messages
              </button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap gap-2 pb-1 pt-1">
          <button type="button" onClick={() => reply(last, false)} className={answer}><Reply className="h-4 w-4" />Reply</button>
          {everyoneElse.length > 0 && <button type="button" onClick={() => reply(last, true)} className={answer}><ReplyAll className="h-4 w-4" />Reply all</button>}
          <button type="button" onClick={() => forward(last)} className={answer}><Forward className="h-4 w-4" />Forward</button>
        </div>
      </div>
    </>
  );
}

function inviteWhen(i: MailInvite): string {
  if (i.all_day) {
    const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    return i.end && i.end !== i.start ? `${day(i.start)} to ${day(i.end)}` : `${day(i.start)}, all day`;
  }
  const start = new Date(i.start);
  const words = start.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return i.end ? `${words} to ${new Date(i.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : words;
}

/** An invitation, answered here: it goes in your calendar and the organiser gets told. */
function InviteCard({ message }: { message: Message }) {
  const invite = message.invite!;
  const qc = useQueryClient();
  const [answer, setAnswer] = useState<InviteAnswer | null>(invite.answer);
  const [eventUrl, setEventUrl] = useState(invite.event_url);
  const [busy, setBusy] = useState(false);
  const say = async (next: InviteAnswer) => {
    setBusy(true);
    try {
      const got = await mailApi.rsvp(message.id, next);
      setAnswer(got.answer);
      setEventUrl(got.event_url);
      toast.success(next === "declined" ? "Declined." : `Added to your calendar${got.told_organiser ? " and the organiser's been told" : ""}.`);
      void qc.invalidateQueries({ queryKey: ["mail-conversation"] });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't answer that."));
    } finally {
      setBusy(false);
    }
  };
  const button = (value: InviteAnswer, label: string) => (
    <button key={value} type="button" disabled={busy} aria-pressed={answer === value} onClick={() => void say(value)} className={`h-8 rounded-lg px-3 text-xs font-medium disabled:opacity-60 ${answer === value ? "bg-[var(--accent-strong)] text-white" : "border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)]"}`}>{label}</button>
  );
  const replied = invite.method === "REPLY" ? invite.attendees.find((a) => a.said) : undefined;
  return (
    <div className="mb-3 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-3 text-sm">
      <p className={`font-medium text-[var(--text)] ${invite.cancelled ? "line-through" : ""}`}>{invite.title}</p>
      <p className="text-xs text-[var(--text-muted)]">{inviteWhen(invite)}{invite.location ? ` · ${invite.location}` : ""}</p>
      {invite.organizer && invite.method !== "REPLY" && <p className="text-xs text-[var(--text-muted)]">From {invite.organizer.name || invite.organizer.addr}</p>}
      {!invite.zone_sure && <p className="mt-1 text-xs text-[var(--warning)]">The invite's time zone isn't clear, so check the time.</p>}
      {invite.repeats && !invite.cancelled && invite.method !== "REPLY" && <p className="mt-1 text-xs text-[var(--text-muted)]">This repeats. Only the first date goes in your calendar for now.</p>}
      {replied ? (
        <p className="mt-2 text-xs text-[var(--text)]">{replied.name || replied.addr} said {replied.said === "going" ? "yes" : replied.said === "maybe" ? "maybe" : "no"}.</p>
      ) : invite.cancelled ? (
        <div className="mt-2 flex items-center gap-3 text-xs">
          <span className="font-medium text-[var(--danger)]">Cancelled</span>
          {eventUrl && <button type="button" disabled={busy} onClick={() => void mailApi.removeCancelled(message.id).then(() => setEventUrl(null))} className="font-medium text-[var(--accent-text)]">Remove from my calendar</button>}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {button("going", "Yes")}{button("maybe", "Maybe")}{button("declined", "No")}
          {eventUrl && <RouterLink to={eventUrl} className="ml-1 text-xs font-medium text-[var(--accent-text)]">Open in Calendar</RouterLink>}
        </div>
      )}
    </div>
  );
}

/** A reply that couldn't go: why, and a way to send it again or let it go. */
function NotSent({ outboxId, error }: { outboxId: string; error: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (what: "retry" | "dismiss") => {
    setBusy(true);
    try {
      await (what === "retry" ? mailApi.retrySend(outboxId) : mailApi.dismissSend(outboxId));
      await qc.invalidateQueries({ queryKey: ["mail-conversation"] });
      void qc.invalidateQueries({ queryKey: ["mail-overview"] });
    } catch (e) {
      toast.error(apiErrorMessage(e, what === "retry" ? "Couldn't try that again." : "Couldn't remove that."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-3 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--text)]">
      <span className="min-w-0 flex-1">{error || "This reply couldn't be sent."}</span>
      <button type="button" disabled={busy} onClick={() => void run("retry")} className="font-medium text-[var(--accent-text)] disabled:opacity-60">Try again</button>
      <button type="button" disabled={busy} onClick={() => void run("dismiss")} className="text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-60">Remove</button>
    </div>
  );
}

function MessageCard({ message, people, startOpen, onReply, onForward, replyAll }: { message: Message; people: People; startOpen: boolean; onReply?: (all: boolean) => void; onForward?: () => void; replyAll?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [dated, setDated] = useState(false);
  const fullDate = new Date(message.at).toLocaleString([], { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" });
  const small = "inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] md:h-8";
  const [viewing, setViewing] = useState<number | null>(null);
  const files = useSavedAttachments(message.id);
  const outgoing = message.outgoing;
  const failed = outgoing?.status === "failed";
  return (
    <article className={`rounded-2xl border bg-[var(--surface)] ${failed ? "border-[var(--danger)]/50" : "border-[var(--border)]"}`}>
      <div className="flex items-stretch">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3 rounded-l-2xl py-3 pl-3 text-left">
          <Avatar person={message.from} people={people} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-[var(--text)]">{shownName(message.from, people)}</span>
            <span className="block truncate text-xs text-[var(--text-muted)]">{open ? `to ${message.to.map(personName).join(", ") || "you"}` : message.text.slice(0, 120)}</span>
          </span>
        </button>
        {/* The short time is enough at a glance. Tap it for the whole date. */}
        {outgoing ? (
          <span role="status" className={`inline-flex shrink-0 items-center gap-1 pl-2 pr-3 text-xs ${failed ? "font-medium text-[var(--danger)]" : "text-[var(--text-muted)]"}`}>
            {!failed && <Loader2 className="h-3 w-3 animate-spin" />}{failed ? "Not sent" : "Sending…"}
          </span>
        ) : (
          <button type="button" onClick={() => setDated((v) => !v)} aria-expanded={dated} aria-label={`Sent ${fullDate}`} title={fullDate} className="flex min-w-10 shrink-0 items-center justify-end rounded-r-2xl pl-2 pr-3 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">{shortWhen(message.at)}</button>
        )}
      </div>
      {failed && outgoing && <NotSent outboxId={outgoing.id} error={outgoing.error} />}
      {dated && <p className="px-3 pb-2 text-xs text-[var(--text-muted)]">Sent {fullDate}</p>}
      {open && (
        <div className="px-3 pb-3">
          {message.invite && <InviteCard message={message} />}
          <MessageBody html={message.html} text={message.text} remoteImages={message.remote_images} clipped={message.html_clipped} />
          {message.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((a, i) => (
                <span key={a.part} className="inline-flex max-w-full items-center rounded-lg bg-[var(--hover)] text-xs text-[var(--text)]">
                  <button type="button" onClick={() => setViewing(i)} title={`Open ${a.name}`} className="flex min-w-0 items-center gap-1.5 rounded-l-lg py-1.5 pl-2.5 pr-1 hover:text-[var(--accent-text)]"><Paperclip className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{a.name}</span></button>
                  <button type="button" onClick={() => void mailApi.download(message.id, a.part, a.name).catch(() => toast.error("Couldn't get that attachment."))} aria-label={`Download ${a.name}`} title="Download" className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]"><Download className="h-3.5 w-3.5" /></button>
                  <SaveToFiles saved={files.saved.has(a.part)} saving={files.saving.has(a.part)} onSave={() => void files.save(a.part)} name={a.name} className="h-8 w-8" />
                </span>
              ))}
            </div>
          )}
          {onReply && (
            <div className="-mb-1 -ml-1.5 mt-2 flex flex-wrap gap-1">
              <button type="button" onClick={() => onReply(false)} className={small}><Reply className="h-3.5 w-3.5" />Reply</button>
              {replyAll && <button type="button" onClick={() => onReply(true)} className={small}><ReplyAll className="h-3.5 w-3.5" />Reply all</button>}
              {onForward && <button type="button" onClick={onForward} className={small}><Forward className="h-3.5 w-3.5" />Forward</button>}
            </div>
          )}
        </div>
      )}
      {viewing !== null && <AttachmentViewer messageId={message.id} attachments={message.attachments} start={viewing} saved={files.saved} saving={files.saving} onSave={(part) => void files.save(part)} onClose={() => setViewing(null)} />}
    </article>
  );
}

/** Always there, never in the way. It knows which conversation you've got open,
 *  and says which model will read your mail before you press anything. */
function AskBar({ open, accounts, viewing, compactModel }: { open: Open | null; accounts: MailAccount[]; viewing?: string; compactModel: boolean }) {
  const selected = useSelectedModel();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ text: string; read: number; hint?: string } | null>(null);
  // The last few questions and answers, so a follow-up ("and the Nelly?")
  // makes sense. Starts again when you close the answer or open another email.
  const [history, setHistory] = useState<{ q: string; a: string }[]>([]);
  const [busy, setBusy] = useState(false);
  // Follows the mailbox you're looking at, until you choose otherwise.
  const [scope, setScope] = useState<string | undefined>(viewing);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => setScope(viewing), [viewing]);
  useEffect(() => setHistory([]), [open?.key, scope]);
  const scoped = accounts.find((a) => a.id === scope);
  const canScope = accounts.length > 1 && !open;

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    if (!selected) return toast.error("Pick a model first.");
    setBusy(true);
    try {
      const got = await mailApi.ask({ question: q, provider_id: selected.provider_id, model_id: selected.model_id, account_id: open?.account_id ?? scoped?.id, thread_key: open?.key, history });
      setAnswer({ text: got.answer, read: got.read, hint: got.hint });
      setHistory((h) => [...h, { q, a: got.answer }].slice(-4));
      setQuestion("");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't get an answer."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      {answer && (
        <div className="mx-auto mb-2 max-w-3xl rounded-xl bg-[var(--accent)]/10 p-3 text-sm text-[var(--text)]">
          <div className="flex gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap">{answer.text}</p>
            <button type="button" onClick={() => { setAnswer(null); setHistory([]); }} aria-label="Close answer" className="self-start text-[var(--text-muted)]"><X className="h-4 w-4" /></button>
          </div>
          <p className="mt-1 text-xs text-[var(--text-muted)]">From {answer.read} {answer.read === 1 ? "email" : "emails"}. AI can get things wrong, so check anything important.</p>
          {answer.hint && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{answer.hint}</p>}
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        {canScope && (
          <div className="relative shrink-0">
            <button type="button" onClick={() => setChoosing((v) => !v)} aria-haspopup="menu" aria-expanded={choosing} aria-label={`Asking about ${scoped?.email ?? "all mailboxes"}. Change`} title="Which mailbox to ask about" className="inline-flex h-10 max-w-[10rem] items-center gap-1.5 rounded-xl bg-[var(--hover)] px-3 text-xs text-[var(--text)]">
              {scoped && <span style={{ backgroundColor: scoped.color }} className="h-2 w-2 shrink-0 rounded-full" />}
              <span className="min-w-0 truncate">{scoped?.email ?? "All mailboxes"}</span>
              <ChevronUp className={`h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform ${choosing ? "rotate-180" : ""}`} />
            </button>
            {choosing && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setChoosing(false)} />
                <div role="menu" className="promptly-scroll absolute bottom-full left-0 z-40 mb-1 max-h-72 w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl">
                  <p className="px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Ask about</p>
                  {[undefined, ...accounts].map((a) => (
                    <button key={a?.id ?? "all"} type="button" role="menuitemradio" aria-checked={scope === a?.id} onClick={() => { setScope(a?.id); setChoosing(false); }} className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]">
                      {a && <span style={{ backgroundColor: a.color }} className="h-2.5 w-2.5 shrink-0 rounded-full" />}
                      <span className="min-w-0 flex-1 truncate">{a?.email ?? "All mailboxes"}</span>
                      {scope === a?.id && <Check className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-[var(--hover)] px-3">
          {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--accent-text)]" /> : <Sparkles className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />}
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void ask(); }}
            placeholder={open ? "Ask about this conversation…" : scoped ? `Ask about ${scoped.email}…` : "Ask about your mail…"}
            aria-label="Ask about your mail"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>
        <ModelSelector compact={compactModel} upward />
      </div>
    </div>
  );
}
