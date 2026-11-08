import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock, Archive, ArrowLeft, CalendarPlus, Check, CheckSquare, ChevronDown, ChevronUp, Download, Forward, Inbox, ListFilter, Loader2, Mail, MailOpen, Paperclip, Pen, Plus, Reply, ReplyAll, Search, Send, Settings, Sparkles, Star, Tag, Trash2, UserPlus, X, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";

import { ModelSelector } from "@/components/chat/ModelSelector";
import { ContextMenu, type ContextMenuItem } from "@/components/files/ContextMenu";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSelectedModel } from "@/store/modelStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { mailApi, personName, shortWhen, type Person, type InviteAnswer, type KnownPerson, type MailAccount, type MailInvite, type MailLabel, type Message, type ThreadAction, type ThreadRow } from "./api";
import { AccountPicker, AccountSheet, MailboxSheet } from "./AccountSheet";
import { asParagraphs, Composer, type Draft } from "./Composer";
import { AttachmentViewer, SaveToFiles, useSavedAttachments } from "./AttachmentViewer";
import { readComposeLink } from "./composeLink";
import { useThreadDrag } from "./DragMove";
import { LabelPicker, LabelPill, LabelsSheet, NewLabelSheet, RuleSheet, type LabelTarget } from "./Labels";
import { labelRows, readFolded, saveFolded, unfolded } from "./labelTree";
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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [folded, setFolded] = useState(readFolded);
  const [menu, setMenu] = useState<{ row: ThreadRow; x: number; y: number } | null>(null);
  const [labelling, setLabelling] = useState<LabelTarget | null>(null);
  const [ruleFor, setRuleFor] = useState<LabelTarget | null>(null);
  const [snoozing, setSnoozing] = useState<Open | null>(null);
  const [editing, setEditing] = useState<MailAccount | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [undo, setUndo] = useState<{ label: string; run: () => void; timer?: number } | null>(null);
  const hidden = useRef(new Set<string>());
  // Closing up before it's gone, so the list settles rather than jumps.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [hiddenTick, setHiddenTick] = useState(0);
  const leavingTimers = useRef(new Map<string, number>());
  const [naming, setNaming] = useState<ThreadRow | null>(null);
  const accounts = useMemo(() => overview?.accounts ?? [], [overview]);
  const location = useLocation();
  const undoTimer = useRef<number | null>(null);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [eventFor, setEventFor] = useState<(Open & { subject: string }) | null>(null);
  const labels = useMemo(() => overview?.labels ?? [], [overview]);

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
    setDraft({ account_id: from, to: link.to, subject: link.subject, html: asParagraphs(link.body) });
  }, [overview, accounts, location.search, location.hash, location.pathname, location.key]);

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
  const rows = useMemo(
    () => (list.data?.pages.flatMap((p) => p.threads) ?? []).filter((t) => !hidden.current.has(`${t.account_id}/${t.key}`)),
    [list.data, hiddenTick], // eslint-disable-line react-hooks/exhaustive-deps
  );

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

  const act = useCallback(async (row: Open, action: ThreadAction) => {
    try {
      await mailApi.act(row.account_id, row.key, action);
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't do that."));
    }
  }, [refresh]);

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
  const moveAway = useCallback((row: Open, action: "archive" | "trash", label: string) => {
    const id = `${row.account_id}/${row.key}`;
    leave(id);
    setOpen((o) => (o && o.key === row.key ? null : o));
    const timer = window.setTimeout(() => {
      setUndo(null);
      void (async () => {
        try {
          await mailApi.act(row.account_id, row.key, action);
          // Kept off the list until the new list is here, or it flashes back.
          await qc.invalidateQueries({ queryKey: ["mail-threads"] });
          void qc.invalidateQueries({ queryKey: ["mail-overview"] });
          void qc.invalidateQueries({ queryKey: ["mail-conversation"] });
        } catch (e) {
          toast.error(apiErrorMessage(e, "Couldn't do that."));
        } finally {
          stay(id);
        }
      })();
    }, UNDO_MS);
    setUndo({
      label,
      timer,
      run: () => {
        window.clearTimeout(timer);
        stay(id);
        setUndo(null);
      },
    });
  }, [qc, leave, stay]);

  /** Into a label, or back to the Inbox, straight away: undo puts it back where it was. */
  const moveNow = useCallback(async (row: Open & { labels: string[] }, labelId: string | null, words: string, cameFrom: "inbox" | "archive" | "trash", fromLabel?: string) => {
    const id = `${row.account_id}/${row.key}`;
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    leave(id);
    setOpen((o) => (o && o.key === row.key ? null : o));
    const put = async (label: string | null, action: ThreadAction) => {
      if (label) await mailApi.setThreadLabel(row.account_id, row.key, label, true);
      else await mailApi.act(row.account_id, row.key, action);
      await qc.invalidateQueries({ queryKey: ["mail-threads"] });
      void qc.invalidateQueries({ queryKey: ["mail-overview"] });
    };
    try {
      await put(labelId, "inbox");
    } catch (e) {
      stay(id);
      toast.error(apiErrorMessage(e, "Couldn't move that."));
      return;
    }
    stay(id);
    undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
    setUndo({
      label: words,
      run: () => {
        if (undoTimer.current) window.clearTimeout(undoTimer.current);
        setUndo(null);
        void put(row.labels[0] ?? fromLabel ?? null, cameFrom).catch((e) => toast.error(apiErrorMessage(e, "Couldn't put that back.")));
      },
    });
  }, [leave, stay, qc]);

  const sent = useCallback((id: string, seconds: number, snapshot: Draft) => {
    setDraft(null);
    refresh();
    const timer = window.setTimeout(() => { setUndo(null); refresh(); }, seconds * 1000);
    setUndo({
      label: "Sending…",
      timer,
      run: () => {
        window.clearTimeout(timer);
        setUndo(null);
        void mailApi.undoSend(id).then(() => setDraft(snapshot)).catch((e) => toast.error(apiErrorMessage(e, "Too late: that's already gone.")));
      },
    });
  }, [refresh]);

  const snooze = useCallback(async (at: Open, when: Date) => {
    setSnoozing(null);
    setOpen((o) => (o && o.key === at.key ? null : o));
    try {
      await mailApi.snooze(at.account_id, at.key, when);
      toast.success(`Snoozed until ${when.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`);
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't snooze that."));
    }
  }, [refresh]);

  const cameFrom: "inbox" | "archive" | "trash" = view.role === "archive" || view.role === "trash" ? view.role : "inbox";
  const moveToLabel = useCallback((row: Open & { labels: string[] }, labelId: string, known?: string) => {
    void moveNow(row, labelId, `Moved to ${known ?? labels.find((l) => l.id === labelId)?.name ?? "label"}`, cameFrom, view.label);
  }, [moveNow, labels, cameFrom, view.label]);

  const dropped = useCallback((row: ThreadRow, target: string) => {
    const [kind, value] = target.split(":");
    if (kind === "label") moveToLabel(row, value);
    else if (kind === "new") setNaming(row);
    else if (value === "inbox") void moveNow(row, null, "Moved to Inbox", cameFrom, view.label);
    else if (value === "archive") moveAway(row, "archive", "Archived");
    else if (value === "trash") moveAway(row, "trash", "Moved to Trash");
    else if (value === "snoozed") setSnoozing(row);
  }, [moveToLabel, moveNow, moveAway, cameFrom, view.label]);
  const { dragging, hover, startDrag, card } = useThreadDrag(dropped);

  const newMessage = useCallback((): Draft => ({ account_id: view.account ?? accounts[0]?.id ?? "", to: "", subject: "" }), [view.account, accounts]);

  // The keys people already know.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const index = open ? rows.findIndex((r) => r.key === open.key) : -1;
      if (e.key === "j" || e.key === "k") {
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + (e.key === "j" ? 1 : -1)))];
        if (next) setOpen({ account_id: next.account_id, key: next.key });
      } else if (e.key === "c" && accounts[0]) {
        e.preventDefault();
        setDraft(newMessage());
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
  }, [open, rows, accounts, newMessage, moveAway]);

  if (isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" /></div>;

  if (accounts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--bg,transparent)] px-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#D97757]/15"><Mail className="h-7 w-7 text-[#D97757]" /></span>
        <h1 className="text-xl font-semibold text-[var(--text)]">All your email, in one calm place</h1>
        <p className="max-w-sm text-sm text-[var(--text-muted)]">Connect any mailbox: Gmail, Proton, Fastmail, your work address. Your mail stays where it is, and you can add as many as you like.</p>
        <button type="button" onClick={() => setAdding(true)} className="mt-2 inline-flex h-10 items-center gap-2 rounded-xl bg-[#D97757] px-4 text-sm font-medium text-white hover:opacity-90"><Plus className="h-4 w-4" />Add a mailbox</button>
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
  const menuItems = (row: ThreadRow): ContextMenuItem[] => {
    const at = { account_id: row.account_id, key: row.key };
    const target: LabelTarget = { ...at, from: row.from, subject: row.subject, labels: row.labels };
    const icon = "h-4 w-4";
    const backToInbox = !view.label && (view.role === "archive" || view.role === "trash");
    return [
      row.unread > 0
        ? { label: "Mark as read", icon: <MailOpen className={icon} />, onClick: () => void act(at, "read") }
        : { label: "Mark as unread", icon: <Mail className={icon} />, onClick: () => void act(at, "unread") },
      row.starred
        ? { label: "Remove star", icon: <Star className={icon} />, onClick: () => void act(at, "unstar") }
        : { label: "Star", icon: <Star className={icon} />, onClick: () => void act(at, "star") },
      ...(row.needs_reply ? [{ label: "No reply needed", icon: <Check className={icon} />, onClick: () => void act(at, "no_reply") }] : []),
      view.role === "snoozed" && !view.label
        ? { label: "Back to Inbox now", icon: <Inbox className={icon} />, onClick: () => void mailApi.unsnooze(at.account_id, at.key).then(refresh) }
        : { label: "Snooze…", icon: <AlarmClock className={icon} />, onClick: () => setSnoozing(at) },
      { label: "Add to calendar…", icon: <CalendarPlus className={icon} />, onClick: () => setEventFor({ ...at, subject: row.subject }) },
      { label: "Turn into a task", icon: <CheckSquare className={icon} />, onClick: () => void mailApi.addTask(at.account_id, at.key).then(() => toast.success("Added to Tasks.")).catch((e) => toast.error(apiErrorMessage(e, "Couldn't add that task."))) },
      ...(people[row.from.addr.toLowerCase()] ? [] : [{ label: "Add to Contacts", icon: <UserPlus className={icon} />, onClick: () => void mailApi.addContact(row.from.name, row.from.addr).then(() => { toast.success("Added to Contacts."); void qc.invalidateQueries({ queryKey: ["mail-known-people"] }); }).catch((e) => toast.error(apiErrorMessage(e, "Couldn't add that contact."))) }]),
      { label: "Move to label…", icon: <Tag className={icon} />, onClick: () => setLabelling(target) },
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
        : { label: "Snooze", icon: AlarmClock, onClick: () => setSnoozing(at) },
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

  const rail = (
    <nav aria-label="Mail folders" className="flex w-60 shrink-0 flex-col border-r border-[var(--border)] p-3">
      <div className="mb-2 shrink-0">{picker}</div>
      <div data-mail-rail-scroll className="promptly-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-0.5">
      <button type="button" onClick={() => setDraft(newMessage())} className="mb-3 inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#D97757] text-sm font-medium text-white hover:opacity-90"><Pen className="h-4 w-4" />Compose</button>
      {ROLES.map(({ role, label, icon: Icon }) => (
        <button key={role} type="button" onClick={() => showRole(role)} aria-current={!view.label && view.role === role ? "page" : undefined} {...(CAN_LAND.has(role) ? dropTarget(`role:${role}`, role === "snoozed" ? "Snooze" : `Move to ${label}`) : {})} style={dropStyle(`role:${role}`)} className={`flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-[background-color,box-shadow,transform,opacity] duration-150 ease-out ${dragging && !CAN_LAND.has(role) ? "opacity-40 " : ""}${!view.label && view.role === role ? "bg-[#D97757]/15 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}>
          <Icon className="h-4 w-4" /><span className="flex-1 text-left">{label}</span>
          {role === "inbox" && unreadInbox > 0 && <span className="text-xs font-medium text-[#D97757]">{unreadInbox}</span>}
        </button>
      ))}
      <div className="mb-1 mt-5 flex shrink-0 items-center justify-between pl-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Labels</p>
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
              <button type="button" onClick={() => showLabel(l.id)} onContextMenu={(e) => { e.preventDefault(); setLabelsOpen(true); }} aria-current={view.label === l.id ? "page" : undefined} aria-label={l.name} title={l.name} {...dropTarget(`label:${l.id}`, `Move to ${l.name}`, l.color)} style={{ ...padding, ...dropStyle(`label:${l.id}`, l.color) }} className={`flex h-8 w-full items-center gap-2.5 rounded-lg text-sm transition-[background-color,box-shadow,transform] duration-150 ease-out ${r.hasChildren ? "pr-8" : "pr-2.5"} ${view.label === l.id ? "bg-[#D97757]/15 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}>
                <span style={{ backgroundColor: l.color }} className="h-2 w-2 shrink-0 rounded-full" /><span className="min-w-0 flex-1 truncate text-left">{r.name}</span>
                {count > 0 && <span className="text-xs font-medium text-[#D97757]">{count}</span>}
              </button>
            ) : (
              // Only a heading: there's a label inside it, but none called this.
              <div style={padding} title={r.path} className="flex h-8 w-full items-center gap-2.5 pr-8 text-sm text-[var(--text-muted)]">
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                {count > 0 && <span className="text-xs font-medium text-[#D97757]">{count}</span>}
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
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-[var(--hover)] px-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input id="mail-search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search your mail" aria-label="Search your mail" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
          {typed && <button type="button" onClick={() => setTyped("")} aria-label="Clear search"><X className="h-4 w-4 text-[var(--text-muted)]" /></button>}
        </div>
      </div>
      {problem && <p className="mx-3 mb-2 rounded-lg bg-[#C62828]/10 px-3 py-2 text-xs text-[var(--text)]"><strong>{problem.email}:</strong> {problem.status_detail}</p>}
      {(overview?.failed ?? []).map((f) => (
        <div key={f.id} role="alert" className="mx-3 mb-2 rounded-lg bg-[#C62828]/10 px-3 py-2 text-xs text-[var(--text)]">
          <p><strong>{f.subject || "(No subject)"}:</strong> {f.error}</p>
          <div className="mt-1 flex gap-3 font-medium">
            <button type="button" onClick={() => void mailApi.retrySend(f.id).then(refresh)} className="text-[#D97757]">Try again</button>
            <button type="button" onClick={() => void mailApi.dismissSend(f.id).then(refresh)} className="text-[var(--text-muted)]">Dismiss</button>
          </div>
        </div>
      ))}
      {overview?.sorting && !view.label && view.role === "inbox" && !search && (
        <div className="flex gap-1.5 px-3 pb-2">
          <button type="button" aria-pressed={!view.needsReply} onClick={() => setView((v) => ({ ...v, needsReply: false }))} className={`h-7 rounded-full px-3 text-xs ${!view.needsReply ? "bg-[#D97757]/15 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}>Everything</button>
          <button type="button" aria-pressed={!!view.needsReply} onClick={() => setView((v) => ({ ...v, needsReply: true }))} className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs ${view.needsReply ? "bg-[#D97757]/15 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}>
            <Sparkles className="h-3 w-3 text-[#D97757]" />Needs a reply{(overview.needs_reply ?? 0) > 0 && <span className="font-medium text-[#D97757]">{overview.needs_reply}</span>}
          </button>
        </div>
      )}
      {shownLabel && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 pb-2 text-sm font-medium text-[var(--text)]">
          <span style={{ backgroundColor: shownLabel.color }} className="h-2.5 w-2.5 shrink-0 rounded-full" /><span className="min-w-0 flex-1 truncate">{shownLabel.name}</span>
          <button type="button" onClick={() => showRole("inbox")} aria-label="Back to Inbox" className="text-[var(--text-muted)]"><X className="h-4 w-4" /></button>
        </div>
      )}
      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
        {list.isLoading && <p className="p-6 text-center text-sm text-[var(--text-muted)]">Getting your mail…</p>}
        {!list.isLoading && rows.length === 0 && (
          <p className="p-8 text-center text-sm text-[var(--text-muted)]">
            {search ? "Nothing found." : view.needsReply ? "Nothing's waiting on you." : view.role === "snoozed" ? "Nothing snoozed. Snooze an email to bring it back when you can deal with it." : shownLabel?.fetching ? "Fetching this label's mail from your mailbox. It'll appear here as it arrives." : view.label ? `Nothing here yet. ${isMobile ? "Press and hold an email and choose Move to label" : "Drag an email onto this label"}, or make a rule.` : accounts.some((a) => !a.last_sync_at) ? "Fetching your mail for the first time. This can take a few minutes." : "Nothing here. Enjoy the quiet."}
          </p>
        )}
        {rows.map((row, i) => (
          <div key={`${row.account_id}/${row.key}`}>
          {row.related && !rows[i - 1]?.related && <p className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Related</p>}
          <div style={{ gridTemplateRows: leaving.has(`${row.account_id}/${row.key}`) ? "0fr" : "1fr", transitionDuration: `${LEAVE_MS}ms` }} className={`grid transition-[grid-template-rows,opacity] ease-out ${leaving.has(`${row.account_id}/${row.key}`) ? "opacity-0" : "opacity-100"}`}>
          <div className={`min-h-0 overflow-hidden transition-opacity duration-150 ${dragging?.key === row.key && dragging.account_id === row.account_id ? "opacity-40" : ""}`}>
          <ThreadItem key={`${row.account_id}/${row.key}`} quick={isMobile || row.related ? undefined : quickActions(row)} onDragStart={isMobile ? undefined : startDrag} row={row} selected={open?.key === row.key} colour={accounts.length > 1 ? accounts.find((a) => a.id === row.account_id)?.color : undefined} people={people} labels={row.labels.filter((id) => id !== view.label).flatMap((id) => labels.filter((l) => l.id === id))} onOpen={() => setOpen({ account_id: row.account_id, key: row.key })} onMenu={(x, y) => setMenu({ row, x, y })} onSwipe={isMobile ? (a) => (a === "archive" ? moveAway(row, "archive", "Archived") : moveAway(row, "trash", "Moved to Trash")) : undefined} />
          </div>
          </div>
          </div>
        ))}
        {list.hasNextPage && <button type="button" onClick={() => void list.fetchNextPage()} className="w-full p-3 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]">{list.isFetchingNextPage ? "Loading…" : "Show older"}</button>}
      </div>
      {isMobile && (
        <button type="button" onClick={() => setDraft(newMessage())} aria-label="Compose" className="absolute bottom-[7.5rem] right-4 z-10 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#D97757] text-white shadow-lg"><Pen className="h-5 w-5" /></button>
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
      onLabel={setLabelling}
      onSnooze={() => setSnoozing(open)}
      onUnsnooze={() => void mailApi.unsnooze(open.account_id, open.key).then(refresh)}
      onBack={() => setOpen(null)}
      onAct={(action) => void act(open, action)}
      onMove={(action, label) => moveAway(open, action, label)}
      onWrite={setDraft}
      markRead={() => { void qc.invalidateQueries({ queryKey: ["mail-overview"] }); void qc.invalidateQueries({ queryKey: ["mail-threads"] }); }}
    />
  ) : (
    !isMobile && <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[var(--text-muted)]"><Mail className="h-8 w-8 opacity-40" /><p className="text-sm">Pick a conversation to read.</p></div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--bg,transparent)]">
      <div className="flex min-h-0 flex-1">
        {!isMobile && rail}
        {(!isMobile || !open) && listPane}
        {reading && <div className="flex min-w-0 flex-1 flex-col">{reading}</div>}
      </div>
      <AskBar open={open} accounts={accounts} viewing={view.account} compactModel={isMobile} />
      {isMobile && !open && (
        <nav aria-label="Mail folders" className="flex border-t border-[var(--border)] pb-[env(safe-area-inset-bottom)]">
          {ROLES.filter((r) => r.role !== "snoozed").map(({ role, label, icon: Icon }) => (
            <button key={role} type="button" onClick={() => showRole(role)} className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${!view.label && view.role === role ? "text-[#D97757]" : "text-[var(--text-muted)]"}`}><Icon className="h-5 w-5" />{label}</button>
          ))}
          <button type="button" onClick={() => setLabelsOpen(true)} className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${view.label ? "text-[#D97757]" : "text-[var(--text-muted)]"}`}><Tag className="h-5 w-5" />Labels</button>
        </nav>
      )}
      {undo && (
        <div role="status" className="absolute bottom-[7.5rem] left-1/2 z-20 flex -translate-x-1/2 items-center gap-4 rounded-xl bg-[#2B2622] px-4 py-2.5 text-sm text-white shadow-lg">
          {undo.label}<button type="button" onClick={undo.run} className="font-medium text-[#F0B59E]">Undo</button>
        </div>
      )}
      {draft && <Composer key={draft.reply_to ?? draft.forward_of ?? "new"} draft={draft} accounts={accounts} onClose={() => setDraft(null)} onSent={sent} />}
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
      {menu && <ContextMenu open x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems(menu.row)} />}
      {labelsOpen && <LabelsSheet labels={labels} current={view.label} top={isMobile ? <button type="button" onClick={() => showRole("snoozed")} className="mb-1 flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"><AlarmClock className="h-4 w-4 text-[var(--text-muted)]" />Snoozed</button> : undefined} onPick={showLabel} onClose={() => setLabelsOpen(false)} onRemoved={(id) => { if (view.label === id) showRole("inbox"); }} />}
      {labelling && (
        <LabelPicker
          target={labelling}
          labels={labels}
          onMove={(id) => { moveToLabel(labelling, id); setLabelling(null); }}
          onToInbox={() => { void moveNow(labelling, null, "Moved to Inbox", cameFrom); setLabelling(null); }}
          onClose={() => setLabelling(null)}
          onMakeRule={() => { setRuleFor(labelling); setLabelling(null); }}
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

function ThreadItem({ row, selected, colour, people, labels, onOpen, onMenu, onSwipe, onDragStart, quick }: { quick?: QuickAction[]; onDragStart?: (e: ReactPointerEvent<HTMLElement>, row: ThreadRow) => void; row: ThreadRow; selected: boolean; colour?: string; people: People; labels: MailLabel[]; onOpen: () => void; onMenu: (x: number, y: number) => void; onSwipe?: (action: "archive" | "trash") => void }) {
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
      <div aria-hidden className={`absolute inset-0 flex items-center px-5 text-white ${slide > 0 ? "justify-start bg-[#D97757]" : "justify-end bg-[#C62828]"}`}>
        {slide > 0 ? <Archive className="h-5 w-5" /> : <Trash2 className="h-5 w-5" />}
      </div>
    )}
    <button
      type="button"
      onClick={() => { if (held.current) held.current = false; else onOpen(); }}
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
      style={{ WebkitTouchCallout: "none", transform: slide ? `translateX(${slide}px)` : undefined, touchAction: "pan-y" }}
      className={`relative flex w-full gap-3 border-b border-[var(--border)] px-3 py-3 text-left transition-colors ${selected ? "bg-[color-mix(in_srgb,#D97757_10%,var(--bg,var(--surface)))]" : "bg-[var(--bg,var(--surface))] hover:bg-[var(--hover)]"}`}>
      <Avatar person={row.from} people={people} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold text-[var(--text)]" : "text-[var(--text)]"}`}>{shownName(row.from, people)}{row.count > 1 && <span className="ml-1 font-normal text-[var(--text-muted)]">{row.count}</span>}</span>
          {colour && <span style={{ backgroundColor: colour }} className="h-2 w-2 shrink-0 rounded-full" />}
          <span className={`shrink-0 text-xs ${unread ? "font-medium text-[#D97757]" : "text-[var(--text-muted)]"}`}>{shortWhen(row.at)}</span>
        </span>
        <span className={`block truncate text-sm ${unread ? "font-medium text-[var(--text)]" : "text-[var(--text-muted)]"}`}>{row.subject || "(No subject)"}</span>
        <span className="flex items-center gap-1.5">
          {row.needs_reply && <span className="shrink-0 rounded-full bg-[#D97757]/15 px-1.5 py-px text-[10px] font-medium text-[#D97757]">Reply</span>}
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">{row.summary || row.snippet}</span>
          {labels.slice(0, 2).map((l) => <LabelPill key={l.id} label={l} />)}
          {row.attachments && <Paperclip className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />}
          {row.starred && <Star className="h-3 w-3 shrink-0 fill-[#D97757] text-[#D97757]" />}
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
  const { data, isLoading, isError } = useQuery({ queryKey: ["mail-conversation", open.account_id, open.key], queryFn: () => mailApi.conversation(open.account_id, open.key) });
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
    const newest = data.messages[data.messages.length - 1];
    const own = mine.includes(newest.from.addr.toLowerCase());
    onWrite({
      account_id: open.account_id, to: own ? newest.to.map((p) => p.addr).join(", ") : newest.reply_to || newest.from.addr,
      subject: data.subject.toLowerCase().startsWith("re:") ? data.subject : `Re: ${data.subject}`, reply_to: newest.id, thread_key: open.key,
      html: asParagraphs(prefill), quoting: "Drafted in Chat. Check it before sending. The email you're replying to will be quoted below this.",
    });
    onPrefilled();
  }, [data, prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" /></div>;
  if (isError || !data) return <p className="p-6 text-sm text-[var(--text-muted)]">Couldn't open this conversation.</p>;
  const last = data.messages[data.messages.length - 1];
  const starred = data.messages.some((m) => m.starred);
  const isMine = (addr: string) => mine.includes(addr.toLowerCase());
  const others = (people: { addr: string }[]) => people.map((p) => p.addr).filter((a) => a && !isMine(a));
  // Replying to your own last message means writing to whoever you sent it to.
  const replyTo = isMine(last.from.addr) ? others(last.to) : [last.reply_to || last.from.addr];
  const everyoneElse = [...new Set([...others(last.to), ...others(last.cc)])].filter((a) => !replyTo.includes(a));
  const reSubject = data.subject.toLowerCase().startsWith("re:") ? data.subject : `Re: ${data.subject}`;
  const reply = (all: boolean) => onWrite({
    account_id: open.account_id, to: replyTo.join(", "), cc: all ? everyoneElse.join(", ") : "", subject: reSubject, reply_to: last.id, thread_key: open.key,
    quoting: `The email you're replying to will be quoted below this.`,
  });
  const forward = () => onWrite({
    account_id: open.account_id, to: "", subject: data.subject.toLowerCase().startsWith("fwd:") ? data.subject : `Fwd: ${data.subject}`, forward_of: last.id, thread_key: open.key,
    quoting: last.attachments.length ? `The original email and its ${last.attachments.length === 1 ? "attachment" : `${last.attachments.length} attachments`} will be included below this.` : "The original email will be included below this.",
  });
  const action = "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--border)] px-2.5 text-xs text-[var(--text)] transition-colors hover:border-[#D97757]";
  const iconButton = "flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]";
  return (
    <>
      <header className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-2">
        {showBack && <button type="button" onClick={onBack} aria-label="Back" className={iconButton}><ArrowLeft className="h-5 w-5" /></button>}
        <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold text-[var(--text)]">{data.subject || "(No subject)"}</h2>
        <button type="button" onClick={() => onAct(starred ? "unstar" : "star")} aria-label={starred ? "Remove star" : "Star"} className={iconButton}><Star className={`h-[18px] w-[18px] ${starred ? "fill-[#D97757] text-[#D97757]" : ""}`} /></button>
        <button type="button" onClick={() => onLabel({ account_id: open.account_id, key: open.key, from: data.messages[0].from, subject: data.subject, labels: data.labels })} aria-label="Label" title="Label" className={iconButton}><Tag className="h-[18px] w-[18px]" /></button>
        <button type="button" onClick={onSnooze} aria-label="Snooze" title="Snooze" className={iconButton}><AlarmClock className="h-[18px] w-[18px]" /></button>
        <button type="button" onClick={() => onMove("archive", "Archived")} aria-label="Archive" className={iconButton}><Archive className="h-[18px] w-[18px]" /></button>
        <button type="button" onClick={() => onMove("trash", "Moved to Trash")} aria-label="Move to Trash" className={iconButton}><Trash2 className="h-[18px] w-[18px]" /></button>
      </header>
      <div className="promptly-scroll flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--border)] px-3 py-2">
        <button type="button" onClick={() => reply(false)} className={action}><Reply className="h-3.5 w-3.5" />Reply</button>
        {everyoneElse.length > 0 && <button type="button" onClick={() => reply(true)} className={action}><ReplyAll className="h-3.5 w-3.5" />Reply all</button>}
        <button type="button" onClick={forward} className={action}><Forward className="h-3.5 w-3.5" />Forward</button>
        <button type="button" onClick={() => onAddEvent(data.subject)} className={action}><CalendarPlus className="h-3.5 w-3.5" />Add to calendar</button>
        <button type="button" onClick={() => void mailApi.addTask(open.account_id, open.key).then(() => toast.success("Added to Tasks.")).catch((e) => toast.error(apiErrorMessage(e, "Couldn't add that task.")))} className={action}><CheckSquare className="h-3.5 w-3.5" />Make a task</button>
      </div>
      <div className="promptly-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {data.summary && (
          <p className="flex gap-2 rounded-xl bg-[#D97757]/10 px-3 py-2.5 text-sm text-[var(--text)]">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[#D97757]" /><span className="min-w-0">{data.summary}</span>
          </p>
        )}
        {data.snoozed_until && (
          <p className="flex items-center gap-2 rounded-lg bg-[#D97757]/10 px-3 py-2 text-xs text-[var(--text)]">
            <AlarmClock className="h-3.5 w-3.5 shrink-0 text-[#D97757]" /><span className="flex-1">Snoozed until {new Date(data.snoozed_until).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
            <button type="button" onClick={onUnsnooze} className="font-medium text-[#D97757]">Back to Inbox</button>
          </p>
        )}
        {data.labels.length > 0 && <div className="flex flex-wrap gap-1.5">{labels.filter((l) => data.labels.includes(l.id)).map((l) => <LabelPill key={l.id} label={l} />)}</div>}
        {data.messages.map((m, i) => <MessageCard key={m.id} message={m} people={people} startOpen={i === data.messages.length - 1 || !m.seen} />)}
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
    <button key={value} type="button" disabled={busy} aria-pressed={answer === value} onClick={() => void say(value)} className={`h-8 rounded-lg px-3 text-xs font-medium disabled:opacity-60 ${answer === value ? "bg-[#D97757] text-white" : "border border-[var(--border)] text-[var(--text)] hover:border-[#D97757]"}`}>{label}</button>
  );
  const replied = invite.method === "REPLY" ? invite.attendees.find((a) => a.said) : undefined;
  return (
    <div className="mb-3 rounded-xl border border-[#D97757]/40 bg-[#D97757]/5 p-3 text-sm">
      <p className={`font-medium text-[var(--text)] ${invite.cancelled ? "line-through" : ""}`}>{invite.title}</p>
      <p className="text-xs text-[var(--text-muted)]">{inviteWhen(invite)}{invite.location ? ` · ${invite.location}` : ""}</p>
      {invite.organizer && invite.method !== "REPLY" && <p className="text-xs text-[var(--text-muted)]">From {invite.organizer.name || invite.organizer.addr}</p>}
      {!invite.zone_sure && <p className="mt-1 text-xs text-[#C9A227]">The invite's time zone isn't clear, so check the time.</p>}
      {invite.repeats && !invite.cancelled && invite.method !== "REPLY" && <p className="mt-1 text-xs text-[var(--text-muted)]">This repeats. Only the first date goes in your calendar for now.</p>}
      {replied ? (
        <p className="mt-2 text-xs text-[var(--text)]">{replied.name || replied.addr} said {replied.said === "going" ? "yes" : replied.said === "maybe" ? "maybe" : "no"}.</p>
      ) : invite.cancelled ? (
        <div className="mt-2 flex items-center gap-3 text-xs">
          <span className="font-medium text-[#C62828]">Cancelled</span>
          {eventUrl && <button type="button" disabled={busy} onClick={() => void mailApi.removeCancelled(message.id).then(() => setEventUrl(null))} className="font-medium text-[#D97757]">Remove from my calendar</button>}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {button("going", "Yes")}{button("maybe", "Maybe")}{button("declined", "No")}
          {eventUrl && <RouterLink to={eventUrl} className="ml-1 text-xs font-medium text-[#D97757]">Open in Calendar</RouterLink>}
        </div>
      )}
    </div>
  );
}

function MessageCard({ message, people, startOpen }: { message: Message; people: People; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [viewing, setViewing] = useState<number | null>(null);
  const files = useSavedAttachments(message.id);
  return (
    <article className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-3 p-3 text-left">
        <Avatar person={message.from} people={people} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--text)]">{shownName(message.from, people)}</span>
          <span className="block truncate text-xs text-[var(--text-muted)]">{open ? `to ${message.to.map(personName).join(", ") || "you"}` : message.text.slice(0, 120)}</span>
        </span>
        <span className="shrink-0 text-xs text-[var(--text-muted)]">{shortWhen(message.at)}</span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {message.invite && <InviteCard message={message} />}
          <MessageBody html={message.html} text={message.text} remoteImages={message.remote_images} />
          {message.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((a, i) => (
                <span key={a.part} className="inline-flex max-w-full items-center rounded-lg bg-[var(--hover)] text-xs text-[var(--text)]">
                  <button type="button" onClick={() => setViewing(i)} title={`Open ${a.name}`} className="flex min-w-0 items-center gap-1.5 rounded-l-lg py-1.5 pl-2.5 pr-1 hover:text-[#D97757]"><Paperclip className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{a.name}</span></button>
                  <button type="button" onClick={() => void mailApi.download(message.id, a.part, a.name).catch(() => toast.error("Couldn't get that attachment."))} aria-label={`Download ${a.name}`} title="Download" className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]"><Download className="h-3.5 w-3.5" /></button>
                  <SaveToFiles saved={files.saved.has(a.part)} saving={files.saving.has(a.part)} onSave={() => void files.save(a.part)} name={a.name} className="h-8 w-8" />
                </span>
              ))}
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
  const [answer, setAnswer] = useState<{ text: string; read: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // Follows the mailbox you're looking at, until you choose otherwise.
  const [scope, setScope] = useState<string | undefined>(viewing);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => setScope(viewing), [viewing]);
  const scoped = accounts.find((a) => a.id === scope);
  const canScope = accounts.length > 1 && !open;

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    if (!selected) return toast.error("Pick a model first.");
    setBusy(true);
    try {
      const got = await mailApi.ask({ question: q, provider_id: selected.provider_id, model_id: selected.model_id, account_id: open?.account_id ?? scoped?.id, thread_key: open?.key });
      setAnswer({ text: got.answer, read: got.read });
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
        <div className="mx-auto mb-2 max-w-3xl rounded-xl bg-[#D97757]/10 p-3 text-sm text-[var(--text)]">
          <div className="flex gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap">{answer.text}</p>
            <button type="button" onClick={() => setAnswer(null)} aria-label="Close answer" className="self-start text-[var(--text-muted)]"><X className="h-4 w-4" /></button>
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">From {answer.read} {answer.read === 1 ? "email" : "emails"}. AI can get things wrong, so check anything important.</p>
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
                  <p className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Ask about</p>
                  {[undefined, ...accounts].map((a) => (
                    <button key={a?.id ?? "all"} type="button" role="menuitemradio" aria-checked={scope === a?.id} onClick={() => { setScope(a?.id); setChoosing(false); }} className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]">
                      {a && <span style={{ backgroundColor: a.color }} className="h-2.5 w-2.5 shrink-0 rounded-full" />}
                      <span className="min-w-0 flex-1 truncate">{a?.email ?? "All mailboxes"}</span>
                      {scope === a?.id && <Check className="h-4 w-4 shrink-0 text-[#D97757]" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-[var(--hover)] px-3">
          {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#D97757]" /> : <Sparkles className="h-4 w-4 shrink-0 text-[#D97757]" />}
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
