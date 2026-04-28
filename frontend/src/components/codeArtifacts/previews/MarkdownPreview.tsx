import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/**
 * Markdown previewer — reuses the exact same ReactMarkdown +
 * remark-gfm + rehype-highlight pipeline the chat bubble uses so
 * the artifact panel looks identical to the in-chat render.
 *
 * We purposefully DON'T pass ``markdownComponents`` from
 * MessageBubble — those components include chat-specific
 * behaviour (mention chips, citation rewriting) that doesn't
 * apply here. A plain pipeline is the right baseline.
 */
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className="h-full w-full overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg)] px-6 py-5 text-[var(--text)]">
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
        >
          {source}
        </ReactMarkdown>
      </div>
    </div>
  );
}
