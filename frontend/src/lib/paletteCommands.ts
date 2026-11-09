import type { CalUser } from "@/api/calendar";
import { WEEK_START, ymd } from "@/calendar/dates";
import { parseEvent, type QuickEvent } from "@/calendar/quickadd";
import { parseQuick } from "@/items/kinds/tasks/quickadd";
import { plusDays } from "@/items/kinds/tasks/recur";
import type { Repeat, TaskList } from "@/items/kinds/tasks/types";
import { cleanTitle, parseWhen } from "@/lib/quickdate";

/*
 * The "Do" half of the Ctrl+K palette: typed commands → something to make.
 *
 *   new event lunch with Sam fri 1pm     → a calendar event (Calendar's quick add)
 *   add task buy milk tomorrow           → a task (Tasks' quick add)
 *   remind me to call mum at 5           → a task at 17:00 today
 *   log $40 fuel / income $500 salary    → a Budget transaction
 *   note … / new list … / voice note     → a note in Notes (a list, a recording)
 *   new doc / sheet / slides <title>     → a Drive file
 *   go to calendar                       → somewhere in Promptly
 *   message sam see you soon             → a direct message in Rooms
 *
 * Dates and times are the shared quick-add wording (``lib/quickdate``, via
 * Calendar's and Tasks' own parsers). Pure: nothing here talks to the server.
 * A command said outright is ``sure``; a guess (a bare "$12 coffee", "call
 * mum tomorrow") is only ever offered, never preselected.
 */

export type DoKind = "event" | "task" | "money" | "note" | "list" | "voice" | "doc" | "sheet" | "slides" | "form" | "goto" | "message";

export interface Command {
  kind: DoKind;
  /** What follows the verb. */
  text: string;
  /** Said outright ("new event …"); false = a guess, offered not preselected. */
  sure: boolean;
}

/** The plain "Create…" actions, and the words that start each one. */
export const CREATE_ACTIONS: { kind: DoKind; label: string; prefix: string; words: string }[] = [
  { kind: "event", label: "New event", prefix: "new event ", words: "new create add event meeting appointment calendar schedule" },
  { kind: "task", label: "New task", prefix: "add task ", words: "new create add task todo reminder remind" },
  { kind: "doc", label: "New doc", prefix: "new doc ", words: "new create document doc word" },
  { kind: "sheet", label: "New sheet", prefix: "new sheet ", words: "new create spreadsheet sheet excel" },
  { kind: "slides", label: "New slides", prefix: "new slides ", words: "new create slides presentation deck" },
  { kind: "form", label: "New form", prefix: "new form ", words: "new create form survey rsvp signup sign-up questionnaire poll" },
  { kind: "note", label: "New note", prefix: "note ", words: "new create note notes keep" },
  { kind: "list", label: "New list", prefix: "new list ", words: "new create list checklist shopping notes keep" },
  { kind: "voice", label: "Record a voice note", prefix: "voice note", words: "new record voice note audio recording memo notes" },
  { kind: "money", label: "Log an expense", prefix: "log $", words: "new add log expense spend spent budget transaction money" },
  { kind: "message", label: "New room message", prefix: "message ", words: "new room message dm direct chat send" },
];

/** Create actions whose words every typed word starts (empty → all). */
export function matchCreate(input: string): typeof CREATE_ACTIONS {
  const q = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!q.length) return CREATE_ACTIONS;
  return CREATE_ACTIONS.filter((a) => {
    const words = `${a.label.toLowerCase()} ${a.words}`.split(/\s+/);
    return q.every((w) => words.some((x) => x.startsWith(w)));
  });
}

const RULES: [RegExp, DoKind][] = [
  [/^(?:new|add|create|make|schedule|book)\s+(?:an?\s+)?(?:event|meeting|appointment|appt)\b:?\s*(.*)$/i, "event"],
  [/^(?:event|meeting)\s*:\s*(.*)$/i, "event"],
  [/^(?:new|add|create|make)\s+(?:an?\s+)?(?:task|to-?do|reminder)\b:?\s*(.*)$/i, "task"],
  [/^(?:task|to-?do)\s*:\s*(.*)$/i, "task"],
  [/^remind\s+me\s+(?:to\s+)?(.+)$/i, "task"],
  [/^(?:log|spent|spend|paid|(?:add|new|log)\s+(?:an?\s+)?expense|expense)\s+(.*)$/i, "money"],
  [/^(?:new|create|make|record)\s+(?:an?\s+)?(?:voice\s+note|voice\s+memo|recording)\b:?\s*(.*)$/i, "voice"],
  [/^voice\s+(?:note|memo)\b:?\s*(.*)$/i, "voice"],
  [/^(?:new|create|make)\s+(?:an?\s+)?note\b:?\s*(.*)$/i, "note"],
  [/^note\b:?\s*(.*)$/i, "note"],
  [/^(?:new|create|make)\s+(?:an?\s+)?(?:list|checklist|shopping\s+list)\b:?\s*(.*)$/i, "list"],
  [/^(?:new|create|make)\s+(?:an?\s+)?(?:doc|document|word\s+doc(?:ument)?)\b:?\s*(.*)$/i, "doc"],
  [/^(?:new|create|make)\s+(?:an?\s+)?(?:sheet|spreadsheet)\b:?\s*(.*)$/i, "sheet"],
  [/^(?:new|create|make)\s+(?:an?\s+)?(?:slides?|slide\s*deck|deck|presentation)\b:?\s*(.*)$/i, "slides"],
  [/^(?:new|create|make)\s+(?:an?\s+)?(?:form|survey|questionnaire|rsvp(?:\s+form)?|sign-?up\s+(?:form|sheet))\b:?\s*(.*)$/i, "form"],
  [/^(?:go\s*to|open|show(?:\s+me)?|switch\s+to|take\s+me\s+to)\s+(.+)$/i, "goto"],
  [/^new\s+(?:room\s+)?(?:message|dm)\b\s*(?:to\s+)?(.*)$/i, "message"],
  [/^(?:message|msg|dm)\s+(.*)$/i, "message"],
];

