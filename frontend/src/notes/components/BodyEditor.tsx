import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { Bold, Heading1, Heading2, Italic, Link2, RemoveFormatting, Underline } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { cn } from "@/utils/cn";

import { blockId, docText, type DocNode } from "../types";

/**
 * A note's body: TipTap with the small schema the server keeps
 * (paragraphs, H1/H2, bold, italic, underline, links). Every paragraph and
 * heading carries a short stable id, which is what lets two people's edits
 * be merged block by block.
 */

const BlockIds = Extension.create({
  name: "noteBlockIds",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          id: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-bid"),
            renderHTML: (attrs) => (attrs.id ? { "data-bid": attrs.id } : {}),
            keepOnSplit: false,
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((t) => t.docChanged)) return null;
          const seen = new Set<string>();
          let tr = state.tr;
          let changed = false;
          state.doc.forEach((node, pos) => {
            if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
            const id = node.attrs.id as string | null;
            if (!id || seen.has(id)) {
              tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: blockId() });
              changed = true;
            } else seen.add(id);
          });
          return changed ? tr.setMeta("addToHistory", false) : null;
        },
      }),
    ];
  },
});

export interface BodyEditorHandle {
  focus: (where?: "start" | "end") => void;
  editor: Editor | null;
}

const EMPTY: DocNode = { type: "doc", content: [{ type: "paragraph" }] };

/** A body as the server keeps it (what to compare: the editor adds
 *  attributes the server drops, and that mustn't count as a change). */
function norm(doc: DocNode | null | undefined): string {
  const inline = (n: DocNode): unknown => {
    if (n.type === "text") return [n.text, (n.marks ?? []).map((m) => (m.type === "link" ? `link:${String(m.attrs?.href ?? "")}` : m.type)).sort()];
    if (n.type === "hardBreak") return "br";
    return docText({ type: "doc", content: [n] });
  };
  const blocks = (doc?.content ?? [])
    .map((b) => [b.type, b.type === "heading" ? b.attrs?.level : 0, (b.content ?? []).map(inline)])
    .filter((b, i, all) => !(i === all.length - 1 && (b[2] as unknown[]).length === 0));
  return JSON.stringify(blocks.length ? blocks : null);
}

export const BodyEditor = forwardRef<
  BodyEditorHandle,
  {
    value: DocNode | null | undefined;
    /** ``base``: the body this edit started from (for merging with
     *  someone else's change that arrived meanwhile). */
    onChange: (doc: DocNode | null, base: DocNode | null) => void;
    editable?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    /** Show the formatting bar while the body has focus. */
    toolbar?: "focus" | "never";
    className?: string;
    label?: string;
  }
