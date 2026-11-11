import { Loader2, LogOut, UserMinus } from "lucide-react";
import { useEffect, useState } from "react";

import type { RoomUser } from "@/api/rooms";
import { PeoplePicker } from "@/components/people/PeoplePicker";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { toast } from "@/store/toastStore";

import { leaveNote, loadMembers, ShareError, shareNote, unshareNote, useNotes } from "../store";
import { displayTitle, type Note, type NoteUser } from "../types";
import { Sheet } from "./Sheet";

const names = (us: { username: string }[]) =>
  us.length <= 2 ? us.map((u) => u.username).join(" and ") : `${us.slice(0, -1).map((u) => u.username).join(", ")} and ${us[us.length - 1].username}`;

/**
 * Who a note is shared with. The owner adds people on this server (the one
 * people picker) and can take anyone off; everyone else sees who's on it and
 * can Leave. There are no links: only the people added can see the note,
 * and they can all edit it.
 */
export function ShareDialog({ note, onClose, onLeft }: { note: Note; onClose: () => void; onLeft?: () => void }) {
  const me = useNotes((s) => s.uid);
  const users = useNotes((s) => s.users);
  const [picked, setPicked] = useState<RoomUser[]>([]);
  const [busy, setBusy] = useState<null | "share" | "leave" | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  // Leave asks first, right here (a dialog over this one would sit under it).
  const [asking, setAsking] = useState(false);
  const owner = note.is_owner;
  const title = displayTitle(note);

  useEffect(() => {
    let live = true;
    void loadMembers(note.id).finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [note.id]);

  const user = (id: string): NoteUser => users[id] ?? { id, username: "Someone" };
  const memberIds = note.member_ids ?? [];
  const everyone = [note.owner_id, ...memberIds];

  const share = async () => {
    if (!picked.length) return;
    setBusy("share");
    setError(null);
    try {
      await shareNote(
        note.id,
        picked.map((u) => u.id),
      );
      toast.success(`Shared with ${names(picked)}`);
      setPicked([]);
      onClose();
    } catch (e) {
      setError(e instanceof ShareError ? e.message : "Couldn't share this note. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (uid: string) => {
    const who = user(uid).username;
    setBusy(uid);
    setError(null);
    try {
      await unshareNote(note.id, uid);
      toast.info(`${who} no longer has this note`);
    } catch (e) {
      setError(e instanceof ShareError ? e.message : `Couldn't remove ${who}. Try again.`);
    } finally {
      setBusy(null);
    }
  };

  const leave = async () => {
    setBusy("leave");
    setError(null);
    try {
      await leaveNote(note.id);
      toast.info(`You left “${title}”`);
      onClose();
      onLeft?.();
    } catch (e) {
      setError(e instanceof ShareError ? e.message : "Couldn't leave this note. Try again.");
      setBusy(null);
    }
  };

  const footer = owner ? (
    <>
      <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-sm font-medium hover:bg-[var(--hover)]">
        {picked.length ? "Cancel" : "Done"}
      </button>
      <button
        type="button"
        onClick={() => void share()}
        disabled={!picked.length || busy === "share"}
        className="flex h-10 items-center gap-2 rounded-full bg-[var(--accent-strong)] px-5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy === "share" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Share
      </button>
    </>
  ) : asking ? (
    <div className="flex w-full flex-wrap items-center justify-end gap-2" role="group" aria-label="Leave this note?">
      <p className="mr-auto min-w-0 text-sm">
        Leave “{title}”? It goes from your notes; {user(note.owner_id).username} keeps it.
      </p>
      <button type="button" data-autofocus onClick={() => setAsking(false)} className="h-10 rounded-full px-4 text-sm font-medium hover:bg-[var(--hover)]">
        Cancel
      </button>
      <button
        type="button"
        onClick={() => void leave()}
        disabled={busy === "leave"}
        className="flex h-10 items-center gap-2 rounded-full bg-[var(--danger)] px-5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy === "leave" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Leave note
      </button>
    </div>
  ) : (
    <>
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="mr-auto flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium text-[var(--danger)] hover:bg-[var(--hover)]"
      >
        <LogOut className="h-4 w-4" aria-hidden /> Leave
      </button>
      <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-sm font-medium hover:bg-[var(--hover)]">
        Done
      </button>
    </>
  );

  return (
    <Sheet title={owner ? "Share" : "People on this note"} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--text-muted)]">
          {owner
            ? "Only the people you add can see this note. They can edit it too, and leave it whenever they like."
            : `Only the people ${user(note.owner_id).username} added can see this note. Everyone on it can edit it.`}
        </p>
        <ul aria-label="People on this note" className="flex flex-col gap-1">
          {everyone.map((uid) => {
            const u = user(uid);
            const isOwner = uid === note.owner_id;
            const you = uid === me;
            return (
              <li key={uid} className="flex min-h-12 items-center gap-3 rounded-xl px-1">
                <UserAvatar name={u.username} userId={uid} avatarUrl={u.avatar_url} color={u.color} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {u.username}
                    {you && <span className="text-[var(--text-muted)]"> (you)</span>}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)]">{isOwner ? "Owner" : "Can edit"}</span>
                </span>
                {owner && !isOwner && (
                  <button
                    type="button"
                    onClick={() => void remove(uid)}
                    disabled={busy === uid}
                    aria-label={`Remove ${u.username}`}
                    title={`Remove ${u.username}`}
                    className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)] disabled:opacity-50"
                  >
                    {busy === uid ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserMinus className="h-4 w-4" />}
                  </button>
                )}
              </li>
            );
          })}
          {checking && !memberIds.length && (
            <li className="flex items-center gap-2 px-1 text-xs text-[var(--text-muted)]" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking who has it…
            </li>
          )}
        </ul>
        {owner && (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Add people</h3>
            <PeoplePicker
              selected={picked}
              exclude={everyone}
              onChange={(next) => {
                setPicked(next);
                setError(null);
              }}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
