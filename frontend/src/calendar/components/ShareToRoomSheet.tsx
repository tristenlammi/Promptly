import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Hash, Loader2, MessagesSquare, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { calendarApi, type CalEvent } from "@/api/calendar";
import { roomsApi, type Room } from "@/api/rooms";
import { extractError } from "@/components/files/helpers";
import { ItemButton, Sheet } from "@/items/ui";
import { BOOTSTRAP_KEY as ROOMS_BOOTSTRAP_KEY, dmTitle } from "@/rooms/cache";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { addUsers, useRefreshEvents } from "../data";

interface Choice {
  room: Room;
  /** "#general", or a DM's people. */
  label: string;
  group: string;
  /** The space's plain name. */
  space: string | null;
}

/** Post an event's card in one of my rooms (and maybe invite everyone there). */
export function ShareToRoomSheet({ ev, open, onClose, sharedIds }: { ev: CalEvent; open: boolean; onClose: () => void; sharedIds: string[] }) {
  const qc = useQueryClient();
  const refresh = useRefreshEvents();
  const { data: rb, isLoading, isError } = useQuery({ queryKey: ROOMS_BOOTSTRAP_KEY, queryFn: roomsApi.bootstrap, staleTime: 30_000, enabled: open });
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [inviteAll, setInviteAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const choices = useMemo(() => {
    if (!rb) return [];
    const out: Choice[] = [];
    for (const s of rb.spaces) {
      for (const r of [...s.rooms].sort((a, b) => a.position - b.position)) {
        if (r.kind === "text") out.push({ room: r, label: `#${r.name}`, group: `${s.emoji ? `${s.emoji} ` : ""}${s.name}`, space: s.name });
      }
    }
    for (const r of rb.dms) out.push({ room: r, label: dmTitle(rb, r), group: "Direct messages", space: null });
    return out;
  }, [rb]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? choices.filter((c) => c.label.toLowerCase().includes(t) || c.group.toLowerCase().includes(t)) : choices;
  }, [choices, q]);
  const groups = useMemo(() => {
    const m = new Map<string, Choice[]>();
    for (const c of shown) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()];
  }, [shown]);
  const chosen = choices.find((c) => c.room.id === picked) ?? null;

  const share = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const r = await calendarApi.share(ev.event_id, chosen.room.id, inviteAll);
      addUsers(r.users);
      toast.success(`Shared to ${chosen.space ? `${chosen.label} · ${chosen.space}` : chosen.label}`);
      void qc.invalidateQueries({ queryKey: ["calendar", "event", ev.event_id] });
      if (inviteAll) refresh();
      onClose();
    } catch (err) {
      toast.error(extractError(err) || "Couldn't share it there.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Share to a room"
      size="md"
      footer={
        <>
          <ItemButton block onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton block variant="primary" disabled={!chosen || busy} onClick={() => void share()}>
            {busy ? "Sharing…" : "Share"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-1">
        <p className="truncate text-sm text-[var(--text-muted)]">
          Post <span className="font-medium text-[var(--text)]">{ev.title}</span> as a card people can add to their calendar.
        </p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a room or person"
            aria-label="Find a room"
            className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--item-accent)] md:h-10"
          />
        </div>
        <div role="radiogroup" aria-label="Room" className="flex max-h-[42dvh] flex-col gap-2 overflow-y-auto overscroll-contain">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : isError ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]">Couldn't load your rooms.</p>
          ) : choices.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]">You're not in any rooms yet.</p>
          ) : groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]">No rooms match “{q.trim()}”.</p>
          ) : (
            groups.map(([group, items]) => (
              <section key={group} className="flex flex-col gap-0.5">
                <h3 className="px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{group}</h3>
                {items.map((c) => {
                  const sel = picked === c.room.id;
                  const already = sharedIds.includes(c.room.id);
                  return (
                    <button
                      key={c.room.id}
                      type="button"
                      role="radio"
                      aria-checked={sel}
                      onClick={() => setPicked(c.room.id)}
                      className={cn(
                        "flex h-11 items-center gap-2.5 rounded-xl px-2 text-left text-sm transition",
                        sel ? "bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] text-[var(--text)]" : "text-[var(--text)] hover:bg-[var(--hover)]",
                      )}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--text-muted)]">
                        {c.room.space_id ? <Hash className="h-3.5 w-3.5" /> : <MessagesSquare className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{c.room.space_id ? c.room.name : c.label}</span>
                      {already && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">Shared</span>}
                      {sel && <Check className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--border)] p-3">
          <input type="checkbox" checked={inviteAll} onChange={(e) => setInviteAll(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--item-accent)]" />
          <span className="flex flex-col">
            <span className="text-sm font-medium text-[var(--text)]">Also invite everyone there</span>
            <span className="text-xs text-[var(--text-muted)]">Otherwise people there can add themselves from the card.</span>
          </span>
        </label>
      </div>
    </Sheet>
  );
}
