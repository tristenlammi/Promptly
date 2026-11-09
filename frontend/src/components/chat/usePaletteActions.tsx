import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  AudioLines,
  CalendarPlus,
  CheckSquare,
  ClipboardList,
  FileText,
  ListChecks,
  ListPlus,
  MapPin,
  Mic,
  MessageSquarePlus,
  Presentation,
  StickyNote,
  Table2,
  Wallet,
  Zap,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { calendarApi, type CalUser } from "@/api/calendar";
import { formsApi } from "@/api/forms";
import { officeApi } from "@/api/office";
import { roomsApi } from "@/api/rooms";
import { addDays, localZone, parseYmd, shortDay, timeLabel, timeRange, ymd } from "@/calendar/dates";
import { extractError, openFile } from "@/components/files/helpers";
import { itemsApi, type ItemListEntry } from "@/items/api";
import type { TasksData } from "@/items/kinds/tasks/types";
import {
  findPlace,
  matchCreate,
  parseCommand,
  planEvent,
  planMessage,
  planMoney,
  planTask,
  type Command,
  type DoKind,
} from "@/lib/paletteCommands";
import { useCallPaletteRows } from "@/rtc/call/ui/paletteCalls";
import { useVoicePaletteRows } from "@/rtc/ui/paletteVoice";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { openNewNote } from "@/notes/newNote";

/*
 * The palette's "Do" rows (see ``lib/paletteCommands``): the typed command
 * on top, then the plain Create… actions. Nothing is made until the person
 * presses Enter (or clicks) on a row. Tasks and Budget write to the app's
 * default file — the one picked last time, else the most recently used —
 * and Tab on the row switches between files when there are several.
 */

export interface PaletteAction {
  key: string;
  icon: ReactNode;
  title: string;
  detail: string;
  /** Said outright — preselected. A guess is only offered. */
  sure: boolean;
  /** Which file it goes to, when there's a choice (Tab cycles). */
  target?: { label: string; count: number };
  /** Runs it. Resolves true when the palette should close. */
  run: () => Promise<boolean>;
  /** A heading of its own (e.g. "Voice"); else Do / Suggestion / Create. */
  group?: string;
}

const PICK_KEY = "promptly.palette.target.";
const ARCHIVE_TITLE = /\s—\sup to \d{4}-\d{2}-\d{2}$/;

function readPick(kind: string): string | null {
  try {
    return localStorage.getItem(PICK_KEY + kind);
  } catch {
    return null;
  }
}
function writePick(kind: string, id: string): void {
  try {
    localStorage.setItem(PICK_KEY + kind, id);
  } catch {
    /* private window */
  }
}

const ICONS: Record<DoKind, ReactNode> = {
  event: <CalendarPlus className="h-4 w-4" />,
  task: <ListPlus className="h-4 w-4" />,
  money: <Wallet className="h-4 w-4" />,
  note: <StickyNote className="h-4 w-4" />,
  list: <ListChecks className="h-4 w-4" />,
  voice: <Mic className="h-4 w-4" />,
  doc: <FileText className="h-4 w-4" />,
  sheet: <Table2 className="h-4 w-4" />,
  slides: <Presentation className="h-4 w-4" />,
  form: <ClipboardList className="h-4 w-4" />,
  goto: <ArrowRight className="h-4 w-4" />,
  message: <MessageSquarePlus className="h-4 w-4" />,
};

const FILE_WORD: Record<"doc" | "sheet" | "slides", string> = { doc: "doc", sheet: "sheet", slides: "slides" };
/** Notes (N1.7): a note, a list or a recording, opened in Notes. */
const NOTE_KINDS = new Set<DoKind>(["note", "list", "voice"]);

function money(n: number): string {
  return `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2).replace(/\.00$/, "")}`;
}

