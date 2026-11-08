import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserX } from "lucide-react";
import { useState } from "react";

import { BLOCKED_KEY, peopleHubApi } from "@/api/peopleHub";
import { unblockPerson } from "@/components/people/blockActions";
import { Button } from "@/components/shared/Button";
import { UserAvatar } from "@/rooms/components/ui";

/**
 * Account → Blocked people: everyone you've blocked (``/api/people/blocks``),
 * each with Unblock. You block someone from their profile or your
 * conversation with them; they aren't told.
 */
export function BlockedPeoplePanel() {
  const qc = useQueryClient();
  const { data: people = [], isLoading, isError } = useQuery({ queryKey: BLOCKED_KEY, queryFn: peopleHubApi.listBlocked });
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <header className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent-text)]">
          <UserX className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Blocked people</h2>
          <p className="text-xs text-[var(--text-muted)]">
            You and someone you've blocked can't message each other one-to-one, and you won't get notifications about
            what they do. You can both still be in the same spaces and group conversations. They aren't told.
          </p>
        </div>
      </header>

      {isLoading ? (
        <p className="text-xs text-[var(--text-muted)]">Loading…</p>
      ) : isError ? (
        <p className="text-xs text-red-600 dark:text-red-400">Couldn't load the list. Try again in a moment.</p>
      ) : people.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          You haven't blocked anyone. If you ever need to, you can from someone's profile or your conversation with them.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
          {people.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <UserAvatar user={p} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.username}</div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  Blocked {new Date(p.blocked_at).toLocaleDateString()}
                </div>
              </div>
              <Button
                variant="ghost"
                disabled={busy === p.id}
                onClick={async () => {
                  setBusy(p.id);
                  await unblockPerson(qc, p);
                  setBusy(null);
                }}
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
