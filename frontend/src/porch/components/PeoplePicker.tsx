import { useQuery } from "@tanstack/react-query";
import { Check, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { porchApi, type PorchUser, type Suggested } from "@/api/porch";
import { TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { PorchAvatar } from "./ui";

/**
 * Pick people who have Porch: type two or more letters, or tick someone
 * from ``suggested`` (your own People directory; nobody is ticked for you).
 */
export function PeoplePicker({
  value,
  onChange,
  suggested = [],
  exclude = [],
  label = "Invite people",
}: {
  value: PorchUser[];
  onChange: (v: PorchUser[]) => void;
  suggested?: Suggested[];
  exclude?: string[];
  label?: string;
}) {
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setTyped(q.trim()), 200);
    return () => window.clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: ["porch", "people", typed],
    queryFn: () => porchApi.people(typed),
    enabled: typed.length >= 2,
    staleTime: 30_000,
  });
  const chosen = useMemo(() => new Set(value.map((u) => u.id)), [value]);
  const skip = useMemo(() => new Set(exclude), [exclude]);
  const toggle = (u: PorchUser) => onChange(chosen.has(u.id) ? value.filter((x) => x.id !== u.id) : [...value, u]);
  const labelOf = new Map(suggested.map((s) => [s.user.id, s.label]));

  const rows: PorchUser[] =
    typed.length >= 2 ? (search.data ?? []).filter((u) => !skip.has(u.id)) : suggested.map((s) => s.user).filter((u) => !skip.has(u.id));

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Chosen">
          {value.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => toggle(u)}
                aria-label={`Remove ${u.name}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] pl-1 pr-2 text-xs font-medium text-[var(--text)]"
              >
                <PorchAvatar user={u} size={24} />
                {u.name}
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
        <TextInput
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a name"
          aria-label="Find people by name"
          className="pl-9"
        />
      </div>
      {typed.length >= 2 || rows.length > 0 ? (
        <ul className="flex max-h-64 flex-col overflow-y-auto rounded-xl border border-[var(--border)]" aria-label={typed.length >= 2 ? "People found" : "People you know"}>
          {typed.length < 2 && <li className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">People you know</li>}
          {rows.map((u) => {
            const on = chosen.has(u.id);
            const rel = labelOf.get(u.id);
            return (
              <li key={u.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(u)}
                  className="flex min-h-[48px] w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
                >
                  <PorchAvatar user={u} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">{u.name}</span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">
                      @{u.username}
                      {rel ? ` · ${rel}` : ""}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full border",
                      on ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[var(--border)]",
                    )}
                  >
                    {on && <Check className="h-4 w-4" />}
                  </span>
                </button>
              </li>
            );
          })}
          {typed.length >= 2 && search.isFetched && rows.length === 0 && (
            <li className="px-3 py-3 text-sm text-[var(--text-muted)]">Nobody here by that name has Porch.</li>
          )}
          {typed.length >= 2 && search.isError && <li className="px-3 py-3 text-sm text-[var(--danger)]">Couldn't search. Try again.</li>}
        </ul>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">Type two or more letters of someone's name.</p>
      )}
    </div>
  );
}
