import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clock, User, X } from "lucide-react";
import { useState } from "react";

import { apiClient } from "@/api/client";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

export interface LivePerson {
  user_id: string;
  name: string;
  live: { lat: number; lon: number; destination: string | null; eta: string | null; at: string } | null;
}

interface Shares {
  sharing_with: { user_id: string; name: string; expires_at: string | null }[];
  shared_with_me: LivePerson[];
}

export function useShares() {
  return useQuery({
    queryKey: ["maps-shares"],
    queryFn: async () => (await apiClient.get<Shares>("/maps/share")).data,
    refetchInterval: 30_000,
  });
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Who can see where you are, and who you can see. */
export function PeoplePanel({ onClose, onShow }: { onClose: () => void; onShow: (p: LivePerson) => void }) {
  const qc = useQueryClient();
  const { data } = useShares();
  const [name, setName] = useState("");
  const [hours, setHours] = useState("1");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["maps-shares"] });

  const share = async () => {
    try {
      await apiClient.put("/maps/share", { username: name.trim(), hours: hours ? Number(hours) : null });
      setName("");
      refresh();
      toast.success("Sharing your location. Your phone sends it while P Maps is driving or the timeline is on.");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't share with them."));
    }
  };

  const stop = async (id: string) => {
    await apiClient.delete(`/maps/share/${id}`);
    refresh();
  };

  return (
    <div className="pb-4">
      <div className="flex items-center gap-2 px-3 pt-3">
        <button type="button" onClick={onClose} aria-label="Back" className="rounded-full p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-base font-semibold text-[var(--text)]">Live location</h1>
      </div>

      {(data?.shared_with_me.length ?? 0) > 0 && <h2 className="px-4 pb-1 pt-3 text-xs font-medium text-[var(--text-muted)]">Sharing with you</h2>}
      {data?.shared_with_me.map((p) => (
        <button key={p.user_id} type="button" disabled={!p.live} onClick={() => onShow(p)} className="flex w-full items-center gap-3 px-4 py-2 text-left enabled:hover:bg-[var(--hover)]">
          <User className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="min-w-0">
            <span className="block truncate text-sm text-[var(--text)]">{p.name}</span>
            <span className="block truncate text-xs text-[var(--text-muted)]">
              {p.live ? `${ago(p.live.at)}${p.live.destination ? ` · going to ${p.live.destination}` : ""}${p.live.eta ? `, arriving ${new Date(p.live.eta).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}` : "No location yet"}
            </span>
          </span>
        </button>
      ))}

      <h2 className="px-4 pb-1 pt-3 text-xs font-medium text-[var(--text-muted)]">You're sharing with</h2>
      {data?.sharing_with.length === 0 && <p className="px-4 text-sm text-[var(--text-muted)]">Nobody. Your location stays with you.</p>}
      {data?.sharing_with.map((p) => (
        <div key={p.user_id} className="flex items-center gap-3 px-4 py-2">
          <Clock className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-[var(--text)]">{p.name}</span>
            <span className="block text-xs text-[var(--text-muted)]">{p.expires_at ? `Until ${new Date(p.expires_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Until you stop"}</span>
          </span>
          <button type="button" onClick={() => void stop(p.user_id)} aria-label={`Stop sharing with ${p.name}`} className="rounded-full p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)]"><X className="h-4 w-4" /></button>
        </div>
      ))}

      <form
        className="flex flex-wrap gap-2 px-4 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void share();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their username or email" aria-label="Who to share with" className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--text)] outline-none" />
        <select value={hours} onChange={(e) => setHours(e.target.value)} aria-label="For how long" className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]">
          <option value="1">1 hour</option>
          <option value="8">8 hours</option>
          <option value="24">1 day</option>
          <option value="">Until I stop</option>
        </select>
        <button type="submit" className="h-9 rounded-lg bg-[var(--accent)] px-3 text-sm font-medium text-white hover:opacity-90">Share</button>
      </form>
    </div>
  );
}
