import { memo } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { safeHref } from "@/items/ui";
import { cn } from "@/utils/cn";

/* The teacher's text: Markdown with $…$ maths. No raw HTML is rendered
   (react-markdown drops it), and links open in a new tab. */

const REMARK: Options["remarkPlugins"] = [remarkGfm, [remarkMath, { singleDollarTextMath: true }]];
const REHYPE: Options["rehypePlugins"] = [[rehypeKatex, { throwOnError: false, strict: false }]];

const components: Components = {
  a({ href, children }) {
    return (
      <a href={safeHref(href)} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img() {
    return null;
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto">
        <table>{children}</table>
      </div>
    );
  },
};

/** A one-line piece of text (a choice, a step to put in order) that starts
 *  "1. …", "- …" or "# …" means those characters, not a list or a heading. */
export function asLine(text: string): string {
  return text
    .replace(/^(\s*\d+)([.)])(\s)/, "$1\\$2$3")
    .replace(/^(\s*)([-+*#>])(\s)/, "$1\\$2$3");
}

export const Md = memo(function Md({ text, compact, line, className }: { text: string; compact?: boolean; line?: boolean; className?: string }) {
  if (!text) return null;
  return (
    <div className={cn("study-md", (compact || line) && "compact", className)}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={components}>
        {line ? asLine(text) : text}
      </ReactMarkdown>
    </div>
  );
});
