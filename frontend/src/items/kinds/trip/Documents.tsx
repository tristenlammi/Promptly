import { BadgeCheck, CircleDashed, Clock3, ExternalLink, IdCard, Paperclip, Plus, ShieldCheck, Sparkles, Stamp, Syringe } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Card, Chip, EmptyState, Fab, Field, ItemButton, List, ListRow, Section, Segmented, Select, Sheet, TextArea, TextInput, safeHref, todayISO, uid } from "@/items/ui";

import { addMonths } from "./logic";
import { assignChanged } from "./ops";
import type { DocStatus, DocType, TravelDocument, Trip } from "./types";
import { DOC_LABEL } from "./types";
import { fmtDate } from "./tz";
import { Attachments, ConfirmDelete, DrivePicker, FieldRow, linkProblem, SeverityDot, type Issue } from "./ui";

const DOC_ICON: Record<DocType, typeof Stamp> = {
  passport: IdCard,
  visa: Stamp,
  eta: Stamp,
  insurance: ShieldCheck,
  vaccination: Syringe,
  driving_permit: IdCard,
  id_card: IdCard,
  other: Paperclip,
};

const STATUS: Record<DocStatus, { label: string; icon: typeof Stamp; color: string }> = {
  todo: { label: "To do", icon: CircleDashed, color: "var(--warning)" },
  applied: { label: "Applied", icon: Clock3, color: "var(--item-accent)" },
  done: { label: "Ready", icon: BadgeCheck, color: "var(--success)" },
};

function blankDoc(type: DocType = "passport", traveller: string | null = null): TravelDocument {
  return { id: uid("doc-"), type, traveller_id: traveller, title: "", country: "", reference: "", issued: null, expires: null, status: "todo", remind_on: null, attachments: [], link: "", notes: "" };
}

/** A local passport/expiry check (the server's conflicts check is the full one). */
export function docWarning(t: Trip, d: TravelDocument): string | null {
  const end = t.end ?? t.start;
  if (!d.expires) return d.type === "passport" ? "Add the expiry date to check it" : null;
  if (end && d.expires < end) return `Expires during the trip (${fmtDate(d.expires)})`;
  const months = t.settings.passport_months;
  if (d.type === "passport" && end && months && d.expires < addMonths(end, months)) return `Expires within ${months} months of your return — many countries refuse entry`;
  if (d.expires < todayISO()) return "Expired";
  return null;
}

