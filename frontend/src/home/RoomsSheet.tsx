import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, Merge, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { homeApi, type Home } from "@/api/home";
import { Sheet } from "@/components/shared/Sheet";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { sameRoom } from "./words";

/**
 * Rooms, in one place: make one, rename it, put them in order, fold two into
 * one ("Lounge Room" into "Living Room"), or remove one (its devices stay in
 * your home, with no room). A device's own room is changed from the device,
 * or several at once from "Sort into rooms".
 *
 * Rooms are Promptly's. A brand's own rooms (Hue's, say) only decide where
 * its devices first land.
 */

const btn =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const strong =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent-strong)] px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
const icon =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const field =
  "h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

export function RoomsSheet({ open, home, onClose }: { open: boolean; home: Home; onClose: () => void }) {
  const qc = useQueryClient();
  // Rooms live on the home's box. With more than one box, the first that's on.
  const box = home.boxes.find((b) => b.ready) ?? home.boxes[0] ?? null;
  const [fresh, setFresh] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setFresh("");
      setEditing(null);
      setMerging(null);
    }
  }, [open]);
  const counts = useMemo(() => {
    const seen = new Map<string, Set<string>>();
    for (const e of home.entities) {
      if (!e.area) continue;
      const set = seen.get(e.area) ?? new Set<string>();
      set.add(e.dev ?? e.id);
      seen.set(e.area, set);
    }
    return seen;
  }, [home.entities]);
  const again = () => void qc.invalidateQueries({ queryKey: ["home", "homes"] });
  const run = <T,>(what: (v: T) => Promise<unknown>, fallback: string, after?: () => void) => ({
    mutationFn: what,
    onSuccess: () => {
      after?.();
      again();
    },
    onError: (e: unknown) => toast.error(apiErrorMessage(e, fallback)),
  });
  const add = useMutation(run((name: string) => homeApi.addRoom(home.id, box!.id, name), "Couldn't make that room.", () => setFresh("")));
  const rename = useMutation(run((r: { id: string; name: string }) => homeApi.renameRoom(home.id, box!.id, r.id, r.name), "Couldn't rename it.", () => setEditing(null)));
  const remove = useMutation(run((id: string) => homeApi.deleteRoom(home.id, box!.id, id), "Couldn't remove it."));
  const merge = useMutation(run((m: { from: string; into: string }) => homeApi.mergeRooms(home.id, box!.id, m.from, m.into), "Couldn't put those together.", () => setMerging(null)));
  const order = useMutation(run((ids: string[]) => homeApi.orderRooms(home.id, box!.id, ids), "Couldn't move it."));
  const busy = add.isPending || rename.isPending || remove.isPending || merge.isPending || order.isPending;
  const live = !!box?.ready;
  const taken = (name: string, but?: string) => home.areas.some((a) => a.id !== but && sameRoom(a.name, name));
  const move = (at: number, by: number) => {
    const ids = home.areas.map((a) => a.id);
    const to = at + by;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    order.mutate(ids);
  };

  return (
    <Sheet open={open} onClose={onClose} title="Rooms" size="md" footer={<button type="button" className={cn(btn, "w-full")} onClick={onClose}>Done</button>}>
      <div className="flex flex-col gap-4">
        {!live && <p role="status" className="text-sm text-[var(--text-muted)]">Rooms can be changed when your home is connected. It isn't right now.</p>}
        {home.areas.length === 0 && <p className="text-sm text-[var(--text-muted)]">No rooms yet. Make one below, or add a device: it brings the rooms its own app knows.</p>}
        <ul className="flex flex-col divide-y divide-[var(--border)]" aria-label="Your rooms">
          {home.areas.map((a, i) => {
            const n = counts.get(a.id)?.size ?? 0;
            const others = home.areas.filter((o) => o.id !== a.id);
            return (
              <li key={a.id} className="flex flex-col gap-2 py-2">
                {editing?.id === a.id ? (
                  <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (editing.name.trim() && !taken(editing.name, a.id)) rename.mutate({ id: a.id, name: editing.name.trim() }); }}>
                    <input data-autofocus className={field} value={editing.name} maxLength={60} aria-label={`New name for ${a.name}`} onChange={(e) => setEditing({ id: a.id, name: e.target.value })} />
                    <button type="submit" className={icon} aria-label="Save name" disabled={busy || !editing.name.trim() || taken(editing.name, a.id)}><Check className="h-4 w-4" /></button>
                    <button type="button" className={icon} aria-label="Cancel" onClick={() => setEditing(null)}><X className="h-4 w-4" /></button>
                  </form>
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--text)]">{a.name}</span>
                      <span className="block text-xs text-[var(--text-muted)]">{n === 0 ? "Nothing in it" : `${n} ${n === 1 ? "device" : "devices"}`}</span>
                    </span>
                    <button type="button" className={icon} aria-label={`Move ${a.name} up`} disabled={!live || busy || i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></button>
                    <button type="button" className={icon} aria-label={`Move ${a.name} down`} disabled={!live || busy || i === home.areas.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></button>
                    <button type="button" className={icon} aria-label={`Rename ${a.name}`} disabled={!live || busy} onClick={() => { setMerging(null); setEditing({ id: a.id, name: a.name }); }}><Pencil className="h-4 w-4" /></button>
                    {others.length > 0 && <button type="button" className={icon} aria-label={`Put ${a.name} into another room`} title="Put into another room" disabled={!live || busy} onClick={() => { setEditing(null); setMerging(merging === a.id ? null : a.id); }}><Merge className="h-4 w-4" /></button>}
                    <button type="button" className={icon} aria-label={`Remove ${a.name}`} disabled={!live || busy} onClick={() => { if (window.confirm(n === 0 ? `Remove ${a.name}?` : `Remove ${a.name}? Its ${n === 1 ? "device stays" : `${n} devices stay`} in your home, with no room.`)) remove.mutate(a.id); }}><Trash2 className="h-4 w-4" /></button>
                  </div>
                )}
                {editing?.id === a.id && editing.name.trim() !== "" && taken(editing.name, a.id) && <p role="alert" className="text-xs text-[var(--danger)]">There's already a room with that name. To make them one room, use "Put into another room".</p>}
                {merging === a.id && (
                  <div className="flex flex-col gap-2 rounded-xl bg-[var(--hover)] p-3">
                    <p className="text-sm text-[var(--text)]">Put everything in {a.name} into:</p>
                    <div className="flex flex-wrap gap-2">
                      {others.map((o) => (
                        <button key={o.id} type="button" className={btn} disabled={busy} onClick={() => merge.mutate({ from: a.id, into: o.id })}>{o.name}</button>
                      ))}
                    </div>
                    <p className="text-xs text-[var(--text-muted)]">{a.name} goes, and its devices move.</p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (fresh.trim() && !taken(fresh)) add.mutate(fresh.trim()); }}>
          <input className={field} value={fresh} maxLength={60} placeholder="A new room, like Kitchen" aria-label="New room's name" disabled={!live} onChange={(e) => setFresh(e.target.value)} />
          <button type="submit" className={strong} disabled={!live || busy || !fresh.trim() || taken(fresh)}><Plus className="h-4 w-4" /> Add room</button>
        </form>
        {fresh.trim() !== "" && taken(fresh) && <p role="alert" className="-mt-2 text-xs text-[var(--danger)]">You already have that room.</p>}
      </div>
    </Sheet>
  );
}
