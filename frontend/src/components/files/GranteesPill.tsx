import { Users } from "lucide-react";

import type { GrantSummary } from "@/api/files";
import { cn } from "@/utils/cn";

interface GranteesPillProps {
  sharing: GrantSummary | null | undefined;
  /** Compact = "@bob, @alice +2" (default). Full = comma-list,
   *  used inside the preview modal where space isn't tight. */
  variant?: "compact" | "full";
  /** Optional click handler so the row's pill can open the share
   *  modal directly. ``undefined`` keeps the pill non-interactive. */
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
}

/** Drive-stage-5 sharing chip. Shown wherever a file/folder row is
 *  rendered (grid, list, preview header) so the caller always knows
 *  who else can see this thing. The exact text:
 *
 *  * Owner with grants: ``"Shared with @bob, @alice +2"``
 *  * Grantee on someone else's resource:
 *      ``"Shared by @owner · also @bob"``
 *  * Both: same as grantee (we still want to surface the owner).
 *
 *  Returns ``null`` when ``sharing`` is null — keeps consumer code
 *  free of repetitive null guards.
 */
export function GranteesPill({
  sharing,
  variant = "compact",
  onClick,
  className,
}: GranteesPillProps) {
  if (!sharing) return null;
  const isOwner = sharing.role === "owner";
  const others = sharing.grantees;
  const ownerName = sharing.owner?.username;

  const interactive = !!onClick;
  const Wrapper: "button" | "span" = interactive ? "button" : "span";

  const namesCompact = formatCompact(others, variant === "compact" ? 2 : 4);
  const namesFull = others.map((g) => `@${g.username}`).join(", ");

  let text: string;
  if (isOwner) {
    if (others.length === 0) {
      // Defensive: backend only emits a summary when grants exist.
      text = "Shared";
    } else {
      text =
        variant === "compact"
          ? `Shared with ${namesCompact}`
          : `Shared with ${namesFull}`;
    }
  } else {
    const ownerPart = ownerName ? `Shared by @${ownerName}` : "Shared";
    if (others.length === 0) {
      text = ownerPart;
    } else {
      const tail =
        variant === "compact" ? `also ${namesCompact}` : `also ${namesFull}`;
      text = `${ownerPart} · ${tail}`;
    }
  }

  return (
    <Wrapper
      type={interactive ? "button" : undefined}
      onClick={onClick}
      title={
        // Always show the full list in the title so a hover reveals
        // every name regardless of which variant is rendered.
        (isOwner ? "Shared with " : `Shared by @${ownerName ?? "?"} · also `) +
        (namesFull || "(no one yet)")
      }
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px]",
        "border border-[var(--accent)]/30",
        "bg-[var(--accent)]/[0.08] text-[var(--accent)]",
        "dark:bg-[var(--accent)]/[0.15]",
        interactive && "cursor-pointer transition hover:bg-[var(--accent)]/[0.18]",
        className
      )}
    >
      <Users className="h-3 w-3 shrink-0" />
      <span className="truncate">{text}</span>
    </Wrapper>
  );
}

function formatCompact(
  grantees: { username: string }[],
  visible: number
): string {
  if (grantees.length === 0) return "(no one yet)";
  const head = grantees.slice(0, visible).map((g) => `@${g.username}`);
  const remainder = grantees.length - visible;
  if (remainder <= 0) return head.join(", ");
  return `${head.join(", ")} +${remainder}`;
}
