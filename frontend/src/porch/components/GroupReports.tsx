import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, MessageCircle } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { porchApi, type PorchGroup, type ReportItem } from "@/api/porch";
import { EmptyState, ItemButton, TextInput } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { ACTIVITY_KEY, BOOTSTRAP_KEY, groupKey, reportsKey } from "../cache";
import { BACKGROUND_LOOK } from "./stories/look";
import { LoadError, PorchAvatar, fullTime, shortAgo } from "./ui";

/**
 * A group's **Reports** tab, for its owner and admins (Everyone's: the
 * people who run this Promptly). What people in the group reported, with
 * their reasons and never their names. Remove takes a post out of this
 * group only (or removes a comment); Keep leaves it. The person who posted
 * it is told the reason you give.
 */
export function GroupReports({ g }: { g: PorchGroup }) {
  const qc = useQueryClient();
  const open = useQuery({ queryKey: reportsKey(g.id), queryFn: () => porchApi.groupReports(g.id), staleTime: 0 });
  const handled = useQuery({ queryKey: reportsKey(g.id, "handled"), queryFn: () => porchApi.groupHandled(g.id), staleTime: 30_000 });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["porch", "reports", g.id] });
    void qc.invalidateQueries({ queryKey: groupKey(g.id) });
    void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
    void qc.invalidateQueries({ queryKey: ACTIVITY_KEY });
    void qc.invalidateQueries({ queryKey: ["porch", "list"] });
  };
  const everyone = g.kind === "everyone";

  let body;
  if (open.isPending) body = <p className="py-6 text-center text-sm text-[var(--text-muted)]">Loading…</p>;
  else if (open.isError) body = <LoadError what="Couldn't load the reports." onRetry={() => void open.refetch()} />;
  else if (open.data.length === 0) {
    body = (
      <EmptyState
        icon={Flag}
        title="Nothing to look at"
        text={`When someone reports a post, comment or story in ${g.name}, it shows here for you to decide what happens.`}
      />
    );
  } else {
    body = (
      <ul className="flex flex-col gap-3" aria-label={`Reports waiting in ${g.name}`}>
        {open.data.map((r) => (
          <ReportCard key={r.id} r={r} g={g} onDone={done} />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 md:px-0">
      <p className="text-sm text-[var(--text-muted)]">
        {everyone
          ? `You look after ${g.name}, so things people report in it come to you.`
          : `You help run ${g.name}, so things people report in it come to you.`}{" "}
        You see their reason, never who reported it.
      </p>
      {body}
      {handled.data && handled.data.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text)]">Recently handled ({handled.data.length})</summary>
          <ul className="mt-2 flex flex-col divide-y divide-[var(--border)]">
            {handled.data.map((h) => (
              <li key={h.id} className="py-1.5 text-xs text-[var(--text-muted)]">
                <span className="font-medium text-[var(--text)]">{h.status === "removed" ? "Removed" : "Kept"}</span> a {h.target_type}
                {h.handled_by ? ` · by ${h.handled_by.name}` : ""}
                {h.handled_at ? ` · ${shortAgo(h.handled_at)}` : ""}
                {h.note ? ` · “${h.note}”` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ReportCard({ r, g, onDone }: { r: ReportItem; g: PorchGroup; onDone: () => void }) {
  const t = r.target;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const name = t.author?.name ?? "They";
  const isPost = t.type === "post";
  // A post or a story leaves this group only; a comment goes for everyone.
  const leaves = t.type !== "comment";

  const decide = async (action: "remove" | "keep") => {
    if (action === "remove" && !t.gone && !reason.trim()) {
      toast.error(`Say why first. ${name} will see it.`);
      document.getElementById(reasonId)?.focus();
      return;
    }
    setBusy(true);
    try {
      const out = await porchApi.decideGroupReport(g.id, r.id, action, reason.trim());
      if (t.gone) toast.success("Report closed.");
      else if (action === "keep") toast.success("Kept. The report is closed.");
      else if (!leaves) toast.success(`Comment removed. ${name} has been told why.`);
      else if (out.deleted) toast.success(`Removed. It was only in ${g.name}, so it's gone. ${name} has been told why.`);
      else toast.success(`Removed from ${g.name}. It stays in ${name}'s other groups, and ${name} has been told why.`);
      onDone();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't do that. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const href = t.post_id ? `/porch/p/${t.post_id}${t.type === "comment" ? `#comment-${t.id}` : ""}` : null;
  const storyBg = t.type === "story" && t.kind === "text" ? BACKGROUND_LOOK[t.background ?? "sunset"] : null;

  return (
    <li data-report={r.id} className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
      {t.gone ? (
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]" aria-hidden>
            {leaves ? <Flag className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}
          </span>
          <p className="text-sm text-[var(--text-muted)]">
            A reported {t.type} that's been deleted, or isn't in {g.name} any more. Nothing more to do: close the report.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <PorchAvatar user={t.author} size={36} />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-[var(--text)]">
              <b className="font-semibold">{name}</b>'s {t.type}
              {t.created_at && (
                <span className="text-[var(--text-muted)]">
                  {" · "}
                  <time dateTime={t.created_at} title={fullTime(t.created_at)}>
                    {shortAgo(t.created_at)}
                  </time>
                </span>
              )}
            </p>
            {t.post_body && <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">On the post: {t.post_body}</p>}
            {t.body && !storyBg && <p className="mt-1.5 whitespace-pre-wrap break-words rounded-xl bg-[var(--surface-2)] p-2.5 text-sm text-[var(--text)]">{t.body}</p>}
            {storyBg && (
              <p
                className={cn("mt-1.5 whitespace-pre-wrap break-words rounded-xl p-3 text-center text-sm font-bold", storyBg.dark ? "text-[#2A2118]" : "text-white")}
                style={{ background: storyBg.css }}
              >
                {t.body}
              </p>
            )}
            {t.type === "story" && <p className="mt-1 text-xs text-[var(--text-muted)]">A story: it shows for a day, or longer in a highlight.</p>}
            {t.media && t.media.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {t.media.slice(0, 6).map((m, i) =>
                  m.thumb ? <img key={i} src={m.thumb} alt={m.alt || `Photo ${i + 1} of the ${t.type}`} className="h-20 w-20 rounded-lg object-cover" /> : null,
                )}
              </div>
            )}
            {href && (
              <Link to={href} className="mt-1.5 inline-block text-xs font-medium text-[var(--text)] underline underline-offset-2 hover:no-underline">
                Open the {isPost ? "post" : "comment"}
              </Link>
            )}
          </div>
        </div>
      )}

      <ul className="flex flex-col gap-1 rounded-xl bg-[var(--surface-1,var(--surface-2))] px-3 py-2">
        {r.reports.map((x) => (
          <li key={x.id} className="text-xs text-[var(--text-muted)]">
            <span className="font-medium text-[var(--text)]">Reported {shortAgo(x.created_at)}</span>
            {x.reason ? `: “${x.reason}”` : " (no reason given)"}
          </li>
        ))}
      </ul>

      {!t.gone && (
        <label htmlFor={reasonId} className="flex flex-col gap-1 text-sm text-[var(--text)]">
          <span className="text-xs font-medium text-[var(--text-muted)]">Why you're removing it ({name} will see this)</span>
          <TextInput id={reasonId} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Please keep it friendly" />
        </label>
      )}
      {!t.gone && leaves && (
        <p className="text-xs text-[var(--text-muted)]">
          Removing takes it out of {g.name} only: people in {name}'s other groups still see it there. If {g.name} is its only group, it's deleted.
        </p>
      )}
      <div className={cn("flex flex-wrap justify-end gap-2")}>
        {t.gone ? (
          <ItemButton variant="secondary" disabled={busy} onClick={() => void decide("keep")}>
            Close report
          </ItemButton>
        ) : (
          <>
            <ItemButton variant="secondary" disabled={busy} onClick={() => void decide("keep")}>
              Keep it
            </ItemButton>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("remove")}
              className="inline-flex h-11 select-none items-center justify-center gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--surface)] px-4 text-sm font-medium text-[var(--danger)] transition hover:bg-[var(--danger-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 md:h-10"
            >
              {leaves ? `Remove from ${g.name}` : "Remove comment"}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
