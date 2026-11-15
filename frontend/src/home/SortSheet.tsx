import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { homeApi, type Home, type HomeEntity } from "@/api/home";
import { Sheet } from "@/components/shared/Sheet";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { isReading, sameRoom } from "./words";

/**
 * "Sort into rooms": the devices with no room yet, ticked a few at a time
 * and sent to a room together. Tick, pick the room, repeat until none are
 * left (or stop whenever: the rest stay under "Not in a room yet").
 */

const btn =
  "inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const chip =
  "inline-flex min-h-10 items-center rounded-full border border-[var(--border)] px-3.5 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const field =
  "h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

export interface Loose {
  key: string;
  box_id: string;
  name: string;
  /** Every part of it: they move together. */
  entities: string[];
}

/** Devices with no room, one row per device (a plug and its power reading are one). */
export function looseDevices(entities: HomeEntity[]): Loose[] {
  const out = new Map<string, Loose>();
  for (const e of entities) {
    if (e.area) continue;
    const key = `${e.box_id}/${e.dev ?? e.id}`;
    const have = out.get(key);
    if (!have) out.set(key, { key, box_id: e.box_id, name: e.name, entities: [e.id] });
    else {
      have.entities.push(e.id);
      // Named after the part you'd tap, not a reading that hangs off it.
      if (!isReading(e) && have.name !== e.name && have.entities.length === 2) have.name = e.name;
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function SortSheet({ open, home, onClose }: { open: boolean; home: Home; onClose: () => void }) {
  const qc = useQueryClient();
  const loose = useMemo(() => looseDevices(home.entities), [home.entities]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (open) {
      setTicked(new Set());
      setFresh("");
    }
  }, [open]);
  const picked = loose.filter((l) => ticked.has(l.key));
  const send = useMutation({
    mutationFn: async (to: { id?: string; name?: string }) => {
      const byBox = new Map<string, string[]>();
      for (const l of picked) byBox.set(l.box_id, [...(byBox.get(l.box_id) ?? []), ...l.entities]);
      for (const [boxId, entities] of byBox) {
        // A room is its box's: with a new name, it's made (or found) there.
        const area = to.id ?? (await homeApi.addRoom(home.id, boxId, to.name ?? "")).id;
        await homeApi.placeDevices(home.id, boxId, entities, area);
      }
    },
    onSuccess: () => {
      setTicked(new Set());
      setFresh("");
      void qc.invalidateQueries({ queryKey: ["home", "homes"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't move those. Try again.")),
  });
  const all = loose.length > 0 && picked.length === loose.length;
  const existing = fresh.trim() ? home.areas.find((a) => sameRoom(a.name, fresh)) : undefined;

  return (
    <Sheet open={open} onClose={onClose} title="Sort into rooms" size="md" footer={<button type="button" className={cn(btn, "w-full")} onClick={onClose}>{loose.length === 0 ? "Done" : "Finish later"}</button>}>
      {loose.length === 0 ? (
        <p className="text-sm text-[var(--text)]">Everything is in a room.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--text-muted)]">Tick the ones that belong together, then pick their room.</p>
          <div>
            <label className="flex min-h-10 items-center gap-3 border-b border-[var(--border)] text-sm font-medium text-[var(--text)]">
              <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={all} onChange={() => setTicked(all ? new Set() : new Set(loose.map((l) => l.key)))} />
              All {loose.length}
            </label>
            <ul className="flex flex-col" aria-label="Devices with no room">
              {loose.map((l) => (
                <li key={l.key}>
                  <label className="flex min-h-11 items-center gap-3 text-sm text-[var(--text)]">
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-[var(--accent)]"
                      checked={ticked.has(l.key)}
                      onChange={(e) => setTicked((old) => { const next = new Set(old); if (e.target.checked) next.add(l.key); else next.delete(l.key); return next; })}
                    />
                    <span className="min-w-0 truncate">{l.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <div className="sticky bottom-0 -mb-4 flex flex-col gap-2 border-t border-[var(--border)] bg-[var(--bg)] pb-4 pt-4">
            <p className="text-sm font-medium text-[var(--text)]">{picked.length === 0 ? "Put them in" : `Put ${picked.length === 1 ? "it" : `these ${picked.length}`} in`}</p>
            {home.areas.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {home.areas.map((a) => (
                  <button key={a.id} type="button" className={chip} disabled={picked.length === 0 || send.isPending} onClick={() => send.mutate({ id: a.id })}>{a.name}</button>
                ))}
              </div>
            )}
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (fresh.trim() && picked.length > 0) send.mutate(existing ? { id: existing.id } : { name: fresh.trim() }); }}>
              <input className={field} value={fresh} maxLength={60} placeholder="A new room, like Kitchen" aria-label="New room's name" onChange={(e) => setFresh(e.target.value)} />
              <button type="submit" className={cn(chip, "rounded-xl")} disabled={!fresh.trim() || picked.length === 0 || send.isPending}>{send.isPending ? "Moving…" : existing ? `Use ${existing.name}` : "New room"}</button>
            </form>
          </div>
        </div>
      )}
    </Sheet>
  );
}
