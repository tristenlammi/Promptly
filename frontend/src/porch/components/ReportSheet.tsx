import { useEffect, useId, useState } from "react";

import { porchAdminApi, porchApi } from "@/api/porch";
import { Field, ItemButton, Sheet, TextArea } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

const REASONS = ["It's unkind or hurtful", "It's private and shouldn't be shared", "It's spam or a scam", "Something else"] as const;

/**
 * Report a post or comment to the people who run this Promptly. The person
 * who wrote it isn't told who reported it.
 */
export function ReportSheet({
  open,
  onClose,
  target,
  id,
  who,
}: {
  open: boolean;
  onClose: () => void;
  target: "post" | "comment";
  id: string;
  who: string;
}) {
  const [pick, setPick] = useState<(typeof REASONS)[number] | null>(null);
  const [more, setMore] = useState("");
  const [busy, setBusy] = useState(false);
  const groupId = useId();
  useEffect(() => {
    if (!open) return;
    setPick(null);
    setMore("");
  }, [open]);
  const send = async () => {
    setBusy(true);
    try {
      const reason = [pick && pick !== "Something else" ? pick : "", more.trim()].filter(Boolean).join(". ");
      await porchApi.report(target, id, reason);
      toast.success("Thanks for telling us. The person who runs this Promptly will look at it.");
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't send the report. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={target === "post" ? "Report this post" : "Report this comment"}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton variant="primary" disabled={busy || (!pick && !more.trim())} onClick={() => void send()}>
            Send report
          </ItemButton>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--text-muted)]">
          The person who runs this Promptly sees what you report and decides what to do. {who} isn't told who reported it.
        </p>
        <div role="radiogroup" aria-labelledby={groupId} className="flex flex-col gap-2">
          <span id={groupId} className="text-sm font-medium text-[var(--text)]">
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
