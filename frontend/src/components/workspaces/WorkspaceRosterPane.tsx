import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  Pencil,
  Plus,
  Repeat,
  Tags,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  workspacesApi,
  type RosterDoc,
  type RosterShift,
  type RosterTag,
  type RosterTemplate,
  type WorkspaceItemNode,
  type WorkspaceParticipant,
} from "@/api/workspaces";
import { useWorkspace } from "@/hooks/useWorkspaces";
import { cn } from "@/utils/cn";
import { ItemPaneHeader } from "./ItemPaneHeader";

type SaveState = "idle" | "saving" | "saved" | "error";
type View = "week" | "month";

const SAVE_DEBOUNCE_MS = 700;

const PALETTE = [
  "#E5679B", "#E0952B", "#4C86E0", "#1FA97A",
  "#8B6CE6", "#159AA8", "#D97757", "#7C82F0",
];
const DEFAULT_TAGS: RosterTag[] = [
  { id: "open", label: "Open", color: "#1FA97A" },
  { id: "close", label: "Close", color: "#8B6CE6" },
  { id: "front", label: "Front", color: "#4C86E0" },
  { id: "kitchen", label: "Kitchen", color: "#E0952B" },
];

function emptyDoc(): RosterDoc {
  return {
    settings: {
      published: false,
      publishedAt: null,
      publishedHash: null,
      targets: {},
      colors: {},
      defaultStart: "09:00",
      defaultEnd: "17:00",
      tags: DEFAULT_TAGS,
      templates: [],
    },
    shifts: [],
  };
}

/** Stable hash of the schedule, used to flag unpublished edits. */
function shiftsHash(shifts: RosterShift[]): string {
  return JSON.stringify(
    [...shifts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => [s.personId, s.date, s.timed, s.start, s.end, s.hours, s.tags, s.color, s.note])
  );
}

