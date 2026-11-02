import { useQueryClient } from "@tanstack/react-query";
import { Check, Images, UserRound, X } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";

import type { CalBirthday, CalTask } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { FILES_PHOTOS_BASE, joinPhotosPath } from "@/components/photos/photosPath";
import { itemsApi } from "@/items/api";
import { ItemButton } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { EXTRAS_KEY } from "../data";
import { parseYmd, shortDay, shortTime } from "../dates";
import { birthdayLabel, type ViewEvent } from "../model";
import { openFrom, type OpenEvent } from "./EventChip";

type ExtrasData = { tasks: CalTask[]; birthdays: CalBirthday[] };

/** Tick a task off (from the Tasks app's own action), hiding it at once. */
export function useCompleteTask() {
  const qc = useQueryClient();
  return async (t: CalTask) => {
    const hide = (data: ExtrasData | undefined) => (data ? { ...data, tasks: data.tasks.filter((x) => !(x.file_id === t.file_id && x.task_id === t.task_id)) } : data);
    qc.setQueriesData<ExtrasData>({ queryKey: EXTRAS_KEY }, hide);
    const refetch = () => void qc.invalidateQueries({ queryKey: EXTRAS_KEY });
    try {
      await itemsApi.action(t.file_id, "complete_tasks", { tasks: [t.task_id] });
      // A repeating task rolls on to its next day (no simple undo for that).
      toast.success(t.repeats ? `Done · next one's scheduled` : "Done", {
        action: t.repeats
          ? undefined
          : {
              label: "Undo",
              onClick: () => {
                void itemsApi
                  .action(t.file_id, "complete_tasks", { tasks: [t.task_id], done: false })
                  .catch((err) => toast.error(extractError(err) || "Couldn't undo that."))
                  .finally(refetch);
              },
            },
      });
    } catch (err) {
      toast.error(extractError(err) || "Couldn't tick that off.");
    } finally {
      refetch();
    }
  };
}

/** The round tick-box of a task, in its list's colour. */
export function TaskCheck({ task, size = 14 }: { task: CalTask; size?: number }) {
  const complete = useCompleteTask();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={`Mark "${task.title}" done`}
      title="Mark done"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (done) return;
        setDone(true);
        void complete(task);
      }}
      // A bigger hit area than the circle itself.
      className="group/check -m-1 flex shrink-0 items-center justify-center p-1"
    >
      <span
        className="flex items-center justify-center rounded-full border-[1.5px] transition group-hover/check:bg-[color-mix(in_srgb,currentColor_14%,transparent)]"
        style={{ width: size, height: size, borderColor: task.color, color: task.color, background: done ? task.color : undefined }}
      >
        <Check className={cn("transition", done ? "opacity-100" : "opacity-0 group-hover/check:opacity-60")} style={{ width: size - 4, height: size - 4, color: done ? "#fff" : task.color }} strokeWidth={3} />
      </span>
    </button>
  );
}

/** A birthday's little round picture: their face, their contact photo, else initials. */
export function BirthdayAvatar({ b, size = 16 }: { b: CalBirthday; size?: number }) {
  const [broken, setBroken] = useState(false);
  const src = !broken ? (b.face ?? b.photo) : null;
  if (src) return <img src={src} alt="" onError={() => setBroken(true)} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  const initials =
    b.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?";
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: b.color || "#D9506A", fontSize: Math.max(7, size * 0.42) }}
    >
      {size >= 20 ? initials : initials[0]}
    </span>
  );
}

const emoji = (b: CalBirthday) => (b.kind === "birthday" ? "🎂" : "💍");

