import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Loader2, Mail, Search, UserCheck, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { authApi, type DirectoryUser } from "@/api/auth";
import { cn } from "@/utils/cn";

/** Value shape the picker hands back. Either resolves to a known
 *  directory user (the common case — the caller clicked a suggestion)
 *  or an "email fallback" the backend can still resolve as long as
 *  someone with that email exists.
 *
 *  Keeping the fallback path means small self-hosted instances with
 *  no directory search sync still work — you can paste a teammate's
 *  email directly into the box and fire off the invite. */
export type UserPickerValue =
  | { kind: "user"; user: DirectoryUser }
  | { kind: "email"; email: string }
  | null;

interface Props {
  value: UserPickerValue;
  onChange: (value: UserPickerValue) => void;
  /** Which user ids to hide from the suggestion list (e.g. the
   *  people already invited so the owner doesn't re-invite them
   *  and get a no-op 409). */
  excludeUserIds?: string[];
  placeholder?: string;
  /** Call when the user presses Enter on an empty/single state —
   *  lets the parent auto-submit rather than requiring a second
   *  click. Optional. */
  onSubmit?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
}

/** Typeahead picker for resolving another Promptly user by username
 *  or email. Used by both the chat-share dialog and the project-
 *  share dialog so the two surfaces stay visually consistent.
 *
 *  Behaviour:
 *  * Idle → plain input with a magnifier icon, no dropdown.
 *  * 1+ chars → fires ``/auth/users/directory?q=`` via TanStack
 *    Query (200 ms debounce), dropdown paints as results land.
 *  * Keyboard: ↑↓ navigate, Enter selects the highlighted row,
 *    Esc closes the dropdown, Tab falls through (doesn't swallow).
 *  * Selection → collapses to a chip showing ``username`` + email;
 *    the caller's ``onChange`` receives a ``{kind:"user"}`` payload.
 *  * Free-typed email that doesn't match a directory row still
 *    commits on Enter / submit as ``{kind:"email"}`` so the old
 *    by-email invite path keeps working. */
export function UserPicker({
  value,
  onChange,
  excludeUserIds = [],
  placeholder = "Search by username or email…",
  onSubmit,
  autoFocus,
  disabled,
}: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 200 ms debounce — long enough to avoid spamming the API on
  // every keystroke, short enough that the dropdown still feels
  // live.
  useEffect(() => {
    if (!query) {
      setDebounced("");
      return;
    }
    const t = window.setTimeout(() => setDebounced(query), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ["user-directory", debounced],
    queryFn: () => authApi.directoryUsers({ q: debounced, limit: 12 }),
    enabled: open && debounced.trim().length > 0,
    // Directory results barely change turn-to-turn — a minute of
    // staleness is plenty for a picker.
    staleTime: 60_000,
  });

  const excluded = useMemo(
    () => new Set(excludeUserIds),
    [excludeUserIds]
  );

  const suggestions = useMemo(
    () => (data ?? []).filter((u) => !excluded.has(u.user_id)),
    [data, excluded]
  );

  // Clamp the highlighted index into range whenever results change.
  useEffect(() => {
    if (highlighted >= suggestions.length) setHighlighted(0);
  }, [highlighted, suggestions.length]);

  const commitEmail = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      // Very loose "looks like an email" check — we don't need to
      // validate rigorously, the backend still does final resolution.
      // Treat a bare non-email token as a username fallback too so
      // the caller can paste a handle directly.
      if (trimmed.includes("@")) {
        onChange({ kind: "email", email: trimmed });
      } else {
        onChange({ kind: "email", email: trimmed });
      }
      setQuery("");
      setOpen(false);
    },
    [onChange]
  );

  const pick = useCallback(
    (u: DirectoryUser) => {
      onChange({ kind: "user", user: u });
      setQuery("");
      setOpen(false);
    },
    [onChange]
  );

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (query.trim()) commitEmail(query);
        else onSubmit?.();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) =>
        suggestions.length ? (i + 1) % suggestions.length : 0
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) =>
        suggestions.length
          ? (i - 1 + suggestions.length) % suggestions.length
          : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = suggestions[highlighted];
      if (hit) pick(hit);
      else if (query.trim()) commitEmail(query);
      else onSubmit?.();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Resolved state — show a chip instead of the input.
  if (value) {
    return (
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "inline-flex min-w-0 flex-1 items-center gap-2 rounded-input border px-3 py-2 text-sm",
            "border-[var(--accent)]/40 bg-[var(--accent)]/5 text-[var(--text)]"
          )}
        >
          {value.kind === "user" ? (
            <UserCheck className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          ) : (
            <Mail className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {value.kind === "user" ? value.user.username : value.email}
            </div>
            {value.kind === "user" && (
              <div className="truncate text-xs text-[var(--text-muted)]">
                {value.user.email}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--text)]"
            aria-label="Clear selection"
            disabled={disabled}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        className={cn(
          "flex items-center gap-2 rounded-input border px-3 py-2 text-sm",
          "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
          "focus-within:border-[var(--accent)]/60"
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so a mousedown inside the dropdown has a chance
            // to fire before the dropdown hides.
            window.setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={handleKey}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--text-muted)]"
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete="off"
        />
        {isFetching && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--text-muted)]" />
        )}
      </div>

      {open && query.trim() && (
        <div
          className={cn(
            "absolute top-full left-0 right-0 z-10 mt-1 max-h-64 overflow-y-auto rounded-card border shadow-lg",
            "border-[var(--border)] bg-[var(--surface)]"
          )}
        >
          {suggestions.length === 0 && !isFetching ? (
            <div className="px-3 py-3 text-xs text-[var(--text-muted)]">
              No users matching{" "}
              <span className="font-mono text-[var(--text)]">
                {query.trim()}
              </span>
              . Press Enter to invite by email anyway.
            </div>
          ) : (
            <ul className="py-1">
              {suggestions.map((u, i) => (
                <li key={u.user_id}>
                  <button
                    type="button"
                    // ``onMouseDown`` so the blur handler above
                    // doesn't race with the click and close the
                    // dropdown before the pick lands.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(u);
                    }}
                    onMouseEnter={() => setHighlighted(i)}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition",
                      highlighted === i
                        ? "bg-[var(--accent)]/10 text-[var(--text)]"
                        : "text-[var(--text)] hover:bg-[var(--bg-muted)]"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{u.username}</div>
                      <div className="truncate text-xs text-[var(--text-muted)]">
                        {u.email}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