export function usePaletteActions(
  query: string,
  { navigate, setQuery }: { navigate: (to: string) => void; setQuery: (q: string) => void },
) {
  const cmd = useMemo(() => parseCommand(query), [query]);
  const meId = useAuthStore((s) => s.user?.id);

  // Which app file a task / transaction goes to.
  const appKind = cmd?.kind === "task" ? "tasks" : cmd?.kind === "money" ? "budget" : null;
  const { data: files } = useQuery({
    queryKey: ["palette", "item-files", appKind],
    queryFn: () => itemsApi.list(appKind!),
    enabled: !!appKind,
    staleTime: 60_000,
  });
  const [picks, setPicks] = useState<Record<string, string>>({});
  const targets = useMemo(() => (files ?? []).filter((f) => !ARCHIVE_TITLE.test(f.title)), [files]);
  const target: ItemListEntry | null = useMemo(() => {
    if (!appKind || !targets.length) return null;
    const want = picks[appKind] ?? readPick(appKind);
    return targets.find((f) => f.file_id === want) ?? targets[0];
  }, [appKind, targets, picks]);

  // People, once someone is named.
  const wantsPeople = cmd?.kind === "message" || (cmd?.kind === "event" && /\bwith\s+\S/i.test(cmd.text));
  const { data: people } = useQuery({
    queryKey: ["rooms", "people", ""],
    queryFn: () => roomsApi.people(""),
    staleTime: 60_000,
    enabled: wantsPeople,
  });
  const users: CalUser[] = useMemo(() => people ?? [], [people]);

  const doRow = useMemo(
    () => (cmd ? buildDo(cmd, { users, meId, target, targetCount: targets.length, navigate, setQuery }) : null),
    [cmd, users, meId, target, targets.length, navigate, setQuery],
  );

  const createRows = useMemo<PaletteAction[]>(() => {
    const t = query.trim();
    // A letter or two is the start of a search, not of "new …".
    if (cmd || (t && t.length < 3) || t.split(/\s+/).length > 3) return [];
    return matchCreate(t).slice(0, t ? 4 : undefined).map((a) => ({
      key: `create-${a.kind}`,
      icon: ICONS[a.kind],
      title: a.label,
      detail: NOTE_KINDS.has(a.kind)
        ? a.kind === "voice"
          ? "Start recording in Notes"
          : "Start one in Notes"
        : a.kind === "doc" || a.kind === "sheet" || a.kind === "slides" || a.kind === "form"
          ? "Make a blank one and open it"
          : `Type “${a.prefix.trim()} …”`,
      sure: false,
      run: async () => {
        if (a.kind === "note" || a.kind === "list" || a.kind === "voice") {
          openNewNote(navigate, a.kind);
          return true;
        }
        if (a.kind === "form") return makeForm("", navigate);
        if (a.kind === "doc" || a.kind === "sheet" || a.kind === "slides") return makeFile(a.kind, "", navigate);
        setQuery(a.prefix);
        return false;
      },
    }));
  }, [cmd, query, navigate, setQuery]);

  // Anything typed can be looked up on the map.
  const mapRow = useMemo<PaletteAction | null>(() => {
    const t = query.trim();
    if (cmd || t.length < 3) return null;
    return {
      key: "maps",
      icon: <MapPin className="h-4 w-4" />,
      title: `Find “${t}” on the map`,
      detail: "Open in Maps",
      sure: false,
      run: async () => {
        navigate(`/maps?q=${encodeURIComponent(t)}`);
        return true;
      },
    };
  }, [cmd, query, navigate]);

  // Talk to Promptly (WP-T4): on an empty palette, or when you look for it.
  const talkRow = useMemo<PaletteAction | null>(() => {
    const t = query.trim().toLowerCase();
    if (cmd || (t && !"talk to promptly voice speak".split(" ").some((w) => w.startsWith(t) || t.startsWith(w)))) return null;
    return {
      key: "talk",
      icon: <AudioLines className="h-4 w-4" />,
      title: "Talk to Promptly",
      detail: "A spoken conversation in a new chat · Ctrl+Shift+Space",
      sure: false,
      run: async () => {
        navigate("/chat?talk=1");
        return true;
      },
    };
  }, [cmd, query, navigate]);

  // Calls: join a voice channel, and Mute / Deafen / Leave while in one.
  const voiceRows = useVoicePaletteRows(query, navigate);
  // Calls: "Call Mum", "Video call Sam" (people you can call).
  const callRows = useCallPaletteRows(query, navigate);
  const callFirst = !doRow && callRows.length > 0 && callRows[0].sure;
  const voiceFirst = !doRow && !callFirst && voiceRows.length > 0 && voiceRows[0].sure;

  const actions = useMemo(
    () =>
      callFirst
        ? [...callRows, ...voiceRows, ...createRows, ...(mapRow ? [mapRow] : []), ...(talkRow ? [talkRow] : [])]
        : voiceFirst
          ? [...voiceRows, ...callRows, ...createRows, ...(mapRow ? [mapRow] : []), ...(talkRow ? [talkRow] : [])]
          : [...(doRow ? [doRow] : []), ...callRows, ...createRows, ...voiceRows, ...(mapRow ? [mapRow] : []), ...(talkRow ? [talkRow] : [])],
    [doRow, createRows, mapRow, voiceRows, voiceFirst, callRows, callFirst, talkRow],
  );

  /** Tab on the Do row: the next file to write to. */
  const cycleTarget = (dir: 1 | -1): boolean => {
    if (!appKind || targets.length < 2 || !target) return false;
    const i = targets.findIndex((f) => f.file_id === target.file_id);
    const next = targets[(i + dir + targets.length) % targets.length];
    setPicks((p) => ({ ...p, [appKind]: next.file_id }));
    writePick(appKind, next.file_id);
    return true;
  };

  return { actions, sureTop: !!doRow?.sure || voiceFirst || callFirst, cycleTarget };
}

