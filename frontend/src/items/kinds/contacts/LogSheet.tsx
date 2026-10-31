import { Check } from "lucide-react";
import { useEffect, useState } from "react";

import { Field, ItemButton, Sheet, TextArea, TextInput, addDays, todayISO, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { displayName, dueOn, fmtDate } from "./model";
import { INTERACTION_META, editContact, type Handle } from "./shared";
import { INTERACTION_TYPES, type InteractionType } from "./types";

/* Log a call, message, catch-up or email — and tick off what you covered. */

export function LogSheet({ item, contactId, open, onClose }: { item: Handle; contactId: string | null; open: boolean; onClose: () => void }) {
  const c = contactId ? item.data.contacts.find((x) => x.id === contactId) : undefined;
  const [type, setType] = useState<InteractionType>("call");
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [covered, setCovered] = useState<Set<string>>(new Set());
  const [followUp, setFollowUp] = useState("");

  useEffect(() => {
    if (open) {
      setType("call");
      setDate(todayISO());
      setNotes("");
      setCovered(new Set());
      setFollowUp("");
    }
  }, [open, contactId]);

  if (!c) return null;
  const openTopics = c.topics.filter((t) => !t.done);
  const today = todayISO();

  const save = () => {
    const day = date && date <= today ? date : today;
    const iid = uid("i");
    const tid = uid("t");
    const f = followUp.trim();
    const done = new Set(covered);
    editContact(item, c.id, (x) => {
      if (x.interactions.some((i) => i.id === iid)) return; // already applied (a replay)
      x.interactions.unshift({ id: iid, date: day, type, notes: notes.trim() });
      x.interactions.sort((a, b) => b.date.localeCompare(a.date));
      if (x.interactions.length > 2000) x.interactions.length = 2000;
      x.snoozed_until = null;
      for (const t of x.topics) if (done.has(t.id)) t.done = true;
      if (f && x.topics.length < 100) x.topics.push({ id: tid, text: f.slice(0, 500), done: false, added: today });
    });
    const next = c.cadence_days ? dueOn({ ...c, interactions: [...c.interactions, { id: "x", date: day, type, notes: "" }], snoozed_until: null }, today) : null;
    toast.success(`Logged with ${displayName(c)}${next ? ` · next catch-up ${fmtDate(next, { year: false })}` : ""}`);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Log with ${displayName(c)}`}
      footer={
        <ItemButton variant="primary" block onClick={save}>
          Save
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Kind" className="grid grid-cols-5 gap-1.5">
          {INTERACTION_TYPES.map((t) => {
            const M = INTERACTION_META[t];
            const on = t === type;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setType(t)}
                className={cn(
                  "flex h-16 flex-col items-center justify-center gap-1 rounded-xl border text-[11px] font-medium transition",
                  on
                    ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] text-[var(--text)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]",
                )}
              >
                <M.icon className="h-5 w-5" />
                {M.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="When" className="min-w-[160px] flex-1">
            <TextInput type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <ItemButton size="sm" variant={date === today ? "primary" : "secondary"} onClick={() => setDate(today)}>
            Today
          </ItemButton>
          <ItemButton size="sm" variant={date === addDays(today, -1) ? "primary" : "secondary"} onClick={() => setDate(addDays(today, -1))}>
            Yesterday
          </ItemButton>
        </div>
        <Field label="What did you talk about?">
          <TextArea autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Her new job at Canva, the trip to Japan…" />
        </Field>
        {openTopics.length > 0 && (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-[var(--text-muted)]">Did you cover…</legend>
            {openTopics.map((t) => {
              const on = covered.has(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() =>
                    setCovered((s) => {
                      const n = new Set(s);
                      if (n.has(t.id)) n.delete(t.id);
                      else n.add(t.id);
                      return n;
                    })
                  }
                  className="flex min-h-[44px] items-center gap-3 rounded-xl px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"
                >
                  <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", on ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[var(--border)]")}>
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                  {t.text}
                </button>
              );
            })}
          </fieldset>
        )}
        <Field label="Follow up next time" hint="Added to their topics">
          <TextInput value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="Ask how the interview went" />
        </Field>
      </div>
    </Sheet>
  );
}