export function DocumentsView({ item, ask, issues, isPhone }: { item: ItemHandle<Trip>; ask: (p: string) => void; issues: Issue[]; isPhone: boolean }) {
  const t = item.data;
  const [editing, setEditing] = useState<TravelDocument | null>(null);
  const names = Object.fromEntries(t.travellers.map((x) => [x.id, x.name]));
  const groups = useMemo(() => {
    const m = new Map<string, TravelDocument[]>();
    for (const d of t.documents) {
      const k = d.traveller_id && names[d.traveller_id] ? d.traveller_id : "";
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    const rank = (k: string) => (k ? t.travellers.findIndex((x) => x.id === k) : 999);
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [t.documents, t.travellers]);
  // The passport check below is local (works offline); the server's other document checks show here too.
  const docIssues = issues.filter((i) => (i.document_id || i.kind === "no_passports") && i.kind !== "passport_missing");
  const ready = t.documents.filter((d) => d.status === "done").length;
  const withPassport = new Set(t.documents.filter((d) => d.type === "passport" && d.traveller_id).map((d) => d.traveller_id));
  const noPassport = withPassport.size ? t.travellers.filter((x) => !withPassport.has(x.id)) : [];

  const save = (d: TravelDocument) => {
    const before = editing && t.documents.some((z) => z.id === editing.id) ? editing : null;
    item.update((x) => {
      const cur = x.documents.find((z) => z.id === d.id);
      if (cur && before) assignChanged(cur, before, d);
      else if (!cur && !before && x.documents.length < 120) x.documents.push(d);
    });
    setEditing(null);
  };

  const addPassports = (only?: string[]) => {
    const fresh = t.travellers.filter((tr) => !only || only.includes(tr.id)).map((tr) => ({ ...blankDoc("passport", tr.id), country: tr.passport_country }));
    item.update((x) => {
      for (const doc of fresh)
        if (x.documents.length < 120 && x.travellers.some((tr) => tr.id === doc.traveller_id) && !x.documents.some((d) => d.type === "passport" && d.traveller_id === doc.traveller_id))
          x.documents.push(doc);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {docIssues.length > 0 && (
        <Card className="flex flex-col gap-2 border-[color-mix(in_srgb,var(--warning)_45%,var(--border))]">
          {docIssues.map((i, n) => (
            <p key={n} className="flex gap-2 text-sm text-[var(--text)]">
              <SeverityDot severity={i.severity} /> {i.message}
            </p>
          ))}
        </Card>
      )}
      {noPassport.length > 0 && (
        <Card className="flex flex-col gap-2 border-[color-mix(in_srgb,var(--warning)_45%,var(--border))]">
          <p className="flex gap-2 text-sm text-[var(--text)]">
            <SeverityDot severity="warning" /> No passport on the list for {noPassport.map((x) => x.name).join(", ")} — add {noPassport.length === 1 ? "it" : "them"} so expiry is checked too.
          </p>
          {item.canEdit && (
            <div className="flex flex-wrap gap-2">
              {noPassport.map((x) => (
                <Chip key={x.id} onClick={() => addPassports([x.id])}>
                  + {x.name}'s passport
                </Chip>
              ))}
            </div>
          )}
        </Card>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--text-muted)]">
          {t.documents.length ? `${ready} of ${t.documents.length} ready` : "Passports, visas, insurance — checked against your dates."}
        </p>
        <div className="flex flex-wrap gap-2">
          {item.canEdit && (
            <ItemButton
              variant="ghost"
              size="sm"
              icon={<Sparkles className="h-4 w-4" />}
              onClick={() => ask("What travel documents do we need for this trip (passports, visas/ETAs, insurance, vaccinations, driving permits) given our nationalities? Add them to the documents checklist with apply-by reminders, and link the official government pages. Remind me to verify on those official sites.")}
            >
              What do we need?
            </ItemButton>
          )}
          {item.canEdit && !isPhone && (
            <ItemButton size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing(blankDoc())}>
              Document
            </ItemButton>
          )}
        </div>
      </div>
      {t.documents.length === 0 ? (
        <EmptyState
          icon={IdCard}
          title="Documents checklist"
          text="Add each traveller's passport to check it's valid long enough, plus visas, ETAs, insurance and permits. Rules change — always confirm on the official government site."
          action={item.canEdit && <ItemButton variant="primary" onClick={() => addPassports()}>Add everyone's passport</ItemButton>}
        />
      ) : (
        groups.map(([tid, list]) => (
          <Section key={tid || "shared"} title={tid ? names[tid] : "Everyone"}>
            <List>
              {list.map((d) => {
                const Icon = DOC_ICON[d.type];
                const st = STATUS[d.status];
                const warn = docWarning(t, d);
                return (
                  <ListRow
                    key={d.id}
                    leading={
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--surface-2)] text-[var(--text-muted)]">
                        <Icon className="h-4 w-4" />
                      </span>
                    }
                    title={d.title || `${DOC_LABEL[d.type]}${d.country ? ` · ${d.country}` : ""}`}
                    subtitle={
                      warn ? (
                        <span className="text-[var(--warning)]">{warn}</span>
                      ) : (
                        [d.expires && `Expires ${fmtDate(d.expires)} ${d.expires.slice(0, 4)}`, d.remind_on && d.status !== "done" && `Reminder ${fmtDate(d.remind_on)}`, d.reference].filter(Boolean).join(" · ") || DOC_LABEL[d.type]
                      )
                    }
                    onClick={item.canEdit ? () => setEditing(d) : undefined}
                    trailing={
                      <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: st.color }}>
                        <st.icon className="h-4 w-4" /> {st.label}
                      </span>
                    }
                  />
                );
              })}
            </List>
          </Section>
        ))
      )}
      <p className="px-1 text-xs text-[var(--text-muted)]">
        Only keep the last few characters of document numbers here. Entry rules change — check the destination's official immigration site and your government's travel advice before you go.
      </p>
      {isPhone && item.canEdit && <Fab label="Document" icon={Plus} onClick={() => setEditing(blankDoc())} />}
      <DocSheet trip={t} doc={editing} onClose={() => setEditing(null)} onSave={save} onDelete={editing && t.documents.some((d) => d.id === editing.id) ? () => {
        const id = editing.id;
        item.update((x) => {
          x.documents = x.documents.filter((d) => d.id !== id);
        });
        setEditing(null);
      } : undefined} />
    </div>
  );
}

