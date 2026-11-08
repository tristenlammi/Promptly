import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { useState } from "react";

import { porchApi, type PorchUser } from "@/api/porch";
import { ItemButton, List, Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { BOOTSTRAP_KEY, discoverKey, updateBootstrap } from "../cache";
import { usePorch } from "../context";
import { DiscoverRow, InviteRow } from "../pages/GroupsPage";
import { usePorchStore } from "../store";
import { NewGroupSheet } from "./GroupSheets";
import { PorchAvatar, peopleCount } from "./ui";

/**
 * The first time you open Porch (once, skippable): what it is, that you're
 * already in Everyone, then any invites waiting, public groups to join, and
 * a nudge to make your first group — with "Make a Family group?" when your
 * own People directory knows who your family are (nobody ticked for you).
 */
export function WelcomeSheet() {
  const { b } = usePorch();
  const qc = useQueryClient();
  const [open, setOpen] = useState(!b.profile.welcomed);
  const [family, setFamily] = useState<PorchUser[]>([]);
  const [making, setMaking] = useState<null | { name?: string; emoji?: string; invite?: PorchUser[] }>(null);
  const setNewGroup = usePorchStore((s) => s.setNewGroupOpen);
  const discover = useQuery({ queryKey: discoverKey(""), queryFn: () => porchApi.discover(""), enabled: open, staleTime: 30_000 });
  const suggested = useQuery({ queryKey: ["porch", "suggested"], queryFn: porchApi.suggested, enabled: open, staleTime: 5 * 60_000 });
  const hasOwnGroups = b.groups.some((g) => g.kind === "custom");

  const done = () => {
    setOpen(false);
    updateBootstrap(qc, (cur) => ({ ...cur, profile: { ...cur.profile, welcomed: true } }));
    void porchApi.updateProfile({ welcomed: true }).catch(() => undefined);
  };

  if (!open && !making) return null;
  const others = b.everyone.member_count - 1;
  const people = (suggested.data ?? []).slice(0, 8);
  const toggle = (u: PorchUser) => setFamily((f) => (f.some((x) => x.id === u.id) ? f.filter((x) => x.id !== u.id) : [...f, u]));
  const publicGroups = (discover.data ?? []).slice(0, 4);

  return (
    <>
      <Sheet
        open={open && !making}
        onClose={done}
        title="Welcome to Porch"
        size="lg"
        footer={
          <div className="flex justify-end">
            <ItemButton variant="primary" onClick={done}>
              Start
            </ItemButton>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          <p className="text-[15px] leading-relaxed text-[var(--text)]">
            Share photos and news with the people on this Promptly. Every post goes to the groups you pick, and nobody outside a group sees its posts.
          </p>
          <div className="flex items-center gap-3 rounded-2xl bg-[var(--surface-2)] p-3">
            <span className="text-2xl" aria-hidden>
              {b.everyone.emoji}
            </span>
            <p className="text-sm text-[var(--text)]">
              You're in <b className="font-semibold">{b.everyone.name}</b> ({peopleCount(b.everyone.member_count)}).{" "}
              {others > 0 ? "Everyone on this Promptly is." : "When others join this Promptly, they'll be in it too."}
            </p>
          </div>

          {b.invites.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-[var(--text)]">You're invited</h3>
              <List>
                {b.invites.map((g) => (
                  <InviteRow key={g.id} g={g} />
                ))}
              </List>
            </section>
          )}

          {publicGroups.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-[var(--text)]">Groups you can join</h3>
              <List>
                {publicGroups.map((g) => (
                  <DiscoverRow key={g.id} g={g} compact />
                ))}
              </List>
            </section>
          )}

          {!hasOwnGroups && people.length > 0 && (
            <section className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] p-3">
              <h3 className="text-sm font-semibold text-[var(--text)]">Make a Family group?</h3>
              <p className="text-xs text-[var(--text-muted)]">From your own Contacts and Photos. Tick who to invite; they'll be asked first.</p>
              <ul className="flex flex-col">
                {people.map((s) => {
                  const on = family.some((x) => x.id === s.user.id);
                  return (
                    <li key={s.user.id}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggle(s.user)}
                        className="flex min-h-[48px] w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
                      >
                        <PorchAvatar user={s.user} size={32} />
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                          {s.user.name}
                          {s.label && <span className="text-[var(--text-muted)]"> · your {s.label.toLowerCase()}</span>}
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
              </ul>
              <div>
                <ItemButton variant="primary" size="sm" disabled={family.length === 0} onClick={() => setMaking({ name: "Family", emoji: "👨‍👩‍👧", invite: family })}>
                  Make a Family group
                </ItemButton>
              </div>
            </section>
          )}

          {!hasOwnGroups && (
            <section className="flex items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] p-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-[var(--text)]">Make your first group</h3>
                <p className="text-xs text-[var(--text-muted)]">Family, your mates, a hobby. Private until you say otherwise.</p>
              </div>
              <ItemButton
                variant="secondary"
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  done();
                  setNewGroup(true);
                }}
              >
                Make a group
              </ItemButton>
            </section>
          )}
        </div>
      </Sheet>
      <NewGroupSheet
        open={!!making}
        preset={making ?? undefined}
        onClose={() => {
          setMaking(null);
          done();
          void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
        }}
      />
    </>
  );
}
