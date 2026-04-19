import { useMemo, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useCreateStudyProject } from "@/hooks/useStudy";
import { useAvailableModels } from "@/hooks/useProviders";
import { useModelStore, useSelectedModel } from "@/store/modelStore";
import { cn } from "@/utils/cn";

interface NewStudyWizardProps {
  open: boolean;
  onClose: () => void;
}

export function NewStudyWizard({ open, onClose }: NewStudyWizardProps) {
  const navigate = useNavigate();
  const create = useCreateStudyProject();
  const { isLoading: modelsLoading } = useAvailableModels();
  const available = useModelStore((s) => s.available);
  const currentSelection = useSelectedModel();
  const setSelection = useModelStore((s) => s.setSelection);

  const [title, setTitle] = useState("");
  const [topicDraft, setTopicDraft] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [goal, setGoal] = useState("");
  const [modelKey, setModelKey] = useState<string>(() =>
    currentSelection
      ? `${currentSelection.provider_id}:${currentSelection.model_id}`
      : ""
  );
  const [error, setError] = useState<string | null>(null);

  const modelOptions = useMemo(
    () =>
      available.map((m) => ({
        key: `${m.provider_id}:${m.model_id}`,
        label: `${m.display_name} — ${m.provider_name}`,
        providerId: m.provider_id,
        modelId: m.model_id,
      })),
    [available]
  );

  const reset = () => {
    setTitle("");
    setTopicDraft("");
    setTopics([]);
    setGoal("");
    setError(null);
  };

  const handleClose = () => {
    if (create.isPending) return;
    reset();
    onClose();
  };

  const addTopic = () => {
    const t = topicDraft.trim();
    if (!t) return;
    if (topics.includes(t)) {
      setTopicDraft("");
      return;
    }
    setTopics((prev) => [...prev, t]);
    setTopicDraft("");
  };

  const handleTopicKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTopic();
    } else if (e.key === "Backspace" && !topicDraft && topics.length > 0) {
      setTopics((prev) => prev.slice(0, -1));
    }
  };

  const handleCreate = async () => {
    setError(null);
    const t = title.trim();
    if (!t) {
      setError("Give your study session a title.");
      return;
    }
    const opt = modelOptions.find((m) => m.key === modelKey);
    // Model is optional at creation time — the session picker can set it
    // later. We only pass it if chosen here.
    try {
      const detail = await create.mutateAsync({
        title: t,
        topics,
        goal: goal.trim() || null,
        model_id: opt?.modelId ?? null,
        provider_id: opt?.providerId ?? null,
      });
      // Sync the global model selection so the session's TopNav reflects
      // the user's intent without a second click.
      if (opt) setSelection(opt.providerId, opt.modelId);

      // The server creates an initial session for us; open it directly.
      const first = detail.sessions[0];
      reset();
      onClose();
      if (first) {
        navigate(`/study/sessions/${first.id}`);
      } else {
        // Fallback — shouldn't happen because create_session defaults true.
        navigate(`/study`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New study session"
      description="Set up a focused tutor session. You can tweak any of this later."
      widthClass="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            loading={create.isPending}
            disabled={!title.trim()}
          >
            Start session
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Session title">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. CCNA Subnetting"
            className={inputCls}
          />
        </Field>

        <Field
          label="Topics to study"
          hint="Press Enter or comma to add each topic."
        >
          {topics.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {topics.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-2.5 py-1 text-xs text-[var(--accent)]"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() =>
                      setTopics((prev) => prev.filter((x) => x !== t))
                    }
                    className="rounded-full p-0.5 hover:bg-[var(--accent)]/20"
                    aria-label={`Remove ${t}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            type="text"
            value={topicDraft}
            onChange={(e) => setTopicDraft(e.target.value)}
            onKeyDown={handleTopicKey}
            onBlur={addTopic}
            placeholder="VLSM, CIDR, subnetting math..."
            className={inputCls}
          />
        </Field>

        <Field
          label="What are you trying to achieve?"
          hint="Optional — helps the tutor tailor explanations."
        >
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="I'm sitting my CCNA next month and I want to get faster at subnet math."
            rows={3}
            className={cn(inputCls, "min-h-[84px] resize-y")}
          />
        </Field>

        <Field label="Study model">
          {modelsLoading ? (
            <div className="text-xs text-[var(--text-muted)]">Loading models...</div>
          ) : modelOptions.length === 0 ? (
            <div className="rounded-card border border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
              No models configured yet. Add a provider in the Models tab, then
              come back — we'll default to whatever you pick later.
            </div>
          ) : (
            <select
              value={modelKey}
              onChange={(e) => setModelKey(e.target.value)}
              className={inputCls}
            >
              <option value="">Pick later</option>
              {modelOptions.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        {error && (
          <div
            role="alert"
            className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

const inputCls = cn(
  "block w-full rounded-input border bg-[var(--bg)] px-3 py-2 text-sm",
  "border-[var(--border)] text-[var(--text)]",
  "focus:border-[var(--accent)]/60 focus:outline-none"
);

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-[var(--text)]">{label}</div>
      {children}
      {hint && (
        <div className="mt-1 text-[11px] text-[var(--text-muted)]">{hint}</div>
      )}
    </label>
  );
}
