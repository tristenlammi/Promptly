import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Sparkles, X } from "lucide-react";

import type { StudyCurrentLevel } from "@/api/types";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useCreateStudyProject } from "@/hooks/useStudy";
import { useAvailableModels } from "@/hooks/useProviders";
import { useModelStore, useSelectedModel } from "@/store/modelStore";
import { cn } from "@/utils/cn";

type LevelOption = {
  value: StudyCurrentLevel;
  label: string;
  description: string;
};

// The three level values mirror ``CurrentLevel`` in the backend schema.
// Kept as radio cards (not a dropdown) because the descriptions matter
// — students need to see what "some exposure" actually implies before
// they pick it, and a dropdown would hide that context behind a click.
const LEVEL_OPTIONS: LevelOption[] = [
  {
    value: "beginner",
    label: "Complete beginner",
    description: "I've never studied this topic before.",
  },
  {
    value: "some_exposure",
    label: "Some exposure",
    description: "I know the basics but want to go deeper.",
  },
  {
    value: "refresher",
    label: "Refresher",
    description: "I know most of this — I'm firming it up for an exam or interview.",
  },
];

interface NewStudyWizardProps {
  open: boolean;
  onClose: () => void;
}

type WizardStep = "form" | "planning";

export function NewStudyWizard({ open, onClose }: NewStudyWizardProps) {
  const navigate = useNavigate();
  const create = useCreateStudyProject();
  const { isLoading: modelsLoading } = useAvailableModels();
  const available = useModelStore((s) => s.available);
  const currentSelection = useSelectedModel();
  const setSelection = useModelStore((s) => s.setSelection);

  const [step, setStep] = useState<WizardStep>("form");
  const [title, setTitle] = useState("");
  const [learningRequest, setLearningRequest] = useState("");
  const [goal, setGoal] = useState("");
  const [currentLevel, setCurrentLevel] = useState<StudyCurrentLevel | null>(
    null
  );
  const [topicDraft, setTopicDraft] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [modelKey, setModelKey] = useState<string>(() =>
    currentSelection
      ? `${currentSelection.provider_id}:${currentSelection.model_id}`
      : ""
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Reset every time the dialog opens so leftover state from the
    // previous session doesn't linger.
    setStep("form");
    setError(null);
  }, [open]);

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
    setLearningRequest("");
    setGoal("");
    setCurrentLevel(null);
    setTopicDraft("");
    setTopics([]);
    setError(null);
    setStep("form");
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
    const request = learningRequest.trim();
    if (!t) {
      setError("Give your study topic a title.");
      return;
    }
    if (request.length < 20) {
      setError(
        "Tell Promptly a bit more about what you want to learn (at least a couple of sentences)."
      );
      return;
    }
    const opt = modelOptions.find((m) => m.key === modelKey);
    if (!opt) {
      setError("Pick a model so the AI can design your study plan.");
      return;
    }

    setStep("planning");
    try {
      const detail = await create.mutateAsync({
        title: t,
        topics,
        goal: goal.trim() || null,
        learning_request: request,
        current_level: currentLevel,
        model_id: opt.modelId,
        provider_id: opt.providerId,
      });
      setSelection(opt.providerId, opt.modelId);
      reset();
      onClose();
      navigate(`/study/topics/${detail.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStep("form");
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={step === "form" ? "New study topic" : "Designing your study plan"}
      description={
        step === "form"
          ? "Tell the tutor what you want to learn. It'll design a plan of focused units for you."
          : undefined
      }
      widthClass="max-w-xl"
      footer={
        step === "form" ? (
          <>
            <Button
              variant="ghost"
              onClick={handleClose}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={create.isPending}
              disabled={!title.trim() || !learningRequest.trim()}
              leftIcon={<Sparkles className="h-4 w-4" />}
            >
              Design my plan
            </Button>
          </>
        ) : undefined
      }
    >
      {step === "form" ? (
        <div className="space-y-4">
          <Field label="Topic title">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. CCNA Subnetting, Organic Chemistry, JavaScript fundamentals"
              className={inputCls}
            />
          </Field>

          <Field
            label="What do you want to learn?"
            hint="Be specific — the AI uses this to build your unit plan."
          >
            <textarea
              value={learningRequest}
              onChange={(e) => setLearningRequest(e.target.value)}
              placeholder={
                "I want to understand IP subnetting from the ground up — binary conversion, CIDR notation, VLSM, " +
                "and be able to design subnet schemes for small networks without relying on a calculator."
              }
              rows={5}
              className={cn(inputCls, "min-h-[120px] resize-y")}
            />
          </Field>

          <Field
            label="What's your end goal?"
            hint="Optional — a deadline, exam, or outcome the plan should aim for."
          >
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Pass my CCNA in 6 weeks."
              rows={2}
              className={cn(inputCls, "min-h-[60px] resize-y")}
            />
          </Field>

          <Field
            label="How much do you already know?"
            hint="Optional, but worth answering — the plan comes out very differently for a true beginner vs. someone refreshing."
          >
            <div
              role="radiogroup"
              aria-label="Current level"
              className="grid gap-2 sm:grid-cols-3"
            >
              {LEVEL_OPTIONS.map((opt) => {
                const selected = currentLevel === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() =>
                      setCurrentLevel(selected ? null : opt.value)
                    }
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-card border px-3 py-2.5 text-left transition",
                      "focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50",
                      selected
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                        : "border-[var(--border)] bg-[var(--bg)] text-[var(--text)] hover:border-[var(--accent)]/50"
                    )}
                  >
                    <span className="text-xs font-semibold leading-tight">
                      {opt.label}
                    </span>
                    <span className="text-[11px] leading-snug text-[var(--text-muted)]">
                      {opt.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>

          <Field
            label="Specific focus areas"
            hint="Optional — press Enter or comma to add each one."
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
              placeholder="VLSM, CIDR, subnet math..."
              className={inputCls}
            />
          </Field>

          <Field label="Study model">
            {modelsLoading ? (
              <div className="text-xs text-[var(--text-muted)]">
                Loading models...
              </div>
            ) : modelOptions.length === 0 ? (
              <div className="rounded-card border border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
                No models configured yet. Add a provider in the Models tab and
                come back.
              </div>
            ) : (
              <select
                value={modelKey}
                onChange={(e) => setModelKey(e.target.value)}
                className={inputCls}
              >
                <option value="">Pick a model...</option>
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
      ) : (
        <PlanningScreen />
      )}
    </Modal>
  );
}

function PlanningScreen() {
  const [stage, setStage] = useState(0);
  const stages = [
    "Parsing your learning goals...",
    "Mapping prerequisites and skill order...",
    "Drafting focused units with clear objectives...",
    "Finalising your study plan...",
  ];
  useEffect(() => {
    const t = setInterval(() => {
      setStage((s) => Math.min(s + 1, stages.length - 1));
    }, 4500);
    return () => clearInterval(t);
  }, [stages.length]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)]/10">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--accent)]" />
      </div>
      <div className="max-w-sm">
        <h3 className="text-base font-semibold text-[var(--text)]">
          Designing your study plan
        </h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Promptly is breaking your topic into focused units. This usually
          takes 10–30 seconds — we'll drop you straight into the plan when
          it's ready.
        </p>
      </div>
      <div className="mt-4 w-full max-w-sm space-y-1 text-left text-xs text-[var(--text-muted)]">
        {stages.map((s, idx) => (
          <div
            key={s}
            className={cn(
              "flex items-center gap-2 transition",
              idx <= stage ? "text-[var(--text)]" : "opacity-40"
            )}
          >
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                idx < stage
                  ? "bg-[var(--accent)]"
                  : idx === stage
                  ? "animate-pulse bg-[var(--accent)]"
                  : "bg-[var(--border)]"
              )}
            />
            {s}
          </div>
        ))}
      </div>
    </div>
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
