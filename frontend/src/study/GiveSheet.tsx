import { Check, Gift, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { RoomUser } from "@/api/rooms";
import { studyApi, studyError, type ShareReply, type SubjectFull } from "@/api/study";
import { PeoplePicker } from "@/components/people/PeoplePicker";
import { Button } from "@/components/shared/Button";
import { Sheet } from "@/components/shared/Sheet";
import { useAuthStore } from "@/store/authStore";

/*
 * Give this course to someone on this Promptly. They get their own copy of
 * the map and the sources and start it fresh; nothing of the giver's
 * progress goes with it, and neither can see the other's afterwards.
 */
export function GiveSheet({ open, onClose, subject }: { open: boolean; onClose: () => void; subject: SubjectFull }) {
  const me = useAuthStore((s) => s.user?.id ?? "");
  const [picked, setPicked] = useState<RoomUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ShareReply | null>(null);
  useEffect(() => {
    if (!open) return;
    setPicked([]);
    setError(null);
    setDone(null);
  }, [open]);

  const ownSources = subject.sources.filter((s) => s.kind !== "web").length;
  const give = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await studyApi.share(subject.id, picked.map((u) => u.id)));
    } catch (e) {
      setError(studyError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const nameOf = (id: string, fallback: string) => picked.find((u) => u.id === id)?.username ?? (fallback || "Someone");

  return (
    <Sheet open={open} onClose={onClose} title="Give this course">
      <div className="study flex flex-col gap-4" data-testid="study-give">
        {done ? (
          <>
            <ul className="flex flex-col gap-2" aria-label="What happened">
              {done.given.map((g) => (
                <li key={g.user_id} className="flex items-start gap-2 rounded-xl border border-[var(--st-good-border)] bg-[var(--st-good-bg)] px-3 py-2.5 text-sm text-[var(--text)]" data-testid="study-given">
                  <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--st-good)]" />
                  <span>
                    <span className="font-semibold">{nameOf(g.user_id, g.name)}</span> now has it in Study, and has been told.
                  </span>
                </li>
              ))}
              {done.skipped.map((s) => (
                <li key={s.user_id} className="flex items-start gap-2 rounded-xl border border-[var(--st-warn-border)] bg-[var(--st-warn-bg)] px-3 py-2.5 text-sm text-[var(--text)]" data-testid="study-not-given">
                  <X aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--st-warn)]" />
                  <span>
                    <span className="font-semibold">{nameOf(s.user_id, s.name)}:</span> {s.reason}
                  </span>
                </li>
              ))}
            </ul>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <div className="rounded-2xl bg-[var(--st-softer)] p-3.5 text-sm text-[var(--text)]">
              <p className="flex items-center gap-2 font-semibold">
                <Gift aria-hidden className="h-4 w-4 text-[var(--st-accent-text)]" /> They get their own copy of “{subject.title}”
              </p>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[var(--text-muted)]">
                <li>The course itself: what it's for, the map of ideas and the sources.</li>
                <li>
                  <span className="font-medium text-[var(--text)]">Nothing of yours:</span> not your progress, your answers, what you found hard or your report.
                </li>
                <li>They start fresh, at their own level. After this, yours and theirs are separate, and neither of you can see the other's.</li>
                {ownSources > 0 && (
                  <li>
                    This course was built with {ownSources === 1 ? "one of your own files or notes" : `${ownSources} of your own files and notes`}. Their names and the passages the course drew on go with it; the files stay yours.
                  </li>
                )}
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Give it to</h3>
              <PeoplePicker
                selected={picked}
                exclude={[me]}
                onChange={(next) => {
                  setPicked(next.slice(0, 10));
                  setError(null);
                }}
              />
            </div>
            {error && (
              <p role="alert" className="rounded-xl border border-[var(--st-bad-border)] bg-[var(--st-bad-bg)] px-3 py-2.5 text-sm text-[var(--st-bad)]">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void give()} disabled={busy || picked.length === 0} leftIcon={<Gift className="h-4 w-4" />} data-testid="study-give-go">
                {busy ? "Giving…" : picked.length > 1 ? `Give to ${picked.length} people` : "Give"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
