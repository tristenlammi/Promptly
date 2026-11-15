import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { homeApi, type Home, type HomeBox } from "@/api/home";
import { Sheet } from "@/components/shared/Sheet";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Looking after a home: its name, who's in it (only Promptly users who are
 * members see or control it; there are no guests), its box, and the brands
 * and bridges that have been added. The owner runs it; a member can leave.
 */

const btn =
  "inline-flex h-10 items-center justify-center rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const strong =
  "inline-flex h-10 items-center justify-center rounded-xl bg-[var(--accent-strong)] px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
const field =
  "h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const heading = "mb-2 text-sm font-semibold text-[var(--text)]";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hours ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function HomeSettingsSheet({ open, home, onClose, onAddBox, onLeft }: { open: boolean; home: Home; onClose: () => void; onAddBox: () => void; onLeft: () => void }) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user?.id);
  const owner = home.role === "owner";
  const [name, setName] = useState(home.name);
  const [who, setWho] = useState("");
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(home.name);
      setWho("");
      setCode(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, home.id]);
  const again = () => void qc.invalidateQueries({ queryKey: ["home", "homes"] });
  const oops = (fallback: string) => (e: unknown) => toast.error(apiErrorMessage(e, fallback));

  const rename = useMutation({ mutationFn: () => homeApi.rename(home.id, name.trim()), onSuccess: again, onError: oops("Couldn't rename it.") });
  const add = useMutation({ mutationFn: () => homeApi.addMember(home.id, who.trim()), onSuccess: () => { setWho(""); again(); }, onError: oops("Couldn't add them.") });
  const remove = useMutation({ mutationFn: (id: string) => homeApi.removeMember(home.id, id), onSuccess: again, onError: oops("Couldn't do that.") });
  const leave = useMutation({ mutationFn: () => homeApi.removeMember(home.id, me ?? ""), onSuccess: () => { again(); onLeft(); }, onError: oops("Couldn't leave.") });
  const release = useMutation({ mutationFn: (boxId: string) => homeApi.releaseBox(home.id, boxId), onSuccess: (c) => { setCode(c); again(); }, onError: oops("Couldn't release it.") });

  return (
    <Sheet open={open} onClose={onClose} title="Home settings" size="md" footer={<button type="button" className={cn(btn, "w-full")} onClick={onClose}>Close</button>}>
      <div className="flex flex-col gap-6">
        <section aria-label="Name">
          <h3 className={heading}>Name</h3>
          {owner ? (
            <div className="flex gap-2">
              <input className={field} value={name} maxLength={80} aria-label="Home's name" onChange={(e) => setName(e.target.value)} />
              <button type="button" className={strong} disabled={rename.isPending || !name.trim() || name.trim() === home.name} onClick={() => rename.mutate()}>Save</button>
            </div>
          ) : (
            <p className="text-sm text-[var(--text)]">{home.name}</p>
          )}
        </section>

        <section aria-label="People">
          <h3 className={heading}>People in this home</h3>
          <p className="mb-2 text-xs text-[var(--text-muted)]">Only the people here can see and control this home's devices. Nobody else on this Promptly can, admins included.</p>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {home.members.map((m) => (
              <li key={m.id} className="flex min-h-11 items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--text)]">{m.name}{m.id === me ? " (you)" : ""}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{m.role === "owner" ? "Owner" : "Member"}</span>
                </span>
                {owner && m.role !== "owner" && (
                  <button type="button" className={btn} disabled={remove.isPending} onClick={() => { if (window.confirm(`Take ${m.name} out of ${home.name}?`)) remove.mutate(m.id); }}>Remove</button>
                )}
              </li>
            ))}
          </ul>
          {owner ? (
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (who.trim()) add.mutate(); }}>
              <input className={field} value={who} maxLength={64} placeholder="Their Promptly username" aria-label="Username to add" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setWho(e.target.value)} />
              <button type="submit" className={strong} disabled={add.isPending || !who.trim()}>Add</button>
            </form>
          ) : (
            <button type="button" className={cn(btn, "mt-3")} disabled={leave.isPending} onClick={() => { if (window.confirm(`Leave ${home.name}? You won't see its devices any more.`)) leave.mutate(); }}>Leave this home</button>
          )}
        </section>

        <section aria-label="Home box">
          <h3 className={heading}>Home box</h3>
          {home.boxes.length === 0 && <p className="text-sm text-[var(--text-muted)]">This home has no box.</p>}
          <ul className="flex flex-col gap-3">
            {home.boxes.map((b) => <BoxRow key={b.id} home={home} box={b} owner={owner} busy={release.isPending} onRelease={() => release.mutate(b.id)} />)}
          </ul>
          {code && (
            <div role="status" className="mt-3 rounded-xl border border-[var(--warning)]/60 p-3">
              <p className="text-sm font-medium text-[var(--text)]">The box is out of this home.</p>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Whoever has it next adds it with this code. It's shown this once:</p>
              <code className="mt-2 block select-all rounded-lg bg-[var(--hover)] px-3 py-2 text-center font-mono text-lg tracking-widest text-[var(--text)]">{code}</code>
            </div>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-[var(--text-muted)]">Have a separate home box with a code?</summary>
            <button type="button" className={cn(btn, "mt-2")} onClick={onAddBox}>Add a box with its code</button>
          </details>
        </section>
      </div>
    </Sheet>
  );
}