interface Ctx {
  users: CalUser[];
  meId: string | undefined;
  target: ItemListEntry | null;
  targetCount: number;
  navigate: (to: string) => void;
  setQuery: (q: string) => void;
}

/** Make a Drive doc / sheet / deck. Untitled ones (and decks, which turn
 *  slide mode on when first opened) open straight away. */
async function makeFile(kind: "doc" | "sheet" | "slides", title: string, navigate: (to: string) => void): Promise<boolean> {
  try {
    if (kind === "slides") {
      const file = await officeApi.create({ kind: "whiteboard", title: title || "Untitled presentation" });
      navigate(`/files/whiteboard/${file.id}?slides=new`);
      return true;
    }
    const file = await officeApi.create({ kind: kind === "doc" ? "document" : kind, ...(title ? { title } : {}) });
    const open = () => {
      if (!openFile(file, navigate)) navigate(`/files/f/${file.id}`);
    };
    if (!title) open();
    else toast.success(`Created ${FILE_WORD[kind]} “${title}”`, { action: { label: "Open", onClick: open } });
    return true;
  } catch (e) {
    toast.error(extractError(e) || "Couldn't create it.");
    return false;
  }
}

/** A new form in your Forms folder (Forms WP-F1.7), opened in the builder. */
async function makeForm(title: string, navigate: (to: string) => void): Promise<boolean> {
  try {
    const file = await formsApi.create(title ? { title } : {});
    navigate(`/files/form/${file.id}`);
    return true;
  } catch (e) {
    toast.error(extractError(e) || "Couldn't make the form.");
    return false;
  }
}

/** The file a task / transaction goes to: the chosen one, else the app's own. */
async function fileFor(kind: "tasks" | "budget", target: ItemListEntry | null): Promise<string> {
  return target?.file_id ?? (await itemsApi.openApp(kind)).file_id;
}

