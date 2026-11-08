import { Globe, Users } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { formsApi, type FormSettings, type FormView } from "@/api/forms";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { LookPanel } from "./LookPanel";
import { Switch, fieldCls } from "./ui";
import type { FormDoc } from "./useFormDoc";

/**
 * Settings, in plain words and groups: who can answer, answers, closing,
 * after sending, and the look. Each change saves straight away.
 */
export function SettingsTab({
  view,
  onView,
  doc,
  fileId,
}: {
  view: FormView;
  onView: (v: FormView) => void;
  doc: FormDoc;
  fileId: string;
}) {
  const s = view.form.settings;
  const [saving, setSaving] = useState(false);

  const change = async (patch: Partial<FormSettings>) => {
    const before = view;
    // Show it at once; put it back if the server says no.
    onView({ ...view, form: { ...view.form, settings: { ...s, ...patch } } });
    setSaving(true);
    try {
      onView(await formsApi.updateSettings(fileId, patch));
    } catch (e) {
      onView(before);
      toast.error(apiErrorMessage(e, "That setting couldn't be saved."));
    } finally {
      setSaving(false);
    }
  };

  const link = s.audience === "link";
  return (
    <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-5 pb-24">
        <p className="sr-only" role="status" aria-live="polite">
          {saving ? "Saving…" : ""}
        </p>

        <Group title="Who can answer">
          <div role="radiogroup" aria-label="Who can answer" className="flex flex-col gap-2">
            <Choice
              name="audience"
              checked={!link}
              onChange={() => void change({ audience: "server" })}
              icon={<Users className="h-5 w-5" />}
              title="People on this server"
              text="Only people with an account here can answer. They sign in first, so you see who answered."
            />
            <Choice
              name="audience"
              checked={link}
              disabled={!view.link_answers_allowed && !link}
              onChange={() => void change({ audience: "link" })}
              icon={<Globe className="h-5 w-5" />}
              title="Anyone with the link"
              text={
                view.link_answers_allowed
                  ? "Anyone you send the link to can answer, without an account. Spam limits are on automatically."
                  : "Your server's admin has turned this off."
              }
            />
          </div>
        </Group>

        <Group title="Answers">
          <Switch
            checked={s.one_per_person}
            onChange={(v) => void change({ one_per_person: v })}
            label="Only one answer per person"
            hint={
              link
                ? "With a link, people aren't signed in, so this only stops a second answer from the same device."
                : "Each person on this server can answer once."
            }
          />
          <Switch
            checked={s.allow_edit}
            onChange={(v) => void change({ allow_edit: v })}
            label="Let people change their answer after sending"
            hint={link ? "They get a private link to come back to their answer." : undefined}
          />
          {link && (
            <Switch
              checked={s.collect_email}
              onChange={(v) => void change({ collect_email: v })}
              label="Ask for an email address"
              hint="People type it in. It isn't checked, so treat it as a contact detail, not proof of who answered."
            />
          )}
          <Switch
            checked={s.show_remaining}
            onChange={(v) => void change({ show_remaining: v })}
            label="Show places left on limited options"
            hint="For example “Salad · 2 left”. Full options disappear either way."
          />
          {link && (
            <Switch
              checked={s.allow_uploads_from_link}
              onChange={(v) => void change({ allow_uploads_from_link: v })}
              label="Let people without an account send files"
              hint="Pictures and PDFs only. Files aren't checked for viruses on this server, so open them with care."
            />
          )}
        </Group>

        <Group title="Closing">
          <CloseAt value={s.close_at} onChange={(v) => void change({ close_at: v })} />
          <MaxAnswers value={s.max_responses} onChange={(v) => void change({ max_responses: v })} />
          <TextSetting
            label="Message when it's closed"
            placeholder="This form isn't taking answers any more."
            value={s.closed_message}
            onSave={(v) => void change({ closed_message: v })}
          />
        </Group>

        <Group title="After sending">
          <TextSetting
            label="Confirmation message"
            placeholder="Your answer has been sent."
            value={s.confirmation}
            onSave={(v) => void change({ confirmation: v })}
          />
          <Switch
            checked={s.allow_another}
            onChange={(v) => void change({ allow_another: v })}
            label="Show a “Send another answer” link"
          />
        </Group>

        <Group title="Look">
          <LookPanel doc={doc} fileId={fileId} />
        </Group>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4" aria-label={title}>
      <h2 className="mb-3 text-base font-semibold text-[var(--text)]">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Choice({
  name,
  checked,
  onChange,
  icon,
  title,
  text,
  disabled,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  icon: ReactNode;
  title: string;
  text: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]",
        checked ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)] hover:bg-[var(--hover)]",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      <input type="radio" name={name} className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={onChange} />
      <span className="mt-0.5 text-[var(--text-muted)]" aria-hidden="true">
        {icon}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-[var(--text)]">{title}</span>
        <span className="text-xs text-[var(--text-muted)]">{text}</span>
      </span>
    </label>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CloseAt({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [on, setOn] = useState(!!value);
  const [text, setText] = useState(toLocalInput(value));
  useEffect(() => {
    setOn(!!value);
    setText(toLocalInput(value));
  }, [value]);
  const past = value ? new Date(value).getTime() <= Date.now() : false;
  return (
    <div className="flex flex-col gap-2">
      <Switch
        checked={on}
        onChange={(v) => {
          setOn(v);
          if (!v) onChange(null);
        }}
        label="Close on a date and time"
      />
      {on && (
        <div className="flex flex-col gap-1 pl-14">
          <label className="text-xs text-[var(--text-muted)]" htmlFor="form-close-at">
            Closes at (your time)
          </label>
          <input
            id="form-close-at"
            type="datetime-local"
            className={cn(fieldCls, "h-10 max-w-xs")}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const d = new Date(e.target.value);
              if (e.target.value && !Number.isNaN(d.getTime())) onChange(d.toISOString());
            }}
          />
          {past && <p className="text-xs text-amber-700 dark:text-amber-400">That time has passed, so the form is closed.</p>}
        </div>
      )}
    </div>
  );
}

