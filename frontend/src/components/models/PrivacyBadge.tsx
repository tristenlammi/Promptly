import { ShieldCheck, ShieldAlert, ShieldQuestion, Shield } from "lucide-react";

import type { ModelPrivacy } from "@/api/types";
import { cn } from "@/utils/cn";

/**
 * Renders a compact, honest summary of an upstream endpoint's data
 * policies for a single model. The goal isn't to *filter* anything —
 * it's to give the admin the same information OpenRouter shows on
 * their own model pages, but at the moment they're deciding whether
 * to enable the model.
 *
 * Interpretation is derived from raw endpoint counts rather than
 * baked into backend labels so we can tweak copy/thresholds here
 * without a catalog refresh.
 */

type Tone = "good" | "mixed" | "bad" | "unknown" | "none";

interface BadgeContent {
  tone: Tone;
  label: string;
  detail: string;
}

/**
 * Pure helper (exported for tests) — map raw endpoint counts to the
 * tone + copy we show next to a model. We pick the *most informative*
 * label, not a strict "worst case" summary, because admins want to
 * know "can I route around the bad endpoints?" not just "is every
 * endpoint clean?".
 */
export function summarisePrivacy(
  privacy: ModelPrivacy | null | undefined
): BadgeContent {
  if (!privacy) {
    return {
      tone: "unknown",
      label: "Privacy unknown",
      detail:
        "We don't have endpoint policy info for this model yet. Click 'Refresh models' to pull the latest.",
    };
  }

  const total = privacy.endpoints_count;
  if (total === 0) {
    return {
      tone: "none",
      label: "No endpoints available",
      detail:
        "OpenRouter knows this model but isn't currently routing any endpoints for it. Enabling it is likely to fail at chat time.",
    };
  }

  const zdr = privacy.zdr_endpoints;
  const training = privacy.training_endpoints;
  const retains = privacy.retains_prompts_endpoints;

  if (zdr === total) {
    return {
      tone: "good",
      label: "ZDR available",
      detail:
        `All ${total} endpoint${total === 1 ? "" : "s"} are zero data retention — no training, no prompt retention.`,
    };
  }

  if (zdr > 0) {
    return {
      tone: "good",
      label: `${zdr} of ${total} ZDR`,
      detail:
        `${zdr} endpoint${zdr === 1 ? "" : "s"} are zero data retention; the rest train on or retain user data.`,
    };
  }

  // No ZDR endpoints at all — characterise which side of the policy
  // is problematic so the admin knows what they'd be agreeing to.
  if (training === total && retains === total) {
    return {
      tone: "bad",
      label: "Trains + retains",
      detail:
        `All ${total} endpoint${total === 1 ? "" : "s"} train on your data and retain prompts${
          privacy.max_retention_days ? ` (up to ${privacy.max_retention_days} days)` : ""
        }.`,
    };
  }

  if (training === total) {
    return {
      tone: "bad",
      label: "Trains on your data",
      detail: `All ${total} endpoint${total === 1 ? "" : "s"} train on your data.`,
    };
  }

  if (retains === total) {
    return {
      tone: "mixed",
      label: "Retains prompts",
      detail:
        `All ${total} endpoint${total === 1 ? "" : "s"} retain prompts${
          privacy.max_retention_days ? ` (up to ${privacy.max_retention_days} days)` : ""
        }.`,
    };
  }

  // Mixed — some train, some retain, but none qualify as ZDR.
  return {
    tone: "mixed",
    label: `${total} endpoint${total === 1 ? "" : "s"}, no ZDR`,
    detail:
      "Every endpoint trains on your data, retains prompts, or both. Check OpenRouter's model page for per-endpoint details.",
  };
}

export function PrivacyBadge({
  privacy,
  className,
}: {
  privacy: ModelPrivacy | null | undefined;
  className?: string;
}) {
  const content = summarisePrivacy(privacy);

  const toneClasses: Record<Tone, string> = {
    good: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    mixed: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    bad: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
    unknown: "bg-black/[0.04] text-[var(--text-muted)] border-[var(--border)] dark:bg-white/[0.05]",
    none: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
  };

  const ToneIcon = {
    good: ShieldCheck,
    mixed: Shield,
    bad: ShieldAlert,
    unknown: ShieldQuestion,
    none: ShieldAlert,
  }[content.tone];

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        toneClasses[content.tone],
        className
      )}
      title={content.detail}
    >
      <ToneIcon className="h-2.5 w-2.5" />
      {content.label}
    </span>
  );
}
