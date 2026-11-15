import type { SetupField, SetupStep } from "@/api/home";

/**
 * One step of adding a device, drawn from the plain shape the home's box
 * sends (``home-box/connector/promptly_box.py::shape_flow``): fields to fill
 * in, or none at all ("press the button on the bridge, then Continue"), a
 * list to pick from, a wait, or how it ended. No Home Assistant screens.
 *
 * Pure: it draws ``step`` and ``values`` and reports changes; the sheet
 * around it talks to the box. Tested against recorded steps
 * (``SetupStepView.test.tsx``).
 */

export type Values = Record<string, unknown>;

const box =
  "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

/** What a fresh step starts with: each field's suggested value. */
export function startValues(step: SetupStep): Values {
  const out: Values = {};
  if (step.kind !== "form") return out;
  for (const f of step.fields) {
    if (f.default !== undefined) out[f.name] = f.default;
    else if (f.type === "bool") out[f.name] = false;
    else if (f.type === "multiselect") out[f.name] = [];
  }
  return out;
}

/** What to send for a form: numbers as numbers, empty optional fields left out. */
export function toInput(step: SetupStep, values: Values): Values {
  const out: Values = {};
  if (step.kind !== "form") return out;
  for (const f of step.fields) {
    const v = values[f.name];
    if (f.type === "unsupported") continue;
    if (f.type === "number") {
      if (v === "" || v === undefined || v === null) continue;
      const n = Number(v);
      if (Number.isFinite(n)) out[f.name] = n;
    } else if (f.type === "bool") out[f.name] = v === true;
    else if (f.type === "multiselect") out[f.name] = Array.isArray(v) ? v : [];
    else if (typeof v === "string" && v.trim() === "" && !f.required) continue;
    else if (v !== undefined) out[f.name] = v;
  }
  return out;
}

/** Fields that must be filled and aren't. */
export function missing(step: SetupStep, values: Values): string[] {
  if (step.kind !== "form") return [];
  return step.fields
    .filter((f) => f.required && f.type !== "bool" && f.type !== "unsupported")
    .filter((f) => {
      const v = values[f.name];
      return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    })
    .map((f) => f.name);
}

/** A step we can't draw all of: it needs a kind of answer Promptly doesn't have yet. */
export function cannotDraw(step: SetupStep): boolean {
  return step.kind === "form" && step.fields.some((f) => f.type === "unsupported" && f.required);
}

function FieldView({ field, value, error, onChange }: { field: SetupField; value: unknown; error?: string; onChange: (v: unknown) => void }) {
  const id = `setup-${field.name}`;
  const label = (
    <span className="text-sm font-medium text-[var(--text)]">
      {field.label}
      {!field.required && field.type !== "bool" && <span className="font-normal text-[var(--text-muted)]"> (optional)</span>}
    </span>
  );
  const under = (
    <>
      {field.hint && <span className="text-xs text-[var(--text-muted)]">{field.hint}</span>}
      {error && <span role="alert" className="text-xs text-[var(--danger)]">{error}</span>}
    </>
  );
  if (field.type === "bool") {
    return (
      <label htmlFor={id} className="flex min-h-11 items-center justify-between gap-3">
        <span className="flex flex-col">{label}{under}</span>
        <input id={id} type="checkbox" role="switch" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-[var(--accent)]" />
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label htmlFor={id} className="flex flex-col gap-1.5">
        {label}
        <select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} className={box}>
          {(!field.required || value === undefined || value === "") && <option value="">Choose…</option>}
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {under}
      </label>
    );
  }
  if (field.type === "multiselect") {
    const picked = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5">{label}</legend>
        {field.options?.map((o) => (
          <label key={o.value} className="flex min-h-9 items-center gap-2.5 text-sm text-[var(--text)]">
            <input type="checkbox" checked={picked.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...picked, o.value] : picked.filter((p) => p !== o.value))} className="h-4 w-4 accent-[var(--accent)]" />
            {o.label}
          </label>
        ))}
        {under}
      </fieldset>
    );
  }
  if (field.type === "unsupported") {
    return (
      <p className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)]">
        <span className="font-medium text-[var(--text)]">{field.label}</span>: Promptly can't ask for this kind of answer yet.
      </p>
    );
  }
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      {label}
      <input
        id={id}
        type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
        inputMode={field.type === "number" ? "decimal" : undefined}
        min={field.min}
        max={field.max}
        step={field.step}
        value={typeof value === "string" || typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={field.type === "password" ? "off" : undefined}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        className={box}
      />
      {under}
    </label>
  );
}

export function SetupStepView({ step, values, onChange, onPick }: { step: SetupStep; values: Values; onChange: (name: string, v: unknown) => void; onPick: (option: string) => void }) {
  if (step.kind === "wait") {
    return <p role="status" className="py-6 text-center text-sm text-[var(--text-muted)]">{step.text}</p>;
  }
  if (step.kind === "stopped" || step.kind === "elsewhere") {
    return (
      <div className="flex flex-col gap-2 py-2">
        <p className="text-sm font-medium text-[var(--text)]">{step.kind === "stopped" ? `${step.brand_name} wasn't added` : `${step.brand_name} can't be added here yet`}</p>
        <p className="whitespace-pre-line text-sm text-[var(--text-muted)]">{step.text}</p>
      </div>
    );
  }
  if (step.kind === "done") {
    return <p className="text-sm text-[var(--text)]">{step.title} is added.</p>;
  }
  if (step.kind === "menu") {
    return (
      <div className="flex flex-col gap-3">
        {step.text && <p className="whitespace-pre-line text-sm text-[var(--text-muted)]">{step.text}</p>}
        <div className="flex flex-col gap-2">
          {step.options.map((o) => (
            <button key={o.value} type="button" onClick={() => onPick(o.value)} className="flex min-h-11 items-center rounded-xl border border-[var(--border)] px-3 text-left text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {step.text && <p className="whitespace-pre-line text-sm text-[var(--text-muted)]">{step.text}</p>}
      {step.errors.base && <p role="alert" className="rounded-xl border border-[var(--danger)]/50 px-3 py-2 text-sm text-[var(--danger)]">{step.errors.base}</p>}
      {step.fields.map((f) => <FieldView key={f.name} field={f} value={values[f.name]} error={step.errors[f.name]} onChange={(v) => onChange(f.name, v)} />)}
      {step.fields.length === 0 && !step.text && <p className="text-sm text-[var(--text-muted)]">Ready when you are.</p>}
    </div>
  );
}