function buildDo(cmd: Command, c: Ctx): PaletteAction {
  const base = { key: `do-${cmd.kind}`, icon: ICONS[cmd.kind], sure: cmd.sure };
  const fill = (prefix: string, title: string, detail: string): PaletteAction => ({
    ...base,
    title,
    detail,
    run: async () => {
      c.setQuery(prefix);
      return false;
    },
  });
  const today = ymd(new Date());
  const targetInfo = c.target ? { label: c.target.title, count: c.targetCount } : undefined;

  switch (cmd.kind) {
    case "event": {
      const q = planEvent(cmd.text, { users: c.users, meId: c.meId });
      if (!q.title) return fill("new event ", "New event", "Type what and when — e.g. lunch with Sam fri 1pm");
      const when = q.allDay ? shortDay(q.start) : `${shortDay(q.start)}, ${timeRange(q.start, q.end)}`;
      const bits = [when, q.location && `at ${q.location}`, q.guests.length ? `invites ${q.guests.map((g) => g.username).join(", ")}` : "", q.repeat ? "repeats" : ""];
      return {
        ...base,
        title: `New event: “${q.title}”`,
        detail: bits.filter(Boolean).join(" · "),
        run: async () => {
          try {
            const r = await calendarApi.create({
              title: q.title,
              all_day: q.allDay,
              ...(q.allDay ? { start: ymd(q.start), end: ymd(addDays(q.end, -1)) } : { start: q.start.toISOString(), end: q.end.toISOString() }),
              tz: localZone(),
              calendar_id: null,
              repeat: q.repeat,
              location: q.location,
              guests: q.guests.map((g) => g.id),
            });
            const id = r.event.event_id;
            toast.success(`Added “${q.title}” · ${q.allDay ? shortDay(q.start) : `${shortDay(q.start)}, ${timeLabel(q.start)}`}`, {
              action: { label: "Open", onClick: () => c.navigate(`/calendar?event=${id}`) },
            });
            return true;
          } catch (e) {
            toast.error(extractError(e) || "Couldn't add the event.");
            return false;
          }
        },
      };
    }
    case "task": {
      const p = planTask(cmd.text, today);
      if (!p.title) return fill("add task ", "New task", "Type the task — e.g. buy milk tomorrow");
      const due = p.due ? `Due ${p.due === today ? "today" : shortDay(parseYmd(p.due))}` : "No date";
      return {
        ...base,
        icon: cmd.sure ? base.icon : <CheckSquare className="h-4 w-4" />,
        title: `Add task: “${p.title}”`,
        detail: [due, p.time && timeLabel(new Date(`2000-01-01T${p.time}`)), p.repeat ? "repeats" : "", p.tags.map((t) => `#${t}`).join(" ")].filter(Boolean).join(" · "),
        target: targetInfo,
        run: async () => {
          try {
            const fileId = await fileFor("tasks", c.target);
            // A #word may name one of the file's lists.
            let plan = p;
            if (cmd.text.includes("#")) {
              const doc = await itemsApi.get<TasksData>(fileId);
              plan = planTask(cmd.text, today, doc.data.lists ?? []);
            }
            await itemsApi.action(fileId, "add_tasks", {
              tasks: [
                {
                  title: plan.title,
                  due: plan.due,
                  time: plan.time,
                  repeat: plan.repeat,
                  priority: plan.priority,
                  tags: plan.tags,
                  ...(plan.listName ? { list: plan.listName } : {}),
                },
              ],
            });
            toast.success(`Added task “${plan.title}”${plan.due ? ` · ${plan.due === today ? "today" : shortDay(parseYmd(plan.due))}` : ""}`, {
              action: { label: "Open", onClick: () => c.navigate(`/apps/tasks/${fileId}`) },
            });
            return true;
          } catch (e) {
            toast.error(extractError(e) || "Couldn't add the task.");
            return false;
          }
        },
      };
    }
    case "money": {
      const m = planMoney(cmd.text, today);
      if (!m) return fill("log $", "Log an expense", "Type an amount and what for — e.g. $40 fuel");
      if (!m.payee) return fill(`log ${cmd.text.trim()} `, `Log ${money(m.amount)}`, "Add what it was for — e.g. fuel");
      return {
        ...base,
        title: `Log ${money(m.amount)} · ${m.payee}`,
        detail: [m.date === today ? "Today" : shortDay(parseYmd(m.date)), m.amount > 0 ? "Money in" : "Spending"].join(" · "),
        target: targetInfo,
        run: async () => {
          try {
            const fileId = await fileFor("budget", c.target);
            const r = await itemsApi.action(fileId, "add_transactions", { items: [{ date: m.date, amount: m.amount, payee: m.payee }] });
            toast.success(r.summary || `Logged ${money(m.amount)} ${m.payee}`, {
              action: { label: "Open", onClick: () => c.navigate(`/apps/budget/${fileId}`) },
            });
            return true;
          } catch (e) {
            toast.error(extractError(e) || "Couldn't log it.");
            return false;
          }
        },
      };
    }
    case "note":
    case "list":
    case "voice": {
      const kind = cmd.kind;
      const words = cmd.text.slice(0, 2000).trim();
      const label = { note: "New note", list: "New list", voice: "Record a voice note" }[kind];
      return {
        ...base,
        title: words && kind !== "voice" ? `${label}: “${words.length > 80 ? `${words.slice(0, 80)}…` : words}”` : label,
        detail: kind === "voice" ? "Start recording in Notes" : kind === "list" && words ? "Each comma starts a new item · opens in Notes" : "Opens in Notes",
        run: async () => {
          openNewNote(c.navigate, kind, kind === "voice" ? "" : words);
          return true;
        },
      };
    }
    case "doc":
    case "sheet":
    case "slides": {
      const kind = cmd.kind;
      const title = cmd.text.slice(0, 200).trim();
      const label = { doc: "New doc", sheet: "New sheet", slides: "New slides" }[kind];
      return {
        ...base,
        title: title ? `${label}: “${title}”` : label,
        detail: kind === "slides" ? "Creates the deck and opens it" : title ? "Creates it in My files" : "Make a blank one and open it",
        run: () => makeFile(kind, title, c.navigate),
      };
    }
    case "form": {
      const title = cmd.text.slice(0, 200).trim();
      return {
        ...base,
        title: title ? `New form: “${title}”` : "New form",
        detail: "Makes it in your Forms folder and opens it",
        run: () => makeForm(title, c.navigate),
      };
    }
    case "goto": {
      const place = findPlace(cmd.text, !cmd.sure);
      return {
        ...base,
        icon: <ArrowRight className="h-4 w-4" />,
        title: `Go to ${place?.label ?? cmd.text}`,
        detail: place?.to ?? "",
        run: async () => {
          if (!place) return false;
          c.navigate(place.to);
          return true;
        },
      };
    }
    case "message": {
      const m = planMessage(cmd.text, c.users);
      if (!m.name)
        return {
          ...base,
          title: "New room message",
          detail: "Type who to — e.g. message sam see you at 5 — or press Enter to pick",
          run: async () => {
            c.navigate("/rooms/dm");
            return true;
          },
        };
      if (!m.user)
        return {
          ...base,
          sure: false,
          title: `Message ${m.name}`,
          detail: c.users.length ? `No one called “${m.name}” here` : "Finding people…",
          run: async () => false,
        };
      const u = m.user;
      return {
        ...base,
        title: m.body ? `Message ${u.username}: “${m.body}”` : `Open a direct message with ${u.username}`,
        detail: m.body ? "Sends it in Rooms" : "Opens Rooms",
        run: async () => {
          try {
            const room = await roomsApi.openDm([u.id]);
            if (!m.body) {
              c.navigate(`/rooms/r/${room.id}`);
              return true;
            }
            await roomsApi.send(room.id, { body: m.body });
            toast.success(`Sent to ${u.username}`, { action: { label: "Open", onClick: () => c.navigate(`/rooms/r/${room.id}`) } });
            return true;
          } catch (e) {
            toast.error(extractError(e) || "Couldn't send it.");
            return false;
          }
        },
      };
    }
  }
}

