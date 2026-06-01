import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  AtSign,
  CalendarPlus,
  CheckCheck,
  Clock,
  Loader2,
  Mail,
  Paperclip,
  Reply,
  Send,
  Sparkles,
  X,
} from "lucide-react";

import { emailApi, type CategoryCounts, type EmailMessageBrief, type EmailMessageDetail } from "@/api/email";
import { CalendarStrip } from "@/components/email/CalendarStrip";
import { TopNav } from "@/components/layout/TopNav";
import { cn } from "@/utils/cn";

const CATEGORIES: { key: keyof CategoryCounts | "all"; label: string }[] = [
  { key: "all", label: "All mail" },
  { key: "action_required", label: "Action required" },
  { key: "fyi", label: "FYI" },
  { key: "newsletter", label: "Newsletters" },
  { key: "promotional", label: "Promotional" },
  { key: "social", label: "Social" },
  { key: "spam", label: "Spam" },
];

const PRIORITY_COLORS: Record<number, string> = {
  8: "bg-red-500",
  9: "bg-red-500",
  10: "bg-red-500",
  6: "bg-amber-500",
  7: "bg-amber-500",
};

interface CalendarPrefill {
  title: string;
  date: string;
  startTime: string;
}

export function EmailPage() {
  const [category, setCategory] = useState<keyof CategoryCounts | "all">("action_required");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [calendarPrefill, setCalendarPrefill] = useState<CalendarPrefill | null>(null);
  const qc = useQueryClient();

  const { data: counts } = useQuery({
    queryKey: ["email", "counts"],
    queryFn: emailApi.messageCounts,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: messages = [], isLoading: listLoading } = useQuery({
    queryKey: ["email", "messages", category],
    queryFn: () =>
      emailApi.listMessages({
        category: category === "all" ? undefined : category,
        archived: false,
        limit: 100,
      }),
    staleTime: 30_000,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["email", "message", selectedId],
    queryFn: () => emailApi.getMessage(selectedId!),
    enabled: !!selectedId,
    staleTime: 60_000,
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "read" | "unread" | "archive" | "unarchive" }) =>
      emailApi.messageAction(id, action),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["email", "messages"] });
      void qc.invalidateQueries({ queryKey: ["email", "counts"] });
      if (selectedId) {
        void qc.invalidateQueries({ queryKey: ["email", "message", selectedId] });
      }
    },
  });

  const handleSelect = (id: string) => {
    setSelectedId(id);
  };

  return (
    <>
      <TopNav title="Email" subtitle="AI-triaged inbox" />

      {/* Calendar strip — above the three columns */}
      <CalendarStrip
        prefill={calendarPrefill}
        onPrefillConsumed={() => setCalendarPrefill(null)}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Category rail */}
        <CategoryRail
          category={category}
          counts={counts}
          onSelect={(c) => {
            setCategory(c);
            setSelectedId(null);
          }}
        />

        {/* Message list */}
        <MessageList
          messages={messages}
          loading={listLoading}
          selectedId={selectedId}
          onSelect={handleSelect}
        />

        {/* Reading pane */}
        <ReadingPane
          message={detail ?? null}
          loading={detailLoading && !!selectedId}
          onAction={(action) => {
            if (selectedId) actionMutation.mutate({ id: selectedId, action });
          }}
          onAddToCalendar={(prefill) => setCalendarPrefill(prefill)}
        />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ //
// Category rail                                                        //
// ------------------------------------------------------------------ //