const INCOME = /^(?:income|earned|got\s+paid|received)\s+(.*)$/i;

/** What ``input`` asks to do, or null when it's just a search. */
export function parseCommand(input: string): Command | null {
  const s = input.trim().replace(/\s+/g, " ");
  if (!s) return null;
  for (const [re, kind] of RULES) {
    const m = re.exec(s);
    if (!m) continue;
    const text = (m[1] ?? "").trim();
    if (kind === "money" && !readAmount(text)) continue;
    if (kind === "goto" && !findPlace(text)) continue;
    return { kind, text, sure: true };
  }
  const inc = INCOME.exec(s);
  if (inc && readAmount(inc[1])) return { kind: "money", text: `+${inc[1].replace(/^\+/, "")}`, sure: true };

  // ---- guesses: offered, never preselected
  if (/^[+-]?\s*[$€£]\s?\d/.test(s)) return { kind: "money", text: s, sure: false };
  const add = /^add\s+(.+)$/i.exec(s);
  if (add) return { kind: "task", text: add[1], sure: false };
  if (findPlace(s, true)) return { kind: "goto", text: s, sure: false };
  if (s.split(" ").length >= 2) {
    const today = ymd(new Date());
    const w = parseWhen(s, today);
    if ((w.due || w.time) && cleanTitle(w.rest)) {
      const ev = /\d\s*(?:am|pm)?\s*(?:-|–|to|until)\s*\d|\bfor\s+\d+\s*(?:h|hours?|min)/i.test(s);
      return { kind: ev ? "event" : "task", text: s, sure: false };
    }
  }
  return null;
}

/* ------------------------------------------------------------- tasks */

export interface TaskPlan {
  title: string;
  due: string | null;
  time: string | null;
  repeat: Repeat | null;
  priority: number;
  tags: string[];
  /** A #list that names one of the file's lists. */
  listName: string | null;
}

export function planTask(text: string, today: string, lists: TaskList[] = []): TaskPlan {
  // The Tasks parser's weeks start on Monday = 0.
  const p = parseQuick(text, lists, today, (WEEK_START + 6) % 7);
  return {
    title: p.title,
    due: p.due,
    time: p.time,
    repeat: p.repeat,
    priority: p.priority ?? 0,
    tags: p.tags,
    listName: p.listId ? (lists.find((l) => l.id === p.listId)?.name ?? null) : null,
  };
}

/* ------------------------------------------------------------- events */

export function planEvent(text: string, opts: { users?: CalUser[]; meId?: string; now?: Date } = {}): QuickEvent {
  return parseEvent(text, opts);
}

/* ------------------------------------------------------------- money */

export interface MoneyPlan {
  /** Dollars; negative = money out. */
  amount: number;
  payee: string;
  /** YYYY-MM-DD. */
  date: string;
}

const AMOUNT_MARKED = /(^|\s)([+-])?\s*[$€£]\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?=\s|$|[,.;])/;
const AMOUNT_BARE = /(^|\s)([+-])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s*(?:dollars|bucks|aud|usd|nzd|gbp|eur))?(?=\s|$|[,;])/i;

