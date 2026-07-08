import { BubbleMenu, type Editor } from "@tiptap/react";
import {
  Bold,
  Code,
  Highlighter,
  Italic,
  Link as LinkIcon,
  Strikethrough,
  Underline as UnderlineIcon,
} from "lucide-react";

import { cn } from "@/utils/cn";
import {
  CALLOUT_VARIANTS,
  type CalloutVariant,
} from "./CalloutExtension";

/**
 * Selection bubble toolbar — the quick inline formatter that floats over a
 * text selection (the toolbar's marks, minus the block/insert controls that
 * don't make sense mid-selection). When the selection sits inside a callout
 * it also grows a variant colour switcher. Every button reuses the same
 * ``editor.chain()`` commands as the top toolbar, so the two can't drift.
 */
const VARIANT_DOT: Record<CalloutVariant, string> = {
  info: "bg-sky-500",
  warning: "bg-amber-500",
  success: "bg-emerald-500",
  danger: "bg-rose-500",
};

function MarkButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md transition",
        active
          ? "bg-[var(--accent)]/15 text-[var(--accent)]"
          : "text-[var(--text)] hover:bg-[var(--hover)]"
      )}
    >
      {children}
    </button>
  );
}

export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const setLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "");
    if (url === null) return; // cancelled
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: url })
      .run();
  };

  const inCallout = editor.isActive("callout");

  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={{ duration: 120, maxWidth: "none" }}
      className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg"
    >
      <MarkButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold"
      >
        <Bold className="h-4 w-4" />
      </MarkButton>
      <MarkButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic"
      >
        <Italic className="h-4 w-4" />
      </MarkButton>
      <MarkButton
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title="Underline"
      >
        <UnderlineIcon className="h-4 w-4" />
      </MarkButton>
      <MarkButton
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title="Strikethrough"
      >
        <Strikethrough className="h-4 w-4" />
      </MarkButton>
      <MarkButton
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
        title="Inline code"
      >
        <Code className="h-4 w-4" />
      </MarkButton>
      <MarkButton
        active={editor.isActive("highlight")}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        title="Highlight"
      >
        <Highlighter className="h-4 w-4" />
      </MarkButton>
      <MarkButton
        active={editor.isActive("link")}
        onClick={setLink}
        title="Link"
      >
        <LinkIcon className="h-4 w-4" />
      </MarkButton>

      {inCallout && (
        <>
          <span className="mx-0.5 h-5 w-px bg-[var(--border)]" aria-hidden />
          {CALLOUT_VARIANTS.map((v) => (
            <button
              key={v}
              type="button"
              title={`Callout: ${v}`}
              aria-label={`Callout ${v}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().setCalloutVariant(v).run()}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-[var(--hover)]"
            >
              <span
                className={cn(
                  "h-3 w-3 rounded-full ring-1 ring-inset ring-black/10",
                  VARIANT_DOT[v],
                  editor.isActive("callout", { variant: v }) &&
                    "ring-2 ring-[var(--text)]"
                )}
              />
            </button>
          ))}
        </>
      )}
    </BubbleMenu>
  );
}
