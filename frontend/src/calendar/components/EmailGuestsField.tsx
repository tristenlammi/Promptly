import { useQuery } from "@tanstack/react-query";
import { Loader2, Mail, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { CalUser, RsvpStatus } from "@/api/calendar";
import { calendarReachApi, looksLikeEmail } from "@/api/calendarReach";
import { TextInput } from "@/items/ui";
import { UserAvatar } from "@/rooms/components/ui";

import { StatusBadge } from "./ui";

/** A guest by email in the editor: saved ones have an ``id`` (and an answer). */
export interface DraftEmailGuest {
  id?: string;
  email: string;
  status?: RsvpStatus;
}

/** "Invite by email" under the guest list. Typing an address offers to add
 *  them — as a guest when they're on Promptly, else by email (when this
 *  server can send email; otherwise it says so and the option is off). */
export function EmailGuestsField({
  guests,
  onChange,
  onAddUser,
  takenUserIds,
}: {
  guests: DraftEmailGuest[];
  onChange: (next: DraftEmailGuest[]) => void;
  /** They're on Promptly: invite them the usual way. */
  onAddUser: (u: CalUser) => void;
  takenUserIds: string[];
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  // Look the address up once typing pauses.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(looksLikeEmail(text) ? text.trim().toLowerCase() : ""), 300);
    return () => window.clearTimeout(t);
  }, [text]);
  const { data: check, isFetching } = useQuery({
    queryKey: ["calendar", "email-check", query],
    queryFn: () => calendarReachApi.emailCheck(query),
    enabled: !!query,
    staleTime: 60_000,
  });
  const current = check && query && check.email === query && looksLikeEmail(text) ? check : null;
  const already = current && guests.some((g) => g.email === current.email);
  const userTaken = current?.user && takenUserIds.includes(current.user.id);

  const add = () => {
    if (!current || !current.valid) return;
    if (current.user) {
      if (!userTaken) onAddUser(current.user);
    } else if (current.can_email && !already) {
      onChange([...guests, { email: current.email }]);
    } else {
      return;
    }
    setText("");
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      {guests.length > 0 && (
        <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {guests.map((g) => (
            <li key={g.email} className="flex h-11 items-center gap-2 px-3">
              <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">
                <Mail className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{g.email}</span>
              {g.id ? <StatusBadge status={g.status ?? "invited"} /> : <span className="text-[11px] text-[var(--text-muted)]">Emailed when you save</span>}
              <button
                type="button"
                aria-label={`Remove ${g.email}`}
                onClick={() => onChange(guests.filter((x) => x.email !== g.email))}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <TextInput
          type="email"
          inputMode="email"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Invite someone by email"
          aria-label="Invite someone by email"
          maxLength={254}
          className="pl-9"
        />
      </div>
      {looksLikeEmail(text) && (
        <div className="text-xs">
          {!current ? (
            <span className="flex items-center gap-1.5 text-[var(--text-muted)]">{isFetching && <Loader2 className="h-3 w-3 animate-spin" />} Checking…</span>
          ) : !current.valid ? (
            <span className="text-[var(--danger)]">That doesn't look like an email address.</span>
          ) : current.user ? (
            <button
              type="button"
              onClick={add}
              disabled={!!userTaken}
              className="flex h-9 w-full items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60"
            >
              <UserAvatar user={current.user} size={22} />
              <span className="min-w-0 flex-1 truncate">
                {userTaken ? `${current.user.username} is already a guest` : `Add ${current.user.username} — they're on Promptly`}
              </span>
              <UserPlus className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            </button>
          ) : current.can_email ? (
            <button
              type="button"
              onClick={add}
              disabled={!!already}
              className="flex h-9 w-full items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60"
            >
              <Mail className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 flex-1 truncate">{already ? `${current.email} is already invited` : `Invite ${current.email} by email`}</span>
            </button>
          ) : (
            <p className="rounded-xl bg-[var(--surface-2)] px-3 py-2 text-[var(--text-muted)]">
              {current.email} isn't on Promptly, and this server can't send email yet — an admin can set up email in Settings.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
