import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { homeApi, type Home, type HomeRole } from "@/api/home";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { leavingChoices, ROLE_WORDS, whoRuns } from "./roles";

/**
 * Who's in a home, and who runs it.
 *
 * Members use the home. The owner, and the co-owners the owner picks, set it
 * up (devices, rooms, music, who's in it). Choosing co-owners, passing the
 * home on and deleting it are the owner's alone, so a home always has one
 * owner: an owner who wants out passes it to someone here or deletes it.
 */

const btn =
  "inline-flex h-10 items-center justify-center rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const strong =
  "inline-flex h-10 items-center justify-center rounded-xl bg-[var(--accent-strong)] px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
const danger =
  "inline-flex h-10 items-center justify-center rounded-xl border border-[var(--danger)]/60 px-3 text-sm font-medium text-[var(--danger)] transition hover:bg-[var(--danger)]/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)]";
const field =
  "h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const heading = "mb-2 text-sm font-semibold text-[var(--text)]";

export function PeopleSection({ open, home, onLeft }: { open: boolean; home: Home; onLeft: () => void }) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user?.id) ?? "";
  const owner = home.role === "owner";
  const runs = home.can_manage;
  const [who, setWho] = useState("");
  const [going, setGoing] = useState(false);
  useEffect(() => {
    if (open) {
      setWho("");
      setGoing(false);
    }
  }, [open, home.id]);
  const again = () => void qc.invalidateQueries({ queryKey: ["home", "homes"] });
  const oops = (fallback: string) => (e: unknown) => toast.error(apiErrorMessage(e, fallback));

  const add = useMutation({ mutationFn: () => homeApi.addMember(home.id, who.trim()), onSuccess: () => { setWho(""); again(); }, onError: oops("Couldn't add them.") });
  const remove = useMutation({ mutationFn: (id: string) => homeApi.removeMember(home.id, id), onSuccess: again, onError: oops("Couldn't do that.") });
  const role = useMutation({ mutationFn: (v: { id: string; role: Exclude<HomeRole, "owner"> }) => homeApi.setRole(home.id, v.id, v.role), onSuccess: again, onError: oops("Couldn't change that.") });
  const leave = useMutation({ mutationFn: () => homeApi.removeMember(home.id, me), onSuccess: () => { again(); onLeft(); }, onError: oops("Couldn't leave.") });

  return (
    <section aria-label="People">
      <h3 className={heading}>People in this home</h3>
      <p className="mb-2 text-xs text-[var(--text-muted)]">Only the people here can see and control this home's devices. Nobody else on this Promptly can, admins included.</p>
      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {home.members.map((m) => {
          // The owner removes anyone; a co-owner removes members.
          const canRemove = m.id !== me && m.role !== "owner" && (owner || (runs && m.role === "member"));
          return (
            <li key={m.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--text)]">{m.name}{m.id === me ? " (you)" : ""}</span>
                <span className="block text-xs text-[var(--text-muted)]">{ROLE_WORDS[m.role]}</span>
              </span>
              {owner && m.role !== "owner" && (
                <button
                  type="button"
                  className={btn}
                  disabled={role.isPending}
                  aria-label={m.role === "coowner" ? `Stop ${m.name} being a co-owner` : `Make ${m.name} a co-owner`}
                  onClick={() => role.mutate({ id: m.id, role: m.role === "coowner" ? "member" : "coowner" })}
                >
                  {m.role === "coowner" ? "Not a co-owner" : "Make co-owner"}
                </button>
              )}
              {canRemove && (
                <button type="button" className={btn} disabled={remove.isPending} aria-label={`Remove ${m.name}`} onClick={() => { if (window.confirm(`Take ${m.name} out of ${home.name}?`)) remove.mutate(m.id); }}>Remove</button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-[var(--text-muted)]">{whoRuns(home.role)}</p>
      {runs && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (who.trim()) add.mutate(); }}>
          <input className={field} value={who} maxLength={64} placeholder="Their Promptly username" aria-label="Username to add" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setWho(e.target.value)} />
          <button type="submit" className={strong} disabled={add.isPending || !who.trim()}>Add</button>
        </form>
      )}
      {!owner && (
        <button type="button" className={cn(btn, "mt-3")} disabled={leave.isPending} onClick={() => { if (window.confirm(`Leave ${home.name}? You won't see its devices any more.`)) leave.mutate(); }}>Leave this home</button>
      )}
      {owner && !going && (
        <button type="button" className={cn(btn, "mt-3")} onClick={() => setGoing(true)}>Leave or delete this home…</button>
      )}
      {owner && going && <OwnerLeaving home={home} me={me} onCancel={() => setGoing(false)} onLeft={() => { again(); onLeft(); }} />}
    </section>
  );
}

