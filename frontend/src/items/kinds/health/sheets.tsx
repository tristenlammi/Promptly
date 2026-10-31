import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import {
  Chip,
  Field,
  IconButton,
  ItemButton,
  Select,
  Sheet,
  TextArea,
  TextInput,
  Toggle,
  uid,
} from "@/items/ui";
import { cn } from "@/utils/cn";

import { DeleteButton, NumberInput, WhenInput, toLocalInput, fromLocalInput } from "./common";
import type { Appointment, HealthData, LabResult, Symptom, Vaccination } from "./types";
import { nowISO, todayISO } from "./zone";

type H = ItemHandle<HealthData>;

const COMMON_SYMPTOMS = ["Headache", "Fatigue", "Nausea", "Back pain", "Anxiety", "Bloating", "Cramps", "Dizziness", "Insomnia", "Joint pain", "Cough", "Low mood"];

/* -------------------------------------------------------------- symptom */

export function SymptomSheet({ item, editing, onClose }: { item: H; editing?: Symptom | null; onClose: () => void }) {
  const data = item.data;
  const [name, setName] = useState(editing?.name ?? "");
  const [severity, setSeverity] = useState(editing?.severity ?? 5);
  const [tags, setTags] = useState<string[]>(editing?.tags ?? []);
  const [tagText, setTagText] = useState("");
  const [note, setNote] = useState(editing?.note ?? "");
  const [at, setAt] = useState(editing?.at ?? nowISO());

  const recent = useMemo(() => {
    const names: string[] = [];
    const tagsSeen: string[] = [];
    for (let i = data.symptoms.length - 1; i >= 0 && (names.length < 10 || tagsSeen.length < 12); i--) {
      const s = data.symptoms[i];
      if (!names.some((n) => n.toLowerCase() === s.name.toLowerCase())) names.push(s.name);
      for (const t of s.tags) if (!tagsSeen.includes(t)) tagsSeen.push(t);
    }
    const fill = COMMON_SYMPTOMS.filter((c) => !names.some((n) => n.toLowerCase() === c.toLowerCase()));
    return { names: [...names.slice(0, 10), ...fill].slice(0, 14), tags: tagsSeen.slice(0, 12) };
  }, [data.symptoms]);

  const addTag = (t: string) => {
    const v = t.trim().toLowerCase().slice(0, 40);
    if (v && !tags.includes(v) && tags.length < 12) setTags([...tags, v]);
    setTagText("");
  };

  const save = () => {
    const row: Symptom = { id: editing?.id ?? uid("s"), at, name: name.trim(), severity, tags, note: note.trim() };
    item.update((d) => {
      if (editing) d.symptoms = d.symptoms.filter((x) => x.id !== editing.id);
      d.symptoms.push(row);
      d.symptoms.sort((a, b) => (a.at < b.at ? -1 : 1));
    });
    onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={editing ? "Edit symptom" : "Log a symptom"}
      footer={
        <>
          {editing && (
            <DeleteButton
              onDelete={() => {
                item.update((d) => {
                  d.symptoms = d.symptoms.filter((x) => x.id !== editing.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" block disabled={!name.trim()} onClick={save}>
            {editing ? "Save" : "Log it"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Symptom">
          <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Headache" />
        </Field>
        <div className="flex flex-wrap gap-2">
          {recent.names.map((n) => (
            <Chip key={n} active={name.toLowerCase() === n.toLowerCase()} onClick={() => setName(n)}>
              {n}
            </Chip>
          ))}
        </div>
        <Field label={`Severity · ${severity}/10`}>
          <div role="radiogroup" aria-label="Severity" className="grid grid-cols-10 gap-1">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={severity === v}
                aria-label={`Severity ${v}`}
                onClick={() => setSeverity(v)}
                className={cn(
                  "h-11 rounded-lg text-sm font-semibold tabular-nums transition",
                  v <= severity ? "text-white" : "bg-[var(--surface-2)] text-[var(--text-muted)]",
                )}
                style={v <= severity ? { background: `color-mix(in srgb, var(--danger) ${30 + v * 7}%, var(--warning))` } : undefined}
              >
                {v}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Possible factors">
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <Chip key={t} active onClick={() => setTags(tags.filter((x) => x !== t))} icon={<X className="h-3 w-3" />}>
                {t}
              </Chip>
            ))}
            {recent.tags
              .filter((t) => !tags.includes(t))
              .map((t) => (
                <Chip key={t} onClick={() => addTag(t)} icon={<Plus className="h-3 w-3" />}>
                  {t}
                </Chip>
              ))}
          </div>
          <TextInput
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagText);
              }
            }}
            onBlur={() => tagText && addTag(tagText)}
            placeholder="Add a factor: coffee, stress, period…"
          />
        </Field>
        <WhenInput value={at} onChange={setAt} />
        <Field label="Notes">
          <TextArea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Where, how long, what helped" />
        </Field>
      </div>
    </Sheet>
  );
}

/* ----------------------------------------------------------- medication */

export { MedSheet } from "./MedSheet";

/* ----------------------------------------------------------- appointment */

export function AppointmentSheet({ item, editing, onClose }: { item: H; editing?: Appointment | null; onClose: () => void }) {
  const team = item.data.profile.care_team;
  const [a, setA] = useState<Appointment>(
    () =>
      editing ?? {
        id: uid("a"),
        at: (() => {
          const d = new Date();
          d.setDate(d.getDate() + 7);
          const day = todayISO(d);
          return fromLocalInput(`${day}T09:00`);
        })(),
        title: "",
        who: "",
        provider_id: null,
        location: "",
        questions: [],
        notes: "",
        done: false,
      },
  );
  const [q, setQ] = useState("");
  const set = (patch: Partial<Appointment>) => setA((cur) => ({ ...cur, ...patch }));
  const addQ = () => {
    if (q.trim()) set({ questions: [...a.questions, q.trim()].slice(0, 40) });
    setQ("");
  };
  const save = () => {
    const row = { ...a, title: a.title.trim(), who: a.who.trim(), location: a.location.trim() };
    item.update((d) => {
      const i = d.appointments.findIndex((x) => x.id === row.id);
      if (i >= 0) d.appointments[i] = row;
      else d.appointments.push(row);
      d.appointments.sort((x, y) => (x.at < y.at ? -1 : 1));
    });
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      size="lg"
      title={editing ? "Appointment" : "New appointment"}
      footer={
        <>
          {editing && (
            <DeleteButton
              onDelete={() => {
                item.update((d) => {
                  d.appointments = d.appointments.filter((x) => x.id !== editing.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" block disabled={!a.title.trim() && !a.who.trim()} onClick={save}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="What for">
          <TextInput value={a.title} maxLength={160} onChange={(e) => set({ title: e.target.value })} placeholder="Annual check-up" />
        </Field>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">When</span>
          <input
            type="datetime-local"
            value={toLocalInput(a.at)}
            onChange={(e) => e.target.value.length >= 16 && set({ at: fromLocalInput(e.target.value) })}
            className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base tabular-nums text-[var(--text)] outline-none focus:border-[var(--item-accent)] md:h-10 md:text-sm"
          />
        </label>
        <Field label="With">
          {team.length > 0 && (
            <div className="mb-1 flex flex-wrap gap-2">
              {team.map((c) => (
                <Chip
                  key={c.id}
                  active={a.provider_id === c.id}
                  onClick={() => set({ provider_id: a.provider_id === c.id ? null : c.id, who: c.name, location: a.location || c.address || c.clinic })}
                >
                  {c.name}
                  {c.role ? ` · ${c.role}` : ""}
                </Chip>
              ))}
            </div>
          )}
          <TextInput value={a.who} maxLength={120} onChange={(e) => set({ who: e.target.value, provider_id: null })} placeholder="Dr Lee" />
        </Field>
        <Field label="Where">
          <TextInput value={a.location} maxLength={300} onChange={(e) => set({ location: e.target.value })} placeholder="Clinic address" />
        </Field>
        <Field label="Questions to ask">
          <ul className="flex flex-col gap-1">
            {a.questions.map((x, i) => (
              <li key={i} className="flex items-center gap-2 rounded-xl bg-[var(--surface-2)] py-1 pl-3 text-sm text-[var(--text)]">
                <span className="flex-1">{x}</span>
                <IconButton label="Remove question" icon={X} onClick={() => set({ questions: a.questions.filter((_, j) => j !== i) })} />
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <TextInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addQ();
                }
              }}
              placeholder="Should I change anything about…"
            />
            <ItemButton onClick={addQ} disabled={!q.trim()}>
              Add
            </ItemButton>
          </div>
        </Field>
        <Field label="Notes / outcome">
          <TextArea value={a.notes} maxLength={4000} onChange={(e) => set({ notes: e.target.value })} placeholder="What was said, the plan, next steps" />
        </Field>
        <div className="flex items-center justify-between rounded-xl border border-[var(--border)] px-3 py-2">
          <span className="text-sm text-[var(--text)]">Done</span>
          <Toggle checked={a.done} onChange={(v) => set({ done: v })} label="Appointment done" />
        </div>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ lab */

export function autoFlag(r: Pick<LabResult, "value" | "ref_low" | "ref_high" | "flag">): LabResult["flag"] {
  if (r.flag && r.flag !== "normal") return r.flag;
  if (r.value === null) return r.flag;
  if (r.ref_low !== null && r.value < r.ref_low) return "low";
  if (r.ref_high !== null && r.value > r.ref_high) return "high";
  if (r.ref_low !== null || r.ref_high !== null) return "normal";
  return "";
}

export function LabSheet({ item, editing, onClose }: { item: H; editing?: LabResult | null; onClose: () => void }) {
  const [r, setR] = useState<LabResult>(
    () =>
      editing ?? { id: uid("l"), day: todayISO(), test: "", value: null, value_text: "", unit: "", ref_low: null, ref_high: null, flag: "", panel: "", note: "" },
  );
  const set = (patch: Partial<LabResult>) => setR((cur) => ({ ...cur, ...patch }));
  const tests = useMemo(() => [...new Set(item.data.labs.map((l) => l.test))].slice(-60), [item.data.labs]);
  const pick = (name: string) => {
    const prev = [...item.data.labs].reverse().find((l) => l.test === name);
    set({ test: name, unit: prev?.unit ?? r.unit, ref_low: prev?.ref_low ?? r.ref_low, ref_high: prev?.ref_high ?? r.ref_high, panel: prev?.panel ?? r.panel });
  };
  const save = () => {
    const row = { ...r, test: r.test.trim(), flag: autoFlag({ ...r, flag: r.flag === "normal" ? "" : r.flag }) };
    item.update((d) => {
      const i = d.labs.findIndex((x) => x.id === row.id);
      if (i >= 0) d.labs[i] = row;
      else d.labs.push(row);
      d.labs.sort((x, y) => (x.day < y.day ? -1 : 1));
    });
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={editing ? "Lab result" : "Add a lab result"}
      footer={
        <>
          {editing && (
            <DeleteButton
              onDelete={() => {
                item.update((d) => {
                  d.labs = d.labs.filter((x) => x.id !== editing.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" block disabled={!r.test.trim() || (r.value === null && !r.value_text.trim())} onClick={save}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Test">
          <TextInput value={r.test} list="health-lab-tests" maxLength={120} onChange={(e) => set({ test: e.target.value })} onBlur={(e) => tests.includes(e.target.value) && pick(e.target.value)} placeholder="HbA1c" />
          <datalist id="health-lab-tests">
            {tests.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Result">
            <NumberInput value={r.value} onChange={(v) => set({ value: v })} placeholder="5.4" ariaLabel="Result value" />
          </Field>
          <Field label="Unit">
            <TextInput value={r.unit} maxLength={30} onChange={(e) => set({ unit: e.target.value })} placeholder="mmol/L" />
          </Field>
        </div>
        <Field label="…or a text result">
          <TextInput value={r.value_text} maxLength={120} onChange={(e) => set({ value_text: e.target.value })} placeholder="Negative" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reference low">
            <NumberInput value={r.ref_low} onChange={(v) => set({ ref_low: v })} ariaLabel="Reference low" />
          </Field>
          <Field label="Reference high">
            <NumberInput value={r.ref_high} onChange={(v) => set({ ref_high: v })} ariaLabel="Reference high" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Collected">
            <TextInput type="date" value={r.day} max={todayISO()} onChange={(e) => e.target.value && set({ day: e.target.value })} />
          </Field>
          <Field label="Lab flag">
            <Select value={r.flag} onChange={(e) => set({ flag: e.target.value as LabResult["flag"] })}>
              <option value="">From the range</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
              <option value="high">High</option>
              <option value="abnormal">Abnormal</option>
              <option value="critical">Critical</option>
            </Select>
          </Field>
        </div>
        <Field label="Panel">
          <TextInput value={r.panel} maxLength={80} onChange={(e) => set({ panel: e.target.value })} placeholder="Lipids" />
        </Field>
        <Field label="Note">
          <TextInput value={r.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} />
        </Field>
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------- vaccination */

export function VaxSheet({ item, editing, onClose }: { item: H; editing?: Vaccination | null; onClose: () => void }) {
  const [v, setV] = useState<Vaccination>(
    () => editing ?? { id: uid("v"), day: todayISO(), name: "", dose_label: "", next_due: null, provider: "", lot: "", note: "" },
  );
  const set = (patch: Partial<Vaccination>) => setV((cur) => ({ ...cur, ...patch }));
  const save = () => {
    const row = { ...v, name: v.name.trim() };
    item.update((d) => {
      const i = d.vaccinations.findIndex((x) => x.id === row.id);
      if (i >= 0) d.vaccinations[i] = row;
      else d.vaccinations.push(row);
      d.vaccinations.sort((x, y) => (x.day < y.day ? -1 : 1));
    });
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={editing ? "Vaccination" : "Add a vaccination"}
      footer={
        <>
          {editing && (
            <DeleteButton
              onDelete={() => {
                item.update((d) => {
                  d.vaccinations = d.vaccinations.filter((x) => x.id !== editing.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" block disabled={!v.name.trim()} onClick={save}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Vaccine">
          <TextInput value={v.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="Influenza" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" value={v.day} onChange={(e) => e.target.value && set({ day: e.target.value })} />
          </Field>
          <Field label="Dose">
            <TextInput value={v.dose_label} maxLength={60} onChange={(e) => set({ dose_label: e.target.value })} placeholder="Booster" />
          </Field>
        </div>
        <Field label="Next due (optional)">
          <TextInput type="date" value={v.next_due ?? ""} onChange={(e) => set({ next_due: e.target.value || null })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Given by">
            <TextInput value={v.provider} maxLength={120} onChange={(e) => set({ provider: e.target.value })} />
          </Field>
          <Field label="Batch / lot">
            <TextInput value={v.lot} maxLength={60} onChange={(e) => set({ lot: e.target.value })} />
          </Field>
        </div>
      </div>
    </Sheet>
  );
}
