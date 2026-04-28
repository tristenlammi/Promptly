import { useMemo } from "react";
import DOMPurify from "dompurify";

/**
 * SVG previewer — sanitize with DOMPurify (using the SVG profile)
 * and inline the markup. Inline rendering gives us the native
 * scale-to-parent behaviour and full CSS inheritance; iframe
 * sandboxing is overkill for SVG once we've stripped scripts and
 * event handlers.
 *
 * The ``USE_PROFILES: { svg: true, svgFilters: true }`` profile
 * forbids <script>, event attributes, and <foreignObject> by
 * default — see
 *   https://github.com/cure53/DOMPurify/wiki/Safely-handling-SVG
 */
export function SvgPreview({ source }: { source: string }) {
  const safe = useMemo(() => {
    return DOMPurify.sanitize(source, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
  }, [source]);

  if (!safe.trim()) {
    return (
      <EmptyState message="No renderable SVG found. Check the Code tab for errors." />
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto rounded-md border border-[var(--border)] bg-white p-4 dark:bg-[#111]">
      <div
        className="max-h-full max-w-full [&_svg]:h-auto [&_svg]:w-auto [&_svg]:max-h-[70vh] [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg)] p-6 text-sm text-[var(--text-muted)]">
      {message}
    </div>
  );
}
