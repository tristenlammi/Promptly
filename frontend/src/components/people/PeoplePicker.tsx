import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { peopleHubApi, type PickerPerson } from "@/api/peopleHub";
import type { RoomUser } from "@/api/rooms";
import { UserAvatar } from "@/rooms/components/ui";
import { cn } from "@/utils/cn";

const ACCENT = "var(--item-accent, var(--accent))";

/** Their face from your Photos when there is one, else their account picture. */
export function PersonAvatar({ person, size = 32 }: { person: Pick<PickerPerson, "face" | "user" | "name">; size?: number }) {
  if (person.face) {
    return <img src={person.face} alt="" aria-hidden className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return <UserAvatar user={person.user ?? { id: "", username: person.name, avatar_url: null, color: "#8A8F98" }} size={size} />;
}

/**
 * The one people picker: everyone on this Promptly, plus your Contacts (with
 * their account when they're on here) and the people in your Photos, with
 * what they are to you ("Bea · Wife"). Suggestions first; arrow keys + Enter
 * on a keyboard, big rows on a phone. Picks Promptly accounts — contacts who
 * aren't on Promptly show greyed out so you know why they can't be added.
 */
export function PeoplePicker({
  selected,
  onChange,
  exclude = [],
  single,
  autoFocus,
}: {
  selected: RoomUser[];
  onChange: (next: RoomUser[]) => void;
  exclude?: string[];
  single?: boolean;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  // Friendly names for the chips ("Bea" rather than "bea_smith").
  const names = useRef<Record<string, string>>({});
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 200);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["people-hub", "search", debounced],
    queryFn: () => peopleHubApi.search(debounced),
    staleTime: 60_000,
  });
  const people = (data ?? []).filter((p) => !p.user || !exclude.includes(p.user.id));
  for (const p of people) if (p.user) names.current[p.user.id] = p.name;
  useEffect(() => setActive(0), [debounced]);

  const isSel = (id: string) => selected.some((u) => u.id === id);
  const toggle = (u: RoomUser) => {
    if (single) onChange(isSel(u.id) ? [] : [u]);
    else onChange(isSel(u.id) ? selected.filter((x) => x.id !== u.id) : [...selected, u]);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!people.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (active + (e.key === "ArrowDown" ? 1 : -1) + people.length) % people.length;
      setActive(next);
      listRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const p = people[active];
      if (p?.user) {
        e.preventDefault();
        toggle(p.user);
      }
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex h-11 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 focus-within:border-[var(--item-accent,var(--accent))] md:h-10">
        <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          autoFocus={autoFocus}
          placeholder="Search people or contacts"
          aria-label="Search people"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={people[active] ? `${listId}-${active}` : undefined}
          className="h-full min-w-0 flex-1 bg-transparent text-base text-[var(--text)] !outline-none placeholder:text-[var(--text-muted)] md:text-sm"
        />
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />}
      </label>
      {selected.length > 0 && !single && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((u) => {
            const label = names.current[u.id] ?? u.username;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => toggle(u)}
                aria-label={`Remove ${label}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-full pl-1 pr-3 text-xs font-medium text-[var(--text)]"
                style={{ background: `color-mix(in srgb, ${ACCENT} 14%, transparent)` }}
              >
                <UserAvatar user={u} size={22} />
                {label} ×
              </button>
            );
          })}
        </div>
      )}
      {!debounced && people.length > 0 && <p className="px-1 text-xs font-medium text-[var(--text-muted)]">Suggested</p>}
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-multiselectable={!single}
        aria-label="People"
        className="flex max-h-[45dvh] flex-col overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
      >
        {isError && <li className="p-4 text-center text-sm text-[var(--danger)]">Couldn't load people.</li>}
        {!isLoading && !isError && people.length === 0 && (
          <li className="p-4 text-center text-sm text-[var(--text-muted)]">
            {debounced ? (debounced.length < 2 ? "Keep typing…" : "Nobody by that name.") : "Search for someone by name."}
          </li>
        )}
        {people.map((p, i) => {
          const u = p.user;
          const on = !!u && isSel(u.id);
          const sub = !u ? "Not on Promptly" : p.name !== u.username ? `@${u.username}` : null;
          return (
            <li key={p.key} id={`${listId}-${i}`} role="option" aria-selected={on} aria-disabled={!u} data-idx={i}>
              <button
                type="button"
                disabled={!u}
                tabIndex={-1}
                onClick={() => u && toggle(u)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex min-h-12 w-full items-center gap-2.5 px-3 py-1.5 text-left focus-visible:outline-none",
                  u ? "hover:bg-[var(--hover)]" : "cursor-default opacity-60",
                  i === active && u && "bg-[var(--hover)]",
                )}
              >
                <PersonAvatar person={p} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--text)]">
                    {p.name}
                    {p.label && <span className="text-[var(--text-muted)]"> · {p.label}</span>}
                  </span>
                  {sub && <span className="block truncate text-xs text-[var(--text-muted)]">{sub}</span>}
                </span>
                {u && (
                  <span
                    className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", on ? "text-white" : "border-[var(--border)]")}
                    style={on ? { borderColor: ACCENT, background: ACCENT } : undefined}
                  >
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
