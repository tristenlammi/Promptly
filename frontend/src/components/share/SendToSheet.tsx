import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Hash, Loader2, MessagesSquare, Search, Send, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { crossApi, GRANTABLE, type ShareTarget } from "@/api/crossapp";
import { roomsApi, type Bootstrap, type RoomUser } from "@/api/rooms";
import { Sheet } from "@/items/ui/Sheet";
import { BOOTSTRAP_KEY } from "@/rooms/cache";
import { UserAvatar } from "@/rooms/components/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * "Send to…": share a file, folder, photo, album, task, recipe, trip or form into
 * a room or to a person (their DM, made if new). It posts a card in Rooms
 * with an optional message. Sending never gives anyone access on its own —
 * for things that can be shared (Drive files and folders, photos, albums)
 * the owner can tick "Also give everyone in the room access".
 */

type Pick =
  | { type: "room"; id: string; name: string; members: number }
  | { type: "person"; user: RoomUser };

/** Where the thing lives, for the "who can open it" line. */
const HOME: Partial<Record<ShareTarget["kind"], string>> = { task: "Tasks", recipe: "Meal Planner", trip: "Trip Planner" };
/** Who can open it, said for kinds that are shared on their own (a note). */
const WHO: Partial<Record<ShareTarget["kind"], string>> = {
  note: "Only people this note is shared with can open it — others see that a note was shared.",
};

function dmName(memberIds: string[] | undefined, b: Bootstrap): string {
  const others = (memberIds ?? []).filter((id) => id !== b.me.id).map((id) => b.users[id]?.username ?? "Someone");
  return others.join(", ") || "Just you";
}

export function SendToSheet({
  open,
  onClose,
  target,
  canGrant = true,
}: {
  open: boolean;
  onClose: () => void;
  target: ShareTarget | null;
  /** False when the person isn't the owner (they can still send the card). */
  canGrant?: boolean;
}) {
  if (!open || !target) return null;
  return <SendTo onClose={onClose} target={target} canGrant={canGrant} />;
}

