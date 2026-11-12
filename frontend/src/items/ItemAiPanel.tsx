import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Check, FileText, Globe, Loader2, Paperclip, RotateCcw, Sparkles, SquarePen, Square, TriangleAlert, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { filesApi } from "@/api/files";
import { useAvailableModels } from "@/hooks/useProviders";
import { NO_MODEL_MESSAGE, useEditorModel } from "@/lib/editorModel";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { itemsApi, type AiTurn, type ItemSpecInfo } from "./api";
import type { ItemHandle } from "./useItem";

const MAX_ATTACHED = 5;
const ATTACHED_ONLY = "Here's a file for this.";

/**
 * The assistant inside an item: ask it to do things *in* the app ("plan my
 * week", "log 3×8 bench at 80", "build a grocery list"). It works with the
 * file through the kind's actions; when it changes something, the new state
 * lands on screen at once and the turn offers Undo. The thread is kept per
 * person, per file. Desktop: a side panel. Phone: the "Ask" tab.
 */
export function ItemAiPanel({
  item,
  spec,
  pendingPrompt,
  onPendingTaken,
  onClose,
  variant,
}: {
  item: ItemHandle<any>;
  spec: ItemSpecInfo;
  pendingPrompt?: { text: string; send: boolean } | null;
  onPendingTaken?: () => void;
  onClose?: () => void;
  variant: "side" | "tab";
}) {
  // An item opened straight from a link hasn't been to Chat, where the
  // model list is usually loaded.
  const models = useAvailableModels();
  const { providerId, modelId } = useEditorModel();
  const { data: saved, isLoading } = useQuery({
    queryKey: ["item-thread", item.fileId],
    queryFn: () => itemsApi.thread(item.fileId),
    staleTime: 60_000,
  });
  const [turns, setTurns] = useState<AiTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Seconds since the request started — so a long job visibly hasn't frozen.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [busy]);
  const since = elapsed >= 5 ? ` · ${elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}` : "";
  const [undone, setUndone] = useState<Set<string>>(new Set());
  const abort = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [attached, setAttached] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);

  const attach = useCallback(async (chosen: FileList | null) => {
    if (!chosen?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(chosen).slice(0, MAX_ATTACHED)) {
        const saved = await filesApi.upload("mine", file, null, "chat");
        setAttached((rows) => (rows.length >= MAX_ATTACHED ? rows : [...rows, { id: saved.id, name: saved.filename }]));
      }
    } catch {
      toast.error("That file couldn't be uploaded.");
    } finally {
      setUploading(false);
    }
  }, []);

  useEffect(() => {
    if (saved) {
      setTurns(saved);
      setUndone(new Set(saved.filter((t) => t.undone && t.version_id).map((t) => t.version_id!)));
    }
  }, [saved]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy, status]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      if (!providerId || !modelId) {
        toast.error(models.isLoading ? "Loading your models — try again in a moment." : NO_MODEL_MESSAGE);
        return;
      }
      setDraft("");
      setBusy(true);
      setStatus(null);
      const ctrl = new AbortController();
      abort.current = ctrl;
      const reply: AiTurn = { role: "assistant", content: "", actions: [] };
      const sending = attached;
      setAttached([]);
      const shown = sending.length ? `${message}\n\n[Attached: ${sending.map((a) => a.name).join(", ")}]` : message;
      setTurns((t) => [...t, { role: "user", content: shown }, reply]);
      const patch = (fn: (r: AiTurn) => void) =>
        setTurns((t) => {
          const copy = t.slice();
          const last = { ...copy[copy.length - 1], actions: [...(copy[copy.length - 1].actions ?? [])] };
          fn(last);
          copy[copy.length - 1] = last;
          return copy;
        });
      try {
        for await (const ev of itemsApi.ask(
          item.fileId,
          { message, provider_id: providerId, model_id: modelId, attachment_ids: sending.map((a) => a.id) },
          ctrl.signal,
        )) {
          if (ev.type === "text") {
            setStatus(null);
            patch((r) => (r.content += ev.text));
          } else if (ev.type === "action") {
            setStatus(null);
            patch((r) => r.actions!.push({ name: ev.name, summary: ev.summary, ok: ev.ok }));
          } else if (ev.type === "status") {
            setStatus(ev.text);
          } else if (ev.type === "done") {
            if (ev.changed && ev.data) item.accept(ev.data, ev.revision);
            patch((r) => (r.version_id = ev.version_id));
          } else if (ev.type === "error") {
            patch((r) => (r.content = (r.content ? r.content + "\n\n" : "") + `⚠️ ${ev.message}`));
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          patch((r) => (r.content = (r.content ? r.content + "\n\n" : "") + "⚠️ The assistant couldn't be reached."));
        }
      } finally {
        setBusy(false);
        setStatus(null);
        abort.current = null;
      }
    },
    [attached, busy, item, modelId, models.isLoading, providerId],
  );

  // A prompt from elsewhere in the item ("Ask AI to plan this week").
  useEffect(() => {
    if (pendingPrompt && !busy && !isLoading) {
      onPendingTaken?.();
      if (pendingPrompt.send) void send(pendingPrompt.text);
      else {
        setDraft(pendingPrompt.text);
        window.setTimeout(() => {
          const el = input.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }, 50);
      }
    }
  }, [pendingPrompt, busy, isLoading, onPendingTaken, send]);

  const undo = async (versionId: string) => {
    try {
      const res = await itemsApi.restore(item.fileId, versionId);
      item.accept(res.data, res.revision);
      setUndone((s) => new Set(s).add(versionId));
      toast.success("Undone");
    } catch {
      toast.error("Couldn't undo — the file may have changed since. Use version history instead.");
    }
  };

  const clear = async () => {
    if (busy) return;
    await itemsApi.clearThread(item.fileId).catch(() => undefined);
    setTurns([]);
    setUndone(new Set());
  };

  const empty = !isLoading && turns.length === 0;
  return (
    <div className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--bg)]", variant === "side" && "border-l border-[var(--border)]")}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <Sparkles className="h-4 w-4 text-[var(--item-accent)]" />
        <span className="flex-1 truncate text-sm font-semibold text-[var(--text)]">Ask {spec.name}</span>
        {spec.ai_web && (
          <span title="Can look things up on the web" className="text-[var(--text-muted)]">
            <Globe className="h-3.5 w-3.5" />
          </span>
        )}
        <button
          type="button"
          onClick={clear}
          disabled={busy || turns.length === 0}
          title="New conversation"
          aria-label="New conversation"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-40"
        >
          <SquarePen className="h-4 w-4" />
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the assistant"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3" aria-live="polite">
        {isLoading && (
          <div className="flex justify-center py-8 text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {empty && (
          <div className="flex flex-col gap-4 px-1 py-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
                <Sparkles className="h-5 w-5" />
              </span>
              <p className="text-sm font-semibold text-[var(--text)]">Your {spec.name} assistant</p>
              <p className="max-w-xs text-xs text-[var(--text-muted)]">
                {item.canEdit
                  ? "It can read this file and make changes for you — every change can be undone."
                  : "You can only view this file, so it'll answer questions but won't change anything."}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              {spec.ai_suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-left text-sm text-[var(--text)] transition hover:border-[var(--item-accent)]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="ml-8 self-end rounded-2xl rounded-br-md bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text)]">
                {t.content}
              </div>
            ) : (
              <div key={i} className="flex flex-col gap-2">
                {!!t.actions?.length && (
                  <ul className="flex flex-col gap-1">
                    {t.actions.map((a, j) => (
                      <li
                        key={j}
                        className={cn(
                          "flex items-start gap-2 rounded-lg px-2 py-1 text-xs",
                          a.ok ? "bg-[color-mix(in_srgb,var(--item-accent)_9%,transparent)] text-[var(--text)]" : "text-[var(--text-muted)]",
                        )}
                      >
                        {a.ok ? (
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--item-accent)]" />
                        ) : (
                          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="min-w-0">{a.summary}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {t.content ? (
                  <div className="prose prose-sm max-w-none text-[var(--text)] dark:prose-invert prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5 prose-headings:mb-1 prose-headings:mt-3 prose-table:text-xs [overflow-wrap:anywhere] prose-table:block prose-table:max-w-full prose-table:overflow-x-auto prose-a:break-all">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.content}</ReactMarkdown>
                  </div>
                ) : busy && i === turns.length - 1 ? (
                  <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {status ?? "Thinking…"}
                    {since}
                  </div>
                ) : null}
                {busy && i === turns.length - 1 && t.content && status && (
                  <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]" role="status">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {status}
                    {since}
                  </div>
                )}
                {t.version_id && item.canEdit && (
                  <div>
                    {undone.has(t.version_id) ? (
                      <span className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
                        <RotateCcw className="h-3 w-3" /> Undone
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void undo(t.version_id!)}
                        className="inline-flex h-7 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                      >
                        <Undo2 className="h-3 w-3" /> Undo these changes
                      </button>
                    )}
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      </div>

      <form
        className={cn("shrink-0 border-t border-[var(--border)] p-2", variant === "tab" && "pb-2")}
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft || (attached.length ? ATTACHED_ONLY : ""));
        }}
      >
        {(attached.length > 0 || uploading) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attached.map((a) => (
              <span
                key={a.id}
                className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate">{a.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttached((rows) => rows.filter((r) => r.id !== a.id))}
                  className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
            {uploading && (
              <span className="inline-flex items-center gap-1 px-1 py-1 text-xs text-[var(--text-muted)]" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…
              </span>
            )}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1.5 focus-within:border-[var(--item-accent)]">
          {item.canEdit && (
            <>
              <input
                ref={picker}
                type="file"
                multiple
                accept=".pdf,.txt,.csv,.docx,image/*"
                aria-label="Attach a file"
                className="hidden"
                onChange={(e) => {
                  void attach(e.currentTarget.files);
                  e.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => picker.current?.click()}
                disabled={busy || uploading || attached.length >= MAX_ATTACHED}
                aria-label="Attach a file"
                title="Attach a file"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-50"
              >
                <Paperclip className="h-4 w-4" />
              </button>
            </>
          )}
          <textarea
            ref={input}
            value={draft}
            rows={1}
            onChange={(e) => {
              setDraft(e.target.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = `${Math.min(160, e.currentTarget.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft || (attached.length ? ATTACHED_ONLY : ""));
              }
            }}
            placeholder={item.canEdit ? `Ask ${spec.name} to do something…` : "Ask about this file…"}
            aria-label={`Ask ${spec.name}`}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] md:text-sm"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => abort.current?.abort()}
              aria-label="Stop"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-2)] text-[var(--text)]"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={(!draft.trim() && !attached.length) || uploading}
              aria-label="Send"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--item-accent-fill)] text-white transition disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
