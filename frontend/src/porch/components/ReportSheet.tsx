import { Check } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { porchAdminApi, porchApi, type GroupLabel } from "@/api/porch";
import { Field, ItemButton, Sheet, TextArea } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { usePorch } from "../context";

const REASONS = ["It's unkind or hurtful", "It's private and shouldn't be shared", "It's spam or a scam", "Something else"] as const;

interface Choice {
  group: GroupLabel;
  /** Who it goes to, in words. */
  to: string;
  /** Why it can't go there (the only admin is the person being reported). */
  blocked: string | null;
}

/** "the admins of Fam" / "the people who run this Promptly". */
function toWords(g: GroupLabel): string {
  return g.kind === "everyone" ? "the people who run this Promptly" : `the admins of ${g.name}`;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Report a post or comment to the admins of a group you see it in (your
 * groups that it's in; Everyone's admins are the people who run this
 * Promptly). Each group's admins only ever see reports made in their own
 * group, and nobody is told who reported it.
 */
export function ReportSheet({
  open,
  onClose,
  target,
  id,
  who,
  authorId,
  groups,
}: {
  open: boolean;
  onClose: () => void;
  target: "post" | "comment";
  id: string;
  who: string;
  /** Who wrote it: they can't be the one to judge it. */
  authorId: string | null | undefined;
  /** The post's groups, as you see them (only ever yours). */
  groups: GroupLabel[];
}) {
  const { b } = usePorch();
  const [pick, setPick] = useState<(typeof REASONS)[number] | null>(null);
  const [more, setMore] = useState("");
  const [to, setTo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const reasonsId = useId();
  const toId = useId();

  const choices = useMemo<Choice[]>(() => {
    const ordered = [...groups].sort((a, c) => Number(a.kind === "everyone") - Number(c.kind === "everyone") || a.name.localeCompare(c.name));
    return ordered.map((g) => {
      const full = b?.groups.find((x) => x.id === g.id);
      const others = (full?.admins ?? []).filter((a) => a.id !== authorId);
      let blocked: string | null = null;
      if (full && others.length === 0) {
        blocked =
          g.kind === "everyone"
            ? `Only ${who} runs this Promptly. You can block ${who}.`
            : `Only ${who} runs ${g.name}. You can leave the group or block ${who}.`;
      }
      return { group: g, to: toWords(g), blocked };
    });
  }, [groups, b?.groups, authorId, who]);
  const usable = choices.filter((c) => !c.blocked);
  const only = usable.length === 1 ? usable[0].group.id : null;

  useEffect(() => {
    if (!open) return;
    setPick(null);
    setMore("");
    // Only one place it can go: picked already.
    setTo(only ? [only] : []);
  }, [open, only]);

  const toggle = (gid: string) => setTo((cur) => (cur.includes(gid) ? cur.filter((x) => x !== gid) : [...cur, gid]));

  const send = async () => {
    setBusy(true);
    try {
      const reason = [pick && pick !== "Something else" ? pick : "", more.trim()].filter(Boolean).join(". ");
      const got = await porchApi.report(target, id, reason, to);
      const words = listWords(got.groups.map(toWords));
      toast.success(`Thanks for telling us. ${words.charAt(0).toUpperCase()}${words.slice(1)} will look at it.`);
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't send the report. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const nowhere = usable.length === 0;
  const thing = target === "post" ? "post" : "comment";
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={target === "post" ? "Report this post" : "Report this comment"}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <ItemButton variant="ghost" onClick={onClose}>
            {nowhere ? "Close" : "Cancel"}
          </ItemButton>
          {!nowhere && (
            <ItemButton variant="primary" disabled={busy || to.length === 0 || (!pick && !more.trim())} onClick={() => void send()}>
              Send report
            </ItemButton>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--text-muted)]">
          The people who look after a group decide what happens to what's reported in it. They see your reason, not your name, and {who} isn't told who reported it.
        </p>

        {choices.length === 1 ? (
          <p className="rounded-xl bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--text)]">
            {choices[0].blocked ?? (
              <>
                This goes to <b className="font-semibold">{choices[0].to}</b>.
              </>
            )}
          </p>
        ) : (
          <div role="group" aria-labelledby={toId} aria-describedby={`${toId}-hint`} className="flex flex-col gap-2">
            <span id={toId} className="text-sm font-medium text-[var(--text)]">
              Who should look at it?
            </span>
            <span id={`${toId}-hint`} className="-mt-1 text-xs text-[var(--text-muted)]">
              You see this {thing} in more than one group. Each group's admins only see reports made in their group.
            </span>
            {choices.map((c) => {
              const on = to.includes(c.group.id);
              return (
                <button
                  key={c.group.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={!!c.blocked}
                  onClick={() => toggle(c.group.id)}
                  className={cn(
                    "flex min-h-[44px] items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                    c.blocked
                      ? "cursor-not-allowed border-[var(--border)] text-[var(--text-muted)]"
                      : on
                        ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_8%,transparent)] text-[var(--text)]"
                        : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2",
                      on ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[var(--border-strong,var(--border))]",
                    )}
                  >
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      <span aria-hidden>{c.group.emoji} </span>
                      {c.group.kind === "everyone" ? "The people who run this Promptly" : `The admins of ${c.group.name}`}
                    </span>
                    {c.blocked ? (
                      <span className="block text-xs">{c.blocked}</span>
                    ) : c.group.kind === "everyone" ? (
                      <span className="block text-xs text-[var(--text-muted)]">It's in {c.group.name}, which they look after</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {!nowhere && (
          <>
            <div role="radiogroup" aria-labelledby={reasonsId} className="flex flex-col gap-2">
              <span id={reasonsId} className="text-sm font-medium text-[var(--text)]">
                What's wrong with it?
              </span>
              {REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={pick === r}
                  onClick={() => setPick(r)}
                  className={cn(
                    "flex min-h-[44px] items-center gap-3 rounded-xl border px-3 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                    pick === r ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_8%,transparent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]",
                  )}
                >
                  <span aria-hidden className={cn("h-4 w-4 shrink-0 rounded-full border-2", pick === r ? "border-[5px] border-[var(--item-accent)]" : "border-[var(--border-strong,var(--border))]")} />
                  {r}
                </button>
              ))}
            </div>
            <Field label="Anything to add?" hint={`${more.length}/400`}>
              <TextArea value={more} maxLength={400} rows={3} onChange={(e) => setMore(e.target.value)} placeholder="Optional" />
            </Field>
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Server admins: take a post out of Everyone, with a reason the poster sees.
 * It stays in their other groups.
 */
export function RemoveFromEveryoneSheet({
  open,
  onClose,
  postId,
  who,
  everyone,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  postId: string;
  who: string;
  everyone: string;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const go = async () => {
    setBusy(true);
    try {
      await porchAdminApi.removeFromEveryone(postId, reason.trim());
      toast.success(`Taken out of ${everyone}. ${who} has been told why.`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't remove it. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Remove from ${everyone}`}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton variant="danger" disabled={busy || !reason.trim()} onClick={() => void go()}>
            Remove
          </ItemButton>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--text-muted)]">
          Only people in {who}'s other groups will still see it. If it's only in {everyone}, it's taken down. {who} sees the reason you give.
        </p>
        <Field label="Reason (shown to them)">
          <TextArea value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} placeholder="Not for everyone, sorry" />
        </Field>
      </div>
    </Sheet>
  );
}
