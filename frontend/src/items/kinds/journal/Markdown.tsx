import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/utils/cn";

/* An entry's Markdown, typeset for reading: a calm serif-free column. */

const components: Components = {
  h1: ({ children }) => <h3 className="mb-2 mt-6 text-xl font-semibold text-[var(--text)] first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-2 mt-6 text-lg font-semibold text-[var(--text)] first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1.5 mt-5 text-base font-semibold text-[var(--text)] first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mb-1 mt-4 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">{children}</h4>,
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children, className }) => (
    <ul className={cn("my-3 flex flex-col gap-1 pl-6", className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc")}>{children}</ul>
  ),
  ol: ({ children }) => <ol className="my-3 flex list-decimal flex-col gap-1 pl-6">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 marker:text-[var(--text-muted)]">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-[3px] border-[var(--item-accent)] pl-4 italic text-[var(--text-muted)]">{children}</blockquote>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-[var(--item-accent)] underline underline-offset-2">
      {children}
    </a>
  ),
  hr: () => <hr className="my-6 border-[var(--border)]" />,
  code: ({ children }) => <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
  pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-xl bg-[var(--surface-2)] p-3 text-sm">{children}</pre>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-[var(--border)] px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-[var(--border)] px-2 py-1 align-top">{children}</td>,
  input: ({ checked }) => (
    <input type="checkbox" checked={!!checked} readOnly disabled className="mr-2 h-4 w-4 translate-y-0.5 accent-[var(--item-accent)]" />
  ),
  img: ({ alt }) => <span className="text-[var(--text-muted)]">[{alt || "image"}]</span>,
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("break-words text-[16px] leading-[1.75] text-[var(--text)] md:text-[17px]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
