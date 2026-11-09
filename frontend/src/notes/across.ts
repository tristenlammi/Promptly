/**
 * A note going elsewhere in Promptly (N1.5): AI proposals applied with Undo,
 * Make a copy, Open as document, Turn into tasks, Make an event. Each one
 * says what it did and offers Undo where it can be undone.
 *
 * AI changes go through the normal outbox (so they sync and merge like
 * typing), marked ``checkpoint: "ai"`` so the server keeps the note as it
 * was first; Undo restores exactly that version.
 */
import axios from "axios";

import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { notesApi, type ToTasksResult } from "./api";
import { notesActions, receive, sentAll, useNotes } from "./store";
import { displayTitle, docText, textDoc, uuid, type AiProposal, type Note, type ProposedTask } from "./types";

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** The versions the server kept before AI changes (ids), to tell a new one. */
async function aiVersionIds(id: string): Promise<Set<string>> {
  try {
    return new Set((await notesApi.versions(id)).filter((v) => v.reason === "ai").map((v) => v.id));
  } catch {
    return new Set();
  }
}

/** Put the note back as it was before the AI change made after ``before``. */
async function undoAi(id: string, before: Set<string>): Promise<void> {
  if (!(await sentAll(id))) {
    toast.error("Couldn't undo while offline. You can change it back by hand.");
    return;
  }
  try {
    const me = useNotes.getState().uid;
    const fresh = (await notesApi.versions(id)).filter((v) => v.reason === "ai" && !before.has(v.id) && (!me || v.made_by === me));
    const target = fresh[fresh.length - 1]; // the oldest new one: from just before the change
    if (!target) {
      toast.error("Couldn't undo that change.");
      return;
    }
    receive(await notesApi.restoreVersion(id, target.id));
    toast.info("Change undone");
  } catch (e) {
    toast.error(apiErrorMessage(e, "Couldn't undo that change."));
  }
}

const DONE: Record<string, string> = {
  tidy: "Note tidied up",
  to_list: "Made into a list",
  title: "Title added",
};

/** "Use this": apply an AI proposal to the note, with Undo. */
export async function applyAi(note: Note, p: AiProposal): Promise<void> {
  const id = note.id;
  const before = await aiVersionIds(id);
  if (p.action === "tidy") {
    notesActions.patch(id, { body_doc: p.body_doc, checkpoint: "ai" });
  } else if (p.action === "to_list") {
    // The items as lines first (kept as a version), then checkboxes on.
    notesActions.patch(id, { body_doc: textDoc(p.items.join("\n")), checkpoint: "ai" });
    notesActions.patch(id, { kind: "list" });
  } else if (p.action === "title") {
    notesActions.patch(id, { title: p.title, checkpoint: "ai" });
  } else return;
  toast.success(DONE[p.action], { action: { label: "Undo", onClick: () => void undoAi(id, before) } });
}

/** Make a copy: a new note of yours. Returns its id (null: it didn't work). */
export async function makeCopy(note: Note): Promise<string | null> {
  if (offline()) {
    toast.error("You're offline. Connect to make a copy.");
    return null;
  }
  if (!(await sentAll(note.id))) {
    toast.error("Couldn't make a copy yet: this note is still saving.");
    return null;
  }
  try {
    const { note: copy, skipped_attachments: skipped } = await notesApi.copy(note.id, uuid());
    receive(copy);
    const undo = { label: "Undo", onClick: () => notesActions.forever(copy.id) };
    if (skipped) toast.info(`Copy made. ${skipped === 1 ? "One picture or recording" : `${skipped} pictures or recordings`} couldn't come too (no room left in your storage).`, { action: undo });
    else toast.success("Copy made", { action: undo });
    return copy.id;
  } catch (e) {
    toast.error(apiErrorMessage(e, "Couldn't make a copy. Try again."));
    return null;
  }
}

/** Open as document (the owner): the note's words become a Document; the
 *  note keeps a card that opens it and goes to your archive. Returns where
 *  the document opens (null: it didn't work). */
export async function openAsDocument(note: Note): Promise<string | null> {
  if (offline()) {
    toast.error("You're offline. Connect to make a document.");
    return null;
  }
  if (!(await sentAll(note.id))) {
    toast.error("Couldn't make the document yet: this note is still saving.");
    return null;
  }
  try {
    const out = await notesApi.toDocument(note.id);
    receive(out.note);
    toast.success(`“${displayTitle(note)}” is now a document. The note is in your archive.`, {
      action: {
        label: "Undo",
        onClick: () =>
          void notesApi
            .undoDocument(note.id)
            .then((n) => {
              receive(n);
              toast.info("Back to a note");
            })
            .catch((e) => toast.error(apiErrorMessage(e, "Couldn't undo that."))),
      },
    });
    return out.document?.href ?? `/files/doc/${out.file_id}`;
  } catch (e) {
    toast.error(apiErrorMessage(e, "Couldn't make a document. Try again."));
    return null;
  }
}

/** Turn into tasks: add them to your Tasks, with Undo. */
export async function makeTasks(note: Note, list: string | null, tasks: ProposedTask[]): Promise<ToTasksResult | null> {
  try {
    if (!(await sentAll(note.id))) throw new Error("offline");
    const out = await notesApi.toTasks(note.id, list, tasks);
    const n = out.count;
    toast.success(`Added ${n === 1 ? "a task" : `${n} tasks`} to ${out.list} in Tasks`, {
      action: {
        label: "Undo",
        onClick: () =>
          void notesApi
            .undoTasks(note.id, out.file_id, out.task_ids)
            .then((gone) => toast.info(gone === n ? "Tasks taken back" : gone ? `${gone} of ${n} tasks taken back (the rest are done)` : "Those tasks are already done"))
            .catch((e) => toast.error(apiErrorMessage(e, "Couldn't undo that."))),
      },
    });
    return out;
  } catch (e) {
    const off = offline() || (axios.isAxiosError(e) && !e.response) || (e instanceof Error && e.message === "offline");
    toast.error(off ? "You're offline. Connect to add tasks." : apiErrorMessage(e, "Couldn't add the tasks. Try again."));
    return null;
  }
}

/** Where "Make an event" goes: Calendar's new-event sheet, filled in. */
export function eventLink(note: Note, p?: Extract<AiProposal, { action: "to_event" }> | null): string {
  const q = new URLSearchParams({ new: "1" });
  const words = note.kind === "list"
    ? note.items.filter((i) => !i.checked && i.text.trim()).map((i) => `• ${i.text.trim()}`).join("\n")
    : (note.body_text ?? docText(note.body_doc) ?? "").trim();
  const title = p?.title || (note.title.trim() || displayTitle(note));
  q.set("title", title.slice(0, 200));
  const description = (p?.description || words).slice(0, 4000);
  if (description && description !== title) q.set("description", description);
  if (p?.date) q.set("date", p.date);
  if (p?.start && !p.all_day) q.set("start", p.start);
  if (p?.end && !p.all_day) q.set("end", p.end);
  if (p?.all_day && p.date) q.set("all_day", "1");
  if (p?.location) q.set("location", p.location.slice(0, 300));
  return `/calendar?${q.toString()}`;
}
