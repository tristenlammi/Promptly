import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ExternalLink, History, Loader2, RefreshCw, RotateCcw, Sparkles, UserRound, X } from "lucide-react";
import { useState } from "react";

import { memoryApi, type Memory, type MemoryLearning } from "@/api/memory";
import { Button } from "@/components/shared/Button";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

const REASONS: Record<string, string> = {
  no_longer_true: "No longer true",
  expired: "Its date passed",
  stale: "Not used in 6 months",
  merged: "Merged into another fact",
  capacity: "Made room",
};

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const key of ["memories", "memory-suggestions", "memory-past", "memory-profile"]) void qc.invalidateQueries({ queryKey: [key] });
  };
}

/** What the AI always has in mind, written from your facts each night. */
function ProfileCard() {
  const refresh = useRefresh();
  const { data: profile } = useQuery({ queryKey: ["memory-profile"], queryFn: memoryApi.profile });
  const rebuild = useMutation({
    mutationFn: memoryApi.rebuildProfile,
    onSuccess: refresh,
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't write that.")),
  });
  return (
    <div className="rounded-input border border-[var(--border)] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-[var(--text)]">What it always keeps in mind</p>
        <Button variant="ghost" size="sm" disabled={rebuild.isPending} onClick={() => rebuild.mutate()} className="text-[var(--text-muted)]">
          {rebuild.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Rewrite
        </Button>
      </div>
      <p className="mt-1 text-sm text-[var(--text)]">{profile?.content ?? "Nothing yet. It's written overnight once there are facts to write it from."}</p>
      {profile && <p className="mt-1 text-[11px] text-[var(--text-muted)]">Written from your facts. If something's wrong, fix the fact and this follows.</p>}
    </div>
  );
}

/** Waiting for you to say yes: sensitive details, and what your other apps suggested. */
function Suggestions() {
  const refresh = useRefresh();
  const { data: rows = [] } = useQuery({ queryKey: ["memory-suggestions"], queryFn: memoryApi.suggestions });
  const answer = useMutation({
    mutationFn: async ({ id, yes }: { id: string; yes: boolean }) => {
      if (yes) await memoryApi.approve(id);
      else await memoryApi.dismiss(id);
    },
    onSuccess: refresh,
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't do that.")),
  });
  if (rows.length === 0) return null;
  return (
    <div className="rounded-input border border-[var(--border)] p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]"><Sparkles className="h-3.5 w-3.5 text-[var(--accent-text)]" />Waiting for your approval</p>
      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">None of these are used until you say yes.</p>
      <ul className="mt-2 space-y-2">
        {rows.map((m) => (
          <li key={m.id} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-[var(--text)]">{m.content}</p>
              {m.source_ref?.url
                ? <a href={m.source_ref.url} className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent-text)]"><ExternalLink className="h-2.5 w-2.5" />From {m.source_ref.kind}: {m.source_ref.title}</a>
                : m.source_conversation_id && <a href={`/chat/${m.source_conversation_id}`} className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent-text)]"><ExternalLink className="h-2.5 w-2.5" />From a chat</a>}
            </div>
            <button type="button" aria-label={`Keep: ${m.content}`} title="Keep" onClick={() => answer.mutate({ id: m.id, yes: true })} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--accent-text)]"><Check className="h-4 w-4" /></button>
            <button type="button" aria-label={`Don't keep: ${m.content}`} title="Don't keep" onClick={() => answer.mutate({ id: m.id, yes: false })} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]"><X className="h-4 w-4" /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SOURCE_TEXT: { key: "mail" | "calendar" | "health"; label: string; about: string }[] = [
  { key: "mail", label: "Mail", about: "What you sent or starred" },
  { key: "calendar", label: "Calendar", about: "Events you created" },
  { key: "health", label: "Health", about: "Conditions, allergies and medications" },
];