/* ------------------------- date helpers (local, no UTC drift) ---------- */
function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function mondayOf(d: Date): Date {
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  return addDays(d, -dow);
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function sameDay(a: Date, b: Date): boolean {
  return isoOf(a) === isoOf(b);
}
function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function shiftHours(sh: RosterShift): number {
  if (!sh.timed || !sh.start || !sh.end) return sh.hours;
  let d = toMin(sh.end) - toMin(sh.start);
  if (d < 0) d += 24 * 60; // overnight
  return Math.round((d / 60) * 4) / 4;
}
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function prettyDate(iso: string): string {
  const d = parseISO(iso);
  return `${DOW[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function uid(): string {
  return "s" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function tplSummary(t: RosterTemplate, tags: RosterTag[]): string {
  const when = t.timed ? `${t.start}–${t.end}` : `${t.hours}h`;
  const tg = t.tags
    .map((id) => tags.find((x) => x.id === id)?.label)
    .filter(Boolean)
    .join(", ");
  return `${when}${tg ? ` · ${tg}` : ""}`;
}

/* ============================ pane ==================================== */
export function WorkspaceRosterPane({
  workspaceId,
  rosterId,
  node,
}: {
  workspaceId: string;
  rosterId: string;
  node: WorkspaceItemNode;
  canEdit: boolean;
}) {
  const { data: ws } = useWorkspace(workspaceId);
  // Rosters are an owner/admin surface — plain editors and viewers get it
  // read-only (the backend enforces the same on every roster mutation).
  const canEdit =
    ws?.access_role === "owner" || ws?.access_role === "admin";
  const members = useMemo<WorkspaceParticipant[]>(
    () =>
      [ws?.owner, ...(ws?.collaborators ?? [])].filter(
        Boolean
      ) as WorkspaceParticipant[],
    [ws]
  );
  const memberById = useCallback(
    (id: string) => members.find((m) => m.user_id === id) ?? null,
    [members]
  );

  const [doc, setDoc] = useState<RosterDoc | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<Date>(() => mondayOf(new Date()));
  const [editing, setEditing] = useState<string | null>(null);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [templateFilter, setTemplateFilter] = useState<string | null>(null);
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);
  const [manageTemplatesOpen, setManageTemplatesOpen] = useState(false);
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  const [personEditing, setPersonEditing] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // Load (seed an empty roster when never saved).
  useEffect(() => {
    let cancelled = false;
    workspacesApi
      .getRoster(workspaceId, rosterId)
      .then((r) => {
        if (cancelled) return;
        const d = (r.data as RosterDoc | null) ?? emptyDoc();
        if (!d.settings) d.settings = emptyDoc().settings;
        if (!d.settings.tags?.length) d.settings.tags = DEFAULT_TAGS;
        if (!Array.isArray(d.settings.templates)) d.settings.templates = [];
        if (!Array.isArray(d.shifts)) d.shifts = [];
        setDoc(d);
      })
      .catch(() => {
        if (!cancelled) setDoc(emptyDoc());
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, rosterId]);

  const flatten = useCallback(
    (d: RosterDoc): string => {
      const byDate = new Map<string, RosterShift[]>();
      for (const s of d.shifts) {
        const arr = byDate.get(s.date) ?? [];
        arr.push(s);
        byDate.set(s.date, arr);
      }
      const dates = [...byDate.keys()].sort();
      const lines = [`# Roster: ${node.title || "Roster"}`, ""];
      for (const date of dates) {
        const items = (byDate.get(date) ?? []).map((s) => {
          const who = memberById(s.personId)?.username ?? "Someone";
          const when =
            s.timed && s.start && s.end
              ? `${s.start}–${s.end} (${shiftHours(s)}h)`
              : `${shiftHours(s)}h`;
          const tags = s.tags.length ? ` [${s.tags.join(", ")}]` : "";
          const note = s.note ? ` — ${s.note}` : "";
          return `${who} ${when}${tags}${note}`;
        });
        lines.push(`${prettyDate(date)}: ${items.join("; ")}`);
      }
      return lines.join("\n").slice(0, 100_000);
    },
    [memberById, node.title]
  );

  // Persist a mutated doc (debounced).
  const commit = useCallback(
    (next: RosterDoc) => {
      setDoc(next);
      if (!canEdit) return;
      dirtyRef.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        setSaveState("saving");
        workspacesApi
          .saveRoster(workspaceId, rosterId, {
            data: next,
            content_text: flatten(next),
          })
          .then(() => aliveRef.current && setSaveState("saved"))
          .catch(() => aliveRef.current && setSaveState("error"));
      }, SAVE_DEBOUNCE_MS);
    },
    [canEdit, workspaceId, rosterId, flatten]
  );

  const colorOf = useCallback(
    (personId: string): string => {
      const override = doc?.settings.colors[personId];
      if (override) return override;
      const idx = members.findIndex((m) => m.user_id === personId);
      return PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length];
    },
    [doc, members]
  );

  /* ------------------------- calendar model ------------------------ */
  const days: Date[] = useMemo(() => {
    if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
    // month: full weeks (Mon-first) spanning the anchor's month
    const first = startOfMonth(anchor);
    const gridStart = mondayOf(first);
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      out.push(d);
      if (i >= 27 && d.getMonth() !== first.getMonth() && d.getDay() === 0) break;
    }
    return out;
  }, [view, anchor]);

  const shiftsByDate = useMemo(() => {
    const map = new Map<string, RosterShift[]>();
    if (!doc) return map;
    for (const s of doc.shifts) {
      if (personFilter && s.personId !== personFilter) continue;
      if (tagFilter && !s.tags.includes(tagFilter)) continue;
      if (templateFilter && s.templateId !== templateFilter) continue;
      const arr = map.get(s.date) ?? [];
      arr.push(s);
      map.set(s.date, arr);
    }
    return map;
  }, [doc, personFilter, tagFilter, templateFilter]);

  // Per-person weekly hours (for the visible week / month window).
  const windowDates = useMemo(() => new Set(days.map(isoOf)), [days]);
  const hoursFor = useCallback(
    (personId: string): number => {
      if (!doc) return 0;
      return doc.shifts
        .filter((s) => s.personId === personId && windowDates.has(s.date))
        .reduce((a, s) => a + shiftHours(s), 0);
    },
    [doc, windowDates]
  );
  const targetOf = (personId: string) => doc?.settings.targets[personId] ?? 38;

  // Conflicts: two shifts for the same person on the same date whose times
  // overlap (untimed shifts conflict with any other same-day shift).
  const conflictIds = useMemo(() => {
    const bad = new Set<string>();
    if (!doc) return bad;
    const byPD = new Map<string, RosterShift[]>();
    for (const s of doc.shifts) {
      const k = `${s.personId}|${s.date}`;
      const arr = byPD.get(k) ?? [];
      arr.push(s);
      byPD.set(k, arr);
    }
    for (const arr of byPD.values()) {
      if (arr.length < 2) continue;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          const overlap =
            !a.timed || !b.timed || !a.start || !a.end || !b.start || !b.end
              ? true
              : toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);
          if (overlap) {
            bad.add(a.id);
            bad.add(b.id);
          }
        }
      }
    }
    return bad;
  }, [doc]);

  /* ------------------------- shift mutations ----------------------- */
  const assign = useCallback(
    (personId: string, dates: string[]) => {
      if (!doc) return;
      const s = doc.settings;
      // A selected template stamps its times/tags/colour/note; with no
      // template active the person drops on the default 9–5 (the settings
      // default start/end), no tags or note. The person's own default tags
      // are still merged in (they belong to the person, not the template).
      const tpl = s.templates.find((t) => t.id === activeTemplate) ?? null;
      const personTags = s.personTags?.[personId] ?? [];
      const created: RosterShift[] = dates.map((date) => ({
        id: uid(),
        personId,
        date,
        timed: tpl ? tpl.timed : true,
        start: tpl ? tpl.start : s.defaultStart,
        end: tpl ? tpl.end : s.defaultEnd,
        hours: tpl ? tpl.hours : 0,
        tags: [...new Set([...(tpl ? tpl.tags : []), ...personTags])],
        // A template always stamps a concrete colour (its own, or terracotta
        // if left unset) so its shifts match its pill; a person dropped with
        // no template active keeps their own colour (null → person colour).
        color: tpl ? tpl.color ?? "#D97757" : null,
        note: tpl?.note ?? "",
        recurGroup: null,
        templateId: tpl?.id ?? null,
      }));
      commit({ ...doc, shifts: [...doc.shifts, ...created] });
    },
    [doc, commit, activeTemplate]
  );
  const moveShift = useCallback(
    (shiftId: string, date: string) => {
      if (!doc) return;
      commit({
        ...doc,
        shifts: doc.shifts.map((s) => (s.id === shiftId ? { ...s, date } : s)),
      });
    },
    [doc, commit]
  );
  const patchShift = useCallback(
    (shiftId: string, patch: Partial<RosterShift>) => {
      if (!doc) return;
      const target = doc.shifts.find((s) => s.id === shiftId);
      // Editing one occurrence of a recurring series updates the whole series
      // (everything but its date), so a weekly shift's hours/tags/times stay in
      // step across occurrences.
      const group = target?.recurGroup ?? null;
      commit({
        ...doc,
        shifts: doc.shifts.map((s) =>
          s.id === shiftId || (group && s.recurGroup === group)
            ? { ...s, ...patch }
            : s
        ),
      });
    },
    [doc, commit]
  );
  const removeShift = useCallback(
    (shiftId: string, series: boolean) => {
      if (!doc) return;
      const target = doc.shifts.find((s) => s.id === shiftId);
      const group = target?.recurGroup;
      commit({
        ...doc,
        shifts: doc.shifts.filter((s) =>
          series && group ? s.recurGroup !== group : s.id !== shiftId
        ),
      });
      setEditing(null);
    },
    [doc, commit]
  );
  const setRecurring = useCallback(
    (shiftId: string, on: boolean, weeks: number, until?: string | null) => {
      if (!doc) return;
      const base = doc.shifts.find((s) => s.id === shiftId);
      if (!base) return;
      if (!on) {
        const group = base.recurGroup;
        const kept = doc.shifts.filter(
          (s) => s.id === shiftId || s.recurGroup !== group
        );
        commit({
          ...doc,
          shifts: kept.map((s) =>
            s.id === shiftId ? { ...s, recurGroup: null } : s
          ),
        });
        return;
      }
      const group = base.recurGroup ?? uid();
      const extra: RosterShift[] = [];
      // Either repeat "until a date" (materialise every weekly occurrence up to
      // it) or "for N weeks". The until-date wins when set; both are capped so a
      // stray far-future date can't spawn thousands of rows.
      const pushOccurrence = (date: string) => {
        if (!doc.shifts.some((s) => s.recurGroup === group && s.date === date))
          extra.push({ ...base, id: uid(), date, recurGroup: group });
      };
      if (until) {
        const end = parseISO(until);
        for (let k = 1; k <= 104; k++) {
          const d = addDays(parseISO(base.date), 7 * k);
          if (d > end) break;
          pushOccurrence(isoOf(d));
        }
      } else {
        for (let k = 1; k < weeks; k++) {
          pushOccurrence(isoOf(addDays(parseISO(base.date), 7 * k)));
        }
      }
      commit({
        ...doc,
        shifts: [
          ...doc.shifts.map((s) =>
            s.id === shiftId ? { ...s, recurGroup: group } : s
          ),
          ...extra,
        ],
      });
    },
    [doc, commit]
  );

  const copyLastWeek = useCallback(() => {
    if (!doc || view !== "week") return;
    const prev = new Set(
      Array.from({ length: 7 }, (_, i) => isoOf(addDays(anchor, i - 7)))
    );
    const copies = doc.shifts
      .filter((s) => prev.has(s.date))
      .map((s) => ({
        ...s,
        id: uid(),
        date: isoOf(addDays(parseISO(s.date), 7)),
        recurGroup: null,
      }));
    if (copies.length) commit({ ...doc, shifts: [...doc.shifts, ...copies] });
  }, [doc, view, anchor, commit]);

  const publishNow = useCallback(() => {
    if (!doc) return;
    commit({
      ...doc,
      settings: {
        ...doc.settings,
        published: true,
        publishedAt: new Date().toISOString(),
        publishedHash: shiftsHash(doc.shifts),
      },
    });
  }, [doc, commit]);

  // Published, but the schedule has changed since — the operator has unpublished
  // edits to push out.
  const unpublished =
    !!doc?.settings.published &&
    shiftsHash(doc.shifts) !== (doc.settings.publishedHash ?? "");

  const patchSettings = useCallback(
    (patch: Partial<RosterDoc["settings"]>) => {
      if (!doc) return;
      commit({ ...doc, settings: { ...doc.settings, ...patch } });
    },
    [doc, commit]
  );
  const setTarget = useCallback(
    (personId: string, hours: number) =>
      doc &&
      patchSettings({
        targets: { ...doc.settings.targets, [personId]: hours },
      }),
    [doc, patchSettings]
  );
  const setPersonColor = useCallback(
    (personId: string, color: string | null) => {
      if (!doc) return;
      const colors = { ...doc.settings.colors };
      if (color) colors[personId] = color;
      else delete colors[personId];
      patchSettings({ colors });
    },
    [doc, patchSettings]
  );
  const setPersonTags = useCallback(
    (personId: string, tags: string[]) => {
      if (!doc) return;
      patchSettings({
        personTags: { ...(doc.settings.personTags ?? {}), [personId]: tags },
      });
    },
    [doc, patchSettings]
  );
  const addTemplate = useCallback(
    (t: Omit<RosterTemplate, "id">) => {
      if (!doc) return;
      patchSettings({ templates: [...doc.settings.templates, { ...t, id: uid() }] });
    },
    [doc, patchSettings]
  );
  const updateTemplate = useCallback(
    (id: string, patch: Partial<RosterTemplate>) => {
      if (!doc) return;
      patchSettings({
        templates: doc.settings.templates.map((t) =>
          t.id === id ? { ...t, ...patch } : t
        ),
      });
    },
    [doc, patchSettings]
  );
  const deleteTemplate = useCallback(
    (id: string) => {
      if (!doc) return;
      if (activeTemplate === id) setActiveTemplate(null);
      patchSettings({
        templates: doc.settings.templates.filter((t) => t.id !== id),
      });
    },
    [doc, patchSettings, activeTemplate]
  );
  const addTag = useCallback(
    (label: string, color: string) => {
      if (!doc || !label.trim()) return;
      const id = label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 24) + "-" + uid().slice(1, 4);
      patchSettings({ tags: [...doc.settings.tags, { id, label: label.trim(), color }] });
    },
    [doc, patchSettings]
  );
  const updateTag = useCallback(
    (id: string, patch: Partial<RosterTag>) => {
      if (!doc) return;
      patchSettings({
        tags: doc.settings.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      });
    },
    [doc, patchSettings]
  );
  const deleteTag = useCallback(
    (id: string) => {
      if (!doc) return;
      // Drop the tag and scrub it from every shift.
      commit({
        ...doc,
        settings: {
          ...doc.settings,
          tags: doc.settings.tags.filter((t) => t.id !== id),
        },
        shifts: doc.shifts.map((s) => ({
          ...s,
          tags: s.tags.filter((t) => t !== id),
        })),
      });
      if (tagFilter === id) setTagFilter(null);
    },
    [doc, commit, tagFilter]
  );

  /* ------------------------- pointer drag -------------------------- */
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    mode: "create" | "move";
    personId: string;
    shiftId: string | null;
    moved: boolean;
    startX: number;
    startY: number;
    painted: Set<string>;
    lastDate: string | null;
  } | null>(null);
  const [ghost, setGhost] = useState<{
    x: number;
    y: number;
    personId: string;
    count: number;
  } | null>(null);
  const [hotDates, setHotDates] = useState<Set<string>>(new Set());
  // A completed drag also fires a trailing click; swallow it so dragging a
  // person doesn't toggle the person filter.
  const suppressClickRef = useRef(false);

  const dateUnder = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const cell = el?.closest("[data-date]") as HTMLElement | null;
    return cell?.dataset.date ?? null;
  };

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      d.moved = true;
    }
    // One day at a time: only the single day currently under the pointer is a
    // drop target — no painting across a range.
    const date = dateUnder(e.clientX, e.clientY);
    if (date) d.lastDate = date;
    setGhost({ x: e.clientX, y: e.clientY, personId: d.personId, count: 1 });
    setHotDates(new Set(date ? [date] : []));
  }, []);

  const endDrag = useCallback(() => {
    window.removeEventListener("pointermove", onPointerMove);
    const d = dragRef.current;
    dragRef.current = null;
    setGhost(null);
    setHotDates(new Set());
    if (!d) return;
    if (!d.moved) {
      if (d.mode === "move" && d.shiftId) setEditing(d.shiftId);
      return;
    }
    suppressClickRef.current = true;
    if (d.mode === "create" && d.lastDate) {
      assign(d.personId, [d.lastDate]);
    } else if (d.mode === "move" && d.shiftId && d.lastDate) {
      moveShift(d.shiftId, d.lastDate);
    }
  }, [onPointerMove, assign, moveShift]);

  const startDrag = useCallback(
    (
      e: React.PointerEvent,
      mode: "create" | "move",
      personId: string,
      shiftId: string | null
    ) => {
      if (!canEdit) return;
      e.preventDefault();
      dragRef.current = {
        mode,
        personId,
        shiftId,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        painted: new Set(),
        lastDate: null,
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag, { once: true });
    },
    [canEdit, onPointerMove, endDrag]
  );

  /* ------------------------- render -------------------------------- */
  if (!doc) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading roster…
        </span>
      </div>
    );
  }

  const rangeLabel =
    view === "week"
      ? `${anchor.getDate()} ${MONTHS[anchor.getMonth()]} – ${addDays(anchor, 6).getDate()} ${MONTHS[addDays(anchor, 6).getMonth()]}`
      : `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
  const step = view === "week" ? 7 : 30;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ItemPaneHeader
        workspaceId={workspaceId}
        itemId={node.id}
        kind="roster"
        fallbackTitle={node.title || "Roster"}
        canEdit={canEdit}
        status={<SaveChip state={saveState} />}
        extra={
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-[var(--border)] p-0.5 text-xs">
              {(["week", "month"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={cn(
                    "rounded-md px-2.5 py-1 font-medium capitalize transition",
                    view === v
                      ? "bg-[var(--hover-strong)] text-[var(--text)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text)]"
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
            {canEdit && (
              <button
                type="button"
                onClick={publishNow}
                disabled={doc.settings.published && !unpublished}
                title={
                  unpublished
                    ? "You have changes that haven't been published"
                    : doc.settings.published
                      ? "Published — no pending changes"
                      : "Publish this roster"
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                  doc.settings.published && !unpublished
                    ? "border border-[var(--border-strong)] text-[var(--text-muted)]"
                    : "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
                )}
              >
                {doc.settings.published && !unpublished ? (
                  <>
                    <Check className="h-3.5 w-3.5" /> Published
                  </>
                ) : unpublished ? (
                  "Publish changes"
                ) : (
                  "Publish"
                )}
              </button>
            )}
          </div>
        }
      />

      {/* Sub-toolbar: week/month nav + copy-week */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setAnchor((a) => addDays(a, -step))}
            className="grid h-7 w-7 place-items-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-label="Previous"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setAnchor(view === "week" ? mondayOf(new Date()) : startOfMonth(new Date()))}
            className="rounded-md px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setAnchor((a) => addDays(a, step))}
            className="grid h-7 w-7 place-items-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-label="Next"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <span className="ml-1 text-sm font-semibold">{rangeLabel}</span>
        </div>
        {/* Filter bar — templates | tags, each a coloured pill. */}
        <div className="ml-2 flex items-center gap-1 overflow-x-auto">
          {doc.settings.templates.map((t) => {
            const c = t.color ?? "#D97757";
            const on = templateFilter === t.id;
            return (
              <button
                key={t.id}
                type="button"
                title={`Filter to ${t.label} shifts`}
                onClick={() =>
                  setTemplateFilter((cur) => (cur === t.id ? null : t.id))
                }
                className="shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition"
                style={
                  on
                    ? { background: c, color: "#fff", borderColor: "transparent" }
                    : { color: c, borderColor: `${c}66` }
                }
              >
                {t.label}
              </button>
            );
          })}
          {doc.settings.templates.length > 0 && doc.settings.tags.length > 0 && (
            <span
              className="mx-1 h-4 w-px shrink-0 bg-[var(--border-strong)]"
              aria-hidden
            />
          )}
          {doc.settings.tags.map((t) => {
            const on = tagFilter === t.id;
            return (
              <button
                key={t.id}
                type="button"
                title={`Filter to ${t.label} tag`}
                onClick={() => setTagFilter((c) => (c === t.id ? null : t.id))}
                className="shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition"
                style={
                  on
                    ? { background: t.color, color: "#fff", borderColor: "transparent" }
                    : { color: t.color, borderColor: `${t.color}66` }
                }
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        {canEdit && view === "week" && (
          <button
            type="button"
            onClick={copyLastWeek}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border-strong)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]"
          >
            <Copy className="h-3.5 w-3.5" /> Copy last week
          </button>
        )}
      </div>

      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "218px 1fr" }}>
        {/* People rail */}
        <div className="flex flex-col gap-2 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface-1)] p-3">
          {/* Templates — pills are selectable brushes; add / edit / remove
              all happen in the manager modal opened from the title bar. */}
          <div className="flex items-center justify-between px-1">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-[var(--text-faint)]">
              Templates
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => setManageTemplatesOpen(true)}
                className="grid h-5 w-5 place-items-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
                title="Add, edit, or remove templates"
                aria-label="Manage templates"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 px-1">
            {doc.settings.templates.length === 0 && (
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => setManageTemplatesOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--accent)]/60 px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)] transition hover:bg-[var(--accent-soft)] disabled:opacity-50"
              >
                <Plus className="h-3 w-3" /> New template
              </button>
            )}
            {doc.settings.templates.map((t) => {
              const on = activeTemplate === t.id;
              const c = t.color ?? "#D97757";
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTemplate((cur) => (cur === t.id ? null : t.id))}
                  className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition"
                  style={
                    on
                      ? { background: c, color: "#fff", borderColor: "transparent" }
                      : { color: c, borderColor: `${c}66` }
                  }
                  title={tplSummary(t, doc.settings.tags)}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          {activeTemplate && (
            <p className="px-1 text-[11px] leading-snug text-[var(--accent)]">
              Template on — new shifts use it. Click the pill again to turn off.
            </p>
          )}

          <div className="mt-1 flex items-center justify-between px-1 pb-0.5">
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-[var(--text-faint)]">
              Team · {members.length}
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => setManageTagsOpen(true)}
                title="Manage tags"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                <Tags className="h-3 w-3" /> Tags
              </button>
            )}
          </div>
          {canEdit && (
            <p className="px-1 pb-1 text-[11px] leading-snug text-[var(--text-faint)]">
              Drag a person onto a day. Click a name to filter the roster to them.
            </p>
          )}
          {members.map((m) => {
            const total = hoursFor(m.user_id);
            const target = targetOf(m.user_id);
            const over = total > target;
            const pct = Math.min(100, Math.round((total / Math.max(1, target)) * 100));
            const active = personFilter === m.user_id;
            return (
              <div
                key={m.user_id}
                onPointerDown={(e) => startDrag(e, "create", m.user_id, null)}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  setPersonFilter((cur) => (cur === m.user_id ? null : m.user_id));
                }}
                className={cn(
                  "group flex select-none items-center gap-2.5 rounded-[10px] border p-2 transition",
                  canEdit && "cursor-grab active:cursor-grabbing",
                  active
                    ? "border-[var(--accent)] bg-[var(--surface)]"
                    : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]"
                )}
                style={{ touchAction: "none" }}
                title={active ? "Showing only this person — click to clear" : m.username}
              >
                <Avatar person={m} color={colorOf(m.user_id)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-semibold">
                    {m.username}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                      <span
                        className="block h-full rounded-full transition-[width]"
                        style={{
                          width: `${pct}%`,
                          background: over ? "var(--danger)" : colorOf(m.user_id),
                        }}
                      />
                    </span>
                    <span
                      className={cn(
                        "whitespace-nowrap text-[10px] tabular-nums",
                        over ? "font-bold text-[var(--danger)]" : "text-[var(--text-muted)]"
                      )}
                    >
                      {total} / {target}h
                    </span>
                  </div>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPersonEditing(m.user_id);
                    }}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--text-faint)] opacity-0 transition hover:bg-[var(--hover)] hover:text-[var(--text)] group-hover:opacity-100"
                    title="Edit colour, target & default tags"
                    aria-label="Edit person"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Calendar */}
        <div ref={gridRef} className="min-h-0 overflow-auto">
          <div
            className={cn("grid", view === "week" ? "" : "")}
            style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}
          >
            {view === "month" &&
              DOW.map((d) => (
                <div
                  key={d}
                  className="border-b border-r border-[var(--border)] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-[var(--text-faint)]"
                >
                  {d}
                </div>
              ))}
            {days.map((d) => {
              const iso = isoOf(d);
              const list = shiftsByDate.get(iso) ?? [];
              const hot = hotDates.has(iso);
              const isToday = sameDay(d, new Date());
              const dim = view === "month" && d.getMonth() !== anchor.getMonth();
              const totalH = list.reduce((a, s) => a + shiftHours(s), 0);
              return (
                <div
                  key={iso}
                  data-date={iso}
                  className={cn(
                    "flex min-h-[118px] flex-col border-b border-r border-[var(--border)] transition",
                    dim && "opacity-45",
                    hot && "bg-[var(--accent-soft)] shadow-[inset_0_0_0_2px_var(--accent)]"
                  )}
                >
                  <div className="flex items-baseline justify-between px-2 pt-1.5">
                    {view === "week" ? (
                      <div>
                        <div className="text-[10.5px] font-bold uppercase tracking-wider text-[var(--text-faint)]">
                          {DOW[(d.getDay() + 6) % 7]}
                        </div>
                        <div className={cn("text-[15px] font-bold", isToday && "text-[var(--accent)]")}>
                          {d.getDate()}
                        </div>
                      </div>
                    ) : (
                      <div className={cn("text-xs font-semibold", isToday && "text-[var(--accent)]")}>
                        {d.getDate()}
                      </div>
                    )}
                    {list.length > 0 && (
                      <span className="text-[10px] text-[var(--text-faint)]">
                        {list.length} · {totalH}h
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5 p-1.5">
                    {list.map((s) => (
                      <ShiftChip
                        key={s.id}
                        shift={s}
                        person={memberById(s.personId)}
                        color={s.color ?? colorOf(s.personId)}
                        tags={doc.settings.tags}
                        conflict={conflictIds.has(s.id)}
                        canEdit={canEdit}
                        onPointerDown={(e) => startDrag(e, "move", s.personId, s.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* drag ghost */}
      {ghost &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[60] flex items-center gap-2 rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold shadow-lg"
            style={{
              left: ghost.x,
              top: ghost.y,
              transform: "translate(-50%,-150%) rotate(-3deg)",
            }}
          >
            <Avatar
              person={memberById(ghost.personId)}
              color={colorOf(ghost.personId)}
              sm
            />
            {memberById(ghost.personId)?.username.split(" ")[0] ?? ""}
            {ghost.count > 1 && (
              <span className="rounded-full bg-[var(--accent)] px-1.5 text-[10px] text-white">
                ×{ghost.count}
              </span>
            )}
          </div>,
          document.body
        )}

      {/* editor popover */}
      {editing &&
        (() => {
          const sh = doc.shifts.find((s) => s.id === editing);
          if (!sh) return null;
          return (
            <ShiftEditor
              shift={sh}
              person={memberById(sh.personId)}
              tags={doc.settings.tags}
              color={sh.color ?? colorOf(sh.personId)}
              canEdit={canEdit}
              onClose={() => setEditing(null)}
              onPatch={(p) => patchShift(sh.id, p)}
              onRecurring={(on, weeks, until) =>
                setRecurring(sh.id, on, weeks, until)
              }
              onRemove={(series) => removeShift(sh.id, series)}
            />
          );
        })()}

      {manageTemplatesOpen && (
        <TemplateManagerPopover
          templates={doc.settings.templates}
          tags={doc.settings.tags}
          defaults={{ start: doc.settings.defaultStart, end: doc.settings.defaultEnd }}
          onClose={() => setManageTemplatesOpen(false)}
          onAdd={addTemplate}
          onUpdate={updateTemplate}
          onDelete={deleteTemplate}
        />
      )}
      {manageTagsOpen && (
        <TagManagerPopover
          tags={doc.settings.tags}
          onClose={() => setManageTagsOpen(false)}
          onAdd={addTag}
          onUpdate={updateTag}
          onDelete={deleteTag}
        />
      )}
      {personEditing &&
        (() => {
          const p = memberById(personEditing);
          if (!p) return null;
          return (
            <PersonEditor
              person={p}
              color={colorOf(personEditing)}
              hasColorOverride={!!doc.settings.colors[personEditing]}
              target={targetOf(personEditing)}
              defaultTags={doc.settings.personTags?.[personEditing] ?? []}
              tags={doc.settings.tags}
              onColor={(c) => setPersonColor(personEditing, c)}
              onTarget={(h) => setTarget(personEditing, h)}
              onTags={(t) => setPersonTags(personEditing, t)}
              onClose={() => setPersonEditing(null)}
            />
          );
        })()}
    </div>
  );
}

/* ============================ sub-components ========================== */
function Avatar({
  person,
  color,
  sm,
}: {
  person: WorkspaceParticipant | null;
  color: string;
  sm?: boolean;
}) {
  const size = sm ? "h-6 w-6 text-[10px]" : "h-[30px] w-[30px] text-[12px]";
  if (person?.avatar_url) {
    return (
      <img
        src={person.avatar_url}
        alt=""
        className={cn("shrink-0 rounded-full object-cover", size)}
      />
    );
  }
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-bold text-white",
        size
      )}
      style={{ background: color, boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,.25)" }}
    >
      {initials(person?.username ?? "?")}
    </span>
  );
}

function ShiftChip({
  shift,
  person,
  color,
  tags,
  conflict,
  canEdit,
  onPointerDown,
}: {
  shift: RosterShift;
  person: WorkspaceParticipant | null;
  color: string;
  tags: RosterTag[];
  conflict: boolean;
  canEdit: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  // A bare shift (no template: untimed, zero hours) shows just the person —
  // no misleading "0h". Otherwise show the times, or the hours.
  const when =
    shift.timed && shift.start && shift.end
      ? `${shift.start}–${shift.end}`
      : shiftHours(shift) > 0
        ? `${shiftHours(shift)}h`
        : "";
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, var(--surface))`,
        borderColor: conflict
          ? "var(--danger)"
          : `color-mix(in srgb, ${color} 30%, transparent)`,
        touchAction: "none",
      }}
      className={cn(
        "group relative select-none overflow-hidden rounded-lg border pl-2.5 pr-2 py-1.5 text-xs",
        canEdit && "cursor-grab active:cursor-grabbing"
      )}
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: "currentColor" }}
      />
      <div className="flex items-center gap-1.5">
        <Avatar person={person} color={color} sm />
        <span className="flex-1 truncate font-semibold text-[var(--text)]">
          {person?.username.split(" ")[0] ?? "?"}
        </span>
        {conflict && <TriangleAlert className="h-3 w-3 text-[var(--danger)]" />}
        {shift.recurGroup && <Repeat className="h-3 w-3 text-[var(--text-muted)]" />}
      </div>
      {when && (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="text-[10.5px] font-semibold tabular-nums text-[var(--text-muted)]">
            {when}
            {shift.timed ? ` · ${shiftHours(shift)}h` : ""}
          </span>
        </div>
      )}
      {shift.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {shift.tags.map((t) => {
            const tag = tags.find((x) => x.id === t);
            if (!tag) return null;
            return (
              <span
                key={t}
                className="rounded-full px-1.5 py-px text-[9.5px] font-semibold"
                style={{ background: `${tag.color}22`, color: tag.color }}
              >
                {tag.label}
              </span>
            );
          })}
        </div>
      )}
      {shift.note && (
        <div className="mt-1 line-clamp-2 text-[10.5px] text-[var(--text-muted)]">
          {shift.note}
        </div>
      )}
    </div>
  );
}

