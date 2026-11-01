import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { roomsApi, type RoomUser } from "@/api/rooms";
import { cn } from "@/utils/cn";

import { UserAvatar } from "./ui";

/** Search everyone on this Promptly and tick one or more people. */
export function PeoplePicker({
  selected,
  onChange,
  exclude = [],
  single,
}: {
  selected: RoomUser[];
  onChange: (next: RoomUser[]) => void;
  exclude?: string[];
  single?: boolean;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 200);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["rooms", "people", debounced],
    queryFn: () => roomsApi.people(debounced),
    staleTime: 60_000,
  });
  const people = (data ?? []).filter((u) => !exclude.includes(u.id));
  const isSel = (id: string) => selected.some((u) => u.id === id);
  const toggle = (u: RoomUser) => {
    if (single) onChange(isSel(u.id) ? [] : [u]);
    else onChange(isSel(u.id) ? selected.filter((x) => x.id !== u.id) : [...selected, u]);
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex h-11 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 focus-within:border-[var(--item-accent)] md:h-10">
        <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people"
          aria-label="Search people"
          className="h-full min-w-0 flex-1 bg-transparent text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] md:text-sm"
        />
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />}
      </label>
      {selected.length > 0 && !single && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => toggle(u)}
              aria-label={`Remove ${u.username}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] pl-1 pr-3 text-xs font-medium text-[var(--text)]"
            >
              <UserAvatar user={u} size={22} />
              {u.username} ×
            </button>
          ))}
        </div>
      )}
      <ul className="flex max-h-[45dvh] flex-col overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]" aria-label="People">
        {isError && <li className="p-4 text-center text-sm text-[var(--danger)]">Couldn't load people.</li>}
        {!isLoading && !isError && people.length === 0 && (
          <li className="p-4 text-center text-sm text-[var(--text-muted)]">{debounced ? "Nobody by that name." : "Nobody else here yet."}</li>
        )}
        {people.map((u) => {
          const on = isSel(u.id);
          return (
            <li key={u.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(u)}
                className="flex h-12 w-full items-center gap-2.5 px-3 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
              >
                <UserAvatar user={u} size={32} />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{u.username}</span>
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full border",
                    on ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[var(--border)]",
                  )}
                >
                  {on && <Check className="h-3.5 w-3.5" />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