/** Off by default, and only ever suggestions. */
function LearnFromApps() {
  const qc = useQueryClient();
  const refresh = useRefresh();
  const { data } = useQuery({ queryKey: ["memory-learning"], queryFn: memoryApi.learning });
  const change = useMutation({
    mutationFn: memoryApi.setLearning,
    onSuccess: (next: MemoryLearning) => qc.setQueryData(["memory-learning"], next),
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't change that.")),
  });
  const check = useMutation({
    mutationFn: memoryApi.checkLearning,
    onSuccess: (n) => {
      toast.info(n ? `${n} new suggestion${n === 1 ? "" : "s"} to review.` : "Nothing new to suggest.");
      refresh();
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't look just now.")),
  });
  if (!data) return null;
  const anyOn = data.mail || data.calendar || data.health;
  return (
    <div className="rounded-input border border-[var(--border)] p-3">
      <p className="text-xs font-medium text-[var(--text)]">Suggest facts from my other apps</p>
      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Off unless you turn it on. Items are sent to your memory model, which may be a cloud service, and everything it finds waits for your approval.</p>
      <div className="mt-2 space-y-1.5">
        {SOURCE_TEXT.map(({ key, label, about }) => {
          const blocked = key === "mail" && !data.mail_allowed;
          return (
            <label key={key} className={`flex items-start gap-2 text-sm text-[var(--text)] ${blocked ? "opacity-50" : ""}`}>
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={data[key]} disabled={blocked || change.isPending} onChange={(e) => change.mutate({ mail: data.mail, calendar: data.calendar, health: data.health, [key]: e.target.checked })} />
              <span>{label} <span className="text-xs text-[var(--text-muted)]">{blocked ? "Your admin has turned off AI reading mail" : about}</span></span>
            </label>
          );
        })}
      </div>
      {anyOn && <Button variant="ghost" size="sm" disabled={check.isPending} onClick={() => check.mutate()} className="mt-2 text-[var(--text-muted)]">{check.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Look now</Button>}
    </div>
  );
}

function OlderChats() {
  const [asked, setAsked] = useState<number | null>(null);
  const read = useMutation({
    mutationFn: memoryApi.readOlderChats,
    onSuccess: setAsked,
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't start that.")),
  });
  return (
    <div className="rounded-input border border-[var(--border)] p-3">
      <p className="text-xs font-medium text-[var(--text)]">Learn from older chats</p>
      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">New chats are read once they go quiet. This goes back through the last 90 days, a few at a time, with one model call per chat.</p>
      {asked === null
        ? <Button variant="ghost" size="sm" disabled={read.isPending} onClick={() => read.mutate()} className="mt-1.5 text-[var(--text-muted)]">Read my older chats</Button>
        : <p className="mt-1.5 text-xs text-[var(--text)]">{asked} chat{asked === 1 ? "" : "s"} queued. New facts will appear here over the next while.</p>}
    </div>
  );
}

/** No longer true. Kept for the record, and each can be put back. */
function PastFacts() {
  const [open, setOpen] = useState(false);
  const refresh = useRefresh();
  const { data: rows = [] } = useQuery({ queryKey: ["memory-past"], queryFn: memoryApi.past });
  const restore = useMutation({
    mutationFn: (m: Memory) => memoryApi.restore(m.id),
    onSuccess: refresh,
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't put that back.")),
  });
  if (rows.length === 0) return null;
  return (
    <div className="rounded-input border border-[var(--border)] p-3">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-[var(--text)]">
        No longer true ({rows.length})
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {rows.map((m) => (
            <li key={m.id} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--text-muted)]">{m.content}</p>
                <p className="text-[11px] text-[var(--text-muted)]">{REASONS[m.retired_reason ?? ""] ?? "Retired"}{m.valid_until ? ` · ${new Date(m.valid_until).toLocaleDateString()}` : ""}</p>
              </div>
              <button type="button" aria-label={`Put back: ${m.content}`} title="Put back" onClick={() => restore.mutate(m)} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--accent-text)]"><RotateCcw className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MemoryExtras() {
  return (
    <div className="space-y-2">
      <Suggestions />
      <ProfileCard />
      <LearnFromApps />
      <OlderChats />
      <PastFacts />
    </div>
  );
}

/** Who a fact is about, by the names in your Contacts and Photos. */
export function FactPeople({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ["memory-people"], queryFn: memoryApi.peopleLinks, staleTime: 60_000 });
  const people = data?.[id];
  if (!people?.length) return null;
  return <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]"><UserRound className="h-2.5 w-2.5" />{people.join(", ")}</span>;
}

/** What a fact used to say. */
export function FactHistory({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const refresh = useRefresh();
  const { data: versions = [] } = useQuery({ queryKey: ["memory-history", id], queryFn: () => memoryApi.history(id), enabled: open });
  const restore = useMutation({
    mutationFn: (versionId: string) => memoryApi.restoreVersion(id, versionId),
    onSuccess: () => { setOpen(false); refresh(); },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't put that back.")),
  });
  return (
    <>
      <button type="button" aria-label="What it used to say" title="What it used to say" aria-expanded={open} onClick={() => setOpen(!open)} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-text)]"><History className="inline h-2.5 w-2.5" /></button>
      {open && (
        <span className="basis-full space-y-1 pt-1">
          {versions.length === 0 && <span className="block text-[11px] text-[var(--text-muted)]">It hasn't changed.</span>}
          {versions.map((v) => (
            <span key={v.id} className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <span className="min-w-0 flex-1">{v.content} · until {new Date(v.replaced_at).toLocaleDateString()}</span>
              <button type="button" onClick={() => restore.mutate(v.id)} className="shrink-0 font-medium text-[var(--accent-text)]">Use this</button>
            </span>
          ))}
        </span>
      )}
    </>
  );
}
