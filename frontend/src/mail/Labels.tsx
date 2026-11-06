import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { mailApi, type MailLabel, type MailRule, type Person, type RuleKind } from "./api";
import { joinLabel, labelRows, parentOf, placesFor, shortName } from "./labelTree";

export const LABEL_COLOURS = ["#D97757", "#C9A227", "#6B9E78", "#4F9DA6", "#5B7FBF", "#8E6FB5", "#C2668A", "#8A7F73"];

// "Anyone at gmail.com" is half the internet, so don't offer it.
const SHARED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "aol.com", "gmx.com", "mail.com", "fastmail.com", "zoho.com", "bigpond.com",
]);

export interface LabelTarget {
  account_id: string;
  key: string;
  from: Person;
  subject: string;
  labels: string[];
}

export function nextColour(labels: MailLabel[]): string {
  return LABEL_COLOURS[labels.length % LABEL_COLOURS.length];
}

export function LabelPill({ label }: { label: MailLabel }) {
  return (
    <span title={label.name} style={{ color: label.color, backgroundColor: `${label.color}22` }} className="inline-flex max-w-[7rem] shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-medium">
      <span className="truncate">{shortName(label.name)}</span>
    </span>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div role="dialog" aria-label={title} className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="promptly-scroll max-h-[90%] w-full max-w-md overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl md:rounded-2xl">
        <div className="flex items-center justify-between px-1 pb-3">
          <h2 className="text-base font-semibold text-[var(--text)]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--text-muted)]"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function useMailRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["mail-overview"] });
    void qc.invalidateQueries({ queryKey: ["mail-threads"] });
    void qc.invalidateQueries({ queryKey: ["mail-conversation"] });
    void qc.invalidateQueries({ queryKey: ["mail-rules"] });
  };
}

/** How far in a label sits, in a list of them. */
const indent = (depth: number) => ({ paddingLeft: `${0.5 + depth * 1.25}rem` });

/** Which label this one goes inside. */
function InsidePicker({ value, places, onChange }: { value: string; places: string[]; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
      <span className="shrink-0">Inside</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)] outline-none focus:border-[#D97757]">
        <option value="">Nothing (top level)</option>
        {places.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
    </label>
  );
}

const INPUT = "h-10 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[#D97757]";

/** Where this conversation should live. A label is a place, so it goes to just one. */
export function LabelPicker({ target, labels, onMove, onToInbox, onMakeRule, onClose }: { target: LabelTarget; labels: MailLabel[]; onMove: (labelId: string) => void; onToInbox: () => void; onMakeRule: () => void; onClose: () => void }) {
  const refresh = useMailRefresh();
  const [name, setName] = useState("");
  const row = "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]";

  const create = async () => {
    if (!name.trim()) return;
    try {
      const label = await mailApi.addLabel(name, nextColour(labels));
      refresh();
      onMove(label.id);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't make that label."));
    }
  };

  return (
    <Sheet title="Move to" onClose={onClose}>
      {labelRows(labels).map((r) => {
        const l = r.label;
        if (!l) return <p key={r.path} style={indent(r.depth)} className="flex min-h-9 items-center truncate text-xs font-medium text-[var(--text-muted)]">{r.name}</p>;
        return (
          <button key={l.id} type="button" aria-label={l.name} aria-current={target.labels.includes(l.id) ? "true" : undefined} onClick={() => onMove(l.id)} style={indent(r.depth)} className={row}>
            <span style={{ backgroundColor: l.color }} className="h-2.5 w-2.5 shrink-0 rounded-full" />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            {target.labels.includes(l.id) && <Check className="h-4 w-4 shrink-0 text-[#D97757]" />}
          </button>
        );
      })}
      {target.labels.length > 0 && <button type="button" onClick={onToInbox} className={row}><span className="h-2.5 w-2.5 shrink-0" />Back to Inbox</button>}
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="New label" aria-label="New label" className={INPUT} />
        <button type="submit" disabled={!name.trim()} aria-label="Add label" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#D97757] text-white disabled:opacity-40"><Plus className="h-4 w-4" /></button>
      </form>
      <button type="button" onClick={onMakeRule} className="mt-3 w-full rounded-lg px-2 py-2 text-left text-sm font-medium text-[#D97757] hover:bg-[var(--hover)]">Do this for future emails too…</button>
    </Sheet>
  );
}