function SendTo({ onClose, target, canGrant }: { onClose: () => void; target: ShareTarget; canGrant: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Pick | null>(null);
  const [note, setNote] = useState("");
  const [grant, setGrant] = useState(false);
  const [busy, setBusy] = useState(false);

  const boot = useQuery({ queryKey: BOOTSTRAP_KEY, queryFn: roomsApi.bootstrap, staleTime: 30_000 });
  const term = q.trim();
  const people = useQuery({
    queryKey: ["rooms", "people", term.length >= 2 ? term : ""],
    queryFn: () => roomsApi.people(term.length >= 2 ? term : ""),
    staleTime: 30_000,
  });

  const rooms = useMemo(() => {
    const b = boot.data;
    if (!b) return [];
    const out: { id: string; name: string; sub: string; members: number; dm: boolean }[] = [];
    for (const s of b.spaces) {
      for (const r of s.rooms) out.push({ id: r.id, name: `#${r.name}`, sub: s.name, members: s.member_ids.length, dm: false });
    }
    for (const r of b.dms) out.push({ id: r.id, name: dmName(r.members, b), sub: r.kind === "group" ? "Group conversation" : "Conversation", members: r.members?.length ?? 2, dm: true });
    const low = term.toLowerCase();
    return low ? out.filter((r) => `${r.name} ${r.sub}`.toLowerCase().includes(low)) : out;
  }, [boot.data, term]);

  const grantable = GRANTABLE.includes(target.kind) && canGrant;
  const home = HOME[target.kind];

  const send = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try {
      let roomId: string;
      let where: string;
      if (pick.type === "person") {
        const room = await roomsApi.openDm([pick.user.id]);
        roomId = room.id;
        where = pick.user.username;
      } else {
        roomId = pick.id;
        where = pick.name;
      }
      const out = await crossApi.share({
        room_id: roomId,
        kind: target.kind,
        id: target.id,
        file_id: target.file_id,
        note: note.trim(),
        grant: grantable && grant,
      });
      void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      const g = out.granted;
      const extra = g && g.skipped > 0 ? ` ${g.skipped} ${g.skipped === 1 ? "person wasn't" : "people weren't"} given access — a file can be shared with at most 10 people.` : "";
      toast.success(`Sent to ${where}.${extra}`, {
        action: { label: "Open", onClick: () => navigate(`/rooms/r/${roomId}`) },
      });
      onClose();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't send that. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const roomSelected = (id: string) => pick?.type === "room" && pick.id === id;
  const personSelected = (id: string) => pick?.type === "person" && pick.user.id === id;
  const peopleList = (people.data ?? []).filter((u) => u.id !== boot.data?.me.id);

  return (
    <Sheet
      open
      onClose={onClose}
      title="Send to…"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-11 flex-1 rounded-xl border border-[var(--border)] text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)] md:flex-none md:px-5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!pick || busy}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] text-sm font-semibold text-white disabled:opacity-50 md:ml-auto md:flex-none md:px-6"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </button>
        </>
      }
    >
      <p className="mb-3 truncate text-sm text-[var(--text-muted)]">
        Sharing <span className="font-medium text-[var(--text)]">“{target.title}”</span>
      </p>
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search rooms and people"
          aria-label="Search rooms and people"
          className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      </label>

      {boot.isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : boot.isError ? (
        <p className="py-4 text-sm text-[var(--text-muted)]">Couldn't load your rooms. Close this and try again.</p>
      ) : (
        <div className="max-h-[38dvh] overflow-y-auto rounded-xl border border-[var(--border)] md:max-h-72">
          {rooms.length > 0 && <Heading>Rooms and conversations</Heading>}
          {rooms.map((r) => (
            <Row
              key={r.id}
              selected={roomSelected(r.id)}
              onClick={() => setPick({ type: "room", id: r.id, name: r.name, members: r.members })}
              icon={r.dm ? <MessagesSquare className="h-4 w-4" /> : <Hash className="h-4 w-4" />}
              title={r.name}
              sub={r.sub}
            />
          ))}
          {peopleList.length > 0 && <Heading>People</Heading>}
          {peopleList.map((u) => (
            <Row
              key={u.id}
              selected={personSelected(u.id)}
              onClick={() => setPick({ type: "person", user: u })}
              icon={<UserAvatar user={u} size={24} />}
              title={u.username}
              sub="Send in a direct message"
            />
          ))}
          {rooms.length === 0 && peopleList.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">
              {term.length >= 2 ? "No rooms or people match." : "No rooms yet. Search for a person by name to message them."}
            </p>
          )}
        </div>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="Add a message (optional)"
        aria-label="Message"
        className="mt-3 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />

      {grantable ? (
        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--border)] p-3">
          <input type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
          <span className="min-w-0 text-sm">
            <span className="flex items-center gap-1.5 font-medium text-[var(--text)]">
              <Users className="h-4 w-4" /> Also give {pick?.type === "person" ? pick.user.username : "everyone in the room"} access
            </span>
            <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
              They'll be able to view it. Without this, only people who already have access can open it.
            </span>
          </span>
        </label>
      ) : (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          {target.kind === "form"
            ? "Everyone who can answer the form sees it with a Fill in button. It doesn't let anyone change the form or see its answers."
            : WHO[target.kind]
            ? WHO[target.kind]
            : home
            ? `Only people you've shared your ${home} with can open it — others see that it was shared.`
            : "Only people who already have access can open it — others see that it was shared."}
        </p>
      )}
    </Sheet>
  );
}

function Heading({ children }: { children: string }) {
  return <div className="sticky top-0 z-[1] bg-[var(--bg)] px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{children}</div>;
}

function Row({ selected, onClick, icon, title, sub }: { selected: boolean; onClick: () => void; icon: React.ReactNode; title: string; sub: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex min-h-[48px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none",
        selected && "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]",
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-muted)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--text)]">{title}</span>
        <span className="block truncate text-xs text-[var(--text-muted)]">{sub}</span>
      </span>
      {selected && <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
    </button>
  );
}
