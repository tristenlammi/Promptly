import { useMemo, useState } from "react";
import { Pencil, UserCircle2, X, Check } from "lucide-react";

import { Button } from "@/components/shared/Button";
import {
  useLearnerProfileQuery,
  useUpdateLearnerProfile,
} from "@/hooks/useStudy";

interface LearnerProfilePanelProps {
  projectId: string;
}

/** Renders + edits the durable ``learner_profile`` JSONB for a study
 *  project. This is the single source of truth for "what does the
 *  tutor know about you?" — showing it here, editable, is how we
 *  prove Persistent state 10/10 to the user: the tutor isn't
 *  forgetting, it's reading from this row, and you can correct it.
 */
export function LearnerProfilePanel({ projectId }: LearnerProfilePanelProps) {
  const { data, isLoading } = useLearnerProfileQuery(projectId);
  const update = useUpdateLearnerProfile();
  const [editing, setEditing] = useState(false);

  const profile = data?.profile ?? {};
  const hasAny = useMemo(() => {
    const occ = profile.occupation?.trim();
    const bg = profile.background?.trim();
    const interests = profile.interests ?? [];
    const goals = profile.goals ?? [];
    const prefs = profile.preferred_examples_from ?? [];
    return Boolean(
      occ || bg || interests.length || goals.length || prefs.length
    );
  }, [profile]);

  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <UserCircle2 className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="text-sm font-semibold text-[var(--text)]">
            Learner profile
          </h3>
        </div>
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            disabled={isLoading}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
      </header>

      {!editing && (
        <div className="mt-3 space-y-2 text-xs text-[var(--text-muted)]">
          {!hasAny && !isLoading && (
            <p className="italic">
              Your tutor doesn&rsquo;t know much about you yet — it&rsquo;ll
              ask in the next session, or you can add context here.
            </p>
          )}
          {profile.occupation && (
            <Row label="Occupation" value={profile.occupation} />
          )}
          {profile.interests && profile.interests.length > 0 && (
            <Row label="Interests" value={profile.interests.join(", ")} />
          )}
          {profile.goals && profile.goals.length > 0 && (
            <Row label="Goals" value={profile.goals.join(" · ")} />
          )}
          {profile.background && (
            <Row label="Background" value={profile.background} />
          )}
          {profile.preferred_examples_from &&
            profile.preferred_examples_from.length > 0 && (
              <Row
                label="Prefer examples from"
                value={profile.preferred_examples_from.join(", ")}
              />
            )}
        </div>
      )}

      {editing && (
        <LearnerProfileForm
          initial={{
            occupation: profile.occupation ?? "",
            interests: (profile.interests ?? []).join(", "),
            goals: (profile.goals ?? []).join(", "),
            background: profile.background ?? "",
            preferred_examples_from: (
              profile.preferred_examples_from ?? []
            ).join(", "),
          }}
          submitting={update.isPending}
          onCancel={() => setEditing(false)}
          onSave={(vals) => {
            update.mutate(
              {
                projectId,
                payload: {
                  occupation: vals.occupation.trim() || null,
                  interests: splitList(vals.interests),
                  goals: splitList(vals.goals),
                  background: vals.background.trim() || null,
                  preferred_examples_from: splitList(
                    vals.preferred_examples_from
                  ),
                },
              },
              { onSuccess: () => setEditing(false) }
            );
          }}
        />
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </div>
      <div className="text-[var(--text)]">{value}</div>
    </div>
  );
}

interface FormValues {
  occupation: string;
  interests: string;
  goals: string;
  background: string;
  preferred_examples_from: string;
}

function LearnerProfileForm({
  initial,
  submitting,
  onCancel,
  onSave,
}: {
  initial: FormValues;
  submitting: boolean;
  onCancel: () => void;
  onSave: (vals: FormValues) => void;
}) {
  const [vals, setVals] = useState<FormValues>(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(vals);
      }}
      className="mt-3 space-y-3"
    >
      <Field
        label="Occupation"
        hint="e.g. software engineer, high-school teacher"
        value={vals.occupation}
        onChange={(v) => setVals({ ...vals, occupation: v })}
      />
      <Field
        label="Interests (comma-separated)"
        hint="e.g. climbing, jazz piano, video games"
        value={vals.interests}
        onChange={(v) => setVals({ ...vals, interests: v })}
      />
      <Field
        label="Goals"
        hint="What are you hoping to do with this?"
        value={vals.goals}
        onChange={(v) => setVals({ ...vals, goals: v })}
      />
      <Field
        label="Background"
        hint="Anything your tutor should know about what you already know."
        multiline
        value={vals.background}
        onChange={(v) => setVals({ ...vals, background: v })}
      />
      <Field
        label="Prefer examples from"
        hint="Domains you'd like the tutor to draw analogies from"
        value={vals.preferred_examples_from}
        onChange={(v) =>
          setVals({ ...vals, preferred_examples_from: v })
        }
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          <Check className="h-3.5 w-3.5" />
          {submitting ? "Saving..." : "Save"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  multiline,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  return (
    <label className="block text-xs">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </span>
      {multiline ? (
        <textarea
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && (
        <span className="mt-0.5 block text-[10px] text-[var(--text-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
