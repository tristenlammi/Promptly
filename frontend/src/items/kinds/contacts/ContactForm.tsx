import { Camera, ChevronDown, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Chip, Field, ItemButton, Select, Sheet, TextArea, TextInput, Toggle, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { AVATAR_COLORS, avatarColor, blankContact, fmtDate, hasIdentity, normalizeWebsite, parseDateInput } from "./model";
import { PHOTO_BUDGET_CHARS, photoChars, shrinkPhoto } from "./photo";
import { ContactAvatar, type Handle } from "./shared";
import type { Address, Contact, ImportantDate, Labeled } from "./types";

/* Add or edit a person — every field Google Contacts has. A bottom sheet on
 * a phone, a dialog on desktop. */

const EDITABLE = [
  "prefix", "first", "middle", "last", "suffix", "nickname", "pronouns", "phonetic_first", "phonetic_last",
  "company", "title", "department", "phones", "emails", "addresses", "websites", "birthday", "dates",
  "met_how", "met_where", "met_date", "tags", "notes", "favorite", "color", "photo",
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const PHONE_LABELS = ["mobile", "home", "work", "main", "iPhone", "work fax", "home fax", "pager", "other"];
const EMAIL_LABELS = ["personal", "work", "school", "other"];
const ADDRESS_LABELS = ["home", "work", "other"];
const WEB_LABELS = ["website", "LinkedIn", "Instagram", "X", "Facebook", "GitHub", "Mastodon", "Bluesky", "TikTok", "blog"];

export function ContactForm({
  item,
  open,
  onClose,
  contactId,
  initial,
  onSaved,
}: {
  item: Handle;
  open: boolean;
  onClose: () => void;
  /** Edit this contact; omit to add a new one. */
  contactId?: string | null;
  /** Prefill for a new contact. */
  initial?: Partial<Contact>;
  onSaved?: (id: string) => void;
}) {
  const existing = contactId ? item.data.contacts.find((c) => c.id === contactId) : undefined;
  const [c, setC] = useState<Contact>(() => existing ?? blankContact(initial));
  const [bday, setBday] = useState("");
  const [tagText, setTagText] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shrinking, setShrinking] = useState(false);
  // What the form opened with — saving writes only the fields that differ
  // from it, so someone else's edits to other fields survive.
  const opened = useRef<Contact | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const base = existing ? structuredClone(existing) : blankContact({ cadence_days: item.data.settings.default_cadence_days, ...initial });
    opened.current = existing ? structuredClone(existing) : null;
    setC(base);
    setBday(base.birthday ? fmtDate(base.birthday) : "");
    setTagText(base.tags.join(", "));
    setNewGroup("");
    setMore(!!(base.prefix || base.middle || base.suffix || base.phonetic_first || base.phonetic_last || base.pronouns));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contactId]);

  const set = <K extends keyof Contact>(k: K, v: Contact[K]) => setC((x) => ({ ...x, [k]: v }));
  const bdayParsed = bday.trim() ? parseDateInput(bday) : null;
  const bdayBad = !!bday.trim() && !bdayParsed;

  const pickPhoto = async (file: File) => {
    setShrinking(true);
    try {
      const url = await shrinkPhoto(file, { size: 256, maxChars: 40_000 });
      if (!url) {
        toast.error("That image couldn't be read — try a JPEG or PNG.");
        return;
      }
      const others = photoChars(item.data.contacts.filter((x) => x.id !== c.id));
      if (others + url.length > PHOTO_BUDGET_CHARS) {
        toast.error("This file has no room for more photos — remove some first.");
        return;
      }
      set("photo", url);
    } finally {
      setShrinking(false);
    }
  };

  const save = () => {
    const tags = tagText.split(",").map((t) => t.trim()).filter(Boolean);
    const next: Contact = {
      ...c,
      birthday: bdayParsed,
      tags,
      phones: c.phones.filter((p) => p.value.trim()).map((p) => ({ label: p.label.trim(), value: p.value.trim() })),
      emails: c.emails.filter((p) => p.value.trim()).map((p) => ({ label: p.label.trim(), value: p.value.trim() })),
      websites: c.websites.flatMap((p) => {
        const value = normalizeWebsite(p.label, p.value);
        return value ? [{ label: p.label.trim(), value }] : [];
      }),
      addresses: c.addresses.filter((a) => a.street || a.city || a.region || a.postcode || a.country),
      dates: c.dates.filter((d) => d.date),
    };
    if (bdayBad) return setError("The birthday isn't a date I can read — try 15 March 1990 or 15 March.");
    if (!hasIdentity(next)) return setError("Add a name, company, phone or email.");
    if (c.websites.some((w) => w.value.trim() && !normalizeWebsite(w.label, w.value)))
      return setError("One of the websites isn't a web link (http, https, mailto or tel) — fix or remove it.");
    const groupName = newGroup.trim().slice(0, 60);
    // Everything decided out here (ids, time, what changed); the update only
    // applies it — it may run again on someone else's newer copy.
    const now = new Date().toISOString();
    const newGroupId = uid("g");
    const was = opened.current;
    const changed = was ? EDITABLE.filter((k) => !same(next[k], was[k])) : [...EDITABLE];
    const joined = next.groups.filter((g) => !(was?.groups ?? []).includes(g));
    const left = (was?.groups ?? []).filter((g) => !next.groups.includes(g));
    if (was && !changed.length && !joined.length && !left.length && !groupName) {
      onClose();
      return;
    }
    const values = Object.fromEntries(changed.map((k) => [k, structuredClone(next[k])]));
    item.update((d) => {
      let gid: string | null = null;
      if (groupName) {
        let g = d.groups.find((x) => x.name.toLowerCase() === groupName.toLowerCase() || x.id === newGroupId);
        if (!g && d.groups.length < 200) {
          g = { id: newGroupId, name: groupName, color: null, description: "" };
          d.groups.push(g);
        }
        gid = g?.id ?? null;
      }
      const target = d.contacts.find((x) => x.id === next.id);
      if (target) {
        Object.assign(target, structuredClone(values));
        target.groups = [...new Set([...target.groups.filter((g) => !left.includes(g)), ...joined, ...(gid ? [gid] : [])])];
        target.updated_at = now;
      } else if (!was) {
        d.contacts.push({ ...structuredClone(next), groups: [...new Set([...next.groups, ...(gid ? [gid] : [])])], created_at: now, updated_at: now });
      }
    });
    onSaved?.(next.id);
    onClose();
  };

  const groups = item.data.groups;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title={existing ? "Edit contact" : "New contact"}
      footer={
        <>
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton variant="primary" block disabled={shrinking} onClick={save}>
            {existing ? "Save" : "Add contact"}
          </ItemButton>
        </>
      }
    >
      <form
        className="flex flex-col gap-5 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {error && (
          <p role="alert" className="rounded-xl bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <div className="flex shrink-0 flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => photoInput.current?.click()}
              aria-label={c.photo ? "Change photo" : "Add a photo"}
              className="relative rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              <ContactAvatar contact={c} size={56} linked={false} />
              <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]">
                <Camera className="h-3.5 w-3.5" />
              </span>
            </button>
            {c.photo && (
              <button type="button" onClick={() => set("photo", null)} className="min-h-[32px] px-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--danger)]">
                Remove
              </button>
            )}
            {shrinking && <span className="text-xs text-[var(--text-muted)]" aria-live="polite">Shrinking…</span>}
            <input
              ref={photoInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickPhoto(f);
                e.target.value = "";
              }}
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Avatar colour">
            {AVATAR_COLORS.map((col) => (
              <button
                key={col}
                type="button"
                role="radio"
                aria-checked={avatarColor(c) === col}
                aria-label={`Colour ${col}`}
                onClick={() => set("color", col)}
                className={cn("h-7 w-7 rounded-full border-2 transition", avatarColor(c) === col ? "border-[var(--text)]" : "border-transparent")}
                style={{ background: col }}
              />
            ))}
          </div>
        </div>

        <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <legend className="sr-only">Name</legend>
          <Field label="First name">
            <TextInput autoFocus value={c.first} onChange={(e) => set("first", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Last name">
            <TextInput value={c.last} onChange={(e) => set("last", e.target.value)} autoComplete="off" />
          </Field>
          {more && (
            <>
              <Field label="Prefix">
                <TextInput value={c.prefix} onChange={(e) => set("prefix", e.target.value)} placeholder="Dr" />
              </Field>
              <Field label="Middle name">
                <TextInput value={c.middle} onChange={(e) => set("middle", e.target.value)} />
              </Field>
              <Field label="Suffix">
                <TextInput value={c.suffix} onChange={(e) => set("suffix", e.target.value)} placeholder="Jr." />
              </Field>
              <Field label="Pronouns">
                <TextInput value={c.pronouns} onChange={(e) => set("pronouns", e.target.value)} placeholder="she/her" />
              </Field>
              <Field label="Phonetic first name">
                <TextInput value={c.phonetic_first} onChange={(e) => set("phonetic_first", e.target.value)} />
              </Field>
              <Field label="Phonetic last name">
                <TextInput value={c.phonetic_last} onChange={(e) => set("phonetic_last", e.target.value)} />
              </Field>
            </>
          )}
          <Field label="Nickname">
            <TextInput value={c.nickname} onChange={(e) => set("nickname", e.target.value)} />
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => setMore((m) => !m)}
              aria-expanded={more}
              className="inline-flex h-11 items-center gap-1 rounded-xl px-2 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]"
            >
              <ChevronDown className={cn("h-4 w-4 transition", more && "rotate-180")} />
              {more ? "Fewer name fields" : "Prefix, middle, pronouns, phonetic…"}
            </button>
          </div>
        </fieldset>

        <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Work</legend>
          <Field label="Company">
            <TextInput value={c.company} onChange={(e) => set("company", e.target.value)} />
          </Field>
          <Field label="Job title">
            <TextInput value={c.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="Department">
            <TextInput value={c.department} onChange={(e) => set("department", e.target.value)} />
          </Field>
        </fieldset>

        <LabeledList title="Phone" items={c.phones} labels={PHONE_LABELS} inputMode="tel" type="tel" placeholder="+61 400 000 000" defaultLabel="mobile" onChange={(v) => set("phones", v)} />
        <LabeledList title="Email" items={c.emails} labels={EMAIL_LABELS} inputMode="email" type="email" placeholder="name@example.com" defaultLabel="personal" onChange={(v) => set("emails", v)} />
        <AddressList items={c.addresses} onChange={(v) => set("addresses", v)} />
        <LabeledList title="Website or profile" items={c.websites} labels={WEB_LABELS} inputMode="url" type="text" placeholder="linkedin.com/in/…" defaultLabel="website" onChange={(v) => set("websites", v)} />

        <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Dates</legend>
          <Field
            label="Birthday"
            hint={bdayBad ? <span className="text-[var(--danger)]">Try “15 March 1990”, “15/03” or “1990-03-15”.</span> : bdayParsed ? fmtDate(bdayParsed) + (bdayParsed.startsWith("--") ? " (no year)" : "") : "Year optional"}
          >
            <TextInput value={bday} onChange={(e) => setBday(e.target.value)} placeholder="15 March 1990" />
          </Field>
          <div className="hidden sm:block" />
          <DateList items={c.dates} onChange={(v) => set("dates", v)} />
        </fieldset>

        <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">How you met</legend>
          <Field label="How" className="sm:col-span-3">
            <TextInput value={c.met_how} onChange={(e) => set("met_how", e.target.value)} placeholder="Intro from Priya" />
          </Field>
          <Field label="Where" className="sm:col-span-2">
            <TextInput value={c.met_where} onChange={(e) => set("met_where", e.target.value)} placeholder="DevCon 2026" />
          </Field>
          <Field label="When">
            <TextInput type="date" value={c.met_date ?? ""} onChange={(e) => set("met_date", e.target.value || null)} />
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Organise</legend>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--text)]">Favourite</span>
            <Toggle checked={c.favorite} onChange={(v) => set("favorite", v)} label="Favourite" />
          </div>
          {groups.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Groups">
              {groups.map((g) => (
                <Chip
                  key={g.id}
                  active={c.groups.includes(g.id)}
                  onClick={() => set("groups", c.groups.includes(g.id) ? c.groups.filter((x) => x !== g.id) : [...c.groups, g.id])}
                >
                  {g.name}
                </Chip>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="New group">
              <TextInput value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="Book club" />
            </Field>
            <Field label="Tags" hint="Separate with commas">
              <TextInput value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="climbing, neighbours" />
            </Field>
          </div>
          <Field label="Notes">
            <TextArea value={c.notes} onChange={(e) => set("notes", e.target.value)} rows={4} />
          </Field>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

function LabeledList({
  title,
  items,
  labels,
  onChange,
  placeholder,
  inputMode,
  type,
  defaultLabel,
}: {
  title: string;
  items: Labeled[];
  labels: string[];
  onChange: (v: Labeled[]) => void;
  placeholder: string;
  inputMode: "tel" | "email" | "url";
  type: string;
  defaultLabel: string;
}) {
  const listId = useId();
  const used = useMemo(() => new Set(items.map((i) => i.label)), [items]);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{title}s</legend>
      <datalist id={listId}>
        {labels.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <TextInput
            aria-label={`${title} ${i + 1} label`}
            list={listId}
            value={it.label}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            className="w-28 shrink-0 sm:w-36"
          />
          <TextInput
            aria-label={`${title} ${i + 1}`}
            type={type}
            inputMode={inputMode}
            value={it.value}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
          />
          <button
            type="button"
            aria-label={`Remove ${title.toLowerCase()} ${i + 1}`}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, { label: items.length === 0 ? defaultLabel : labels.find((l) => !used.has(l)) ?? "other", value: "" }])}
        className="inline-flex h-10 w-fit items-center gap-1.5 rounded-xl px-2 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]"
      >
        <Plus className="h-4 w-4" /> Add {title.toLowerCase()}
      </button>
    </fieldset>
  );
}

function AddressList({ items, onChange }: { items: Address[]; onChange: (v: Address[]) => void }) {
  const listId = useId();
  const patch = (i: number, p: Partial<Address>) => onChange(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Addresses</legend>
      <datalist id={listId}>
        {ADDRESS_LABELS.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      {items.map((a, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--border)] p-3 sm:grid-cols-6">
          <TextInput aria-label="Address label" list={listId} value={a.label} onChange={(e) => patch(i, { label: e.target.value })} className="col-span-1 sm:col-span-2" />
          <div className="col-span-1 flex justify-end sm:col-span-4">
            <button
              type="button"
              aria-label={`Remove address ${i + 1}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <TextInput aria-label="Street" placeholder="Street" value={a.street} onChange={(e) => patch(i, { street: e.target.value })} className="col-span-2 sm:col-span-6" autoComplete="off" />
          <TextInput aria-label="City" placeholder="City" value={a.city} onChange={(e) => patch(i, { city: e.target.value })} className="col-span-2 sm:col-span-3" />
          <TextInput aria-label="State / region" placeholder="State" value={a.region} onChange={(e) => patch(i, { region: e.target.value })} className="sm:col-span-2" />
          <TextInput aria-label="Postcode" placeholder="Postcode" value={a.postcode} onChange={(e) => patch(i, { postcode: e.target.value })} className="sm:col-span-1" />
          <TextInput aria-label="Country" placeholder="Country" value={a.country} onChange={(e) => patch(i, { country: e.target.value })} className="col-span-2 sm:col-span-6" />
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, { label: items.length ? "work" : "home", street: "", city: "", region: "", postcode: "", country: "" }])}
        className="inline-flex h-10 w-fit items-center gap-1.5 rounded-xl px-2 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]"
      >
        <Plus className="h-4 w-4" /> Add address
      </button>
    </fieldset>
  );
}

function DateList({ items, onChange }: { items: ImportantDate[]; onChange: (v: ImportantDate[]) => void }) {
  const [text, setText] = useState<Record<string, string>>({});
  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      {items.map((d, i) => {
        const raw = text[d.id] ?? fmtDate(d.date);
        const parsed = parseDateInput(raw);
        return (
          <div key={d.id} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
            <TextInput aria-label="Date label" value={d.label} placeholder="Anniversary" onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <Select
              aria-label="Kind"
              value={d.kind}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, kind: e.target.value as ImportantDate["kind"] } : x)))}
              className="w-36"
            >
              <option value="anniversary">Anniversary</option>
              <option value="other">Other date</option>
            </Select>
            <TextInput
              aria-label="Date"
              aria-invalid={!parsed}
              value={raw}
              placeholder="20 Nov 2016"
              onChange={(e) => {
                setText((t) => ({ ...t, [d.id]: e.target.value }));
                const p = parseDateInput(e.target.value);
                if (p) onChange(items.map((x, j) => (j === i ? { ...x, date: p } : x)));
              }}
              className={cn(!parsed && "border-[var(--danger)]")}
            />
            <button
              type="button"
              aria-label={`Remove ${d.label || "date"}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...items, { id: uid("d"), label: "Anniversary", date: "", kind: "anniversary", remind: true }])}
        className="inline-flex h-10 w-fit items-center gap-1.5 rounded-xl px-2 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]"
      >
        <Plus className="h-4 w-4" /> Add anniversary or date
      </button>
    </div>
  );
}
