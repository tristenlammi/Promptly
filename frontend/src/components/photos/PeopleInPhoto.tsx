import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { Link } from "react-router-dom";

import { peopleApi, type Observation } from "@/api/people";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** Who's in this photo (PH-3): each face (when faces are on) and animal,
 *  with who it is — or "Who is this?". Yours only: nothing for anyone else. */
export function PeopleInPhoto({ fileId }: { fileId: string }) {
  const qc = useQueryClient();
  const key = ["photo-people", fileId];
  const { data } = useQuery({ queryKey: key, queryFn: () => peopleApi.inPhoto(fileId), retry: false });
  if (!data || data.length === 0) return null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["people"] });
  };
  return (
    <div className="mt-4 space-y-2 text-xs">
      <p className="font-medium">In this photo</p>
      <ul className="space-y-1.5" aria-label="People and pets in this photo">
        {data.map((o) => (
          <Who key={o.id} obs={o} onChange={refresh} />
        ))}
      </ul>
    </div>
  );
}

function Who({ obs, onChange }: { obs: Observation; onChange: () => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const { data: known } = useQuery({
    queryKey: ["people", obs.kind],
    queryFn: () => peopleApi.list(obs.kind),
    enabled: naming,
  });
  const listId = `names-${obs.id}`;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save that."));
    }
  };
  const label = obs.kind === "pet" ? (obs.species ?? "animal") : "face";
  return (
    <li className="flex items-center gap-2">
      {obs.crop ? (
        <img src={obs.crop} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" loading="lazy" />
      ) : (
        <span className="h-8 w-8 shrink-0 rounded-full bg-[var(--hover)]" />
      )}
      {naming ? (
        <form
          className="flex flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            void act(() => peopleApi.name(obs.id, { name: n })).then(() => setNaming(false));
          }}
        >
          <input
            autoFocus
            list={listId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={obs.kind === "pet" ? "Their name" : "Who is this?"}
            aria-label={`Name this ${label}`}
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1"
          />
          <datalist id={listId}>
            {(known ?? []).filter((p) => p.name).map((p) => (
              <option key={p.id} value={p.name!} />
            ))}
          </datalist>
          <button type="submit" aria-label="Save name" className="rounded p-1 hover:bg-[var(--hover)]">
            <Check className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Cancel" onClick={() => setNaming(false)} className="rounded p-1 hover:bg-[var(--hover)]">
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      ) : obs.person?.name ? (
        <span className="flex flex-1 items-center gap-1">
          <Link to={`/files/photos/people/${obs.person.id}`} className="font-medium text-[var(--accent-text)] hover:underline">
            {obs.person.name}
          </Link>
          {!obs.confirmed && (
            <>
              <button
                type="button"
                title={`Yes, that's ${obs.person.name}`}
                aria-label={`Yes, that's ${obs.person.name}`}
                onClick={() => void act(() => peopleApi.name(obs.id, { person_id: obs.person!.id }))}
                className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--hover)]"
              >
                <Check className="h-3 w-3" />
              </button>
              <button
                type="button"
                title={`Not ${obs.person.name}`}
                aria-label={`Not ${obs.person.name}`}
                onClick={() => void act(() => peopleApi.notThem(obs.id, obs.person!.id))}
                className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--hover)]"
              >
                <X className="h-3 w-3" />
              </button>
            </>
          )}
        </span>
      ) : (
        <button type="button" onClick={() => setNaming(true)} className="flex-1 text-left text-[var(--accent-text)] hover:underline">
          {obs.kind === "pet" ? `A ${obs.species ?? "pet"} — who is this?` : "Who is this?"}
        </button>
      )}
    </li>
  );
}