/** A task / birthday in a month cell or the all-day row. */
export function ExtraChip({ v, onOpen, compact }: { v: ViewEvent; onOpen: OpenEvent; compact?: boolean }) {
  const x = v.extra!;
  if (x.kind === "task") {
    const t = x.task;
    return (
      <div className={cn("flex h-full w-full min-w-0 items-center gap-1 rounded-md px-1 hover:bg-[var(--hover)]", compact ? "text-[10px]" : "text-[11px]")}>
        <TaskCheck task={t} size={compact ? 11 : 13} />
        <button type="button" onClick={(e) => openFrom(e, v, onOpen)} title={`${t.title} · ${t.list}`} className="flex min-w-0 flex-1 items-center gap-1 text-left">
          {t.time && !compact && <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{shortTime(v.start)}</span>}
          <span className="truncate text-[var(--text)]">{t.title}</span>
        </button>
      </div>
    );
  }
  const b = x.b;
  return (
    <button
      type="button"
      onClick={(e) => openFrom(e, v, onOpen)}
      aria-label={birthdayLabel(b)}
      className={cn(
        "flex h-full w-full min-w-0 items-center gap-1 rounded-md px-1 text-left text-[var(--text)] hover:brightness-95",
        compact ? "text-[10px]" : "text-[11px]",
      )}
      style={{ background: `color-mix(in srgb, ${v.color} 12%, var(--surface))` }}
    >
      <BirthdayAvatar b={b} size={compact ? 12 : 15} />
      <span className="truncate">
        {!compact && <span aria-hidden>{emoji(b)} </span>}
        {birthdayLabel(b)}
      </span>
    </button>
  );
}

/** A timed task in the hour grid: a slim marker at its time, not a block. */
export function TaskMarker({ v, onOpen, top, narrow }: { v: ViewEvent; onOpen: OpenEvent; top: number; narrow: boolean }) {
  const t = (v.extra as { kind: "task"; task: CalTask }).task;
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute left-[1px] right-[3px] z-[5] flex h-[18px] items-center gap-1 rounded-md border-l-2 pl-1 pr-1 text-[11px] leading-none shadow-[0_0_0_1px_var(--bg)]"
      style={{ top, borderColor: t.color, background: `color-mix(in srgb, ${t.color} 14%, var(--surface))` }}
    >
      <TaskCheck task={t} size={12} />
      <button type="button" onClick={(e: MouseEvent<HTMLElement>) => openFrom(e, v, onOpen)} className="min-w-0 flex-1 truncate text-left text-[var(--text)]" title={`${t.title} · ${t.list}`}>
        {t.title}
        {!narrow && <span className="text-[var(--text-muted)]"> · {shortTime(v.start)}</span>}
      </button>
    </div>
  );
}

/** Where a contact lives in the Contacts app. */
export function contactPath(b: CalBirthday): string {
  return `/apps/contacts/${b.file_id}?c=${encodeURIComponent(b.contact_id)}`;
}

/** A birthday / anniversary opened (popover / sheet body). */
export function BirthdayDetail({ b, onClose }: { b: CalBirthday; onClose: () => void }) {
  const navigate = useNavigate();
  const day = parseYmd(b.day);
  const what = b.kind === "birthday" ? (b.years ? `Turns ${b.years}` : "Birthday") : `${b.label || "Anniversary"}${b.years ? ` · ${b.years} ${b.years === 1 ? "year" : "years"}` : ""}`;
  return (
    <div className="flex flex-col gap-4 text-sm text-[var(--text)]">
      <div className="flex items-start gap-3">
        <BirthdayAvatar b={b} size={48} />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-lg font-semibold leading-snug">{b.name}</h2>
          <p className="text-[var(--text-muted)]">
            <span aria-hidden>{emoji(b)} </span>
            {what} · {shortDay(day)}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <ItemButton
          size="sm"
          icon={<UserRound className="h-3.5 w-3.5" />}
          onClick={() => {
            onClose();
            navigate(contactPath(b));
          }}
        >
          Open in Contacts
        </ItemButton>
        {b.person_id && (
          <ItemButton
            size="sm"
            icon={<Images className="h-3.5 w-3.5" />}
            onClick={() => {
              onClose();
              navigate(joinPhotosPath(FILES_PHOTOS_BASE, `/people/${b.person_id}`));
            }}
          >
            See photos
          </ItemButton>
        )}
      </div>
    </div>
  );
}