function ShiftEditor({
  shift,
  person,
  tags,
  color,
  canEdit,
  onClose,
  onPatch,
  onRecurring,
  onRemove,
}: {
  shift: RosterShift;
  person: WorkspaceParticipant | null;
  tags: RosterTag[];
  color: string;
  canEdit: boolean;
  onClose: () => void;
  onPatch: (p: Partial<RosterShift>) => void;
  onRecurring: (on: boolean, weeks: number, until?: string | null) => void;
  onRemove: (series: boolean) => void;
}) {
  const [weeks, setWeeks] = useState(4);
  const [until, setUntil] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const ro = !canEdit;
  return createPortal(
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 text-sm shadow-xl"
      >
        <div className="mb-3 flex items-center gap-2">
          <Avatar person={person} color={color} sm />
          <span className="font-semibold">{person?.username ?? "Shift"}</span>
        </div>

        {/* timed vs hours */}
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10.5px] font-bold uppercase tracking-wide text-[var(--text-faint)]">
              {shift.timed ? "Times" : "Hours"}
            </span>
            <button
              type="button"
              disabled={ro}
              onClick={() =>
                onPatch(
                  shift.timed
                    ? { timed: false, hours: shiftHours(shift) }
                    : { timed: true }
                )
              }
              className="text-[11px] font-semibold text-[var(--accent)] hover:underline disabled:opacity-50"
            >
              {shift.timed ? "Use hours" : "Set times"}
            </button>
          </div>
          {shift.timed ? (
            <div className="flex items-center gap-2">
              <input
                type="time"
                disabled={ro}
                value={shift.start ?? "09:00"}
                onChange={(e) => onPatch({ start: e.target.value })}
                className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-xs"
              />
              <span className="text-[var(--text-muted)]">→</span>
              <input
                type="time"
                disabled={ro}
                value={shift.end ?? "17:00"}
                onChange={(e) => onPatch({ end: e.target.value })}
                className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-xs"
              />
              <span className="text-xs font-bold tabular-nums text-[var(--text-muted)]">
                {shiftHours(shift)}h
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={ro}
                onClick={() => onPatch({ hours: Math.max(0.5, shift.hours - 0.5) })}
                className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border-strong)] disabled:opacity-50"
              >
                –
              </button>
              <b className="w-12 text-center tabular-nums">{shift.hours}h</b>
              <button
                type="button"
                disabled={ro}
                onClick={() => onPatch({ hours: Math.min(24, shift.hours + 0.5) })}
                className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border-strong)] disabled:opacity-50"
              >
                +
              </button>
            </div>
          )}
        </div>

        {/* tags */}
        <div className="mb-3">
          <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-[var(--text-faint)]">
            Tags
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => {
              const on = shift.tags.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={ro}
                  onClick={() =>
                    onPatch({
                      tags: on
                        ? shift.tags.filter((x) => x !== t.id)
                        : [...shift.tags, t.id],
                    })
                  }
                  className="rounded-full border px-2.5 py-1 text-[10.5px] font-semibold transition disabled:opacity-50"
                  style={
                    on
                      ? { background: t.color, color: "#fff", borderColor: "transparent" }
                      : { color: "var(--text-muted)", borderColor: "var(--border)" }
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* colour */}
        <div className="mb-3">
          <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-[var(--text-faint)]">
            Colour
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={ro}
              onClick={() => onPatch({ color: null })}
              title="Default (person colour)"
              className={cn(
                "grid h-5 w-5 place-items-center rounded-full border-2 disabled:opacity-50",
                shift.color === null ? "border-[var(--text)]" : "border-[var(--border)]"
              )}
            >
              <span className="h-3 w-3 rounded-full" style={{ background: color }} />
            </button>
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                disabled={ro}
                onClick={() => onPatch({ color: c })}
                className={cn(
                  "h-5 w-5 rounded-full border-2 disabled:opacity-50",
                  shift.color === c ? "border-[var(--text)]" : "border-transparent"
                )}
                style={{ background: c }}
                aria-label="Set colour"
              />
            ))}
          </div>
        </div>

        {/* note */}
        <div className="mb-3">
          <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-[var(--text-faint)]">
            Note
          </div>
          <textarea
            rows={2}
            disabled={ro}
            value={shift.note}
            onChange={(e) => onPatch({ note: e.target.value })}
            placeholder="e.g. covering lunch rush"
            className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-xs"
          />
        </div>

        {/* recurring + delete */}
        <div className="flex items-center gap-2 border-t border-[var(--border)] pt-3">
          <button
            type="button"
            disabled={ro}
            onClick={() =>
              onRecurring(!shift.recurGroup, weeks, until.trim() || null)
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-semibold transition disabled:opacity-50",
              shift.recurGroup
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "border border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text)]"
            )}
          >
            <Repeat className="h-3.5 w-3.5" />
            {shift.recurGroup ? "Repeating" : "Repeat"}
          </button>
          {!shift.recurGroup && !until.trim() && (
            <select
              disabled={ro}
              value={weeks}
              onChange={(e) => setWeeks(+e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-1.5 py-1 text-[11px]"
            >
              {[2, 3, 4, 6, 8, 12].map((w) => (
                <option key={w} value={w}>
                  ×{w} wks
                </option>
              ))}
            </select>
          )}
          <div className="flex-1" />
          <button
            type="button"
            disabled={ro}
            onClick={() => onRemove(false)}
            className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--danger)] hover:underline disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </button>
        </div>
        {!shift.recurGroup && !ro && (
          <label className="mt-2 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <span className="whitespace-nowrap">or repeat until</span>
            <input
              type="date"
              value={until}
              min={shift.date}
              onChange={(e) => setUntil(e.target.value)}
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[11px]"
            />
          </label>
        )}
        {shift.recurGroup && !ro && (
          <button
            type="button"
            onClick={() => onRemove(true)}
            className="mt-2 w-full text-center text-[11px] text-[var(--text-muted)] hover:text-[var(--danger)]"
          >
            Delete whole series
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}

function SaveChip({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  const map = {
    saving: { icon: <Loader2 className="h-3 w-3 animate-spin" />, text: "Saving…" },
    saved: { icon: <Check className="h-3 w-3" />, text: "Saved" },
    error: { icon: <TriangleAlert className="h-3 w-3" />, text: "Save failed" },
  } as const;
  const m = map[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px]",
        state === "error" ? "text-[var(--danger)]" : "text-[var(--text-muted)]"
      )}
    >
      {m.icon}
      {m.text}
    </span>
  );
}