function MaxAnswers({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [on, setOn] = useState(value !== null);
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    setOn(value !== null);
    setText(value === null ? "" : String(value));
  }, [value]);
  const timer = useRef<number | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Switch
        checked={on}
        onChange={(v) => {
          setOn(v);
          if (!v) onChange(null);
          else if (text) onChange(Math.max(1, Number(text)));
        }}
        label="Close after a number of answers"
      />
      {on && (
        <div className="flex flex-col gap-1 pl-14">
          <label className="text-xs text-[var(--text-muted)]" htmlFor="form-max-answers">
            Number of answers
          </label>
          <input
            id="form-max-answers"
            type="number"
            min={1}
            max={100000}
            inputMode="numeric"
            className={cn(fieldCls, "h-10 w-32")}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (timer.current) window.clearTimeout(timer.current);
              const n = Math.round(Number(e.target.value));
              if (e.target.value && n >= 1 && n <= 100000) timer.current = window.setTimeout(() => onChange(n), 600);
            }}
          />
        </div>
      )}
    </div>
  );
}

function TextSetting({
  label,
  placeholder,
  value,
  onSave,
}: {
  label: string;
  placeholder: string;
  value: string;
  onSave: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const id = useRef(`ts-${Math.random().toString(36).slice(2)}`).current;
  const timer = useRef<number | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const save = (v: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    if (v.trim() !== value) onSave(v.trim());
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm text-[var(--text)]">
        {label}
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={2000}
        className={cn(fieldCls, "resize-y")}
        placeholder={placeholder}
        value={text}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          save(text);
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (timer.current) window.clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = window.setTimeout(() => save(v), 1200);
        }}
      />
    </div>
  );
}