/** The first amount in ``text`` (a $-marked one first): value, sign, where. */
function readAmount(text: string): { value: number; sign: "+" | "-" | null; index: number; length: number } | null {
  const m = AMOUNT_MARKED.exec(text) ?? AMOUNT_BARE.exec(text);
  if (!m) return null;
  const value = Number(m[3].replace(/,/g, "") + (m[4] ? `.${m[4]}` : ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, sign: (m[2] as "+" | "-" | undefined) ?? null, index: m.index + m[1].length, length: m[0].length - m[1].length };
}

/** "log $40 fuel yesterday" → −40, "Fuel", yesterday. Income is "+$…". */
export function planMoney(text: string, today: string): MoneyPlan | null {
  const a = readAmount(text);
  if (!a) return null;
  let rest = ` ${text.slice(0, a.index)} ${text.slice(a.index + a.length)} `;
  let date = today;
  const y = /\s(?:on\s+)?yesterday\b/i.exec(rest);
  if (y) {
    date = plusDays(today, -1);
    rest = rest.slice(0, y.index) + " " + rest.slice(y.index + y[0].length);
  }
  const w = parseWhen(rest, today);
  // A day in the past is what's meant ("on Mon" = last Monday, not next).
  if (!y && w.due) date = w.due > today && daysBetween(today, w.due) <= 7 ? plusDays(w.due, -7) : w.due;
  let payee = cleanTitle(w.rest).replace(/^(?:on|for|at|from|to)\s+/i, "").trim();
  payee = payee.charAt(0).toUpperCase() + payee.slice(1);
  return { amount: a.sign === "+" ? a.value : -a.value, payee: payee.slice(0, 120), date };
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/* ------------------------------------------------------------- places */

export interface Place {
  label: string;
  to: string;
  words: string[];
}

export const PLACES: Place[] = [
  { label: "Chat", to: "/chat", words: ["chat", "chats", "conversations"] },
  { label: "Today", to: "/today", words: ["today", "my day", "home", "my work", "cards", "shifts"] },
  { label: "Calendar", to: "/calendar", words: ["calendar", "cal", "events"] },
  { label: "Rooms", to: "/rooms", words: ["rooms", "room", "messages", "dms"] },
  { label: "Notes", to: "/notes", words: ["notes", "keep", "my notes", "shopping list"] },
  // Passwords is its own page (the route in App.tsx does a full page load). Item
  // names can't be searched from here, by design; the vault page has its own palette.
  { label: "Passwords", to: "/passwords", words: ["passwords", "password", "vault", "logins", "2fa", "totp"] },
  { label: "Files", to: "/files", words: ["files", "drive", "my files", "documents", "docs"] },
  { label: "Photos", to: "/files/photos", words: ["photos", "pictures", "gallery"] },
  { label: "Workspaces", to: "/workspaces", words: ["workspaces", "workspace"] },
  { label: "Automations", to: "/tasks", words: ["automations", "automation"] },
  { label: "Apps", to: "/apps", words: ["apps", "launcher"] },
  { label: "Item Store", to: "/apps/store", words: ["store", "app store", "item store"] },
  { label: "Tasks", to: "/apps/tasks", words: ["tasks", "todo", "todos", "to-do", "reminders"] },
  { label: "Budget", to: "/apps/budget", words: ["budget", "money", "finances", "spending"] },
  { label: "Contacts", to: "/apps/contacts", words: ["contacts", "people", "address book"] },
  { label: "Habits", to: "/apps/habits", words: ["habits"] },
  { label: "Journal", to: "/apps/journal", words: ["journal", "diary"] },
  { label: "Workout", to: "/apps/workout", words: ["workout", "workouts", "gym"] },
  { label: "Meal plan", to: "/apps/mealplan", words: ["meal plan", "mealplan"] },
  { label: "Recipes", to: "/apps/meals", words: ["meals", "recipes"] },
  { label: "Health", to: "/apps/health", words: ["health"] },
  { label: "Trips", to: "/apps/trip", words: ["trip", "trips", "travel"] },
  { label: "Flashcards", to: "/apps/flashcards", words: ["flashcards", "cards deck"] },
  { label: "Board games", to: "/apps/boardgames", words: ["board games", "boardgames"] },
  { label: "Starred files", to: "/files/starred", words: ["starred"] },
  { label: "Recent files", to: "/files/recent", words: ["recent", "recents"] },
  { label: "Shared with me", to: "/files/shared", words: ["shared", "shared with me"] },
  { label: "Trash", to: "/files/trash", words: ["trash", "bin", "deleted"] },
  { label: "Account settings", to: "/account", words: ["account", "settings", "preferences", "profile"] },
  { label: "Admin", to: "/admin", words: ["admin", "admin panel"] },
];

/** Where ``text`` names ("calendar", "the budget app"); ``exact`` only
 *  takes a whole name (for guesses from a bare word). */
export function findPlace(text: string, exact = false): Place | null {
  const t = text
    .toLowerCase()
    .replace(/^(?:the|my)\s+/, "")
    .replace(/\s+(?:app|page|tab)$/, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (!t) return null;
  const hit = PLACES.find((p) => p.words.includes(t) || p.label.toLowerCase() === t);
  if (hit || exact || t.length < 3) return hit ?? null;
  const pre = PLACES.filter((p) => p.words.some((w) => w.startsWith(t)) || p.label.toLowerCase().startsWith(t));
  return pre.length === 1 ? pre[0] : null;
}

/* ------------------------------------------------------------- messages */

export interface MessagePlan {
  /** The name as typed (empty: no one named yet). */
  name: string;
  user: CalUser | null;
  body: string;
}

export function planMessage(text: string, users: CalUser[]): MessagePlan {
  const m = /^(?:to\s+)?@?([\p{L}\p{N}_.'-]+)[:,]?\s*(.*)$/u.exec(text.trim());
  if (!m) return { name: "", user: null, body: "" };
  const name = m[1].toLowerCase();
  const user = users.find((u) => u.username.toLowerCase() === name) ?? users.find((u) => u.username.toLowerCase().startsWith(name)) ?? null;
  const body = m[2].replace(/^(?:saying|that)\s+/i, "").trim();
  return { name: m[1], user, body };
}
