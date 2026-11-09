import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { Bold, Heading1, Heading2, Italic, Link2, RemoveFormatting, Underline } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { connectionsApi, linkPath } from "@/api/connections";
import { WikiLinkExtension, type WikiTarget } from "@/components/files/documents/WikiLinkExtension";
import { cn } from "@/utils/cn";

import { mergeDocs } from "../merge";
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

/** Escape presses the body editor didn't use itself. ProseMirror calls
 *  preventDefault on every Escape (its own key capture), so the note around
 *  it can't tell "a popup in the editor took it" from "nobody wanted it" by
 *  ``defaultPrevented`` alone. This plugin runs last: reached, nothing in the
 *  editor (like the [[ link suggestions) handled the key, so the composer and
 *  the note dialog may close on it. */
export const escapeNotUsed = new WeakSet<Event>();

const PassEscape = Extension.create({
  name: "notePassEscape",
  priority: 1,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown: (_view, event) => {
            if (event.key === "Escape") escapeNotUsed.add(event);
            return false;
          },
        },
      }),
    ];
  },
});

/** Did something else (a popup, a menu, a sheet) already answer this Escape? */
export function escapeTaken(e: KeyboardEvent): boolean {
  return e.defaultPrevented && !escapeNotUsed.has(e);
}

/** Answer this Escape: nothing else around it closes on it too. */
export function takeEscape(e: KeyboardEvent): void {
  e.preventDefault();
  escapeNotUsed.delete(e);
}

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

/** Where the cursor is, as (block id, offset in it) — blocks keep their
 *  ids through a merge, so the cursor can stay in the same sentence. */
function caret(editor: Editor): { id: string | null; off: number; pos: number } | null {
  if (!editor.isFocused) return null;
  const { from } = editor.state.selection;
  const $p = editor.state.doc.resolve(from);
  if ($p.depth < 1) return { id: null, off: 0, pos: from };
  return { id: ($p.node(1).attrs.id as string | null) ?? null, off: from - $p.start(1), pos: from };
}

function restore(editor: Editor, at: ReturnType<typeof caret>) {
  if (!at) return;
  let target: number | null = null;
  if (at.id) {
    editor.state.doc.forEach((node, pos) => {
      if (target === null && node.attrs.id === at.id) target = pos + 1 + Math.min(at.off, node.content.size);
    });
  }
  editor.commands.setTextSelection(target ?? Math.min(at.pos, editor.state.doc.content.size));
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
    /** Who made a change that arrives while you're typing (for the line a
     *  clash leaves: "Sam changed this while you were editing"). */
    theirName?: string;
    /** This note's id: it isn't offered when linking with ``[[``. */
    noteId?: string;
  }
>(function BodyEditor({ value, onChange, editable = true, placeholder = "Note", autoFocus, toolbar = "focus", className, label = "Note text", theirName, noteId }, ref) {
  const navigate = useNavigate();
  // ``[[`` (or ``@`` after a space) links anything you can open — another
  // note, a task, an event, a file, a person — as an in-app ``/link/…``
  // link, which the server records as a mention.
  const selfRef = useRef(noteId);
  selfRef.current = noteId;
  const wiki = useMemo(
    () =>
      WikiLinkExtension.configure({
        items: async (q: string): Promise<WikiTarget[]> => {
          if (!q.trim()) return [];
          try {
            const found = await connectionsApi.search(q.trim(), 6);
            return found
              .filter((t) => !(t.kind === "note" && t.id === selfRef.current))
              .map((t) => ({ id: t.id, kind: t.label, refId: null, title: t.title, workspaceId: "", href: linkPath(t) }));
          } catch {
            return [];
          }
        },
      }),
    [],
  );
  const theirNameRef = useRef(theirName);
  theirNameRef.current = theirName;
  // Everything this editor has sent out lately: a body coming back equal
  // to one of them is our own save (maybe an older one), not someone else's.
  const sent = useRef<string[]>([]);
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
  const remember = (n: string) => {
    sent.current.push(n);
    if (sent.current.length > 200) sent.current.shift();
  };

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
      wiki,
      PassEscape,
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
      remember(lastOut.current);
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
    if (dirty.current && sent.current.includes(incoming)) {
      // An older save of ours coming back (newer typing is on its way):
      // what's on screen grew out of it. (With nothing unsent, a body we
      // once had coming back is a real change — an Undo or an earlier
      // version restored — and is shown.)
      base.current = value ?? null;
      return;
    }
    const at = caret(editor);
    if (dirty.current) {
      // Someone else's change while you have typing they haven't got: put
      // the two together here, block by block (a block you both changed
      // keeps both), and send the result on from their version.
      const mine = editor.isEmpty ? null : (editor.getJSON() as DocNode);
      const merged = mergeDocs(base.current, value ?? null, mine, theirNameRef.current ?? "Someone");
      base.current = value ?? null;
      editor.commands.setContent((merged as object) ?? EMPTY, { emitUpdate: false });
      restore(editor, at);
      const m = norm(merged);
      lastOut.current = m;
      if (m === incoming) dirty.current = false;
      else {
        remember(m);
        onChangeRef.current(merged, value ?? null);
      }
      return;
    }
    lastOut.current = incoming;
    base.current = value ?? null;
    editor.commands.setContent((value as object) ?? EMPTY, { emitUpdate: false });
    restore(editor, at);
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
      onClick={(e) => {
        // A link to something in Promptly (a ``[[`` mention) opens it.
        const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='/']");
        const href = a?.getAttribute("href");
        if (!a || !href || href.startsWith("//") || e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        if (window.getSelection()?.isCollapsed === false) return;
        e.preventDefault();
        navigate(href);
      }}
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