function DocSheet({ trip, doc, onClose, onSave, onDelete }: { trip: Trip; doc: TravelDocument | null; onClose: () => void; onSave: (d: TravelDocument) => void; onDelete?: () => void }) {
  const [d, setD] = useState<TravelDocument>(doc ?? blankDoc());
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (doc) setD(structuredClone(doc));
  }, [doc]);
  const set = <K extends keyof TravelDocument>(k: K, v: TravelDocument[K]) => setD((x) => ({ ...x, [k]: v }));
  const mask = (s: string) => (s.trim().length > 6 ? `…${s.trim().slice(-4)}` : s.trim());
  return (
    <Sheet
      open={!!doc}
      onClose={onClose}
      title={doc && trip.documents.some((x) => x.id === doc.id) ? DOC_LABEL[d.type] : "Add document"}
      footer={
        <>
          {onDelete && <ConfirmDelete question="Delete this document?" onConfirm={onDelete} />}
          <ItemButton variant="primary" block disabled={!!linkProblem(d.link)} onClick={() => onSave({ ...d, reference: mask(d.reference), link: d.link.trim() })}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldRow>
          <Field label="Type">
            <Select value={d.type} onChange={(e) => set("type", e.target.value as DocType)}>
              {(Object.keys(DOC_LABEL) as DocType[]).map((k) => (
                <option key={k} value={k}>
                  {DOC_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="For">
            <Select value={d.traveller_id ?? ""} onChange={(e) => set("traveller_id", e.target.value || null)}>
              <option value="">Everyone</option>
              {trip.travellers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
        </FieldRow>
        <Field label="Name" hint="e.g. Japan eVisa, Cover-More policy">
          <TextInput value={d.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <FieldRow>
          <Field label={d.type === "passport" ? "Issued by" : "Country"}>
            <TextInput value={d.country} onChange={(e) => set("country", e.target.value)} />
          </Field>
          <Field label="Number (last 4)" hint="Kept short on purpose">
            <TextInput value={d.reference} onChange={(e) => set("reference", e.target.value)} onBlur={() => set("reference", mask(d.reference))} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Issued">
            <TextInput type="date" value={d.issued ?? ""} onChange={(e) => set("issued", e.target.value || null)} />
          </Field>
          <Field label="Expires">
            <TextInput type="date" value={d.expires ?? ""} onChange={(e) => set("expires", e.target.value || null)} />
          </Field>
        </FieldRow>
        {docWarning(trip, d) && d.expires && <p className="-mt-2 text-sm text-[var(--warning)]">{docWarning(trip, d)}</p>}
        <Field label="Status">
          <Segmented<DocStatus>
            value={d.status}
            onChange={(v) => set("status", v)}
            options={[
              { value: "todo", label: "To do" },
              { value: "applied", label: "Applied" },
              { value: "done", label: "Ready" },
            ]}
          />
        </Field>
        {d.status !== "done" && (
          <Field label="Remind me on" hint="e.g. the apply-by date">
            <TextInput type="date" value={d.remind_on ?? ""} onChange={(e) => set("remind_on", e.target.value || null)} />
          </Field>
        )}
        <Field label="Official link" hint={linkProblem(d.link) ?? undefined}>
          <div className="flex gap-2">
            <TextInput type="url" value={d.link} onChange={(e) => set("link", e.target.value)} placeholder="https://" />
            {safeHref(d.link) && (
              <a href={safeHref(d.link)} target="_blank" rel="noopener noreferrer" aria-label="Open link" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-10 md:w-10">
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
          </div>
        </Field>
        <Field label="Notes">
          <TextArea value={d.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <Attachments files={d.attachments} onRemove={(id) => set("attachments", d.attachments.filter((a) => a.file_id !== id))} />
        <ItemButton size="sm" className="self-start" icon={<Paperclip className="h-4 w-4" />} disabled={d.attachments.length >= 10} onClick={() => setPicking(true)}>
          Attach a scan from Files
        </ItemButton>
      </div>
      <DrivePicker open={picking} onClose={() => setPicking(false)} onPick={(a) => set("attachments", d.attachments.some((x) => x.file_id === a.file_id) ? d.attachments : [...d.attachments, a])} />
    </Sheet>
  );
}
