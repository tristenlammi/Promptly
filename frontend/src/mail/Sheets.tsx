import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MapPin } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ModelSelector } from "@/components/chat/ModelSelector";
import { LocationInput } from "@/components/maps/LocationInput";
import { Sheet as SharedSheet } from "@/items/ui";
import { useSelectedModel } from "@/store/modelStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { mapsSearchLink } from "@/maps/links";

import { mailApi, type MailAccount, type MailLayout, type MailSettings } from "./api";

function localDay(d = new Date()): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** Add to Calendar from an email. The AI has a go at filling it in, and you check it. */
export function EventSheet({ accountId, threadKey, subject, onClose }: { accountId: string; threadKey: string; subject: string; onClose: () => void }) {
  const selected = useSelectedModel();
  const [title, setTitle] = useState(subject.replace(/^((re|fwd?):\s*)+/i, ""));
  const [day, setDay] = useState(localDay());
  const [time, setTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [place, setPlace] = useState("");
  const { isFetching } = useQuery({
    queryKey: ["mail-event-draft", accountId, threadKey, selected?.model_id],
    enabled: !!selected,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const got = await mailApi.eventDraft(accountId, threadKey, { provider_id: selected!.provider_id, model_id: selected!.model_id, today: localDay() });
      if (got.title) setTitle(got.title);
      if (/^\d{4}-\d{2}-\d{2}$/.test(got.date)) setDay(got.date);
      if (/^\d{2}:\d{2}$/.test(got.time)) setTime(got.time);
      if (/^\d{2}:\d{2}$/.test(got.end_time)) setEndTime(got.end_time);
      if (got.location) setPlace(got.location);
      return got;
    },
  });
  const add = useMutation({
    mutationFn: () => mailApi.addEvent(accountId, threadKey, {
      title, all_day: !time, location: place,
      start: time ? `${day}T${time}:00` : day,
      end: time && endTime ? `${day}T${endTime}:00` : undefined,
    }),
    onSuccess: () => {
      toast.success("Added to your calendar.");
      onClose();
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't add that.")),
  });
  return (
    <Sheet title="Add to calendar" onClose={onClose}>
      {isFetching && <p className="flex items-center gap-2 px-1 text-xs text-[var(--text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />Reading the email for the details…</p>}
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="Title" aria-label="Title" className={FIELD} />
      <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Date" className={FIELD} />
      <div className="flex gap-2">
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Starts" className={FIELD} />
        <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={!time} aria-label="Ends" className={`${FIELD} disabled:opacity-50`} />
      </div>
      <LocationInput value={place} onChange={setPlace} maxLength={500} placeholder="Where" aria-label="Where" unstyled inlineList className={FIELD} />
      {place.trim().length > 3 && (
        <a href={mapsSearchLink(place.trim())} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1.5 self-start px-1 text-xs font-medium text-[var(--accent-text)] md:min-h-0">
          <MapPin className="h-3.5 w-3.5" />See it in Maps
        </a>
      )}
      <p className="px-1 text-xs text-[var(--text-muted)]">{time ? "" : "With no time, it's added as an all-day event. "}Check the details: AI can get them wrong.</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-10 rounded-xl px-4 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]">Cancel</button>
        <button type="button" onClick={() => add.mutate()} disabled={add.isPending || !title.trim() || !day} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">{add.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Add</button>
      </div>
    </Sheet>
  );
}

/** A reminder in Tasks from an email: a bill to pay, something to follow up.
 *  The AI has a go at the title, the day it's due and the amount, and you check it. */
export function ReminderSheet({ accountId, threadKey, subject, onClose }: { accountId: string; threadKey: string; subject: string; onClose: () => void }) {
  const selected = useSelectedModel();
  const [title, setTitle] = useState(subject.replace(/^((re|fwd?):\s*)+/i, ""));
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const { isFetching } = useQuery({
    queryKey: ["mail-task-draft", accountId, threadKey, selected?.model_id],
    enabled: !!selected,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const got = await mailApi.taskDraft(accountId, threadKey, { provider_id: selected!.provider_id, model_id: selected!.model_id, today: localDay() });
      if (got.title) setTitle(got.title);
      if (/^\d{4}-\d{2}-\d{2}$/.test(got.due)) setDue(got.due);
      const kept = [got.amount, got.note].filter(Boolean).join(" · ");
      if (kept) setNote(kept);
      return got;
    },
  });
  const add = useMutation({
    mutationFn: () => mailApi.addTask(accountId, threadKey, { title: title.trim(), due: due || undefined, note: note.trim() }),
    onSuccess: () => {
      toast.success(due ? `Added to Tasks, due ${new Date(`${due}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}.` : "Added to Tasks.");
      onClose();
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't add that task.")),
  });
  return (
    <Sheet title="Remind me" onClose={onClose}>
      {isFetching && <p className="flex items-center gap-2 px-1 text-xs text-[var(--text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />Reading the email for the details…</p>}
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} placeholder="What to do" aria-label="What to do" className={FIELD} />
      <label className="block px-1 text-xs text-[var(--text-muted)]">Due
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" className={`${FIELD} mt-1`} />
      </label>
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Amount, reference…" aria-label="Note" className={FIELD} />
      <p className="px-1 text-xs text-[var(--text-muted)]">{due ? "It shows in Tasks on that day, with a link back to this email. " : "With no day, it goes to your Tasks inbox, with a link back to this email. "}{selected ? "Check the details: AI can get them wrong." : ""}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-10 rounded-xl px-4 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]">Cancel</button>
        <button type="button" onClick={() => add.mutate()} disabled={add.isPending || !title.trim()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">{add.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Add</button>
      </div>
    </Sheet>
  );
}

const COLOURS = ["#D97757", "#4F7FE0", "#6B9E78", "#8E6FB5", "#C9A227", "#C2668A"];
const FIELD = "w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]";

/** Mail's sheets are the shared one: same handle, Esc and Close as the rest of Promptly. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <SharedSheet open onClose={onClose} title={title} size="sm">
      <div className="space-y-3 pb-1">{children}</div>
    </SharedSheet>
  );
}

function at(hour: number, days = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function snoozeChoices(): { label: string; when: Date }[] {
  const now = new Date();
  const toSaturday = ((6 - now.getDay() + 7) % 7) || 7;
  const toMonday = ((1 - now.getDay() + 7) % 7) || 7;
  const choices = [
    { label: "Tomorrow morning", when: at(8, 1) },
    { label: "This weekend", when: at(9, toSaturday) },
    { label: "Next week", when: at(8, toMonday) },
  ];
  if (now.getHours() < 17) choices.unshift({ label: "This evening", when: at(18) });
  return choices;
}

function localInputValue(d: Date): string {
  const shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/** Out of your Inbox until then, or until someone replies. */
export function SnoozeSheet({ onPick, onClose }: { onPick: (when: Date) => void; onClose: () => void }) {
  const [custom, setCustom] = useState("");
  const row = "flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]";
  return (
    <Sheet title="Snooze until" onClose={onClose}>
      <div>
        {snoozeChoices().map((c) => (
          <button key={c.label} type="button" onClick={() => onPick(c.when)} className={row}>
            <span>{c.label}</span><span className="text-xs text-[var(--text-muted)]">{c.when.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
          </button>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (custom) onPick(new Date(custom)); }}>
        <input type="datetime-local" value={custom} min={localInputValue(new Date())} onChange={(e) => setCustom(e.target.value)} aria-label="Pick a date and time" className={FIELD} />
        <button type="submit" disabled={!custom} className="h-10 shrink-0 rounded-lg bg-[var(--accent-strong)] px-3 text-sm font-medium text-white disabled:opacity-40">Snooze</button>
      </form>
    </Sheet>
  );
}

/** A mailbox's own details: how you appear, and a new password when it changes. */
export function EditMailboxSheet({ account, onClose }: { account: MailAccount; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(account.display_name);
  const [colour, setColour] = useState(account.color);
  const [signature, setSignature] = useState(account.signature);
  const [notify, setNotify] = useState(account.notify);
  const [password, setPassword] = useState("");
  const save = useMutation({
    mutationFn: () => mailApi.editAccount(account.id, { display_name: name, color: colour, signature, notify, ...(password ? { password } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mail-overview"] });
      onClose();
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't save that.")),
  });
  return (
    <Sheet title={account.email} onClose={onClose}>
      {account.status === "error" && account.status_detail && <p className="rounded-lg bg-[var(--danger)]/10 p-2.5 text-xs text-[var(--text)]">{account.status_detail}</p>}
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Your name, as people will see it" aria-label="Your name" className={FIELD} />
      <div className="flex gap-2" role="radiogroup" aria-label="Colour">
        {COLOURS.map((c) => <button key={c} type="button" role="radio" aria-checked={colour === c} aria-label={c} onClick={() => setColour(c)} style={{ backgroundColor: c }} className={`h-7 w-7 rounded-full ${colour === c ? "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--surface)]" : ""}`} />)}
      </div>
      <textarea value={signature} onChange={(e) => setSignature(e.target.value)} rows={3} maxLength={10_000} placeholder="Signature" aria-label="Signature" className={`${FIELD} promptly-scroll resize-none`} />
      <label className="flex items-center gap-3 px-1 text-sm text-[var(--text)]"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />Notify me about new email here</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password, if it's changed" aria-label="New password" autoComplete="new-password" className={FIELD} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-10 rounded-xl px-4 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]">Cancel</button>
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">{save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save</button>
      </div>
    </Sheet>
  );
}

const LAYOUTS: { id: MailLayout; name: string; about: string }[] = [
  { id: "split", name: "Split", about: "The list on the left, the open email beside it." },
  { id: "full", name: "Full list", about: "One line per email across the whole width. An email opens over the list." },
];

/** A thumbnail of a layout: folders, then the list, and where the open email goes. */
function LayoutPicture({ layout }: { layout: MailLayout }) {
  const line = "h-1 rounded-full bg-[var(--text-muted)] opacity-50";
  const faint = "h-1 rounded-full bg-[var(--text-muted)] opacity-25";
  return (
    <span aria-hidden className="flex h-[4.5rem] w-full gap-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg,var(--surface))] p-1.5">
      <span className="flex w-[16%] flex-col gap-1 pt-0.5">
        <span className="h-1.5 rounded-full bg-[var(--accent)]" />
        {[0, 1, 2].map((i) => <span key={i} className={line} />)}
      </span>
      {layout === "split" ? (
        <>
          <span className="flex w-[30%] flex-col gap-1.5 border-l border-[var(--border)] pl-1 pt-0.5">
            {[0, 1, 2, 3].map((i) => <span key={i} className="flex flex-col gap-0.5"><span className={`${line} w-3/5`} /><span className={faint} /></span>)}
          </span>
          <span className="flex flex-1 flex-col gap-1 rounded border border-[var(--border)] bg-[var(--surface)] p-1">
            <span className={`${line} w-2/5`} />
            {[0, 1, 2].map((i) => <span key={i} className={faint} />)}
            <span className={`${faint} w-3/5`} />
          </span>
        </>
      ) : (
        <span className="flex flex-1 flex-col gap-[5px] border-l border-[var(--border)] pl-1 pt-0.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="flex items-center gap-1">
              <span className={`${line} w-[16%]`} /><span className={`${faint} flex-1`} /><span className={`${line} w-[7%]`} />
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** How the list is laid out, and sorting by AI: off until you choose a model, and it's
 *  your model and your choice. */
export function MailSettingsSheet({ phone, onClose }: { phone: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const selected = useSelectedModel();
  const { data } = useQuery({ queryKey: ["mail-settings"], queryFn: mailApi.settings });
  const change = useMutation({
    mutationFn: (on: boolean) => mailApi.setSorting(on && selected ? { provider_id: selected.provider_id, model_id: selected.model_id } : {}),
    onSuccess: (next) => {
      qc.setQueryData(["mail-settings"], next);
      void qc.invalidateQueries({ queryKey: ["mail-overview"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't change that.")),
  });
  const lay = useMutation({
    mutationFn: (layout: MailLayout) => mailApi.setLayout(layout),
    // Straight away: the list behind this changes as you choose.
    onMutate: (layout) => {
      const before = qc.getQueryData<MailSettings>(["mail-settings"]);
      qc.setQueryData<MailSettings>(["mail-settings"], (old) => (old ? { ...old, layout } : old));
      return before;
    },
    onSuccess: (next) => qc.setQueryData<MailSettings>(["mail-settings"], (old) => ({ ...(old ?? next), layout: next.layout })),
    onError: (e, _layout, before) => {
      qc.setQueryData(["mail-settings"], before);
      toast.error(apiErrorMessage(e, "Couldn't change the layout."));
    },
  });
  const on = Boolean(data?.sorting);
  const layout = data?.layout ?? "split";
  return (
    <Sheet title="Mail settings" onClose={onClose}>
      <div className="px-1">
        <p id="mail-layout-title" className="text-sm font-medium text-[var(--text)]">Layout</p>
        {phone ? (
          <p className="mt-1 text-xs text-[var(--text-muted)]">On a phone, Mail always shows the list, then the email. You can choose a layout for bigger screens from a computer.</p>
        ) : (
          <>
            <div role="radiogroup" aria-labelledby="mail-layout-title" className="mt-2 grid grid-cols-2 gap-2">
              {LAYOUTS.map((l) => (
                <button key={l.id} type="button" role="radio" aria-checked={layout === l.id} disabled={!data} onClick={() => { if (layout !== l.id) lay.mutate(l.id); }} className={`flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors ${layout === l.id ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] hover:bg-[var(--hover)]"}`}>
                  <LayoutPicture layout={l.id} />
                  <span className="px-0.5">
                    <span className="block text-sm font-medium text-[var(--text)]">{l.name}</span>
                    <span className="mt-0.5 block text-xs text-[var(--text-muted)]">{l.about}</span>
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-[var(--text-muted)]">Saved to your account, so it's the same on every computer you sign in on. Phones always show the list, then the email.</p>
          </>
        )}
      </div>
      <hr className="border-[var(--border)]" />
      <label className="flex items-start gap-3 px-1 text-sm text-[var(--text)]">
        <input type="checkbox" checked={on} disabled={change.isPending || (!on && !selected)} onChange={(e) => change.mutate(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
        <span>
          Sort my mail with AI
          <span className="mt-1 block text-xs text-[var(--text-muted)]">Flags emails that want a reply and adds a one-line summary. Your last {14} days of email, and new email as it arrives, goes to the model you choose. Newsletters and no-reply senders are skipped.</span>
        </span>
      </label>
      {on ? (
        <p className="px-1 text-xs text-[var(--text-muted)]">Using {data?.sorting?.model_id}. To change it, pick another below, then turn this off and on.</p>
      ) : (
        <p className="px-1 text-xs text-[var(--text-muted)]">It will use {selected?.model_id ?? "the model chosen here"}. To use a different one, pick it here:</p>
      )}
      {/* The list of models opens downwards, inside the sheet: room for it to open into. */}
      <div className="flex min-h-[26rem] items-start justify-end px-1"><div className="relative"><ModelSelector /></div></div>
    </Sheet>
  );
}
