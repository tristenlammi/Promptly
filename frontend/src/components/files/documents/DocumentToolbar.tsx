import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  Bold,
  ChevronDown,
  Code2,
  FileText as FileTextIcon,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  ListVideo,
  Minus,
  Music,
  Pilcrow,
  Quote,
  Redo2,
  Smile,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
  Youtube as YoutubeIcon,
} from "lucide-react";

import { cn } from "@/utils/cn";
import { documentsApi } from "@/api/documents";

import { EmojiPicker } from "./EmojiPicker";

/**
 * Document editor toolbar.
 *
 * Groups controls by purpose (Text / Structure / Lists / Insert)
 * so the density stays manageable even with the full extension
 * set turned on. On mobile the structure + insert groups collapse
 * behind an overflow sheet; on desktop everything is visible in
 * one row.
 *
 * The toolbar is intentionally stateless from the editor's point
 * of view — every button calls an ``editor.chain()`` command and
 * re-reads editor state on each render (TipTap's
 * ``useEditorState`` is cheap and re-renders only when the
 * underlying selection changes).
 */
interface DocumentToolbarProps {
  editor: Editor | null;
  documentId: string;
  disabled?: boolean;
}

export function DocumentToolbar({
  editor,
  documentId,
  disabled,
}: DocumentToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const emojiButtonRef = useRef<HTMLButtonElement | null>(null);
  const overflowSheetRef = useRef<HTMLDivElement | null>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Outside-click + escape dismissal for the mobile overflow sheet.
  // Without this, tapping the editor to resume typing leaves the
  // sheet hanging open, covering the first line of content.
  useEffect(() => {
    if (!overflowOpen) return;
    const handlePointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (overflowSheetRef.current?.contains(target)) return;
      if (overflowTriggerRef.current?.contains(target)) return;
      setOverflowOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverflowOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [overflowOpen]);

  const uploadAsset = useCallback(
    async (file: File, kind: "image" | "audio") => {
      if (!editor || disabled) return;
      setUploading(true);
      setUploadError(null);
      try {
        const asset = await documentsApi.uploadAsset(documentId, file);
        if (kind === "image") {
          editor.chain().focus().setImage({ src: asset.url }).run();
        } else {
          editor.chain().focus().setAudio({ src: asset.url }).run();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        setUploadError(msg);
      } finally {
        setUploading(false);
      }
    },
    [editor, documentId, disabled]
  );

  const handleImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      e.target.value = "";
      return;
    }
    const file = files[0];
    e.target.value = "";
    void uploadAsset(file, "image");
  };

  const handleAudioPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      e.target.value = "";
      return;
    }
    const file = files[0];
    e.target.value = "";
    void uploadAsset(file, "audio");
  };

  const handleInsertYoutube = () => {
    if (!editor) return;
    const url = window.prompt("Paste a YouTube URL");
    if (!url) return;
    editor.chain().focus().setYoutubeVideo({ src: url }).run();
  };

  const handleInsertLink = () => {
    if (!editor) return;
    const existing = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", existing ?? "https://");
    if (url === null) return;
    if (url.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const handleInsertTable = () => {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  };

  const handleInsertDetails = () => {
    if (!editor) return;
    editor.chain().focus().setDetails().run();
  };

  const handleInsertHighlight = () => {
    if (!editor) return;
    editor.chain().focus().toggleHighlight({ color: "#FFE888" }).run();
  };

  const emojiAnchor = emojiButtonRef.current?.getBoundingClientRect() ?? null;

  return (
    <div
      className={cn(
        "sticky top-0 z-10 flex w-full flex-wrap items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1.5",
        // Match the header's notch padding so the toolbar doesn't
        // drift under the rounded iOS corners when scrolled.
        "pl-[max(env(safe-area-inset-left,0),0.5rem)]",
        "pr-[max(env(safe-area-inset-right,0),0.5rem)]",
        disabled && "pointer-events-none opacity-60"
      )}
      role="toolbar"
      aria-label="Document formatting"
    >
      {/* Text group */}
      <ToolbarGroup>
        <ToolButton
          label="Bold"
          active={editor?.isActive("bold")}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Italic"
          active={editor?.isActive("italic")}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Underline"
          active={editor?.isActive("underline")}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Strikethrough"
          active={editor?.isActive("strike")}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          <Strikethrough className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Highlight"
          active={editor?.isActive("highlight")}
          onClick={handleInsertHighlight}
        >
          <Highlighter className="h-4 w-4" />
        </ToolButton>
        <ToolButton label="Link" onClick={handleInsertLink}>
          <LinkIcon className="h-4 w-4" />
        </ToolButton>
      </ToolbarGroup>

      <Divider />

      {/* Structure group */}
      <ToolbarGroup className="hidden md:flex">
        <ToolButton
          label="Heading 1"
          active={editor?.isActive("heading", { level: 1 })}
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 1 }).run()
          }
        >
          <Heading1 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Heading 2"
          active={editor?.isActive("heading", { level: 2 })}
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          <Heading2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Heading 3"
          active={editor?.isActive("heading", { level: 3 })}
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 3 }).run()
          }
        >
          <Heading3 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Paragraph"
          active={editor?.isActive("paragraph")}
          onClick={() => editor?.chain().focus().setParagraph().run()}
        >
          <Pilcrow className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Blockquote"
          active={editor?.isActive("blockquote")}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Quote className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Inline code"
          active={editor?.isActive("code")}
          onClick={() => editor?.chain().focus().toggleCode().run()}
        >
          <Code2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Code block"
          active={editor?.isActive("codeBlock")}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
        >
          <FileTextIcon className="h-4 w-4" />
        </ToolButton>
      </ToolbarGroup>

      <Divider className="hidden md:block" />

      {/* Lists group */}
      <ToolbarGroup>
        <ToolButton
          label="Bullet list"
          active={editor?.isActive("bulletList")}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Ordered list"
          active={editor?.isActive("orderedList")}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Task list"
          active={editor?.isActive("taskList")}
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
        >
          <ListTodo className="h-4 w-4" />
        </ToolButton>
      </ToolbarGroup>

      <Divider />

      {/* Insert group */}
      <ToolbarGroup>
        <ToolButton label="Insert image" onClick={() => imageInputRef.current?.click()}>
          <ImageIcon className="h-4 w-4" />
        </ToolButton>
        <ToolButton label="Insert audio" onClick={() => audioInputRef.current?.click()}>
          <Music className="h-4 w-4" />
        </ToolButton>
        <ToolButton label="Insert YouTube" onClick={handleInsertYoutube}>
          <YoutubeIcon className="h-4 w-4" />
        </ToolButton>
        <ToolButton label="Insert table" onClick={handleInsertTable}>
          <TableIcon className="h-4 w-4" />
        </ToolButton>
        <ToolButton label="Insert details" onClick={handleInsertDetails}>
          <ListVideo className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Horizontal rule"
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
        >
          <Minus className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Emoji"
          ref={emojiButtonRef}
          onClick={() => setEmojiOpen((v) => !v)}
          active={emojiOpen}
        >
          <Smile className="h-4 w-4" />
        </ToolButton>
      </ToolbarGroup>

      <Divider />

      {/* Undo / Redo */}
      <ToolbarGroup>
        <ToolButton
          label="Undo"
          onClick={() => editor?.chain().focus().undo().run()}
          disabled={!editor?.can().undo()}
        >
          <Undo2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          label="Redo"
          onClick={() => editor?.chain().focus().redo().run()}
          disabled={!editor?.can().redo()}
        >
          <Redo2 className="h-4 w-4" />
        </ToolButton>
      </ToolbarGroup>

      {/* Mobile overflow sheet trigger. On small screens we collapse
          the Structure group behind a bottom-sheet rather than making
          users hunt horizontally through a cramped scroll strip. */}
      <div className="ml-auto md:hidden">
        <button
          type="button"
          ref={overflowTriggerRef}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOverflowOpen((v) => !v)}
          aria-expanded={overflowOpen}
          aria-controls="document-toolbar-overflow"
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/10"
        >
          More
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              overflowOpen && "rotate-180"
            )}
          />
        </button>
      </div>

      {overflowOpen && (
        <>
          {/* Backdrop — tap-to-dismiss on mobile. Sits below the sheet
              but above the editor so stray taps don't poke into the
              content while a sheet is open. */}
          <div
            aria-hidden
            className="fixed inset-0 z-[70] bg-black/30 md:hidden"
            onClick={() => setOverflowOpen(false)}
          />
          <div
            id="document-toolbar-overflow"
            ref={overflowSheetRef}
            role="dialog"
            aria-label="More formatting"
            className={cn(
              "fixed inset-x-0 bottom-0 z-[80] md:hidden",
              "rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface)] shadow-2xl",
              "pb-[max(env(safe-area-inset-bottom,0),1rem)]",
              "pl-[max(env(safe-area-inset-left,0),0.75rem)]",
              "pr-[max(env(safe-area-inset-right,0),0.75rem)]",
              "pt-3"
            )}
          >
            {/* Drag handle hint. Purely visual — the sheet dismisses
                via backdrop tap or the explicit close button. */}
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--border)]" />
            <div className="grid grid-cols-4 gap-2">
              <SheetButton
                label="H1"
                icon={<Heading1 className="h-5 w-5" />}
                active={editor?.isActive("heading", { level: 1 })}
                onClick={() => {
                  editor?.chain().focus().toggleHeading({ level: 1 }).run();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="H2"
                icon={<Heading2 className="h-5 w-5" />}
                active={editor?.isActive("heading", { level: 2 })}
                onClick={() => {
                  editor?.chain().focus().toggleHeading({ level: 2 }).run();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="H3"
                icon={<Heading3 className="h-5 w-5" />}
                active={editor?.isActive("heading", { level: 3 })}
                onClick={() => {
                  editor?.chain().focus().toggleHeading({ level: 3 }).run();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="Paragraph"
                icon={<Pilcrow className="h-5 w-5" />}
                active={editor?.isActive("paragraph")}
                onClick={() => {
                  editor?.chain().focus().setParagraph().run();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="Quote"
                icon={<Quote className="h-5 w-5" />}
                active={editor?.isActive("blockquote")}
                onClick={() => {
                  editor?.chain().focus().toggleBlockquote().run();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="Code"
                icon={<Code2 className="h-5 w-5" />}
                active={editor?.isActive("code")}
                onClick={() => {
                  editor?.chain().focus().toggleCode().run();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="Block"
                icon={<FileTextIcon className="h-5 w-5" />}
                active={editor?.isActive("codeBlock")}
                onClick={() => {
                  editor?.chain().focus().toggleCodeBlock().run();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="Table"
                icon={<TableIcon className="h-5 w-5" />}
                onClick={() => {
                  handleInsertTable();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="Details"
                icon={<ListVideo className="h-5 w-5" />}
                onClick={() => {
                  handleInsertDetails();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="Rule"
                icon={<Minus className="h-5 w-5" />}
                onClick={() => {
                  editor?.chain().focus().setHorizontalRule().run();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="YouTube"
                icon={<YoutubeIcon className="h-5 w-5" />}
                onClick={() => {
                  handleInsertYoutube();
                  setOverflowOpen(false);
                }}
              />
              <SheetButton
                label="Emoji"
                icon={<Smile className="h-5 w-5" />}
                onClick={() => {
                  setOverflowOpen(false);
                  setEmojiOpen(true);
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => setOverflowOpen(false)}
              className="mt-3 w-full rounded-lg border border-[var(--border)] py-2 text-sm text-[var(--muted)] hover:bg-black/5 dark:hover:bg-white/10"
            >
              Close
            </button>
          </div>
        </>
      )}

      {/* Hidden file pickers used by the image / audio buttons. */}
      <input
        type="file"
        accept="image/*"
        ref={imageInputRef}
        className="hidden"
        onChange={handleImagePick}
      />
      <input
        type="file"
        accept="audio/*"
        ref={audioInputRef}
        className="hidden"
        onChange={handleAudioPick}
      />

      {emojiOpen && (
        <EmojiPicker
          anchor={emojiAnchor}
          onSelect={(glyph) => editor?.chain().focus().insertContent(glyph).run()}
          onClose={() => setEmojiOpen(false)}
        />
      )}

      {(uploading || uploadError) && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-2 right-4 rounded-md px-3 py-1 text-xs shadow-md",
            uploadError
              ? "bg-red-600 text-white"
              : "bg-black/80 text-white dark:bg-white/15"
          )}
        >
          {uploadError ?? "Uploading…"}
        </div>
      )}
    </div>
  );
}

function ToolbarGroup({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-0.5", className)}>{children}</div>
  );
}

function Divider({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("mx-1 hidden h-6 w-px bg-[var(--border)] md:inline-block", className)}
    />
  );
}

interface ToolButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(
  function ToolButton(
    { label, active, className, children, onMouseDown, ...rest },
    ref
  ) {
    return (
      <button
        ref={ref}
        type="button"
        title={label}
        aria-label={label}
        // ``preventDefault`` on mousedown keeps ProseMirror's text
        // selection alive when the user clicks a toolbar button.
        // Without this the browser blurs the editor on mousedown, the
        // selection collapses, and ``editor.chain().focus()`` refocuses
        // with an empty range — so toggleBold/toggleItalic/setLink etc.
        // silently do nothing to the text the user actually highlighted.
        onMouseDown={(e) => {
          e.preventDefault();
          onMouseDown?.(e);
        }}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted)] transition",
          "hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10",
          "disabled:cursor-not-allowed disabled:opacity-40",
          active && "bg-black/10 text-[var(--text)] dark:bg-white/15",
          className
        )}
        {...rest}
      >
        {children}
      </button>
    );
  }
);

interface SheetButtonProps {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}

/** Touch-optimised tile used inside the mobile overflow sheet. */
function SheetButton({ label, icon, active, onClick }: SheetButtonProps) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-xl border text-xs transition",
        "border-transparent text-[var(--muted)]",
        "hover:border-[var(--border)] hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10",
        active &&
          "border-[var(--border)] bg-black/10 text-[var(--text)] dark:bg-white/15"
      )}
    >
      {icon}
      <span className="leading-none">{label}</span>
    </button>
  );
}
