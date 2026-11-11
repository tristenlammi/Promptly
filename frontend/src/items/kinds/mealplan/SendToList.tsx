import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ListChecks, Loader2, NotebookPen, Search, StickyNote } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiClient } from "@/api/client";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import type { ItemHandle } from "@/items/useItem";
import { ItemButton, Sheet } from "@/items/ui";
import { notesApi } from "@/notes/api";
import { displayTitle, type Note } from "@/notes/types";
import { toast } from "@/store/toastStore";

import type { MealPlanData } from "./types";

/*
 * "Send to list ▾" (Notes N2.3): the grocery list goes to your Shopping note
 * by default — one household list, by aisle, that everyone on it sees change
 * — or another list note, or Tasks as before.
 */

interface Target {
  note: { id: string; title: string; shared: boolean } | null;
  new_title?: string;
}

interface Sent {
  note_id: string;
  title: string;
  made: boolean;
  version_id: string | null;
  href: string;
  summary?: string;
}

function errDetail(e: unknown, fallback: string): string {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof d === "string" ? d : fallback;
}

export function SendToList({ item, fileId }: { item: ItemHandle<MealPlanData>; fileId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(menu, menuRef, () => setMenu(false));
  const { data: target } = useQuery({
    queryKey: ["mealplan-note-target"],
    queryFn: async () => (await apiClient.get<Target>("/crossapp/mealplan/note-target")).data,
    staleTime: 60_000,
  });

  const toNote = async (noteId: string | null) => {
    setMenu(false);
    setPicking(false);
    setBusy(true);
    try {
      let out: Sent & { summary: string };
      if (item.canEdit) {
        // Our own pending edits land first, so the note gets what's on screen.
        const r = await item.runAction<Sent>("send_grocery_list_to_note", noteId ? { note_id: noteId } : {});
        out = { ...r.result, summary: r.summary };
      } else {
        out = (await apiClient.post<Sent & { summary: string }>(`/crossapp/mealplan/${fileId}/to-note`, noteId ? { note_id: noteId } : {})).data;
      }
      void qc.invalidateQueries({ queryKey: ["mealplan-note-target"] });
      const undo = async () => {
        try {
          if (out.made) await notesApi.forever(out.note_id);
          else if (out.version_id) await notesApi.restoreVersion(out.note_id, out.version_id);
          toast.success("Undone");
          void qc.invalidateQueries({ queryKey: ["mealplan-note-target"] });
        } catch (e) {
          toast.error(errDetail(e, "Couldn't undo that."));
        }
      };
      toast.success(`${out.summary}.`, {
        action: { label: "Open", onClick: () => navigate(out.href) },
        secondary: out.made || out.version_id ? { label: "Undo", onClick: () => void undo() } : undefined,
      });
    } catch (e) {
      toast.error(errDetail(e, "Couldn't send the list to the note."));
    } finally {
      setBusy(false);
    }
  };

  const toTasks = async () => {
    setMenu(false);
    setBusy(true);
    try {
      const r = await item.runAction<{ href: string }>("send_grocery_list_to_tasks");
      toast.success(`${r.summary}. To shop together, share your Tasks from Tasks.`, {
        action: { label: "Open Tasks", onClick: () => navigate(r.result.href) },
      });
    } catch (e) {
      toast.error(errDetail(e, "Couldn't send the list to Tasks."));
    } finally {
      setBusy(false);
    }
  };

  const first = target?.note ? `${target.note.title} (note)` : `A new ${target?.new_title ?? "Groceries"} note`;
  const helper = target?.note
    ? `Adds to your ${target.note.title} note, by aisle. Everyone on it sees the changes.`
    : "Makes a Groceries note, by aisle. Share it from Notes to shop together.";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="relative" ref={menuRef}>
        <ItemButton
          size="sm"
          variant="ghost"
          icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <span className="inline-flex items-center gap-1">
            Send to list <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </span>
        </ItemButton>
        {menu && (
          <div role="menu" aria-label="Send the grocery list to" className="absolute left-0 top-10 z-50 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]">
            <Choice icon={StickyNote} label={first} onClick={() => void toNote(target?.note?.id ?? null)} />
            <Choice icon={NotebookPen} label="Another note…" onClick={() => (setMenu(false), setPicking(true))} />
            <Choice icon={ListChecks} label="Tasks" onClick={() => void toTasks()} />
          </div>
        )}
      </div>
      <span className="text-xs text-[var(--text-muted)]">{helper}</span>
      <PickNote open={picking} onClose={() => setPicking(false)} onPick={(id) => void toNote(id)} />
    </div>
  );
}

function Choice({ icon: Icon, label, onClick }: { icon: typeof ListChecks; label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none">
      <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** Your checklists (and ones shared with you), to pick one. */
function PickNote({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["mealplan-note-lists"],
    queryFn: async () => (await notesApi.list("home", { limit: 200 })).notes,
    enabled: open,
    staleTime: 30_000,
  });
  const lists = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data ?? []).filter((n: Note) => n.kind === "list" && !n.trashed_at && (!term || displayTitle(n).toLowerCase().includes(term)));
  }, [data, q]);
  return (
    <Sheet open={open} onClose={onClose} title="Send to which list?" size="sm">
      <div className="flex flex-col gap-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a list"
            aria-label="Find a list"
            className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        {isLoading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your lists…
          </p>
        ) : isError ? (
          <p className="py-6 text-sm text-[var(--text-muted)]">Couldn't load your notes. Check your connection and try again.</p>
        ) : lists.length ? (
          <ul className="flex max-h-[50vh] flex-col overflow-y-auto">
            {lists.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => onPick(n.id)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-[var(--hover)]">
                  <ListChecks className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[var(--text)]">{displayTitle(n)}</span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">{n.items_total - n.items_checked} left{n.is_owner ? "" : " · shared"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-sm text-[var(--text-muted)]">{q.trim() ? `No list called “${q.trim()}”.` : "You have no checklists in Notes yet. Pick “A new Groceries note” instead."}</p>
        )}
      </div>
    </Sheet>
  );
}