function BoxRow({ home, box, owner, busy, onRelease }: { home: Home; box: HomeBox; owner: boolean; busy: boolean; onRelease: () => void }) {
  const qc = useQueryClient();
  const connected = useQuery({ queryKey: ["home", "connected", home.id, box.id], queryFn: () => homeApi.connected(home.id, box.id), enabled: box.online });
  const drop = useMutation({
    mutationFn: (id: string) => homeApi.disconnect(home.id, box.id, id),
    onSuccess: () => {
      void connected.refetch();
      void qc.invalidateQueries({ queryKey: ["home", "homes"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't remove that.")),
  });
  return (
    <li className="rounded-xl border border-[var(--border)] p-3">
      <div className="flex items-center gap-3">
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", box.online ? "bg-[var(--success)]" : "bg-[var(--border)]")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--text)]">{box.name}</span>
          <span className="block text-xs text-[var(--text-muted)]">
            {box.builtin ? "Part of this Promptly · " : ""}
            {box.online ? (box.ready ? "Online" : "Starting up") : box.builtin && !box.last_seen_at ? "Starting up" : `Offline · last seen ${ago(box.last_seen_at)}`}
            {box.version ? ` · version ${box.version}` : ""}
          </span>
        </span>
        {owner && !box.builtin && (
          <button type="button" className={btn} disabled={busy} onClick={() => { if (window.confirm("Take this box out of your home? Its devices will go from your Home page, and you'll get a code for whoever has it next.")) onRelease(); }}>
            Move or give away
          </button>
        )}
      </div>
      {box.online && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <p className="mb-1 text-xs font-medium text-[var(--text-muted)]">Brands and bridges added</p>
          {connected.isLoading && <p className="text-sm text-[var(--text-muted)]">Looking…</p>}
          {connected.data && connected.data.length === 0 && <p className="text-sm text-[var(--text-muted)]">None yet. Use "Add a device" on your Home page.</p>}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {connected.data?.map((c) => (
              <li key={c.id} className="flex min-h-11 items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--text)]">{c.title || c.brand_name}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">{c.brand_name}{c.state && c.state !== "loaded" ? " · not working right now" : ""}</span>
                </span>
                <button type="button" className={btn} disabled={drop.isPending} onClick={() => { if (window.confirm(`Remove ${c.title || c.brand_name}? The devices it brought go with it.`)) drop.mutate(c.id); }}>Remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