/** Dropped on New label: name it and it goes straight there. */
export function NewLabelSheet({ labels, onMade, onClose }: { labels: MailLabel[]; onMade: (labelId: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const make = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      onMade((await mailApi.addLabel(name, nextColour(labels))).id);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't make that label."));
      setBusy(false);
    }
  };
  return (
    <Sheet title="New label" onClose={onClose}>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void make(); }}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Name the label" aria-label="Name the label" className={INPUT} />
        <button type="submit" disabled={busy || !name.trim()} className="h-10 shrink-0 rounded-lg bg-[#D97757] px-4 text-sm font-medium text-white disabled:opacity-40">Move</button>
      </form>
    </Sheet>
  );
}

/** Make a rule from an email: what to look for, and which label it goes under. */
export function RuleSheet({ target, labels, onClose }: { target: LabelTarget; labels: MailLabel[]; onClose: () => void }) {
  const refresh = useMailRefresh();
  const address = target.from.addr.toLowerCase();
  const domain = address.split("@")[1] ?? "";
  const [kind, setKind] = useState<RuleKind>("from");
  const [subject, setSubject] = useState(target.subject.replace(/^((re|fwd?):\s*)+/i, "").trim());
  const [labelId, setLabelId] = useState<string | "new">(labels[0]?.id ?? "new");
  const [newName, setNewName] = useState("");
  const [existing, setExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const value = kind === "from" ? address : kind === "domain" ? domain : subject.trim();

  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), 300);
    return () => window.clearTimeout(t);
  }, [value]);
  const valid = kind !== "subject" ? value.length > 0 : value.length >= 3;
  const { data: preview } = useQuery({
    queryKey: ["mail-rule-preview", kind, settled],
    queryFn: () => mailApi.previewRule(kind, settled),
    enabled: settled === value && valid,
    retry: false,
  });
  const already = preview?.conversations ?? 0;

  const create = async () => {
    setBusy(true);
    try {
      const label = labelId === "new" ? await mailApi.addLabel(newName, nextColour(labels)) : labels.find((l) => l.id === labelId);
      if (!label) return;
      await mailApi.addRule({ kind, value, label_id: label.id, apply_existing: existing, thread: { account_id: target.account_id, key: target.key } });
      toast.success(`${label.name} will collect these from now on.`);
      refresh();
      onClose();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't make that rule."));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const choice = (active: boolean) => `flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm text-[var(--text)] ${active ? "border-[#D97757] bg-[#D97757]/10" : "border-[var(--border)] hover:bg-[var(--hover)]"}`;
  const dot = (active: boolean) => <span className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${active ? "border-[#D97757] bg-[#D97757]" : "border-[var(--text-muted)]"}`} />;

  return (
    <Sheet title="Make a rule" onClose={onClose}>
      <p className="mb-2 px-1 text-xs font-medium text-[var(--text-muted)]">When an email</p>
      <div role="radiogroup" aria-label="When an email" className="space-y-1.5">
        <button type="button" role="radio" aria-checked={kind === "from"} onClick={() => setKind("from")} className={choice(kind === "from")}>{dot(kind === "from")}<span className="min-w-0 truncate">is from {address}</span></button>
        {domain && !SHARED_DOMAINS.has(domain) && (
          <button type="button" role="radio" aria-checked={kind === "domain"} onClick={() => setKind("domain")} className={choice(kind === "domain")}>{dot(kind === "domain")}<span className="min-w-0 truncate">is from anyone at {domain}</span></button>
        )}
        <button type="button" role="radio" aria-checked={kind === "subject"} onClick={() => setKind("subject")} className={choice(kind === "subject")}>{dot(kind === "subject")}<span>has this in the subject</span></button>
        {kind === "subject" && <input autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} aria-label="Words in the subject" className={INPUT} />}
      </div>

      <p className="mb-2 mt-4 px-1 text-xs font-medium text-[var(--text-muted)]">Send it to</p>
      <div className="flex flex-wrap gap-1.5">
        {labels.map((l) => (
          <button key={l.id} type="button" aria-pressed={labelId === l.id} onClick={() => setLabelId(l.id)} className={`inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-sm text-[var(--text)] ${labelId === l.id ? "border-[#D97757] bg-[#D97757]/10" : "border-[var(--border)] hover:bg-[var(--hover)]"}`}>
            <span style={{ backgroundColor: l.color }} className="h-2 w-2 shrink-0 rounded-full" /><span className="truncate">{l.name}</span>
          </button>
        ))}
        <button type="button" aria-pressed={labelId === "new"} onClick={() => setLabelId("new")} className={`inline-flex h-8 items-center gap-1 rounded-full border px-3 text-sm text-[var(--text)] ${labelId === "new" ? "border-[#D97757] bg-[#D97757]/10" : "border-[var(--border)] hover:bg-[var(--hover)]"}`}><Plus className="h-3.5 w-3.5" />New label</button>
      </div>
      {labelId === "new" && <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} placeholder="Name the label" aria-label="Name the label" className={`${INPUT} mt-2`} />}

      {already > 1 && (
        <label className="mt-3 flex items-start gap-3 px-1 text-sm text-[var(--text)]">
          <input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#D97757]" />
          <span>Also do this for the {already} conversations already here</span>
        </label>
      )}
      <p className="mt-3 px-1 text-xs text-[var(--text-muted)]">These go straight to the label and skip your Inbox, in all your mailboxes. Nothing is sent anywhere.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-10 rounded-xl px-4 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]">Cancel</button>
        <button type="button" onClick={() => void create()} disabled={busy || !valid || (labelId === "new" && !newName.trim())} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#D97757] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}Make rule
        </button>
      </div>
    </Sheet>
  );
}

function ruleWords(rule: MailRule): string {
  if (rule.kind === "from") return `From ${rule.value}`;
  if (rule.kind === "domain") return `From anyone at ${rule.value}`;
  return `Subject has “${rule.value}”`;
}

/** Your labels and the rules behind them. On a phone this is also how you open one. */
export function LabelsSheet({ labels, current, top, onPick, onClose, onRemoved }: { labels: MailLabel[]; current?: string; top?: ReactNode; onPick: (id: string) => void; onClose: () => void; onRemoved: (id: string) => void }) {
  const refresh = useMailRefresh();
  const { data } = useQuery({ queryKey: ["mail-rules"], queryFn: mailApi.rules });
  const rules = data ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [inside, setInside] = useState("");
  const [fresh, setFresh] = useState("");
  const [freshInside, setFreshInside] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const rows = labelRows(labels);

  const attempt = async (job: () => Promise<unknown>, fallback: string) => {
    try {
      await job();
      refresh();
      return true;
    } catch (e) {
      toast.error(apiErrorMessage(e, fallback));
      return false;
    }
  };

  const save = async (l: MailLabel) => {
    const whole = joinLabel(inside, name);
    if (name.trim() && whole !== l.name && !(await attempt(() => mailApi.editLabel(l.id, { name: whole }), "Couldn't rename that."))) return;
    setEditing(null);
  };

  return (
    <Sheet title="Labels" onClose={onClose}>
      {top}
      {labels.length === 0 && <p className="px-1 pb-2 text-sm text-[var(--text-muted)]">Labels are places to keep email, separate from your Inbox. Add one here, then drag email onto it on a computer, or press and hold an email on a phone.</p>}
      {rows.map((r) => {
        const l = r.label;
        if (!l) return <p key={r.path} style={indent(r.depth)} className="flex min-h-9 items-center truncate text-xs font-medium text-[var(--text-muted)]">{r.name}</p>;
        return (
        <div key={l.id}>
          {editing === l.id ? (
            <form className="rounded-lg bg-[var(--hover)] p-2" onSubmit={(e) => { e.preventDefault(); void save(l); }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Label name" className={INPUT} />
              <div className="mt-2"><InsidePicker value={inside} places={placesFor(rows, l.name)} onChange={setInside} /></div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {LABEL_COLOURS.map((c) => (
                  <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={l.color === c} onClick={() => void attempt(() => mailApi.editLabel(l.id, { color: c }), "Couldn't change the colour.")} style={{ backgroundColor: c }} className={`h-7 w-7 rounded-full ${l.color === c ? "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--surface)]" : ""}`} />
                ))}
              </div>
              {removing === l.id ? (
                <div className="mt-2 text-xs text-[var(--text)]">
                  <p>This removes the label and its rules from Promptly. No email is deleted, and a folder in your mailbox stays there.{r.hasChildren && " Labels inside it stay too."}</p>
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" onClick={() => setRemoving(null)} className="h-8 rounded-lg px-3 text-[var(--text-muted)]">Keep it</button>
                    <button type="button" onClick={() => void attempt(() => mailApi.removeLabel(l.id), "Couldn't remove that.").then((ok) => { if (ok) { setEditing(null); setRemoving(null); onRemoved(l.id); } })} className="h-8 rounded-lg bg-[#C62828] px-3 font-medium text-white">Remove</button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex items-center justify-between">
                  <button type="button" onClick={() => setRemoving(l.id)} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-[#C62828]"><Trash2 className="h-3.5 w-3.5" />Remove</button>
                  <button type="submit" className="h-8 rounded-lg bg-[#D97757] px-3 text-xs font-medium text-white">Done</button>
                </div>
              )}
            </form>
          ) : (
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => onPick(l.id)} aria-label={l.name} aria-current={current === l.id ? "true" : undefined} style={indent(r.depth)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg pr-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]">
                <span style={{ backgroundColor: l.color }} className="h-2.5 w-2.5 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                {l.unread > 0 && <span className="text-xs font-medium text-[#D97757]">{l.unread}</span>}
                {current === l.id && <Check className="h-4 w-4 shrink-0 text-[#D97757]" />}
              </button>
              <button type="button" onClick={() => { setEditing(l.id); setName(shortName(l.name)); setInside(parentOf(l.name)); setRemoving(null); }} aria-label={`Edit ${l.name}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"><Pencil className="h-4 w-4" /></button>
            </div>
          )}
          {rules.filter((r) => r.label_id === l.id).map((r) => (
            <div key={r.id} className="flex items-center gap-2 pl-7 pr-1 text-xs text-[var(--text-muted)]">
              <span className="min-w-0 flex-1 truncate" title={ruleWords(r)}>{ruleWords(r)}</span>
              <button type="button" onClick={() => void attempt(() => mailApi.removeRule(r.id), "Couldn't remove that rule.")} aria-label={`Stop rule: ${ruleWords(r)}`} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--hover)]"><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
        );
      })}
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (fresh.trim()) void attempt(() => mailApi.addLabel(joinLabel(freshInside, fresh), nextColour(labels)), "Couldn't make that label.").then((ok) => { if (ok) setFresh(""); }); }}>
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] px-3 focus-within:border-[#D97757]">
          <Tag className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input value={fresh} onChange={(e) => setFresh(e.target.value)} maxLength={60} placeholder="New label" aria-label="New label" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
        </div>
        <button type="submit" disabled={!fresh.trim()} aria-label="Add label" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#D97757] text-white disabled:opacity-40"><Plus className="h-4 w-4" /></button>
      </form>
      {rows.length > 0 && <div className="mt-2"><InsidePicker value={freshInside} places={placesFor(rows)} onChange={setFreshInside} /></div>}
    </Sheet>
  );
}
