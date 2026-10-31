import { GitMerge, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Field, ItemButton, Segmented, Select, Sheet, TextInput, Toggle } from "@/items/ui";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { toGoogleCSV } from "./csv";
import { CADENCES, COUNTRY_NAMES, displayName, duplicateGroups, homeCountry, lastContacted, ruleOutPairs, workLine } from "./model";
import { ContactAvatar, downloadText, safeFilename, useHomeCountry, type Handle } from "./shared";
import type { Contact } from "./types";
import { toVCards } from "./vcard";

// ------------------------------------------------------------------ export

type Scope = "all" | "favorites" | "group" | "tag";
type Format = "vcf3" | "vcf4" | "csv";

export function ExportSheet({ item, open, onClose, title }: { item: Handle; open: boolean; onClose: () => void; title: string }) {
  const data = item.data;
  const cc = useHomeCountry(item);
  const [scope, setScope] = useState<Scope>("all");
  const [group, setGroup] = useState("");
  const [tag, setTag] = useState("");
  const [format, setFormat] = useState<Format>("vcf3");
  const tags = useMemo(() => [...new Set(data.contacts.flatMap((c) => c.tags))].sort(), [data.contacts]);
  const chosen = useMemo(() => {
    switch (scope) {
      case "favorites":
        return data.contacts.filter((c) => c.favorite);
      case "group":
        return data.contacts.filter((c) => c.groups.includes(group));
      case "tag":
        return data.contacts.filter((c) => c.tags.includes(tag));
      default:
        return data.contacts;
    }
  }, [scope, group, tag, data.contacts]);
  useEffect(() => {
    if (open) {
      setGroup(data.groups[0]?.id ?? "");
      setTag(tags[0] ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const go = () => {
    const byId = new Map(data.contacts.map((c) => [c.id, c]));
    const base = safeFilename(title);
    if (format === "csv") downloadText(`${base}.csv`, "﻿" + toGoogleCSV(chosen, data.groups, byId), "text/csv;charset=utf-8");
    else downloadText(`${base}.vcf`, toVCards(chosen, data.groups, format === "vcf4" ? "4.0" : "3.0", byId, cc), "text/vcard;charset=utf-8");
    toast.success(`Exported ${chosen.length.toLocaleString()} ${chosen.length === 1 ? "person" : "people"}`);
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Export contacts"
      footer={
        <ItemButton variant="primary" block disabled={!chosen.length} onClick={go}>
          Download {chosen.length.toLocaleString()}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Who">
          <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="all">Everyone ({data.contacts.length})</option>
            <option value="favorites">Favourites</option>
            {data.groups.length > 0 && <option value="group">A group</option>}
            {tags.length > 0 && <option value="tag">A tag</option>}
          </Select>
        </Field>
        {scope === "group" && (
          <Field label="Group">
            <Select value={group} onChange={(e) => setGroup(e.target.value)}>
              {data.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {scope === "tag" && (
          <Field label="Tag">
            <Select value={tag} onChange={(e) => setTag(e.target.value)}>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Format">
          <Segmented<Format>
            value={format}
            onChange={setFormat}
            options={[
              { value: "vcf3", label: "vCard 3.0" },
              { value: "vcf4", label: "vCard 4.0" },
              { value: "csv", label: "Google CSV" },
            ]}
          />
        </Field>
        <p className="text-xs text-[var(--text-muted)]">
          vCard 3.0 opens everywhere (iPhone, Android, Google, Outlook) and carries photos. 4.0 keeps pronouns and relationships in the standard fields. CSV is for spreadsheets and Google Contacts (no photos).
          Interactions and private notes like gift ideas stay here. Re-importing an exported file matches people up again by their card ID.
        </p>
      </div>
    </Sheet>
  );
}

// -------------------------------------------------------------- duplicates

function completeness(c: Contact): number {
  let n = 0;
  for (const v of [c.first, c.last, c.company, c.title, c.nickname, c.birthday, c.notes, c.met_how]) if (v) n++;
  return n + c.phones.length + c.emails.length + c.addresses.length + c.interactions.length * 2 + c.relationships.length + c.remember.length;
}

interface Preview {
  keep: string;
  merged: Contact;
}

/** The server merges at most this many into one contact per call. */
const MERGE_BATCH = 20;

export function DuplicatesSheet({ item, open, onClose }: { item: Handle; open: boolean; onClose: () => void }) {
  const data = item.data;
  const cc = useHomeCountry(item);
  const groups = useMemo(() => duplicateGroups(data, cc), [data, cc]);
  // "Merge all" only takes sets linked by an email / full phone / card —
  // never a name — and asks first.
  const strongGroups = useMemo(() => duplicateGroups(data, cc, { strongOnly: true }), [data, cc]);
  const byId = useMemo(() => new Map(data.contacts.map((c) => [c.id, c])), [data.contacts]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [group, setGroup] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (open) {
      setPreview(null);
      setConfirmAll(false);
    }
  }, [open]);

  const bestOf = (ids: string[]) => [...ids].sort((a, b) => completeness(byId.get(b)!) - completeness(byId.get(a)!))[0];

  const showPreview = async (ids: string[], keep: string) => {
    setBusy("preview");
    try {
      const res = await item.runAction<{ merged: Contact }>("preview_merge", { keep_id: keep, merge_ids: ids.filter((x) => x !== keep) });
      setGroup(ids);
      setPreview({ keep, merged: res.result.merged });
    } catch {
      toast.error("Couldn't preview that merge.");
    } finally {
      setBusy(null);
    }
  };

  /** Merge every other id into ``keep`` — in batches, so a big set works. */
  const merge = async (ids: string[], keep: string) => {
    const rest = ids.filter((x) => x !== keep);
    for (let i = 0; i < rest.length; i += MERGE_BATCH) {
      await item.runAction("merge_contacts", { keep_id: keep, merge_ids: rest.slice(i, i + MERGE_BATCH) });
    }
  };

  const mergeAll = async () => {
    setBusy("all");
    let n = 0;
    const sets = strongGroups.map((g) => g.ids.filter((id) => byId.has(id))).filter((ids) => ids.length >= 2);
    setProgress({ done: 0, total: sets.length });
    try {
      for (const ids of sets) {
        await merge(ids, bestOf(ids));
        n++;
        setProgress({ done: n, total: sets.length });
      }
      toast.success(`Merged ${n} set${n === 1 ? "" : "s"} of duplicates`);
      setConfirmAll(false);
    } catch {
      toast.error(`Stopped after ${n} of ${sets.length} sets — the rest are still listed.`);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const notSame = (ids: string[]) =>
    item.update((d) => {
      const pairs = new Set(d.settings.not_duplicates);
      for (const p of ruleOutPairs(ids)) pairs.add(p);
      d.settings.not_duplicates = [...pairs].slice(-5000);
    });

  return (
    <Sheet
      open={open}
      onClose={busy ? () => undefined : onClose}
      size="lg"
      title={preview ? "Merge preview" : confirmAll ? "Merge these sets?" : `Possible duplicates${groups.length ? ` (${groups.length})` : ""}`}
      footer={
        confirmAll ? (
          <>
            <ItemButton variant="ghost" disabled={!!busy} onClick={() => setConfirmAll(false)}>
              Back
            </ItemButton>
            <ItemButton
              variant="primary"
              block
              disabled={!!busy || !strongGroups.length}
              icon={busy === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
              onClick={() => void mergeAll()}
            >
              {progress ? `Merging ${progress.done}/${progress.total}…` : `Merge ${strongGroups.length} set${strongGroups.length === 1 ? "" : "s"}`}
            </ItemButton>
          </>
        ) : preview && group ? (
          <>
            <ItemButton variant="ghost" onClick={() => setPreview(null)}>
              Back
            </ItemButton>
            <ItemButton
              variant="primary"
              block
              disabled={!!busy}
              icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
              onClick={async () => {
                setBusy("merge");
                try {
                  await merge(group, preview.keep);
                  toast.success(`Merged into ${displayName(preview.merged)}`);
                  setPreview(null);
                } catch {
                  toast.error("That merge didn't work.");
                } finally {
                  setBusy(null);
                }
              }}
            >
              Merge {group.length} into one
            </ItemButton>
          </>
        ) : strongGroups.length > 1 && item.canEdit ? (
          <ItemButton block disabled={!!busy} onClick={() => setConfirmAll(true)} icon={<GitMerge className="h-4 w-4" />}>
            Merge the {strongGroups.length} sure sets…
          </ItemButton>
        ) : undefined
      }
    >
      {confirmAll ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-muted)]">
            Only sets that share an email, a full phone number or a card ID are included — never people who just share a name. In each, the fullest record is kept and the
            others are folded into it. You can undo from the ⋯ menu or version history.
          </p>
          <ul className="flex flex-col gap-2" aria-label="Sets to merge">
            {strongGroups.map((g) => {
              const keep = bestOf(g.ids.filter((id) => byId.has(id)));
              return (
                <li key={g.ids.join("|")} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                  <p className="text-sm font-medium text-[var(--text)]">
                    {byId.get(keep) ? displayName(byId.get(keep)!) : "?"}
                    <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">
                      ← {g.ids.filter((id) => id !== keep && byId.has(id)).map((id) => displayName(byId.get(id)!)).join(", ")}
                    </span>
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">{g.reasons.join(" · ")}</p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : preview && group ? (
        <div className="flex flex-col gap-4">
          <Field label="Keep the name and details of">
            <Select value={preview.keep} onChange={(e) => void showPreview(group, e.target.value)}>
              {group.map((id) => (
                <option key={id} value={id}>
                  {displayName(byId.get(id)!)} {workLine(byId.get(id)!) ? `· ${workLine(byId.get(id)!)}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <MergedCard c={preview.merged} />
          <p className="text-xs text-[var(--text-muted)]">Phones, emails, dates, tags, notes and history from all of them are kept, without repeats. Anyone linked to them is linked to the merged contact.</p>
        </div>
      ) : groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-muted)]">No duplicates found — nobody shares an email, a phone or a full name.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((g) => (
            <li key={g.ids.join("|")} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
              <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">{g.reasons.join(" · ")}</p>
              <ul className="flex flex-col gap-2">
                {g.ids.map((id) => {
                  const c = byId.get(id);
                  if (!c) return null;
                  return (
                    <li key={id} className="flex items-center gap-3">
                      <ContactAvatar contact={c} size={32} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[var(--text)]">{displayName(c)}</p>
                        <p className="truncate text-xs text-[var(--text-muted)]">
                          {[c.emails[0]?.value, c.phones[0]?.value, workLine(c), lastContacted(c) ? `last ${lastContacted(c)}` : ""].filter(Boolean).join(" · ") || "No details"}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {item.canEdit && (
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <ItemButton size="sm" variant="ghost" onClick={() => notSame(g.ids)}>
                    Not the same person
                  </ItemButton>
                  <ItemButton size="sm" variant="primary" disabled={!!busy} onClick={() => void showPreview(g.ids, bestOf(g.ids))}>
                    {busy === "preview" ? "…" : "Review merge"}
                  </ItemButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

function MergedCard({ c }: { c: Contact }) {
  const rows: [string, string][] = [
    ["Name", displayName(c)],
    ["Work", workLine(c)],
    ["Phones", c.phones.map((p) => `${p.value}${p.label ? ` (${p.label})` : ""}`).join(", ")],
    ["Emails", c.emails.map((e) => e.value).join(", ")],
    ["Addresses", c.addresses.map((a) => [a.street, a.city].filter(Boolean).join(", ")).join(" · ")],
    ["Birthday", c.birthday ?? ""],
    ["Tags", c.tags.join(", ")],
    ["History", c.interactions.length ? `${c.interactions.length} interactions` : ""],
    ["Remember", c.remember.map((n) => n.text).join(" · ")],
    ["Notes", c.notes.slice(0, 200)],
  ];
  return (
    <div className="rounded-2xl border border-[var(--item-accent)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center gap-3">
        <ContactAvatar contact={c} size={44} />
        <p className="text-base font-semibold text-[var(--text)]">{displayName(c)}</p>
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-sm">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--text-muted)]">{k}</dt>
              <dd className="min-w-0 break-words text-[var(--text)]">{v}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------- settings

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function SettingsSheet({ item, open, onClose }: { item: Handle; open: boolean; onClose: () => void }) {
  const s = item.data.settings;
  const auto = homeCountry({ phone_country: "" }, useAuthStore((st) => st.user?.settings) as Record<string, unknown> | undefined);
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) =>
    item.update((d) => {
      d.settings[k] = v;
    });
  const can = item.canEdit;
  return (
    <Sheet open={open} onClose={onClose} title="Reminders & display">
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Reminders</h3>
          <Field label="Remind me at">
            <TextInput type="time" disabled={!can} value={s.reminder_time} onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && set("reminder_time", e.target.value)} />
          </Field>
          <Row label="Birthdays" hint="On the day">
            <Toggle checked={s.birthday_reminders} onChange={(v) => can && set("birthday_reminders", v)} label="Birthday reminders" />
          </Row>
          {s.birthday_reminders && (
            <Field label="Also remind me before a birthday">
              <Select disabled={!can} value={s.birthday_days_before} onChange={(e) => set("birthday_days_before", Number(e.target.value))}>
                <option value={0}>No, just on the day</option>
                <option value={1}>1 day before</option>
                <option value={2}>2 days before</option>
                <option value={3}>3 days before</option>
                <option value={7}>A week before</option>
                <option value={14}>Two weeks before</option>
              </Select>
            </Field>
          )}
          <Row label="Anniversaries & other dates" hint="On the day">
            <Toggle checked={s.date_reminders} onChange={(v) => can && set("date_reminders", v)} label="Date reminders" />
          </Row>
          <Row label="Weekly keep-in-touch digest" hint="One nudge listing who's due — never one per person">
            <Toggle checked={s.reconnect_digest} onChange={(v) => can && set("reconnect_digest", v)} label="Weekly digest" />
          </Row>
          {s.reconnect_digest && (
            <Field label="Send it on">
              <Select disabled={!can} value={s.digest_weekday} onChange={(e) => set("digest_weekday", Number(e.target.value))}>
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Rhythm for new contacts">
            <Select disabled={!can} value={s.default_cadence_days ?? ""} onChange={(e) => set("default_cadence_days", e.target.value ? Number(e.target.value) : null)}>
              <option value="">None</option>
              {CADENCES.map((c) => (
                <option key={c.days} value={c.days}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </section>
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Display</h3>
          <Field label="Show names as">
            <Segmented
              value={s.name_order}
              onChange={(v) => can && set("name_order", v)}
              options={[
                { value: "first_last", label: "First Last" },
                { value: "last_first", label: "Last, First" },
              ]}
            />
          </Field>
          <Field label="Phone numbers are from" hint="How numbers written without a country code (0400 123 456) are read — for duplicates and calling.">
            <Select disabled={!can} value={s.phone_country ?? ""} onChange={(e) => set("phone_country", e.target.value)}>
              <option value="">Automatic ({COUNTRY_NAMES[auto] ?? auto})</option>
              {Object.entries(COUNTRY_NAMES)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Sort by">
            <Segmented
              value={s.sort_by}
              onChange={(v) => can && set("sort_by", v)}
              options={[
                { value: "first", label: "First name" },
                { value: "last", label: "Last name" },
              ]}
            />
          </Field>
        </section>
      </div>
    </Sheet>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-h-[44px] items-center justify-between gap-3")}>
      <span className="text-sm text-[var(--text)]">
        {label}
        {hint && <span className="block text-xs text-[var(--text-muted)]">{hint}</span>}
      </span>
      {children}
    </div>
  );
}
