import { cn } from "@/utils/cn";

/**
 * A single shimmering placeholder block. Compose several to mock the
 * shape of the content that's loading (a row, a card, a line of text)
 * so the first paint reads as "loading this layout" rather than a bare
 * spinner. Decorative, so it's hidden from assistive tech — pair the
 * surrounding container with an `aria-busy`/`aria-live` hint where the
 * loading state matters to screen-reader users.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("promptly-skeleton rounded-md", className)}
    />
  );
}
