import { ClipboardList } from "lucide-react";
import { Link } from "react-router-dom";

import type { ActivityStep } from "@/components/chat/ToolActivityCard";

interface FormCard {
  file_id: string;
  title: string;
  questions: number;
  url: string;
}

/** A draft form the chat made (``draft_form``, Forms WP-F1.7): "BBQ sign-up
 *  (draft) · Open to check and send". It isn't taking answers and has no
 *  link until the person sends it from the builder. */
export function FormDraftChips({ steps }: { steps: ActivityStep[] }) {
  const cards = steps
    .filter((s) => s.status === "ok" && s.meta && typeof s.meta === "object" && "form_card" in s.meta)
    .map((s) => (s.meta as { form_card: FormCard }).form_card)
    .filter((c) => c && typeof c.url === "string" && c.url.startsWith("/files/form/"));
  if (cards.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {cards.map((c) => (
        <Link
          key={c.file_id}
          to={c.url}
          className="flex max-w-md items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2.5 text-left transition hover:border-[var(--accent)] hover:bg-[var(--hover)]"
          data-testid="form-draft-card"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#7c3aed]/10 text-[#7c3aed]">
            <ClipboardList className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-[var(--text)]">{c.title} (draft)</span>
            <span className="block text-xs text-[var(--text-muted)]">
              {c.questions === 1 ? "1 question" : `${c.questions} questions`} · Open to check and send
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}
