import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clock, Smartphone, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { apiClient } from "@/api/client";
import { PersonInput } from "@/items/ui/PersonInput";
import { isAndroidDevice } from "@/lib/installPrompt";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { ageNow, liveState, seenWords, sharingWords, type LiveState, type MySharing } from "./freshness";
import { openPhoneTracking } from "./Timeline";
import { Choice } from "./ui";

export interface LivePerson {
  user_id: string;
  name: string;
  /** Sharing the trip they're driving, not their location in general: it ends when they arrive. */
  trip?: boolean;
  /** `age_s`: how old the position is by the server's clock; `state`: fresh, late or stale. */
  live: { lat: number; lon: number; destination: string | null; eta: string | null; at: string; age_s?: number; state?: LiveState } | null;
}

interface Shares {
  sharing_with: { user_id: string; name: string; expires_at: string | null; trip?: boolean }[];
  shared_with_me: LivePerson[];
  /** While you're sharing: whether your phone is actually sending. */
  me?: MySharing | null;
}

export function useShares() {
  return useQuery({
    queryKey: ["maps-shares"],
    queryFn: async () => (await apiClient.get<Shares>("/maps/share")).data,
    refetchInterval: 30_000,
  });
}

/** How old a position is right now: the server's count when it was fetched, plus the time since. */
export function liveAge(live: NonNullable<LivePerson["live"]>, fetchedAt: number): number {
  const fromServer = live.age_s ?? Math.max(0, Math.round((fetchedAt - new Date(live.at).getTime()) / 1000));
  return ageNow(fromServer, fetchedAt) ?? 0;
}

/** While you're sharing: is your phone really sending? Plain words either way, and a
 *  way to start it when it isn't. */
function MyPhone({ me, fetchedAt }: { me: MySharing; fetchedAt: number }) {
  const said = sharingWords(me, new Date(), ageNow(me.age_s, fetchedAt));
  const open = async () => {
    try {
      await openPhoneTracking();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't open the app."));
    }
  };
  if (!said.bad) return <p className="px-4 pb-1 text-xs text-[var(--text-muted)]">{said.text}</p>;
  return (
    <div role="status" className="mx-4 mb-1 rounded-lg border border-[var(--border)] bg-[var(--hover)] px-3 py-2.5">
      <p className="flex gap-2 text-sm text-[var(--text)]">
        <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" />
        <span>{said.text}</span>
      </p>
      {isAndroidDevice() && (
        <button type="button" onClick={() => void open()} className="mt-2 h-10 rounded-lg bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 md:h-9">
          Open Promptly on this phone
        </button>
      )}
    </div>
  );
}

/** Who can see where you are, and who you can see. */
export function PeoplePanel({ onClose, onShow, show }: { onClose: () => void; onShow: (p: LivePerson) => void; show?: string | null }) {
  const qc = useQueryClient();
  const { data, dataUpdatedAt } = useShares();
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
      toast.success("Sharing your location. Your phone sends where you are every couple of minutes; this page says if it hasn't started.");
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
      {data?.shared_with_me.map((p) => {
        const age = p.live ? liveAge(p.live, dataUpdatedAt) : null;
        const state = liveState(age);
        // A position that stopped coming is shown as that, not as where they are.
        const old = state === "stale";
        return (
          <button key={p.user_id} type="button" disabled={!p.live} onClick={() => onShow(p)} className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left enabled:hover:bg-[var(--hover)]">
            <User className={`h-4 w-4 text-[var(--text-muted)] ${old ? "opacity-50" : ""}`} />
            <span className="min-w-0">
              <span className={`block truncate text-sm ${old ? "text-[var(--text-muted)]" : "text-[var(--text)]"}`}>{p.name}</span>
              <span className={`block text-xs ${state === "late" || old ? "font-medium text-[var(--text)]" : "truncate text-[var(--text-muted)]"}`} data-live-state={state}>
                {p.trip ? "Sharing this trip · " : ""}
                {p.live ? `${seenWords(age, p.live.at)}${!old && p.live.destination ? ` · going to ${p.live.destination}` : ""}${!old && p.live.eta ? `, arriving ${new Date(p.live.eta).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}` : "No location yet: their phone hasn't sent one"}
              </span>
            </span>
          </button>
        );
      })}

      <h2 className="px-4 pb-1 pt-3 text-xs font-medium text-[var(--text-muted)]">You're sharing with</h2>
      {data?.sharing_with.length === 0 && <p className="px-4 text-sm text-[var(--text-muted)]">Nobody. Your location stays with you.</p>}
      {data?.me && data.sharing_with.length > 0 && <MyPhone me={data.me} fetchedAt={dataUpdatedAt} />}
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
