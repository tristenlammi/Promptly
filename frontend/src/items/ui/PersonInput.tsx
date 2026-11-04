import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";

import { peopleHubApi, type PickerPerson } from "@/api/peopleHub";
import { PersonAvatar } from "@/components/people/PeoplePicker";
import { cn } from "@/utils/cn";

import { TextInput } from "./primitives";

/** Someone picked from the suggestions: your own Contacts (with the first
 *  phone / email / address on the card) and/or a Promptly account. Empty
 *  strings where a part isn't known. */
export interface PickedPerson {
  name: string;
  /** What they are to you ("Wife"), from Photos. */
  label: string | null;
  user_id: string;
  username: string;
  contact_id: string;
  contact_file_id: string;
  phone: string;
  email: string;
  address: string;
  company: string;
}

export function pickedFrom(p: PickerPerson): PickedPerson {
  const c = p.contact;
  return {
    name: p.name,
    label: p.label,
    user_id: p.user?.id ?? "",
    username: p.user?.username ?? "",
    contact_id: c?.contact_id ?? "",
    contact_file_id: c?.file_id ?? "",
    phone: c?.phone ?? "",
    email: c?.email ?? "",
    address: c?.address ?? "",
    company: c?.company ?? "",
  };
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onKeyDown"> & {
  value: string;
  /** Free typing — the name stays whatever is typed. */
  onChange: (name: string) => void;
  /** A suggestion was chosen (``onChange`` gets its name first). */
  onPick?: (p: PickedPerson) => void;
  /** Enter with no suggestion highlighted (e.g. "add this typed name"). */
  onEnter?: () => void;
  /** Only people on your Contacts (care team, emergency contact). */
  contactsOnly?: boolean;
  /** Promptly accounts to leave out (already added). */
  excludeUserIds?: string[];
  /** Names to leave out (case-insensitive; already added). */
  excludeNames?: string[];
};

/**
 * A name field for item apps that suggests people you already know as you
 * type — your own Contacts and Promptly accounts (``/api/people/search``) —
 * while still taking any typed name. Picking fills the name and hands the
 * caller the contact / account so it can fill phone, email…
 */
export function PersonInput({ value, onChange, onPick, onEnter, contactsOnly, excludeUserIds, excludeNames, className, onBlur, onFocus, ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(-1);
  const listId = useId();
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value.trim()), 200);
    return () => window.clearTimeout(t);
  }, [value]);
  const { data } = useQuery({
    queryKey: ["people-hub", "search", debounced, "details"],
    queryFn: () => peopleHubApi.search(debounced, { details: true }),
    enabled: open && debounced.length > 0,
    staleTime: 60_000,
  });
  const skipNames = new Set((excludeNames ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
  const people = (data ?? [])
    .filter((p) => (contactsOnly ? !!p.contact : true))
    .filter((p) => !(p.user && excludeUserIds?.includes(p.user.id)))
    .filter((p) => !skipNames.has(p.name.trim().toLowerCase()))
    .slice(0, 8);
  const shown = open && debounced.length > 0 && people.length > 0;
  useEffect(() => setActive(-1), [debounced]);

  const pick = (p: PickerPerson) => {
    const got = pickedFrom(p);
    onChange(got.name);
    onPick?.(got);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (shown && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      // -1 = the typed text itself (Enter keeps it as typed).
      setActive((i) => (e.key === "ArrowDown" ? (i + 1 >= people.length ? -1 : i + 1) : i - 1 < -1 ? people.length - 1 : i - 1));
      return;
    }
    if (e.key === "Escape" && shown) {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "Enter") {
      const p = shown && active >= 0 ? people[active] : undefined;
      if (p) {
        e.preventDefault();
        pick(p);
      } else if (onEnter) {
        e.preventDefault();
        setOpen(false);
        onEnter();
      }
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <TextInput
        {...rest}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={(e) => {
          setOpen(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          // Let a tap on a suggestion land first.
          window.setTimeout(() => setOpen(false), 150);
          onBlur?.(e);
        }}
        onKeyDown={onKey}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 && active < people.length ? `${listId}-${active}` : undefined}
        className={className}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label="People you know"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-md)]"
        >
          {people.map((p, i) => {
            const c = p.contact;
            const sub = [p.user && p.name !== p.user.username ? `@${p.user.username}` : null, c ? c.phone || c.email || "In your Contacts" : !p.user ? "In your Photos" : null]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={p.key} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(p);
                  }}
                  onMouseMove={() => setActive(i)}
                  className={cn("flex min-h-11 w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-[var(--hover)]", i === active && "bg-[var(--hover)]")}
                >
                  <PersonAvatar person={p} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--text)]">
                      {p.name}
                      {p.label && <span className="text-[var(--text-muted)]"> · {p.label}</span>}
                    </span>
                    {sub && <span className="block truncate text-xs text-[var(--text-muted)]">{sub}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
