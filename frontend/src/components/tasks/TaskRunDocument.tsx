import { useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";

import type { TaskRun } from "@/api/tasks";

// ``singleDollarTextMath: false`` stops a lone ``$`` from opening inline
// math — critical for reports full of currency ("$965 billion") that
// would otherwise be swallowed into garbled KaTeX. Genuine math can still
// use ``$$…$$``.
const REMARK: Options["remarkPlugins"] = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
];
const REHYPE: Options["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false }],
  rehypeHighlight,
];

/** Renders a finished run's Markdown output as a clean standalone
 *  document (the "newsletter back-issue" reader), plus a sources
 *  footer when the run's search tools collected citations. */
export function TaskRunDocument({ run }: { run: TaskRun }) {
  const body = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE}>
        {run.output_markdown ?? ""}
      </ReactMarkdown>
    ),
    [run.output_markdown]
  );

  if (run.status === "failed") {
    return (
      <div className="rounded-card border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-300">
        <p className="font-medium">This run failed.</p>
        <p className="mt-1 text-[var(--text-muted)]">
          {run.error ?? "Unknown error."}
        </p>
      </div>
    );
  }

  if (run.status !== "success") {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" />
        {run.status === "running" ? "Generating report…" : "Queued…"}
      </div>
    );
  }

  const sources = (run.sources ?? []).filter((s) => s.url);

  return (
    <article className="promptly-prose max-w-none">
      {body}
      {sources.length > 0 && (
        <div className="mt-6 border-t border-[var(--border)] pt-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Sources
          </h4>
          <ol className="space-y-1 text-sm">
            {sources.map((s, i) => (
              <li key={`${s.url}-${i}`} className="flex gap-2">
                <span className="text-[var(--text-muted)]">[{i + 1}]</span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-[var(--accent)] hover:underline"
                  title={s.title || s.url}
                >
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}
