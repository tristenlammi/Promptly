import { Bell, CalendarDays, Clock, Flag, ListChecks, Plus, Repeat as RepeatIcon, Send, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { SendToSheet } from "@/components/share/SendToSheet";
import { TagPicker } from "@/components/tags/TagPicker";
import { LinkedSection } from "@/components/links/LinkedSection";
import type { ItemHandle } from "@/items/useItem";
import { Chip, Field, ItemButton, Segmented, Select, Sheet, Stepper, TextArea, TextInput, Toggle, fmtDay, todayISO, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { ALERTS, PRIORITY, alertLabel } from "./logic";
import { WEEKDAY_SHORT, describeRepeat, firstDue, makeRepeat, plusDays, weekday } from "./recur";
import { TaskCheck, useToggle } from "./parts";
import type { Freq, Repeat, Task, TasksData } from "./types";

/*
 * One task, every field. Each control writes only its own field (the
 * mutator rule: no whole-object copies). Title and notes are typed locally
 * and written when they settle.
 */

function Row({ icon: Icon, label, children }: { icon: typeof Bell; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
      <span className="flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      {children}
    </div>
  );
}

export function TaskEditor({ item, taskId, onClose }: { item: ItemHandle<TasksData>; taskId: string | null; onClose: () => void }) {
  const task = item.data.tasks.find((t) => t.id === taskId) ?? null;
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState("");
  const toggle = useToggle(item);
  const ro = !item.canEdit;
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setNotes(task.notes);
    }
    // Only when a different task opens — not on every save of this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const edit = (fn: (t: Task) => void) =>
    item.update((d) => {
      const t = d.tasks.find((x) => x.id === taskId);
      if (t) fn(t);
    });
  const commitText = () => {
    if (!task || ro) return;
    const tt = title.trim();
    if (tt && tt !== task.title) edit((t) => void (t.title = tt));
    if (notes !== task.notes) edit((t) => void (t.notes = notes));
  };
  const close = () => {
    commitText();
    onClose();
  };

  if (!task) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const today = todayISO();
  const s = item.data.settings;

  const setDue = (due: string | null) =>
    edit((t) => {
      t.due = due;
      if (!due) {
        t.time = null;
        t.alerts = [];
        t.repeat = null;
      }
    });
  const setTime = (time: string | null) =>
    edit((t) => {
      t.time = time;
      if (time && !t.due) t.due = today;
      if (time && !t.alerts.length && s.alert_timed) t.alerts = [0];
    });
  const setRepeat = (rep: Repeat | null) =>
    edit((t) => {
      t.repeat = rep;
      if (rep) t.due = t.due ?? firstDue(rep, today);
    });
  const rep = task.repeat;
  const freqValue: Freq | "none" = rep ? rep.freq : "none";

  return (
    <Sheet
      open={!!task}
      onClose={close}
      size="lg"
      title={
        <span className="flex items-center gap-1">
          <TaskCheck task={task} onToggle={() => toggle(task)} disabled={ro} />
          <span className="text-sm text-[var(--text-muted)]">{task.done ? "Completed" : rep ? describeRepeat(rep) : "Task"}</span>
        </span>
      }
      footer={
        <div className="flex w-full items-center gap-2">
          {!ro && (
            <ItemButton
              variant="ghost"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                const copy = JSON.parse(JSON.stringify(task)) as Task;
                const idx = item.data.tasks.findIndex((x) => x.id === task.id);
                item.update((d) => {
                  d.tasks = d.tasks.filter((x) => x.id !== copy.id);
                });
                onClose();
                toast.info(`Deleted “${copy.title}”`, {
                  action: {
                    label: "Undo",
                    onClick: () =>
                      item.update((d) => {
                        if (!d.tasks.some((x) => x.id === copy.id)) d.tasks.splice(Math.min(idx, d.tasks.length), 0, copy);
                      }),
                  },
                });
              }}
              className="text-[var(--danger)]"
            >
              Delete
            </ItemButton>
          )}
          <ItemButton variant="ghost" icon={<Send className="h-4 w-4" />} onClick={() => setSending(true)}>
            Send to…
          </ItemButton>
          <ItemButton variant="primary" className="ml-auto" onClick={close}>
            Done
          </ItemButton>
        </div>
      }
    >
      <SendToSheet open={sending} onClose={() => setSending(false)} target={{ kind: "task", id: task.id, file_id: item.fileId, title: task.title }} />
      <fieldset disabled={ro} className="flex flex-col gap-3">
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitText}
          aria-label="Title"
          className="!h-auto border-transparent !px-1 py-1 text-lg font-semibold md:text-base"
        />
        <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={commitText} placeholder="Notes" aria-label="Notes" className="min-h-[64px]" />

        <Row icon={CalendarDays} label="Due">
          <div className="flex flex-wrap gap-1.5">
            {[
              ["Today", today],
              ["Tomorrow", plusDays(today, 1)],
              ["Next week", plusDays(today, ((7 - weekday(today) + s.week_start) % 7) || 7)],
            ].map(([label, day]) => (
              <Chip key={label} active={task.due === day} onClick={() => setDue(day)}>
                {label}
              </Chip>
            ))}
            <Chip active={!task.due} onClick={() => setDue(null)}>
              No date
            </Chip>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Day">
              <TextInput type="date" value={task.due ?? ""} onChange={(e) => setDue(e.target.value || null)} />
            </Field>
            <Field label="Time">
              <div className="flex items-center gap-1">
                <TextInput type="time" value={task.time ?? ""} onChange={(e) => setTime(e.target.value || null)} />
                {task.time && (
                  <button type="button" aria-label="Make it all day" onClick={() => edit((t) => void (t.time = null))} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </Field>
          </div>
          {task.due && task.due !== today && <p className="px-1 text-xs text-[var(--text-muted)]">{fmtDay(task.due, { long: true })}</p>}
        </Row>

        <Row icon={Bell} label="Reminders">
          {!task.due ? (
            <p className="text-xs text-[var(--text-muted)]">Give it a day to set a reminder.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {ALERTS.filter((a) => task.time || a.value === 0 || a.value >= 1440).map((a) => {
                const on = task.alerts.includes(a.value);
                return (
                  <Chip
                    key={a.value}
                    active={on}
                    onClick={() =>
                      edit((t) => {
                        t.alerts = on ? t.alerts.filter((m) => m !== a.value) : [...new Set([...t.alerts, a.value])].sort((x, y) => x - y).slice(0, 5);
                      })
                    }
                  >
                    {alertLabel(a.value, !!task.time, s.default_time)}
                  </Chip>
                );
              })}
            </div>
          )}
        </Row>

        <Row icon={RepeatIcon} label="Repeat">
          <Select
            value={freqValue}
            aria-label="Repeat"
            onChange={(e) => {
              const v = e.target.value as Freq | "none";
              if (v === "none") return setRepeat(null);
              const day = task.due ?? today;
              setRepeat(
                makeRepeat({
                  freq: v,
                  interval: rep?.interval ?? 1,
                  from_completion: rep?.from_completion ?? false,
                  weekdays: v === "weekly" ? [weekday(day)] : [],
                  month_day: v === "monthly" ? Number(day.slice(8, 10)) : null,
                }),
              );
            }}
          >
            <option value="none">Doesn't repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </Select>
          {rep && (
            <div className="flex flex-col gap-3 rounded-xl bg-[var(--surface-2)] p-3">
              <Stepper
                label={`Every … ${({ daily: "days", weekly: "weeks", monthly: "months", yearly: "years" } as const)[rep.freq]}`}
                value={rep.interval}
                min={1}
                max={365}
                onChange={(v) => edit((t) => void (t.repeat && (t.repeat.interval = v)))}
              />
              {rep.freq === "weekly" && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-[var(--text-muted)]">On</span>
                  <div className="grid grid-cols-7 gap-1">
                    {WEEKDAY_SHORT.map((d, i) => {
                      const on = rep.weekdays.includes(i);
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            edit((t) => {
                              if (!t.repeat) return;
                              const next = on ? t.repeat.weekdays.filter((x) => x !== i) : [...t.repeat.weekdays, i].sort();
                              t.repeat.weekdays = next.length ? next : t.repeat.weekdays;
                            })
                          }
                          className={cn(
                            "h-10 rounded-lg text-xs font-medium transition",
                            on ? "bg-[var(--item-accent)] text-white" : "bg-[var(--surface)] text-[var(--text-muted)]",
                          )}
                        >
                          {d.slice(0, 2)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {rep.freq === "monthly" && (
                <Stepper label="On day of the month" value={rep.month_day ?? Number((task.due ?? today).slice(8, 10))} min={1} max={31} onChange={(v) => edit((t) => void (t.repeat && (t.repeat.month_day = v)))} />
              )}
              <label className="flex items-center justify-between gap-3 text-sm text-[var(--text)]">
                <span>
                  Count from when it's done
                  <span className="block text-xs text-[var(--text-muted)]">“Water the plants 3 days after I last did”</span>
                </span>
                <Toggle label="Count from when it's done" checked={rep.from_completion} onChange={(v) => edit((t) => void (t.repeat && (t.repeat.from_completion = v)))} />
              </label>
              <Field label="Ends (optional)">
                <TextInput type="date" value={rep.until ?? ""} onChange={(e) => edit((t) => void (t.repeat && (t.repeat.until = e.target.value || null)))} />
              </Field>
            </div>
          )}
        </Row>

        <Row icon={Flag} label="Priority & list">
          <Segmented
            value={String(task.priority) as "0"}
            onChange={(v) => edit((t) => void (t.priority = Number(v)))}
            options={PRIORITY.map((p) => ({ value: String(p.value) as "0", label: p.label }))}
            className="w-full"
          />
          <Select value={task.list_id} aria-label="List" onChange={(e) => edit((t) => void (t.list_id = e.target.value))}>
            {item.data.lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.emoji ? `${l.emoji} ` : ""}
                {l.name}
              </option>
            ))}
          </Select>
          <Field label="Tags" hint="Shared with your other apps">
            <TagPicker value={task.tags} onChange={(tags) => edit((t) => void (t.tags = tags))} max={20} disabled={ro} placeholder="errands, calls" />
          </Field>
        </Row>

        <Row icon={ListChecks} label={`Steps${task.steps.length ? ` · ${task.steps.filter((x) => x.done).length}/${task.steps.length}` : ""}`}>
          {task.steps.length > 0 && (
            <ul className="flex flex-col">
              {task.steps.map((st) => (
                <li key={st.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={st.done}
                    aria-label={st.title}
                    onClick={() => {
                      const target = !st.done;
                      edit((t) => {
                        const x = t.steps.find((y) => y.id === st.id);
                        if (x) x.done = target;
                      });
                    }}
                    className="flex h-10 w-10 shrink-0 items-center justify-center"
                  >
                    <span className={cn("h-4 w-4 rounded border-2 border-[var(--text-muted)]", st.done && "border-[var(--item-accent)] bg-[var(--item-accent)]")} />
                  </button>
                  <span className={cn("min-w-0 flex-1 text-sm text-[var(--text)]", st.done && "text-[var(--text-muted)] line-through")}>{st.title}</span>
                  <button type="button" aria-label={`Remove step ${st.title}`} onClick={() => edit((t) => void (t.steps = t.steps.filter((y) => y.id !== st.id)))} className="flex h-10 w-10 items-center justify-center text-[var(--text-muted)] hover:text-[var(--danger)]">
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = step.trim();
              if (!v) return;
              const id = uid("s");
              edit((t) => void t.steps.push({ id, title: v.slice(0, 300), done: false }));
              setStep("");
            }}
          >
            <TextInput value={step} onChange={(e) => setStep(e.target.value)} placeholder="Add a step" aria-label="New step" enterKeyHint="done" />
            <ItemButton type="submit" aria-label="Add step" icon={<Plus className="h-4 w-4" />} disabled={!step.trim()} />
          </form>
        </Row>
        {task.created_at && (
          <p className="flex items-center gap-1 px-1 text-[11px] text-[var(--text-muted)]">
            <Clock className="h-3 w-3" />
            Added {fmtDay(task.created_at.slice(0, 10))}
            {task.done_at ? ` · done ${fmtDay(task.done_at.slice(0, 10))}` : ""}
          </p>
        )}
      </fieldset>
      <LinkedSection thing={{ kind: "task", id: `${item.fileId}:${task.id}` }} readOnly={ro} className="mt-4" />
    </Sheet>
  );
}