function CategoryRail({
  category,
  counts,
  onSelect,
}: {
  category: keyof CategoryCounts | "all";
  counts: CategoryCounts | undefined;
  onSelect: (c: keyof CategoryCounts | "all") => void;
}) {
  return (
    <nav className="hidden w-44 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] md:flex">
      <div className="px-3 py-3">
        <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Inbox
        </p>
        <div className="space-y-0.5">
          {CATEGORIES.map(({ key, label }) => {
            const count =
              key === "all"
                ? counts
                  ? Object.values(counts).reduce((a, b) => a + b, 0)
                  : 0
                : (counts?.[key as keyof CategoryCounts] ?? 0);
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelect(key as keyof CategoryCounts | "all")}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition",
                  category === key
                    ? "bg-[var(--accent)]/10 font-medium text-[var(--accent)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                )}
              >
                <span className="truncate">{label}</span>
                {count > 0 && (
                  <span
                    className={cn(
                      "ml-2 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                      category === key
                        ? "bg-[var(--accent)] text-white"
                        : "bg-[var(--border)] text-[var(--text-muted)]"
                    )}
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------ //
// Message list                                                         //
// ------------------------------------------------------------------ //

function MessageList({
  messages,
  loading,
  selectedId,
  onSelect,
}: {
  messages: EmailMessageBrief[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex w-72 shrink-0 flex-col items-center justify-center border-r border-[var(--border)]">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex w-72 shrink-0 flex-col items-center justify-center gap-2 border-r border-[var(--border)] text-[var(--text-muted)]">
        <Mail className="h-8 w-8 opacity-30" />
        <p className="text-sm">No messages</p>
      </div>
    );
  }

  return (
    <div className="promptly-scroll w-72 shrink-0 overflow-y-auto border-r border-[var(--border)]">
      {messages.map((msg) => (
        <MessageRow
          key={msg.id}
          message={msg}
          selected={msg.id === selectedId}
          onClick={() => onSelect(msg.id)}
        />
      ))}
    </div>
  );
}

function MessageRow({
  message: msg,
  selected,
  onClick,
}: {
  message: EmailMessageBrief;
  selected: boolean;
  onClick: () => void;
}) {
  const date = msg.date ? new Date(msg.date) : null;
  const dateStr = date
    ? isToday(date)
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString([], { month: "short", day: "numeric" })
    : "";

  const priorityColor =
    msg.ai_priority != null ? PRIORITY_COLORS[msg.ai_priority] ?? null : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-1 border-b border-[var(--border)] px-3 py-2.5 text-left transition",
        selected
          ? "bg-[var(--accent)]/10"
          : "hover:bg-[var(--hover)]",
        !msg.read && "font-semibold"
      )}
    >
      <div className="flex items-center gap-2">
        {priorityColor && (
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", priorityColor)} />
        )}
        <span className="min-w-0 flex-1 truncate text-xs">
          {msg.from_name || msg.from_address || "(unknown sender)"}
        </span>
        <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{dateStr}</span>
      </div>
      <p className="truncate text-xs">{msg.subject || "(no subject)"}</p>
      <p className="truncate text-[11px] text-[var(--text-muted)]">
        {msg.ai_summary || msg.snippet || ""}
      </p>
      <div className="flex items-center gap-2">
        {msg.needs_reply && (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
            <Reply className="h-2.5 w-2.5" />
            Reply needed
          </span>
        )}
        {msg.has_attachments && (
          <Paperclip className="h-3 w-3 text-[var(--text-muted)]" />
        )}
        {msg.due_at && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
            <Clock className="h-2.5 w-2.5" />
            {new Date(msg.due_at).toLocaleDateString([], { month: "short", day: "numeric" })}
          </span>
        )}
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ //
// Reading pane                                                         //
// ------------------------------------------------------------------ //

function ReadingPane({
  message,
  loading,
  onAction,
  onAddToCalendar,
}: {
  message: EmailMessageDetail | null;
  loading: boolean;
  onAction: (action: "read" | "unread" | "archive" | "unarchive") => void;
  onAddToCalendar: (prefill: { title: string; date: string; startTime: string }) => void;
}) {
  const [draftOpen, setDraftOpen] = useState(false);

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (!message) {
    return (
      <div className="hidden flex-1 flex-col items-center justify-center gap-2 text-[var(--text-muted)] md:flex">
        <Mail className="h-10 w-10 opacity-20" />
        <p className="text-sm">Select an email to read</p>
      </div>
    );
  }

  const date = message.date ? new Date(message.date).toLocaleString() : "";

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-2">
        <button
          type="button"
          onClick={() => onAction(message.archived ? "unarchive" : "archive")}
          title={message.archived ? "Unarchive" : "Archive"}
          className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          {message.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => onAction(message.read ? "unread" : "read")}
          title={message.read ? "Mark unread" : "Mark read"}
          className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <CheckCheck className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setDraftOpen((o) => !o)}
          title="Draft reply"
          className={cn(
            "inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium transition",
            draftOpen
              ? "bg-[var(--accent)]/10 text-[var(--accent)]"
              : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          )}
        >
          <Reply className="h-3.5 w-3.5" />
          Reply
        </button>
        <div className="flex-1" />
        {message.due_at && (
          <button
            type="button"
            onClick={() => {
              const due = new Date(message.due_at!);
              onAddToCalendar({
                title: message.subject || "Email follow-up",
                date: due.toISOString().slice(0, 10),
                startTime: due.toTimeString().slice(0, 5),
              });
            }}
            title="Add to calendar"
            className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <CalendarPlus className="h-3.5 w-3.5" />
            Add to calendar
          </button>
        )}
        {message.needs_reply && (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400">
            <AtSign className="h-3 w-3" />
            Reply needed
          </span>
        )}
      </div>

      {/* Header */}
      <div className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-base font-semibold">{message.subject || "(no subject)"}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
          <span>
            <span className="font-medium text-[var(--text)]">
              {message.from_name || message.from_address}
            </span>
            {message.from_name && message.from_address && (
              <span className="ml-1 opacity-60">&lt;{message.from_address}&gt;</span>
            )}
          </span>
          {date && <span>{date}</span>}
        </div>
        {message.to_addresses?.length > 0 && (
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            To: {message.to_addresses.join(", ")}
          </p>
        )}
      </div>

      {/* AI summary card */}
      {message.ai_summary && (
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--accent)]/5 px-4 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--accent)]">
            AI summary
          </p>
          <p className="mt-1 text-xs leading-relaxed">{message.ai_summary}</p>
          {message.due_at && (
            <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
              <Clock className="h-3 w-3" />
              Due {new Date(message.due_at).toLocaleDateString()}
            </p>
          )}
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {message.body_html ? (
          <SandboxedBody html={message.body_html} />
        ) : message.body_text ? (
          <pre className="whitespace-pre-wrap px-4 py-4 font-sans text-sm leading-relaxed">
            {message.body_text}
          </pre>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-[var(--text-muted)]">
            <Mail className="h-8 w-8 opacity-20" />
            <p className="text-sm">No body content</p>
          </div>
        )}
      </div>

      {/* Draft reply composer */}
      {draftOpen && (
        <DraftReplyComposer
          message={message}
          onClose={() => setDraftOpen(false)}
        />
      )}

      {/* AI assistant */}
      {!draftOpen && <EmailAssistant message={message} />}
    </div>
  );
}

