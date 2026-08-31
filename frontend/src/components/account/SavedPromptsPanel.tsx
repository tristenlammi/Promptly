import { useNavigate } from "react-router-dom";
import { ArrowRight, Sparkles } from "lucide-react";

import { Button } from "@/components/shared/Button";

/**
 * Signpost, not an editor.
 *
 * Saved prompts moved into the command library (Automations → Prompts),
 * because a prompt and a voice command turned out to be the same object
 * with different action types — they share one `/` menu and one
 * matcher. Leaving a second editor here would mean two lists of the
 * same rows drifting apart, which is the exact failure the merge
 * existed to prevent.
 *
 * The section stays rather than disappearing: people know to look here,
 * and a one-line pointer costs less than a surface vanishing without
 * explanation.
 */
export function SavedPromptsPanel() {
  const navigate = useNavigate();

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <span className="text-[var(--text-muted)]">
          <Sparkles className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-semibold">Saved prompts</h3>
      </header>

      <div className="px-4 py-4">
        <p className="text-sm text-[var(--text-muted)]">
          Saved prompts now live in <strong>Automations → Prompts</strong>,
          alongside the commands you can run by asking. Everything you had
          is already there, and <code className="font-mono">/</code> in any
          chat still inserts them exactly as before.
        </p>
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
            onClick={() => navigate("/tasks")}
          >
            Open Automations
          </Button>
        </div>
      </div>
    </section>
  );
}
