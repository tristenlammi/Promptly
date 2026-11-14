import { useQuery } from "@tanstack/react-query";
import { FileText, Hash, Image as ImageIcon, Loader2, MapPin, MessagesSquare, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { roomsApi, type Bootstrap } from "@/api/rooms";
import { Sheet } from "@/items/ui/Sheet";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { aimIncomingShare, dropIncomingShare, type IncomingShare } from "../incomingShare";
import { UserAvatar } from "./ui";

/**
 * "Share → P Rooms" from another app on the phone: choose the conversation.
 * Choosing opens it with the photos, files and words waiting in the box to
 * type in; nothing is sent until you press Send there.
 */
export function ShareInSheet({ share, b }: { share: IncomingShare; b: Bootstrap }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const term = q.trim();
  const people = useQuery({
    queryKey: ["rooms", "people", term.length >= 2 ? term : ""],
    queryFn: () => roomsApi.people(term.length >= 2 ? term : ""),
    staleTime: 30_000,
  });

  const rooms = useMemo(() => {
    const out: { id: string; name: string; sub: string; dm: boolean; canPost: boolean }[] = [];
    // Conversations first, newest first: that's where a photo usually goes.
    for (const r of b.dms) {
      const others = (r.members ?? []).filter((id) => id !== b.me.id).map((id) => b.users[id]?.username ?? "Someone");
      out.push({ id: r.id, name: others.join(", ") || "Just you", sub: r.kind === "group" ? "Group conversation" : "Conversation", dm: true, canPost: true });
    }
    for (const s of b.spaces) {
      for (const r of s.rooms) if (r.kind !== "voice") out.push({ id: r.id, name: `#${r.name}`, sub: s.name, dm: false, canPost: true });
    }
    const low = term.toLowerCase();
    return low ? out.filter((r) => `${r.name} ${r.sub}`.toLowerCase().includes(low)) : out;
  }, [b, term]);
  const inDm = new Set(b.dms.filter((r) => r.kind === "dm").flatMap((r) => r.members ?? []));
  const peopleList = (people.data ?? []).filter((u) => u.id !== b.me.id && !inDm.has(u.id));

  const go = (roomId: string) => {
    aimIncomingShare(roomId);
    navigate(`/rooms/r/${roomId}`);
  };
  const toPerson = async (userId: string) => {
    if (busy) return;
    setBusy(userId);
    try {
      const room = await roomsApi.openDm([userId]);
      go(room.id);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't open that conversation. Try again."));
    } finally {
      setBusy(null);
    }
  };

  const n = share.files.length;
  const photos = share.files.filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/")).length;
  const what =
    n === 0
      ? share.place
        ? share.place.name
        : "What you shared"
      : photos === n
        ? n === 1
          ? "1 photo or video"
          : `${n} photos and videos`
        : n === 1
          ? share.files[0].name
          : `${n} files`;

  return (
    <Sheet open onClose={dropIncomingShare} title="Send to…">
      <p className="mb-3 flex items-center gap-2 text-sm text-[var(--text-muted)]">
        {n > 0 && photos === n ? <ImageIcon className="h-4 w-4 shrink-0" /> : n === 0 && share.place ? <MapPin className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}
        <span className="min-w-0 truncate">
          <span className="font-medium text-[var(--text)]">{what}</span>
          {share.text && (n > 0 || share.place) ? " and a message" : share.text ? `: ${share.text.slice(0, 80)}` : ""}
        </span>
      </p>
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search conversations and people"
          aria-label="Search conversations and people"
          className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-base text-[var(--text)] outline-none focus:border-[var(--accent)] md:text-sm"
        />
      </label>
      <div className="max-h-[50dvh] overflow-y-auto rounded-xl border border-[var(--border)] md:max-h-80">
        {rooms.map((r) => (
          <button key={r.id} type="button" onClick={() => go(r.id)} className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--text-muted)]">{r.dm ? <MessagesSquare className="h-4 w-4" /> : <Hash className="h-4 w-4" />}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--text)]">{r.name}</span>
              <span className="block truncate text-xs text-[var(--text-muted)]">{r.sub}</span>
            </span>
          </button>
        ))}
        {peopleList.map((u) => (
          <button key={u.id} type="button" disabled={busy !== null} onClick={() => void toPerson(u.id)} className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none disabled:opacity-60">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center">{busy === u.id ? <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" /> : <UserAvatar user={u} size={24} />}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--text)]">{u.username}</span>
              <span className="block truncate text-xs text-[var(--text-muted)]">Start a conversation</span>
            </span>
          </button>
        ))}
        {rooms.length === 0 && peopleList.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">
            {term.length >= 2 ? "No conversations or people match." : "No conversations yet. Search for a person by name."}
          </p>
        )}
      </div>
      <p className="mt-3 text-xs text-[var(--text-muted)]">It opens ready to send; nothing goes until you press Send.</p>
    </Sheet>
  );
}
