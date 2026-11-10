import { memo, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";

const REMARK = [remarkGfm];

const urlTransform = (url: string) => (url.startsWith("mention:") ? url : defaultUrlTransform(url));

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A message's Markdown: GFM (tables, strikethrough, auto-linked URLs), no
 * raw HTML, links open in a new tab, ``@name`` drawn as a mention chip
 * (highlighted when it's you).
 */
export const MessageBody = memo(function MessageBody({
  body,
  usernames,
  me,
}: {
  body: string;
  usernames: string[];
  me: string | undefined;
}) {
  const source = useMemo(() => {
    const names = [...usernames, "promptly", "everyone", "here"].filter(Boolean).sort((a, b) => b.length - a.length);
    if (!names.length || !body.includes("@")) return body;
    const re = new RegExp(`(^|[\\s(])@(${names.map(escapeRe).join("|")})(?![\\w.-])`, "gi");
    // Leave fenced / inline code alone.
    return body
      .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
      .map((part, i) => (i % 2 === 1 ? part : part.replace(re, (_m, pre: string, name: string) => `${pre}[@${name}](mention:${name})`)))
      .join("");
  }, [body, usernames]);

  const components = useMemo<Components>(
    () => ({
      a({ href, children }) {
        if (href?.startsWith("mention:")) {
          const name = href.slice(8).toLowerCase();
          const self = name === me?.toLowerCase() || name === "everyone" || name === "here";
          return (
            <span
              className={
                self
                  ? "rounded bg-[color-mix(in_srgb,#C08B2C_22%,transparent)] px-0.5 font-medium text-[var(--text)]"
                  : "rounded bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] px-0.5 font-medium text-[var(--accent-text)]"
              }
            >
              {children}
            </span>
          );
        }
        if (href?.startsWith("/") && !href.startsWith("//")) {
          // A mention (``@[Title](/link/…)``) or another in-app path.
          return (
            <Link to={href} className="font-medium text-[var(--accent-text)] underline underline-offset-2 break-words">
              {children}
            </Link>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-text)] underline underline-offset-2 break-words">
            {children}
          </a>
        );
      },
      p: ({ children }) => <p className="my-0.5 whitespace-pre-wrap break-words">{children}</p>,
      ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
      ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
      blockquote: ({ children }) => (
        <blockquote className="my-1 border-l-[3px] border-[var(--border)] pl-2 text-[var(--text-muted)]">{children}</blockquote>
      ),
      code: ({ children, className }) =>
        className ? (
          <code className={className}>{children}</code>
        ) : (
          <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
        ),
      pre: ({ children }) => (
        <pre className="my-1 max-w-full overflow-x-auto rounded-lg bg-[var(--surface-2)] p-2 font-mono text-[0.85em] leading-snug">{children}</pre>
      ),
      table: ({ children }) => (
        <div className="my-1 max-w-full overflow-x-auto">
          <table className="border-collapse text-sm [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_th]:py-1">
            {children}
          </table>
        </div>
      ),
      h1: ({ children }) => <p className="my-1 text-lg font-bold">{children}</p>,
      h2: ({ children }) => <p className="my-1 text-base font-bold">{children}</p>,
      h3: ({ children }) => <p className="my-1 font-semibold">{children}</p>,
      img: ({ src, alt }) => (
        <a href={src} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-text)] underline">
          {alt || src}
        </a>
      ),
    }),
    [me],
  );

  return (
    <div className="rooms-md text-[15px] leading-[1.45] text-[var(--text)] md:text-sm">
      <ReactMarkdown remarkPlugins={REMARK} components={components} urlTransform={urlTransform} skipHtml>
        {source}
      </ReactMarkdown>
    </div>
  );
});