>(function BodyEditor({ value, onChange, editable = true, placeholder = "Note", autoFocus, toolbar = "focus", className, label = "Note text" }, ref) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // What the editor last sent out (or was given): a value coming back
  // equal to it is our own echo and mustn't reset the cursor.
  const lastOut = useRef<string>(norm(value));
  // The last body handed in, and whether there's typing it doesn't have yet.
  const lastIn = useRef<string>(norm(value));
  const base = useRef<DocNode | null>(value ?? null);
  const dirty = useRef(false);
  const [focused, setFocused] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        link: { openOnClick: false, autolink: true, protocols: ["https", "http", "mailto"], HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
      }),
      Placeholder.configure({ placeholder }),
      BlockIds,
    ],
    content: (value as object) ?? EMPTY,
    editable,
    autofocus: autoFocus ? "end" : false,
    editorProps: { attributes: { "aria-label": label, role: "textbox", "aria-multiline": "true" } },
    onUpdate: ({ editor: ed }) => {
      const json = ed.getJSON() as DocNode;
      const empty = ed.isEmpty;
      const out = empty ? null : json;
      lastOut.current = norm(out);
      dirty.current = true;
      onChangeRef.current(out, base.current);
    },
  });

  // Someone else's change (or a merge) arrived: show it, keeping the cursor
  // near where it was.
  useEffect(() => {
    if (!editor) return;
    const incoming = norm(value);
    if (incoming === lastIn.current) return; // the same body again (a refetch)
    lastIn.current = incoming;
    if (incoming === lastOut.current) {
      // Our own typing, saved.
      dirty.current = false;
      base.current = value ?? null;
      return;
    }
    // Someone else's change while you're typing: your save merges with it
    // (from ``base``), and the merged body comes back here.
    if (dirty.current && editor.isFocused) return;
    lastOut.current = incoming;
    base.current = value ?? null;
    dirty.current = false;
    const { from } = editor.state.selection;
    editor.commands.setContent((value as object) ?? EMPTY, { emitUpdate: false });
    if (editor.isFocused) editor.commands.setTextSelection(Math.min(from, editor.state.doc.content.size));
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useImperativeHandle(ref, () => ({
    focus: (where = "end") => editor?.commands.focus(where),
    editor,
  }));

  return (
    <div
      className={cn("note-body", className)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <EditorContent editor={editor} />
      {editable && toolbar === "focus" && focused && editor && <FormatBar editor={editor} />}
    </div>
  );
});

function FormatBar({ editor }: { editor: Editor }) {
  const btn = (active: boolean) =>
    cn("flex h-8 w-8 items-center justify-center rounded-md note-hover", active && "bg-[var(--note-hover)] ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]");
  const keep = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest("input")) e.preventDefault(); // keep the editor's focus
  };
  const [linking, setLinking] = useState<string | null>(null);
  const applyLink = (url: string) => {
    const href = url.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href) chain.unsetLink().run();
    else chain.setLink({ href: /^(https?:|mailto:|\/)/i.test(href) ? href : `https://${href}` }).run();
    setLinking(null);
  };
  if (linking !== null) {
    return (
      <form
        className="mt-2 flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          applyLink(linking);
        }}
      >
        <input
          autoFocus
          value={linking}
          onChange={(e) => setLinking(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setLinking(null);
              editor.commands.focus();
            }
          }}
          placeholder="Paste or type a link"
          aria-label="Link address"
          className="h-8 min-w-0 flex-1 rounded-md border border-[color-mix(in_srgb,var(--note-text)_25%,transparent)] bg-transparent px-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        <button type="submit" className="h-8 rounded-md px-3 text-sm font-medium note-hover">
          {linking.trim() ? "Add link" : "Remove link"}
        </button>
      </form>
    );
  }
  return (
    <div role="toolbar" aria-label="Formatting" className="mt-2 flex flex-wrap items-center gap-0.5 note-muted" onMouseDown={keep}>
      <button type="button" aria-label="Heading 1" aria-pressed={editor.isActive("heading", { level: 1 })} className={btn(editor.isActive("heading", { level: 1 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 className="h-4 w-4" />
      </button>
      <button type="button" aria-label="Heading 2" aria-pressed={editor.isActive("heading", { level: 2 })} className={btn(editor.isActive("heading", { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="h-4 w-4" />
      </button>
      <button type="button" aria-label="Bold" aria-pressed={editor.isActive("bold")} className={btn(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-4 w-4" />
      </button>
      <button type="button" aria-label="Italic" aria-pressed={editor.isActive("italic")} className={btn(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-4 w-4" />
      </button>
      <button type="button" aria-label="Underline" aria-pressed={editor.isActive("underline")} className={btn(editor.isActive("underline"))} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <Underline className="h-4 w-4" />
      </button>
      <button type="button" aria-label="Link" aria-pressed={editor.isActive("link")} className={btn(editor.isActive("link"))} onClick={() => setLinking((editor.getAttributes("link").href as string | undefined) ?? "")}>
        <Link2 className="h-4 w-4" />
      </button>
      <button type="button" aria-label="Clear formatting" className={btn(false)} onClick={() => editor.chain().focus().unsetAllMarks().setParagraph().run()}>
        <RemoveFormatting className="h-4 w-4" />
      </button>
    </div>
  );
}