/** The Do / Create rows, at the top of the palette. */
export function ActionRows({
  actions,
  cursor,
  busyKey,
  onRun,
  onHover,
  onCycle,
}: {
  actions: PaletteAction[];
  cursor: number;
  busyKey: string | null;
  onRun: (a: PaletteAction) => void;
  onHover: (idx: number) => void;
  onCycle: () => void;
}) {
  if (!actions.length) return null;
  const groupOf = (a: PaletteAction) => a.group ?? (a.key.startsWith("do-") ? (a.sure ? "Do" : "Suggestion") : "Create");
  return (
    <div className="py-1">
      {actions.map((a, idx) => {
        const active = idx === cursor;
        const label = idx === 0 || groupOf(actions[idx - 1]) !== groupOf(a) ? groupOf(a) : null;
        return (
          <div key={a.key}>
            {label && (
              <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                {label === "Do" ? <Zap className="h-3 w-3" /> : null}
                {label}
              </div>
            )}
            <button
              type="button"
              data-idx={idx}
              onMouseEnter={() => onHover(idx)}
              onClick={() => onRun(a)}
              disabled={busyKey !== null}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left transition",
                active ? "bg-[var(--accent)]/10 text-[var(--text)]" : "hover:bg-[var(--surface-2)]"
              )}
            >
              <span className={cn("shrink-0", a.sure || active ? "text-[var(--accent)]" : "text-[var(--text-muted)]")}>{a.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--text)]">{a.title}</span>
                {a.detail && <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">{a.detail}</span>}
              </span>
              {a.target && (
                <span
                  role="button"
                  tabIndex={-1}
                  title={a.target.count > 1 ? "Change file (Tab)" : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (a.target!.count > 1) onCycle();
                  }}
                  className={cn(
                    "max-w-[10rem] shrink-0 truncate rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]",
                    a.target.count > 1 && "hover:border-[var(--accent)] hover:text-[var(--text)]"
                  )}
                >
                  in {a.target.label}
                  {a.target.count > 1 ? " ⇥" : ""}
                </span>
              )}
              {active && busyKey === null && (
                <kbd className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-px font-mono text-[10px] text-[var(--text)]">⏎</kbd>
              )}
              {busyKey === a.key && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">Working…</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}
