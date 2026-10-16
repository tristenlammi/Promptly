import { useState } from "react";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";

import { chatApi } from "@/api/chat";
import type { PersistedToolCall } from "@/api/types";
import { extractError } from "@/components/files/helpers";
import { useChatStore } from "@/store/chatStore";
import { cn } from "@/utils/cn";

type Approval = "pending" | "approved" | "declined" | "failed";

/**
 * "Unlock the front door?" — a connector action the model asked to take
 * that changes something which can't be taken back. It doesn't run until
 * the person whose chat it is approves it here, seeing exactly what would
 * be sent. Destructive tools used to be hidden from chat altogether.
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
  const connector = String(meta.connector ?? "Connector");
  const title = String(meta.title ?? meta.tool ?? call.name);
  const target = typeof meta.target === "string" ? meta.target : null;
  const args = (meta.arguments ?? {}) as Record<string, unknown>;

  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "decline");
    setError(null);
    try {
      const { tool_call } = await chatApi.decideToolCall(messageId, call.id, approve);
      const store = useChatStore.getState();
      store.setMessages(
        store.messages.map((m) =>
          m.id === messageId
            ? {
                ...m,
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
        state === "pending" ? "border-[var(--warning)]/60" : "border-[var(--border)]"
      )}
      role="group"
      aria-label={`${connector}: ${title}`}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-[var(--text)]">
            <span className="font-medium">{connector}</span> · {title}
            {target && <span className="text-[var(--text-muted)]"> · {target}</span>}
          </div>
          {Object.keys(args).length > 0 && (
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
          {state === "pending" ? (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void decide(true)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {busy === "approve" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Approve
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
              <span className="text-xs text-[var(--text-muted)]">Nothing has happened yet.</span>
            </div>
          ) : (
            <div
              className={cn(
                "mt-1 text-xs",
                state === "failed" ? "text-[var(--danger)]" : "text-[var(--text-muted)]"
              )}
            >
              {state === "approved" && "Approved and done."}
              {state === "declined" && "Not run."}
              {state === "failed" && `Approved, but it failed: ${call.error ?? "unknown error"}`}
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
