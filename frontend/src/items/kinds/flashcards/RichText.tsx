import { memo, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { safeHref } from "@/items/ui";
import { cn } from "@/utils/cn";

import { CLOZE_RE } from "./cards";
import { CardMedia } from "./media";

/*
 * A card side: Markdown (GFM) with $…$ / $$…$$ math (KaTeX) and cloze
 * deletions. Clozes become links to "#cloze-…" before parsing (so math
 * inside an answer still renders) and the ``a`` renderer turns them into
 * the blank or the highlighted answer.
 */

const REMARK: Options["remarkPlugins"] = [remarkGfm, [remarkMath, { singleDollarTextMath: true }]];
const REHYPE: Options["rehypePlugins"] = [[rehypeKatex, { throwOnError: false, strict: false }]];
// ``drive:<file id>`` is how a card points at its Drive media (media.tsx);
// everything else gets react-markdown's safe default (no javascript: etc.).
const urlTransform = (url: string) => (/^drive:[0-9a-f-]{36}$/i.test(url) ? url : defaultUrlTransform(url));

const components: Components = {
  a({ href, children }) {
    if (href === "#cloze-hidden")
      return (
        <span className="mx-0.5 inline-block min-w-[2.5em] rounded-md border-b-2 border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] px-1.5 text-center font-semibold text-[var(--item-accent)]">
          {children}
        </span>
      );
    if (href === "#cloze-shown")
      return (
        <span className="rounded-md bg-[color-mix(in_srgb,var(--item-accent)_18%,transparent)] px-1 font-semibold text-[var(--text)]">{children}</span>
      );
    return (
      <a href={safeHref(href)} target="_blank" rel="noreferrer noopener" className="text-[var(--item-accent)] underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    return <CardMedia src={typeof src === "string" ? src : ""} alt={alt ?? ""} />;
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="mx-auto border-collapse text-sm [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_th]:py-1">
          {children}
        </table>
      </div>
    );
  },
};

/** The text with cloze ``active`` hidden (unless ``reveal``) and others shown as answers. */
export function clozeToMarkdown(text: string, active: number | null, reveal: boolean): string {
  return (text || "").replace(CLOZE_RE, (_m, n: string, ans: string, hint?: string) => {
    const isActive = active !== null && Number(n) === active;
    if (isActive && !reveal) return `[${hint ? hint.replace(/[[\]]/g, "") : "…"}](#cloze-hidden)`;
    if (isActive) return `[${ans}](#cloze-shown)`;
    return ans;
  });
}

/** ``$$…$$`` written on one line is *inline* math to remark-math (small,
 *  squashed fractions); a line holding only that is meant as a display
 *  equation, as in Anki/MathJax — put the delimiters on their own lines. */
export function displayMath(md: string): string {
  return md.replace(/^[ \t]*\$\$([^\n$]+?)\$\$[ \t]*$/gm, (_m, tex: string) => `$$\n${tex.trim()}\n$$`);
}

export const RichText = memo(function RichText({
  text,
  cloze,
  reveal = true,
  className,
  size = "md",
}: {
  text: string;
  cloze?: number | null;
  reveal?: boolean;
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const md = useMemo(() => displayMath(cloze !== undefined ? clozeToMarkdown(text, cloze, reveal) : text), [text, cloze, reveal]);
  return (
    <div
      className={cn(
        "promptly-prose break-words text-[var(--text)] [&_.katex-display]:my-2 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_code]:rounded [&_code]:bg-[var(--surface-2)] [&_code]:px-1 [&_li]:text-left [&_ol]:inline-block [&_ul]:inline-block [&_p]:my-1.5",
        size === "xl" && "text-[30px] font-medium leading-tight md:text-[34px]",
        size === "lg" && "text-[22px] leading-snug md:text-2xl",
        size === "md" && "text-base leading-relaxed",
        size === "sm" && "text-sm leading-relaxed",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={components} urlTransform={urlTransform}>
        {md}
      </ReactMarkdown>
    </div>
  );
});
