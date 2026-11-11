import { useState } from "react";
import { Check, Loader2, Mic, ShieldAlert, X } from "lucide-react";

import { chatApi } from "@/api/chat";
import type { PersistedToolCall } from "@/api/types";
import { extractError } from "@/components/files/helpers";
import { useChatStore } from "@/store/chatStore";
import { cn } from "@/utils/cn";

type Approval = "pending" | "running" | "approved" | "declined" | "failed" | "expired";

/**
 * "Unlock the front door?" — a connector action the model asked to take
 * that changes something which can't be taken back. It doesn't run until
 * the person whose chat it is approves it here, seeing exactly what would
 * be sent. Destructive tools used to be hidden from chat altogether.
 *
 * Talk (WP-T3) holds every change asked for out loud the same way
 * ("Add Dentist to your calendar for Friday 20 November at 9 AM?"):
 * ``meta.native`` with the read-back in ``meta.question``. Saying "yes"
 * and pressing Approve here are the same action on the server.
 *
 * A typed chat that read outside content (a web page, an email, a file, a
 * workspace note) holds its changes the same way instead of refusing them
 * (``meta.held = "outside_content"``, backend ``chat/holds.py``), and says
 * why. A held look at something private (the timeline) shows what it found
 * once you say yes (``meta.show_result``).
 */
export function ToolApprovalCards({
  messageId,
  toolCalls,
}: {
  messageId: string;
  toolCalls: PersistedToolCall[];
}) {
  const asks = toolCalls.filter((c) => typeof c.meta?.approval === "string");
  if (asks.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {asks.map((c) => (
        <ApprovalCard key={c.id} messageId={messageId} call={c} />
      ))}
    </div>
  );
}

function ApprovalCard({ messageId, call }: { messageId: string; call: PersistedToolCall }) {
  const meta = call.meta ?? {};
  const state = meta.approval as Approval;
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const native = meta.native === true;
  const spoken = native && meta.spoken === true;
  const why = native && meta.held === "outside_content" && typeof meta.why === "string" ? meta.why : null;
  const result = meta.show_result === true && typeof meta.result === "string" && meta.result.trim() ? meta.result : null;
  const question = native && typeof meta.question === "string" ? meta.question : null;
  const connector = spoken ? "Asked out loud" : native ? "Checking with you" : String(meta.connector ?? "Connector");
  const title = String(meta.title ?? meta.tool ?? call.name);
  const target = typeof meta.target === "string" ? meta.target : null;
  const args = (meta.arguments ?? {}) as Record<string, unknown>;
  // A spoken question is only open for a little while: past its time it
  // can't be approved (the server refuses too), so don't offer to.
  const expiresAt = typeof meta.expires_at === "string" ? Date.parse(meta.expires_at) : NaN;
  const lapsed = state === "pending" && Number.isFinite(expiresAt) && Date.now() >= expiresAt;
  const shown: Approval = lapsed ? "expired" : state;

  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "decline");
    setError(null);
    try {
      const { tool_call, content } = await chatApi.decideToolCall(messageId, call.id, approve);
      const store = useChatStore.getState();
      store.setMessages(
        store.messages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                ...(typeof content === "string" ? { content } : {}),
                tool_calls: (m.tool_calls ?? []).map((t) => (t.id === call.id ? tool_call : t)),
              }
            : m
        )
      );
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={cn(
        "rounded-lg border bg-[var(--surface)] px-3 py-2.5",
        shown === "pending" ? "border-[var(--warning)]/60" : "border-[var(--border)]"
      )}
      role="group"
      aria-label={question ?? `${connector}: ${title}`}
    >
      <div className="flex items-start gap-2">
        {spoken ? (
          <Mic className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
        ) : (
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          {question ? (
            <div className="whitespace-pre-wrap break-words text-sm text-[var(--text)]">{question}</div>
          ) : (
            <div className="text-sm text-[var(--text)]">
              <span className="font-medium">{connector}</span> · {title}
              {target && <span className="text-[var(--text-muted)]"> · {target}</span>}
            </div>
          )}
          {why && <div className="mt-0.5 text-xs text-[var(--text-muted)]">{why}</div>}
          {!spoken && Object.keys(args).length > 0 && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-[var(--text-muted)]">
              {Object.entries(args).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono">{k}</dt>
                  <dd className="truncate font-mono text-[var(--text)]">
                    {typeof v === "string" ? v : JSON.stringify(v)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {shown === "pending" ? (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void decide(true)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-strong)] px-3 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {busy === "approve" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                {native ? "Yes, do it" : "Approve"}
              </button>
              <button
                type="button"
                onClick={() => void decide(false)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-60"
              >
                {busy === "decline" ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                Don't run it
              </button>
              <span className="text-xs text-[var(--text-muted)]">
                {spoken ? "Or say yes. Nothing has happened yet." : "Nothing has happened yet."}
              </span>
            </div>
          ) : (
            <div
              className={cn(
                "mt-1 text-xs",
                shown === "failed" ? "text-[var(--danger)]" : "text-[var(--text-muted)]"
              )}
            >
              {shown === "running" && "Doing it now…"}
              {shown === "approved" && (native ? "Done." : "Approved and done.")}
              {shown === "declined" && (native ? "Left alone: nothing was changed." : "Not run.")}
              {shown === "expired" && "Not done: nobody said yes in time. Ask again if you still want it."}
              {shown === "failed" && `Approved, but it failed: ${call.error ?? "unknown error"}`}
            </div>
          )}
          {shown === "approved" && result && (
            <div className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text)]">
              {result}
            </div>
          )}
          {error && (
            <div role="alert" className="mt-1 text-xs text-[var(--danger)]">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
