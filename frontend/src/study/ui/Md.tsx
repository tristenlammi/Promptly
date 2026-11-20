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

export const Md = memo(function Md({ text, compact, className }: { text: string; compact?: boolean; className?: string }) {
  if (!text) return null;
  return (
    <div className={cn("study-md", compact && "compact", className)}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