function Modal({
  title,
  onClose,
  children,
  widthClass = "max-w-md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClass?: string;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex max-h-[85vh] w-full flex-col overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] text-sm shadow-xl",
          widthClass
        )}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <span className="text-[15px] font-semibold">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function TemplateManagerPopover({
  templates,
  tags,
  defaults,
  onClose,
  onAdd,
  onUpdate,
  onDelete,
}: {
  templates: RosterTemplate[];
  tags: RosterTag[];
  defaults: { start: string; end: string };
  onClose: () => void;
  onAdd: (t: Omit<RosterTemplate, "id">) => void;
  onUpdate: (id: string, patch: Partial<RosterTemplate>) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Modal title="Templates" onClose={onClose} widthClass="max-w-lg">
      <div className="flex flex-col gap-2.5">
        {templates.length === 0 && (
          <p className="py-2 text-center text-[11.5px] text-[var(--text-muted)]">
            No templates yet. Add one below — then select it in the rail and drop
            people to stamp its times &amp; tags.
          </p>
        )}
        {templates.map((t) => (
          <TemplateRow
            key={t.id}
            template={t}
            tags={tags}
            onUpdate={(p) => onUpdate(t.id, p)}
            onDelete={() => onDelete(t.id)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          onAdd({
            label: "New shift",
            timed: true,
            start: defaults.start,
            end: defaults.end,
            hours: 8,
            tags: [],
            color: null,
            note: "",
          })
        }
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--accent)]/60 py-2 text-xs font-semibold text-[var(--accent)] transition hover:bg-[var(--accent-soft)]"
      >
        <Plus className="h-3.5 w-3.5" /> Add template
      </button>
    </Modal>
  );
}

function TemplateRow({
  template: t,
  tags,
  onUpdate,
  onDelete,
}: {
  template: RosterTemplate;
  tags: RosterTag[];
  onUpdate: (patch: Partial<RosterTemplate>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-2.5">
      <div className="flex items-center gap-2">
        <input
          value={t.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder="Template name"
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-semibold"
        />
        <button
          type="button"
          onClick={() => onUpdate({ timed: !t.timed })}
          className="shrink-0 rounded-md border border-[var(--border-strong)] px-2 py-1 text-[10.5px] font-semibold text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          {t.timed ? "Times" : "Hours"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--danger)]"
          aria-label="Delete template"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {t.timed ? (
          <>
            <input
              type="time"
              value={t.start}
              onChange={(e) => onUpdate({ start: e.target.value })}
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
            />
            <span className="text-[var(--text-muted)]">→</span>
            <input
              type="time"
              value={t.end}
              onChange={(e) => onUpdate({ end: e.target.value })}
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
            />
          </>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onUpdate({ hours: Math.max(0.5, t.hours - 0.5) })}
              className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border-strong)]"
            >
              –
            </button>
            <b className="w-12 text-center tabular-nums">{t.hours}h</b>
            <button
              type="button"
              onClick={() => onUpdate({ hours: Math.min(24, t.hours + 0.5) })}
              className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border-strong)]"
            >
              +
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <input
            type="color"
            value={t.color ?? "#D97757"}
            onChange={(e) => onUpdate({ color: e.target.value })}
            className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
            title="Template colour"
          />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {tags.map((tag) => {
          const on = t.tags.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              onClick={() =>
                onUpdate({
                  tags: on
                    ? t.tags.filter((x) => x !== tag.id)
                    : [...t.tags, tag.id],
                })
              }
              className="rounded-full border px-2 py-0.5 text-[10px] font-semibold transition"
              style={
                on
                  ? { background: tag.color, color: "#fff", borderColor: "transparent" }
                  : { color: "var(--text-muted)", borderColor: "var(--border)" }
              }
            >
              {tag.label}
            </button>
          );
        })}
      </div>
      <input
        value={t.note ?? ""}
        onChange={(e) => onUpdate({ note: e.target.value })}
        placeholder="Default note (optional)"
        className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11.5px]"
      />
    </div>
  );
}