// ------------------------------------------------------------------ //
// Draft reply composer                                                 //
// ------------------------------------------------------------------ //

function DraftReplyComposer({
  message,
  onClose,
}: {
  message: EmailMessageDetail;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const generateDraft = async () => {
    setDrafting(true);
    setError(null);
    try {
      const { draft: text } = await emailApi.draftReply(message.id);
      setDraft(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Draft generation failed.");
    } finally {
      setDrafting(false);
    }
  };

  const handleSend = async () => {
    setSending(true);
    setError(null);
    try {
      await emailApi.sendReply(message.id, draft);
      setSent(true);
      setConfirmOpen(false);
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setSending(false);
    }
  };

  const recipient = message.from_name
    ? `${message.from_name} <${message.from_address}>`
    : (message.from_address ?? "");

  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]">
      {/* Composer header */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2">
        <Reply className="h-3.5 w-3.5 text-[var(--text-muted)]" />
        <span className="text-xs font-medium">
          Reply to{" "}
          <span className="text-[var(--text)]">{recipient}</span>
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={generateDraft}
          disabled={drafting}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-50"
        >
          {drafting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          {drafting ? "Generating…" : "AI draft"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={drafting ? "Generating draft…" : "Write your reply…"}
        disabled={drafting}
        rows={5}
        className="w-full resize-none bg-transparent px-4 py-3 text-sm placeholder:text-[var(--text-muted)] focus:outline-none disabled:opacity-50"
      />

      {error && (
        <p className="px-4 pb-2 text-xs text-red-500">{error}</p>
      )}

      {sent && (
        <p className="px-4 pb-2 text-xs text-green-600 dark:text-green-400">
          Sent successfully.
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2">
        <div className="flex-1" />
        {confirmOpen ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-muted)]">
              Send to <strong>{recipient}</strong>?
            </span>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending}
              className="inline-flex items-center gap-1.5 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Confirm send
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={!draft.trim() || drafting}
            className="inline-flex items-center gap-1.5 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            <Send className="h-3 w-3" />
            Send
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ //
// Email assistant (in-pane AI chat)                                   //
// ------------------------------------------------------------------ //

function EmailAssistant({ message }: { message: EmailMessageDetail }) {
  const [input, setInput] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const instr = input.trim();
    if (!instr) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const { response: text } = await emailApi.aiAssist(message.id, instr);
      setResponse(text);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI assist failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-[var(--border)]">
      {response && (
        <div className="border-b border-[var(--border)] bg-[var(--accent)]/5 px-4 py-2.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--accent)]">
              AI response
            </p>
            <button
              type="button"
              onClick={() => setResponse(null)}
              className="text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{response}</p>
        </div>
      )}
      {error && (
        <p className="border-b border-[var(--border)] px-4 py-2 text-xs text-red-500">{error}</p>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="Ask about this email… (summarise, draft a decline, etc.)"
          disabled={loading}
          className="flex-1 bg-transparent text-xs placeholder:text-[var(--text-muted)] focus:outline-none disabled:opacity-50"
        />
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />}
      </div>
    </div>
  );
}

/**
 * Sandboxed iframe for HTML email bodies.
 *
 * Security: allow-scripts is NOT set (scripts blocked). allow-same-origin is
 * NOT set (iframe has null origin — JS can't touch parent DOM). External
 * images are blocked via a restrictive Content-Security-Policy injected into
 * the srcdoc: the user must explicitly choose to load remote images.
 */
function SandboxedBody({ html }: { html: string }) {
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'";
  const srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6; word-wrap: break-word; }
  a { color: inherit; }
  img { max-width: 100%; height: auto; }
</style>
</head>
<body>${html}</body>
</html>`;

  return (
    <iframe
      srcDoc={srcdoc}
      sandbox="allow-popups"
      className="h-full w-full border-0"
      title="Email body"
    />
  );
}

// ------------------------------------------------------------------ //
// Helpers                                                              //
// ------------------------------------------------------------------ //

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}
