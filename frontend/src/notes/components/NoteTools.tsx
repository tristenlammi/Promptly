import { CalendarPlus, Check, ListChecks, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useEditorModel } from "@/lib/editorModel";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { applyAi, eventLink, makeTasks } from "../across";
import { notesApi } from "../api";
import { grouped } from "../ops";
import { sentAll } from "../store";
import { displayTitle, type AiAction, type AiProposal, type Note, type ProposedTask } from "../types";
import { Sheet } from "./Sheet";

/**
 * The note's "do something with it" sheets (N1.5): an AI proposal to look
 * at before anything changes (Tidy up, Make a list, Suggest a title), Turn
 * into tasks (pick which, and the list), and Make an event (reads the day
 * and time, then opens Calendar's new-event sheet to check and save).
 */

const btn = "flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium";
const primary = `${btn} bg-[var(--accent-strong)] px-5 text-white disabled:opacity-50`;
const quiet = `${btn} hover:bg-[var(--hover)]`;

/** Ask the model for a proposal (once on open, again on Try again). */
function useProposal(note: Note, action: AiAction | null) {
  const { providerId, modelId } = useEditorModel();
  const [state, setState] = useState<{ busy: boolean; error: string | null; proposal: AiProposal | null }>({ busy: !!action, error: null, proposal: null });
  const run = useRef(0);
  const ask = () => {
    if (!action) return;
    if (!providerId || !modelId) {
      setState({ busy: false, error: "No AI model is available to you yet — ask an admin to add one.", proposal: null });
      return;
    }
    const mine = ++run.current;
    setState({ busy: true, error: null, proposal: null });
    // The model reads the note as the server has it: anything typed goes first.
    sentAll(note.id)
      .then((sent) => {
        if (!sent) throw new Error("You're offline. Connect to use AI on this note.");
        return notesApi.ai(note.id, action, { provider_id: providerId, model_id: modelId });
      })
      .then((proposal) => mine === run.current && setState({ busy: false, error: null, proposal }))
      .catch(
        (e) =>
          mine === run.current &&
          setState({ busy: false, error: e instanceof Error && !("isAxiosError" in e) ? e.message : apiErrorMessage(e, "AI couldn't do that just now. Try again."), proposal: null }),
      );
  };
  useEffect(() => {
    ask();
    return () => {
      run.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, action]);
  return { ...state, retry: ask };
}

function Thinking({ words }: { words: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {words}
    </p>
  );
}

function Failed({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 py-4 text-sm">
      <p>{error}</p>
      <button type="button" onClick={onRetry} className={cn(quiet, "border border-[var(--border)]")}>
        <RotateCcw className="h-4 w-4" aria-hidden />
        Try again
      </button>
    </div>
  );
}

const AI_TITLES: Record<"tidy" | "to_list" | "title", string> = { tidy: "Tidy up", to_list: "Make a list", title: "Suggest a title" };
const AI_BUSY: Record<"tidy" | "to_list" | "title", string> = {
  tidy: "Tidying up the note…",
  to_list: "Picking out the items…",
  title: "Thinking of a title…",
};

/** Tidy up / Make a list / Suggest a title: the proposal, then Use this. */
export function AiSheet({ note, action, onClose }: { note: Note; action: "tidy" | "to_list" | "title"; onClose: () => void }) {
  const { busy, error, proposal, retry } = useProposal(note, action);
  const use = () => {
    if (!proposal) return;
    onClose();
    void applyAi(note, proposal);
  };
  return (
    <Sheet
      title={AI_TITLES[action]}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={quiet}>
            Cancel
          </button>
          <button type="button" onClick={use} disabled={!proposal} className={primary}>
            <Check className="h-4 w-4" aria-hidden />
            Use this
          </button>
        </>
      }
    >
      {busy && <Thinking words={AI_BUSY[action]} />}
      {error && <Failed error={error} onRetry={retry} />}
      {proposal?.action === "tidy" && (
        <div aria-label="Tidied note" className="space-y-2 whitespace-pre-wrap rounded-xl bg-[var(--surface-2)] p-3 text-[15px] leading-relaxed">
          {proposal.text.split("\n").map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
      {proposal?.action === "to_list" && (
        <ul aria-label="List items" className="space-y-1 rounded-xl bg-[var(--surface-2)] p-3 text-[15px]">
          {proposal.items.map((t, i) => (
            <li key={i} className="flex items-start gap-2">
              <span aria-hidden className="mt-1 h-4 w-4 shrink-0 rounded border-2 border-[var(--text-muted)]" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      )}
      {proposal?.action === "title" && (
        <p aria-label="Suggested title" className="rounded-xl bg-[var(--surface-2)] p-3 text-lg font-semibold">
          {proposal.title}
        </p>
      )}
      {proposal && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Nothing changes until you choose Use this, and you can undo it after.
        </p>
      )}
    </Sheet>
  );
}

function whenLabel(t: ProposedTask): string {
  if (!t.due) return "";
  const d = new Date(`${t.due}T12:00:00`);
  const day = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return t.time ? `${day}, ${t.time}` : day;
}

/** Turn into tasks: a list's unticked items, or the to-dos AI finds in a
 *  text note (or its lines, with no model). Pick which, and the list. */
export function TasksSheet({ note, onClose, onDone }: { note: Note; onClose: () => void; onDone?: () => void }) {
  const { providerId, modelId } = useEditorModel();
  const useModel = note.kind === "text" && !!providerId && !!modelId;
  const local: ProposedTask[] | null =
    note.kind === "list"
      ? grouped(note.items).filter((i) => !i.checked && i.text.trim()).map((i) => ({ title: i.text.trim(), due: null, time: null }))
      : !useModel
        ? (note.body_text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 50).map((title) => ({ title, due: null, time: null }))
        : null;
  const ai = useProposal(note, local ? null : "to_tasks");
  const tasks: ProposedTask[] = local ?? (ai.proposal?.action === "to_tasks" ? ai.proposal.tasks : []);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [lists, setLists] = useState<{ id: string; name: string }[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [list, setList] = useState("Inbox");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    notesApi
      .taskLists()
      .then((r) => {
        if (!live) return;
        setAvailable(r.available);
        setLists(r.lists);
        const shop = /shop|grocer/i.test(note.title) ? r.lists.find((l) => /shopping|groceries/i.test(l.name)) : null;
        setList(shop?.name ?? r.lists[0]?.name ?? "Inbox");
      })
      .catch(() => live && setLists([]));
    return () => {
      live = false;
    };
  }, [note.title]);

  const picked = tasks.filter((_, i) => !off.has(i));
  const add = async () => {
    setBusy(true);
    const out = await makeTasks(note, list, picked);
    setBusy(false);
    if (out) {
      onClose();
      onDone?.();
    }
  };

  return (
    <Sheet
      title="Turn into tasks"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={quiet}>
            Cancel
          </button>
          <button type="button" onClick={() => void add()} disabled={!picked.length || busy || !available} className={primary}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ListChecks className="h-4 w-4" aria-hidden />}
            {picked.length === 1 ? "Add 1 task" : `Add ${picked.length} tasks`}
          </button>
        </>
      }
    >
      {!available ? (
        <p className="py-4 text-sm">Tasks is turned off on this server, so there's nowhere to add them.</p>
      ) : ai.busy ? (
        <Thinking words="Finding the to-dos in this note…" />
      ) : ai.error ? (
        <Failed error={ai.error} onRetry={ai.retry} />
      ) : !tasks.length ? (
        <p className="py-4 text-sm">{note.kind === "list" ? "Every item on this list is ticked off." : "There's nothing in this note to turn into tasks."}</p>
      ) : (
        <>
          <p className="mb-2 text-sm text-[var(--text-muted)]">They go into your own Tasks{note.shared ? " (not the other people's on this note)" : ""}, linked back to this note.</p>
          <ul aria-label="Tasks to add" className="mb-4 space-y-0.5">
            {tasks.map((t, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
                  <input
                    type="checkbox"
                    checked={!off.has(i)}
                    onChange={(e) =>
                      setOff((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 text-sm">
                    {t.title}
                    {t.due && <span className="block text-xs text-[var(--text-muted)]">{whenLabel(t)}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-3 text-sm">
            <span className="shrink-0 font-medium">List</span>
            <select
              value={list}
              onChange={(e) => setList(e.target.value)}
              disabled={!lists}
              className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm"
            >
              {(lists ?? [{ id: "inbox", name: "Inbox" }]).map((l) => (
                <option key={l.id} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </Sheet>
  );
}

/** Make an event: AI reads the day, time and place (when there's a
 *  model), then Calendar's new-event sheet opens filled in to check and save. */
export function EventSheet({ note, onGo, onClose }: { note: Note; onGo: (href: string) => void; onClose: () => void }) {
  const { providerId, modelId } = useEditorModel();
  const withModel = !!providerId && !!modelId;
  const ai = useProposal(note, withModel ? "to_event" : null);
  const went = useRef(false);
  const go = (p?: AiProposal | null) => {
    if (went.current) return;
    went.current = true;
    onGo(eventLink(note, p?.action === "to_event" ? p : null));
  };
  useEffect(() => {
    if (!withModel || ai.proposal) go(ai.proposal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withModel, ai.proposal]);
  return (
    <Sheet
      title="Make an event"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={quiet}>
            Cancel
          </button>
          <button type="button" onClick={() => go(null)} className={primary}>
            <CalendarPlus className="h-4 w-4" aria-hidden />
            {ai.error ? "Open Calendar" : "Skip — just the title"}
          </button>
        </>
      }
    >
      {ai.busy && <Thinking words={`Finding the day and time in “${displayTitle(note)}”…`} />}
      {ai.error && <Failed error={ai.error} onRetry={ai.retry} />}
    </Sheet>
  );
}