function TagManagerPopover({
  tags,
  onClose,
  onAdd,
  onUpdate,
  onDelete,
}: {
  tags: RosterTag[];
  onClose: () => void;
  onAdd: (label: string, color: string) => void;
  onUpdate: (id: string, patch: Partial<RosterTag>) => void;
  onDelete: (id: string) => void;
}) {
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState(PALETTE[0]);
  return (
    <Modal title="Tags" onClose={onClose}>
      <div className="mb-3 flex flex-col gap-1.5">
        {tags.map((t) => (
          <div key={t.id} className="flex items-center gap-2">
            <input
              type="color"
              value={t.color}
              onChange={(e) => onUpdate(t.id, { color: e.target.value })}
              className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
            />
            <input
              value={t.label}
              onChange={(e) => onUpdate(t.id, { label: e.target.value })}
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={() => onDelete(t.id)}
              className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--danger)]"
              aria-label="Delete tag"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border)] pt-3">
        <input
          type="color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="New tag"
          className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && newLabel.trim()) {
              onAdd(newLabel, newColor);
              setNewLabel("");
            }
          }}
        />
        <button
          type="button"
          disabled={!newLabel.trim()}
          onClick={() => {
            onAdd(newLabel, newColor);
            setNewLabel("");
          }}
          className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </Modal>
  );
}

