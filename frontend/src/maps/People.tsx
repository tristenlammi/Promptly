import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clock, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { apiClient } from "@/api/client";
import { PersonInput } from "@/items/ui/PersonInput";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { Choice } from "./ui";

export interface LivePerson {
  user_id: string;
  name: string;
  /** Sharing the trip they're driving, not their location in general: it ends when they arrive. */
  trip?: boolean;
  live: { lat: number; lon: number; destination: string | null; eta: string | null; at: string } | null;
}

interface Shares {
  sharing_with: { user_id: string; name: string; expires_at: string | null; trip?: boolean }[];
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
export function PeoplePanel({ onClose, onShow, show }: { onClose: () => void; onShow: (p: LivePerson) => void; show?: string | null }) {
  const qc = useQueryClient();
  const { data } = useShares();
  // Opened from "… is sharing a trip with you": straight to them on the map, once they've a position.
  const shown = useRef(false);
  const wanted = show ? data?.shared_with_me.find((p) => p.user_id === show && p.live) : undefined;
  useEffect(() => {
    if (!wanted || shown.current) return;
    shown.current = true;
    onShow(wanted);
  }, [wanted, onShow]);
  const [name, setName] = useState("");
  // Who was picked from the suggestions; typing again clears it.
  const [picked, setPicked] = useState("");
  const [hours, setHours] = useState("1");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["maps-shares"] });

  const share = async () => {
    try {
      await apiClient.put("/maps/share", { username: picked || name.trim(), hours: hours ? Number(hours) : null });
      setName("");
      setPicked("");
      refresh();
      toast.success("Sharing your location. Your phone sends it while P Maps is driving or the timeline is on.");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't share with them."));
    }
  };

  // Stopping is done straight away (it's your privacy): Undo shares again for the time that was left.
  const stop = async (p: Shares["sharing_with"][number]) => {
    try {
      await apiClient.delete(`/maps/share/${p.user_id}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, `Couldn't stop sharing with ${p.name}. They can still see where you are: try again.`));
      return;
    }
    refresh();
    const left = p.expires_at ? (new Date(p.expires_at).getTime() - Date.now()) / 3_600_000 : null;
    toast.success(`Stopped sharing with ${p.name}`, {
      action: {
        label: "Undo",
        onClick: () => {
          if (left !== null && left <= 0) return;
          apiClient
            .put("/maps/share", { username: p.name, hours: left === null ? null : Math.max(1, Math.round(left)) })
            .then(refresh)
            .catch((e) => toast.error(apiErrorMessage(e, `Couldn't share with ${p.name} again.`)));
        },
      },
    });
  };

  return (
    <div className="pb-4">
      <div className="flex items-center gap-2 px-3 pt-3">
        <button type="button" onClick={onClose} aria-label="Back" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-8 md:w-8">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-base font-semibold text-[var(--text)]">Live location</h1>
      </div>

      {(data?.shared_with_me.length ?? 0) > 0 && <h2 className="px-4 pb-1 pt-3 text-xs font-medium text-[var(--text-muted)]">Sharing with you</h2>}
      {data?.shared_with_me.map((p) => (
        <button key={p.user_id} type="button" disabled={!p.live} onClick={() => onShow(p)} className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left enabled:hover:bg-[var(--hover)]">
          <User className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="min-w-0">
            <span className="block truncate text-sm text-[var(--text)]">{p.name}</span>
            <span className="block truncate text-xs text-[var(--text-muted)]">
              {p.trip ? "Sharing this trip · " : ""}
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
            <span className="block text-xs text-[var(--text-muted)]">{p.trip ? "This trip, until you arrive or end it" : p.expires_at ? `Until ${new Date(p.expires_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Until you stop"}</span>
          </span>
          <button type="button" onClick={() => void stop(p)} aria-label={`Stop sharing with ${p.name}`} title="Stop sharing" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-8 md:w-8"><X className="h-4 w-4" /></button>
        </div>
      ))}

      <form
        className="flex flex-wrap gap-2 px-4 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void share();
        }}
      >
        <div className="w-full">
          <PersonInput
            value={name}
            accountsOnly
            inlineList
            onChange={(v) => {
              setName(v);
              setPicked("");
            }}
            onPick={(p) => setPicked(p.username)}
            placeholder="Name, username or email"
            aria-label="Who to share with"
          />
        </div>
        <div className="w-full">
          <p className="mb-1 text-xs text-[var(--text-muted)]">For how long</p>
          <Choice
            label="For how long"
            value={hours}
            onChange={setHours}
            options={[
              { value: "1", label: "1 hour" },
              { value: "8", label: "8 hours" },
              { value: "24", label: "1 day" },
              { value: "", label: "Until I stop" },
            ]}
          />
        </div>
        <button type="submit" disabled={!name.trim()} className="h-10 rounded-lg bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 md:h-9">Share</button>
      </form>
    </div>
  );
}
