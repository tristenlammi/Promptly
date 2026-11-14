import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { roomsApi, type PollDraft } from "@/api/rooms";
import { Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { patchRoom } from "../cache";
import { newClientId } from "../format";
import { useRoomsStore } from "../store";

const MAX_OPTIONS = 10;
const CLOSES: { label: string; hours: number | null }[] = [
  { label: "When I close it", hours: null },
  { label: "In 1 hour", hours: 1 },
  { label: "In 6 hours", hours: 6 },
  { label: "In 1 day", hours: 24 },
  { label: "In 3 days", hours: 72 },
  { label: "In 1 week", hours: 168 },
];

const field =
  "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none md:h-10 md:text-sm";

/** Ask the room a question: two to ten answers, one vote each. */
export function PollSheet({ open, onClose, roomId }: { open: boolean; onClose: () => void; roomId: string }) {
  const qc = useQueryClient();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [closes, setCloses] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [tried, setTried] = useState(false);
  const clientId = useRef(newClientId());
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    setQuestion("");
    setOptions(["", ""]);
    setMultiple(false);
    setAnonymous(false);
    setCloses(null);
    setTried(false);
    clientId.current = newClientId();
  }, [open]);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const distinct = new Set(filled.map((o) => o.toLowerCase())).size;
  const problem = !question.trim() ? "Ask a question." : distinct < 2 ? "Give at least two different answers." : null;

  const setOption = (i: number, v: string) => setOptions((cur) => cur.map((x, j) => (j === i ? v : x)));
  const addOption = () => {
    if (options.length >= MAX_OPTIONS) return;
    setOptions((cur) => [...cur, ""]);
    requestAnimationFrame(() => inputs.current[options.length]?.focus());
  };

  const submit = async () => {
    setTried(true);
    if (problem || sending) return;
    const poll: PollDraft = {
      question: question.trim(),
      options: filled,
      multiple,
      anonymous,
      closes_at: closes ? new Date(Date.now() + closes * 3600_000).toISOString() : null,
    };
    setSending(true);
    try {
      // The same id on a retry: a poll whose answer got lost isn't asked twice.
      const msg = await roomsApi.send(roomId, { body: "", poll, client_id: clientId.current });
      useRoomsStore.getState().upsertMessage(msg);
      patchRoom(qc, roomId, (r) => ({
        ...r,
        last_seq: Math.max(r.last_seq, msg.seq),
        last_read_seq: Math.max(r.last_read_seq, msg.seq),
        last_message_at: msg.created_at,
        preview: { author_id: msg.author_id, body: msg.body, kind: msg.kind },
        unread: 0,
        mentions: 0,
      }));
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "The poll didn't send. Try again."));
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ask a poll"
      footer={
        <div className="flex items-center justify-end gap-2">
          {tried && problem && (
            <span role="alert" className="mr-auto text-sm text-[var(--danger)]">
              {problem}
            </span>
          )}
          <button type="button" onClick={onClose} className="h-11 rounded-xl px-4 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-10">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-[var(--accent-strong)] px-5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60 md:h-10"
          >
            {sending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Send poll
          </button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-[var(--text)]">Question</span>
          <input
            data-autofocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={300}
            placeholder="Where should we go for lunch?"
            className={field}
          />
        </label>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-[var(--text)]">Answers</legend>
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                ref={(el) => {
                  inputs.current[i] = el;
                }}
                value={o}
                onChange={(e) => setOption(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && i === options.length - 1 && o.trim()) {
                    e.preventDefault();
                    addOption();
                  }
                }}
                maxLength={120}
                placeholder={`Answer ${i + 1}`}
                aria-label={`Answer ${i + 1}`}
                className={field}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  aria-label={`Remove answer ${i + 1}`}
                  onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] md:h-10 md:w-10"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {options.length < MAX_OPTIONS && (
            <button
              type="button"
              onClick={addOption}
              className="inline-flex h-11 items-center gap-2 self-start rounded-xl px-3 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--hover)] md:h-10"
            >
              <Plus className="h-4 w-4" aria-hidden /> Add an answer
            </button>
          )}
        </fieldset>

        <div className="flex flex-col overflow-hidden rounded-2xl border border-[var(--border)]">
          <Toggle label="Let people pick more than one" checked={multiple} onChange={setMultiple} />
          <Toggle label="Hide who voted" hint="Everyone sees the counts, nobody sees names" checked={anonymous} onChange={setAnonymous} />
          <label className="flex min-h-[52px] items-center justify-between gap-3 px-3 py-2">
            <span className="text-sm text-[var(--text)]">Voting ends</span>
            <select
              value={closes === null ? "" : String(closes)}
              onChange={(e) => setCloses(e.target.value ? Number(e.target.value) : null)}
              className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            >
              {CLOSES.map((c) => (
                <option key={c.label} value={c.hours === null ? "" : String(c.hours)}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </form>
    </Sheet>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-[52px] cursor-pointer items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2">
      <span className="flex min-w-0 flex-col">
        <span className="text-sm text-[var(--text)]">{label}</span>
        {hint && <span className="text-xs text-[var(--text-muted)]">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--surface)]",
          checked ? "bg-[var(--accent-strong)]" : "bg-[color-mix(in_srgb,var(--text)_25%,transparent)]",
        )}
      >
        <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[22px]" : "translate-x-0.5")} />
      </span>
    </label>
  );
}