function PersonEditor({
  person,
  color,
  hasColorOverride,
  target,
  defaultTags,
  tags,
  onColor,
  onTarget,
  onTags,
  onClose,
}: {
  person: WorkspaceParticipant;
  color: string;
  hasColorOverride: boolean;
  target: number;
  defaultTags: string[];
  tags: RosterTag[];
  onColor: (c: string | null) => void;
  onTarget: (h: number) => void;
  onTags: (t: string[]) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={person.username} onClose={onClose} widthClass="max-w-sm">
      {/* colour */}
      <div className="mb-4">
        <div className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-[var(--text-faint)]">
          Colour
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onColor(c)}
              className={cn(
                "h-6 w-6 rounded-full border-2 transition",
                hasColorOverride && color.toLowerCase() === c.toLowerCase()
                  ? "border-[var(--text)]"
                  : "border-transparent"
              )}
              style={{ background: c }}
              aria-label={`Set colour ${c}`}
            />
          ))}
          {hasColorOverride && (
            <button
              type="button"
              onClick={() => onColor(null)}
              className="text-[11px] font-semibold text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* weekly target */}
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[10.5px] font-bold uppercase tracking-wide text-[var(--text-faint)]">
          Weekly target
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onTarget(Math.max(0, target - 2))}
            className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border-strong)]"
          >
            –
          </button>
          <b className="w-12 text-center tabular-nums">{target}h</b>
          <button
            type="button"
            onClick={() => onTarget(Math.min(80, target + 2))}
            className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border-strong)]"
          >
            +
          </button>
        </div>
      </div>

      {/* default tags */}
      <div>
        <div className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-[var(--text-faint)]">
          Default tags
        </div>
        {tags.length === 0 ? (
          <p className="text-[11.5px] text-[var(--text-muted)]">
            No tags yet — add some from a shift's tag manager first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => {
              const on = defaultTags.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() =>
                    onTags(
                      on
                        ? defaultTags.filter((x) => x !== t.id)
                        : [...defaultTags, t.id]
                    )
                  }
                  className="rounded-full border px-2.5 py-1 text-[10.5px] font-semibold transition"
                  style={
                    on
                      ? { background: t.color, color: "#fff", borderColor: "transparent" }
                      : { color: "var(--text-muted)", borderColor: "var(--border)" }
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[11px] leading-snug text-[var(--text-faint)]">
          Stamped onto every new shift you assign to {person.username.split(" ")[0]}.
        </p>
      </div>
    </Modal>
  );
}