/** The owner going: pass the home to someone in it, or delete it. */
function OwnerLeaving({ home, me, onCancel, onLeft }: { home: Home; me: string; onCancel: () => void; onLeft: () => void }) {
  const others = leavingChoices(home.members, me);
  const [to, setTo] = useState(others[0]?.id ?? "");
  const [typed, setTyped] = useState("");
  const oops = (fallback: string) => (e: unknown) => toast.error(apiErrorMessage(e, fallback));
  const pass = useMutation({
    mutationFn: (leave: boolean) => homeApi.passOn(home.id, to, leave).then(() => leave),
    onSuccess: (left) => {
      const name = others.find((o) => o.id === to)?.name ?? "them";
      toast.success(left ? `${home.name} is ${name}'s now, and you've left it.` : `${home.name} is ${name}'s now. You're a co-owner.`);
      onLeft();
    },
    onError: oops("Couldn't pass it on."),
  });
  const wipe = useMutation({
    mutationFn: () => homeApi.deleteHome(home.id),
    onSuccess: (r) => {
      toast.success(r.waiting > 0 ? `${home.name} is deleted. Its box is offline, so it forgets its devices when it's next plugged in, before anyone sees them.` : `${home.name} is deleted, and its box has forgotten its devices.`);
      onLeft();
    },
    onError: oops("Couldn't delete it."),
  });
  const busy = pass.isPending || wipe.isPending;
  const sure = typed.trim().toLowerCase() === home.name.trim().toLowerCase();

  return (
    <div role="group" aria-label="Leave or delete this home" className="mt-3 flex flex-col gap-4 rounded-xl border border-[var(--border)] p-3">
      <p className="text-sm text-[var(--text)]">A home always has an owner. To go, pass it to someone here, or delete it.</p>
      {others.length > 0 ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
            Pass this home to
            <select className={field} value={to} onChange={(e) => setTo(e.target.value)}>
              {others.map((o) => <option key={o.id} value={o.id}>{o.name}{o.role === "coowner" ? " (co-owner)" : ""}</option>)}
            </select>
          </label>
          <p className="text-xs text-[var(--text-muted)]">Everything stays as it is: devices, rooms, music and everyone in it.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={strong} disabled={busy || !to} onClick={() => pass.mutate(true)}>Pass it on and leave</button>
            <button type="button" className={btn} disabled={busy || !to} onClick={() => pass.mutate(false)}>Pass it on, stay as co-owner</button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">You're the only one in this home, so there's nobody to pass it to. Add someone above first, or delete it.</p>
      )}
      <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
        <p className="text-sm font-medium text-[var(--text)]">Delete this home</p>
        <p className="text-xs text-[var(--text-muted)]">
          Everyone is taken out of it. Its box forgets the brands and bridges you added (and their devices and sign-ins), linked music and rooms.
          What can't be done from here: a bridge or device may still remember it was paired, so reset it yourself if you're giving it away.
          {home.boxes.some((b) => b.builtin) ? " The box that's part of this Promptly stays with the server, empty, for whoever sets Home up next." : ""}
        </p>
        <label className="flex flex-col gap-1.5 text-xs text-[var(--text-muted)]">
          Type the home's name ({home.name}) to delete it
          <input className={field} value={typed} maxLength={80} aria-label="Home's name, to delete it" onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={danger} disabled={busy || !sure} onClick={() => wipe.mutate()}>{wipe.isPending ? "Deleting…" : "Delete this home"}</button>
          <button type="button" className={btn} disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
