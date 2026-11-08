import { useQuery } from "@tanstack/react-query";
import { Check, Plus, Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { porchApi, type PorchGroup } from "@/api/porch";
import { EmptyState, ItemButton, List, Section, TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { useGroupActions } from "../actions";
import { discoverKey } from "../cache";
import { Column, GroupTile, LoadError, PageHeader, VisibilityTag, peopleCount } from "../components/ui";
import { usePorch } from "../context";
import { GroupBell } from "../notify";
import { usePorchStore } from "../store";

/** An invite to answer: "Sam invited you to 🍻 The Lads · 6 people". */
export function InviteRow({ g, compact = false }: { g: PorchGroup; compact?: boolean }) {
  const { accept, decline } = useGroupActions();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  return (
    <div data-invite={g.id} className={cn("flex flex-col gap-3 p-3", !compact && "sm:flex-row sm:items-center")}>
      <Link to={`/porch/g/${g.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <GroupTile group={g} size={44} />
        <span className="min-w-0">
          <span className="block text-sm text-[var(--text)]">
            {g.invited_by ? (
              <>
                <b className="font-semibold">{g.invited_by.name}</b> invited you to{" "}
              </>
            ) : (
              "You're invited to "
            )}
            <b className="font-semibold">
              {g.emoji ? `${g.emoji} ` : ""}
              {g.name}
            </b>
          </span>
          <span className="block text-xs text-[var(--text-muted)]">
            {peopleCount(g.member_count)} · {g.visibility === "private" ? "Private" : "Public"}
          </span>
        </span>
      </Link>
      <div className="flex shrink-0 gap-2">
        <ItemButton size="sm" variant="primary" disabled={busy} onClick={() => void run(() => accept(g))}>
          Join
        </ItemButton>
        <ItemButton size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => decline(g))}>
          Not now
        </ItemButton>
      </div>
    </div>
  );
}

/** A public group you're not in, with one-tap Join. */
export function DiscoverRow({ g, compact }: { g: PorchGroup; compact?: boolean }) {
  const { join } = useGroupActions();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 p-3">
      <Link to={`/porch/g/${g.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <GroupTile group={g} size={compact ? 36 : 44} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-[var(--text)]">{g.name}</span>
          <span className="block truncate text-xs text-[var(--text-muted)]">{g.about ? `${peopleCount(g.member_count)} · ${g.about}` : peopleCount(g.member_count)}</span>
        </span>
      </Link>
      <ItemButton
        size="sm"
        variant="primary"
        disabled={busy}
        aria-label={`Join ${g.name}`}
        onClick={() => {
          setBusy(true);
          void join(g).finally(() => setBusy(false));
        }}
      >
        Join
      </ItemButton>
    </div>
  );
}

/** ``/porch/groups``: invites, your groups, and public groups to find. */
export function GroupsPage() {
  const { b } = usePorch();
  const location = useLocation();
  const { setTicks } = useGroupActions();
  const setNewGroup = usePorchStore((s) => s.setNewGroupOpen);
  const [filter, setFilter] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setTyped(filter.trim()), 250);
    return () => window.clearTimeout(t);
  }, [filter]);
  const discover = useQuery({ queryKey: discoverKey(typed), queryFn: () => porchApi.discover(typed), staleTime: 30_000 });

  // /porch/groups#find: straight to Find groups.
  useEffect(() => {
    if (location.hash === "#find") {
      const t = window.setTimeout(() => document.getElementById("find")?.scrollIntoView({ block: "start" }), 50);
      return () => window.clearTimeout(t);
    }
  }, [location.hash]);

  return (
    <Column>
      <PageHeader
        title="Groups"
        actions={
          <ItemButton variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setNewGroup(true)}>
            New group
          </ItemButton>
        }
      />
      <div className="flex flex-col gap-6 px-4 pt-2 md:px-0">
        {b.invites.length > 0 && (
          <Section title="Invites" hint="Nobody is added to a group without saying yes.">
            <List>
              {b.invites.map((g) => (
                <InviteRow key={g.id} g={g} />
              ))}
            </List>
          </Section>
        )}

        <Section title="Your groups" hint="Ticked groups are in your feed. The bell sends a notification for every new post.">
          <List>
            {b.groups.map((g) => (
              <div key={g.id} className="flex items-center gap-0.5 pr-2">
                <Link to={`/porch/g/${g.id}`} className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 px-3 py-2 hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]">
                  <GroupTile group={g} size={44} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-[var(--text)]">{g.name}</span>
                    <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <VisibilityTag visibility={g.visibility} />· {peopleCount(g.member_count)}
                    </span>
                  </span>
                </Link>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={!!g.in_feed}
                  aria-label={`${g.name} in your feed`}
                  onClick={() => setTicks({ [g.id]: !g.in_feed })}
                  className="flex h-11 shrink-0 items-center gap-2 rounded-xl px-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-md border",
                      g.in_feed ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[var(--border)] bg-[var(--surface)]",
                    )}
                  >
                    {g.in_feed && <Check className="h-4 w-4" />}
                  </span>
                  In feed
                </button>
                <GroupBell group={g} />
              </div>
            ))}
          </List>
          {b.groups.length === 1 && (
            <p className="px-1 text-sm text-[var(--text-muted)]">
              Only Everyone so far.{" "}
              <button type="button" onClick={() => setNewGroup(true)} className="font-medium text-[var(--accent-text)] hover:underline">
                Make a group
              </button>{" "}
              for your family or friends.
            </p>
          )}
        </Section>

        <section id="find" className="flex scroll-mt-4 flex-col gap-2">
          <div className="px-1">
            <h2 className="text-sm font-semibold text-[var(--text)]">Find groups</h2>
            <p className="text-xs text-[var(--text-muted)]">Public groups on this Promptly. Join with one tap.</p>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
            <TextInput type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or about" aria-label="Filter public groups" className="pl-9" />
          </div>
          {discover.isPending ? (
            <p className="px-1 py-4 text-sm text-[var(--text-muted)]">Looking…</p>
          ) : discover.isError ? (
            <LoadError what="Couldn't load the public groups." onRetry={() => void discover.refetch()} />
          ) : discover.data.length === 0 ? (
            typed ? (
              <p className="px-1 py-4 text-sm text-[var(--text-muted)]">No public groups match "{typed}".</p>
            ) : (
              <EmptyState
                icon={Users}
                title="No public groups to join yet"
                text="Make one and anyone here can find it."
                action={
                  <ItemButton variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setNewGroup(true)}>
                    New group
                  </ItemButton>
                }
              />
            )
          ) : (
            <List>
              {discover.data.map((g) => (
                <DiscoverRow key={g.id} g={g} />
              ))}
            </List>
          )}
        </section>
      </div>
    </Column>
  );
}
