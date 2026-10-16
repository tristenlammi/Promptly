import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import Mathematics from "@tiptap/extension-mathematics";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Typography from "@tiptap/extension-typography";
import Youtube from "@tiptap/extension-youtube";
import { Placeholder } from "@tiptap/extensions";
import { common, createLowlight } from "lowlight";
import type { Doc as YDoc } from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";

import { AudioExtension } from "./AudioExtension";
import { BlockMoveExtension } from "./BlockMoveExtension";
import { CalloutExtension } from "./CalloutExtension";
import { Column, Columns } from "./ColumnsExtension";
import { CommentsExtension } from "./CommentsExtension";
import { DocImage } from "./DocImage";
import { FindReplaceExtension } from "./FindReplaceExtension";
import { MentionMark } from "./MentionMark";
import { PageBreakExtension } from "./PageBreakExtension";
import { SlashCommandExtension } from "./SlashCommandExtension";
import { SpellCheckExtension, SPELLCHECK_WORD_EVENT } from "./SpellCheckExtension";
import { SuggestionExtension } from "./SuggestionExtension";
import { WikiLinkExtension, type WikiTarget } from "./WikiLinkExtension";

/**
 * Build the TipTap extension array used by the Drive Documents editor.
 *
 * This is where the "feature rich doc editor" request lands — one
 * flat array listing every block / mark the user asked for. A few
 * non-obvious configuration notes:
 *
 *   - ``StarterKit.undoRedo`` (v2's ``history``) is disabled when collab
 *     is on because the Collaboration extension ships its own yUndoPlugin;
 *     running both history managers at once corrupts the CRDT.
 *   - TipTap v3's StarterKit brings Link and Underline (configured here)
 *     and a TrailingNode, which stays off: every collaborator appending
 *     its own trailing paragraph would grow the document on open.
 *   - ``StarterKit.codeBlock`` is disabled in favour of
 *     CodeBlockLowlight so we get language-aware highlighting via
 *     the existing highlight.js bundle.
 *   - The Placeholder text is a plain string rather than a React
 *     component so it survives the collab snapshot round-trip
 *     (y-prosemirror only replays document state, not UI widgets).
 *   - YouTube is forced into the privacy-preserving
 *     ``youtube-nocookie.com`` embed host, which pairs with the
 *     ``frame-src`` entry in the nginx CSP.
 *
 * ## Manual extension QA matrix
 *
 * Covering every extension automatically would require spinning up
 * Hocuspocus + a browser runner per test, which is out of scope for
 * this stage. The table below is the "manual extension matrix"
 * called out in the plan — walk through it in a fresh document
 * after any change to this file or the serializer in
 * ``backend/app/files/document_render.py``.
 *
 *   Source / Extension                   | Editor | Snapshot HTML | FTS text
 *   ------------------------------------ | ------ | ------------- | --------
 *   StarterKit: paragraph / text         |   ✓    |     ✓         |    ✓
 *   StarterKit: bold / italic / strike   |   ✓    |     ✓         |    ✓ (plain text)
 *   StarterKit: blockquote               |   ✓    |     ✓         |    ✓
 *   StarterKit: bulletList + listItem    |   ✓    |     ✓         |    ✓
 *   StarterKit: orderedList              |   ✓    |     ✓         |    ✓
 *   StarterKit: heading (h1..h6)         |   ✓    |     ✓         |    ✓
 *   StarterKit: hardBreak / hr           |   ✓    |     ✓         |    ✓ (whitespace)
 *   CodeBlockLowlight                    |   ✓    |     ✓ (<pre><code class="language-*">) | ✓ (code indexed)
 *   Underline / Highlight / Link         |   ✓    |     ✓         |    ✓ (plain)
 *   Image (inline asset)                 |   ✓    |     ✓ (signed URL) | ✗ (alt only)
 *   AudioExtension (inline asset)        |   ✓    |     ✓ (signed URL) | ✗
 *   Youtube (nocookie only)              |   ✓    |     ✓ iframe  | ✗
 *   TaskList + TaskItem                  |   ✓    |     ✓ (data-checked) | ✓
 *   Table + Row + Header + Cell          |   ✓    |     ✓         |    ✓
 *   Details / Summary / Content          |   ✓    |     ✓         |    ✓
 *   Emoji (custom span)                  |   ✓    |     ✓         |    ✓ (unicode glyph)
 *   Collaboration + CollaborationCursor  |   ✓ (two browser sessions, cursors visible) | n/a | n/a
 *
 * Snapshot correctness can be spot-checked by opening the
 * FilePreviewModal on the same file — it renders from the stored
 * HTML blob via DOMPurify, so anything missing in preview is
 * missing in FTS too.
 */
/** Fired when a maths node is clicked; the editor opens its LaTeX editor. */
export const EDIT_MATH_EVENT = "promptly:edit-math";

export interface BuildExtensionsOptions {
  ydoc: YDoc | null;
  provider: HocuspocusProvider | null;
  /** ``avatar`` rides through CollaborationCursor into awareness so
   *  peers can render profile pictures on their collaborator chips. */
  user: {
    id: string;
    name: string;
    color: string;
    avatar?: string | null;
  } | null;
  placeholder?: string;
  /** Workspace-note-only: enables the ``[[`` wiki-link autocomplete.
   *  Absent for normal Drive documents, so nothing changes there. The
   *  ``items`` fetcher resolves the popup list for the current query. */
  wikiLink?: {
    items: (query: string) => Promise<WikiTarget[]>;
    /** ``@`` menu: people + items + dates (R-232). */
    mentions?: (query: string) => Promise<WikiTarget[]>;
    /** A person was mentioned — the host notifies them (R-232). */
    onMention?: (userId: string) => void;
  };
}

// Lazily-built lowlight instance. Registers the "common" languages
// (javascript, typescript, python, …) which covers ~95% of what users
// will actually paste; the advanced set is available via the plain
// CodeBlock node's ``language`` attribute if a user opts in.
const lowlight = createLowlight(common);

export function buildExtensions({
  ydoc,
  provider,
  user,
  placeholder = "Start typing, or hit / for commands…",
  wikiLink,
}: BuildExtensionsOptions): Extensions {

  const extensions: Extensions = [
    StarterKit.configure({
      // When Collaboration is active, y-prosemirror installs its own
      // undo plugin. Two history managers fight over the transactions
      // and eventually corrupt the Y.Doc — always leave one of the
      // two disabled.
      // Off whenever a Y.Doc is bound (Collaboration brings its own undo) —
      // keying it on the provider left both on during the first render.
      undoRedo: ydoc ? false : {},
      // Replaced by CodeBlockLowlight below so we get syntax
      // highlighting.
      codeBlock: false,
      trailingNode: false,
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ["http", "https", "mailto", "tel"],
        HTMLAttributes: {
          rel: "noopener noreferrer",
          target: "_blank",
        },
      },
    }),
    CodeBlockLowlight.configure({
      lowlight,
      defaultLanguage: null,
      HTMLAttributes: {
        class: "hljs not-prose",
      },
    }),
    Placeholder.configure({
      placeholder,
      emptyEditorClass: "is-editor-empty",
    }),
    // Smart typography — curly quotes, em/en dashes, ellipsis, ©/™/… (MIT).
    Typography,
    // Text colour: the Color mark rides on TextStyle (both MIT). Renders as
    // ``<span style="color:…">`` — allow-listed + handled by the walker.
    TextStyle,
    Color,
    // Font family and size ride on TextStyle too (WP-4.5). Rendered as
    // ``font-family`` / ``font-size`` in the span's style; the server
    // snapshot allow-lists both.
    FontFamily,
    FontSize,
    // Paragraph / heading alignment (WP-4.5) — ``style="text-align:…"``.
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Subscript,
    Superscript,
    Highlight.configure({
      multicolor: true,
    }),
    // Person-mention chip styling (@people). Registered always so any doc
    // can parse/preserve an existing mention, even opened outside a
    // workspace; only workspace notes actually insert them.
    MentionMark,
    // Image with resize handles, a caption and alignment (WP-4.5).
    DocImage.configure({
      allowBase64: false,
      resize: { enabled: true, minWidth: 48, minHeight: 32, alwaysPreserveAspectRatio: true },
      HTMLAttributes: {
        class: "rounded-md max-w-full h-auto",
      },
    }),
    AudioExtension,
    Youtube.configure({
      nocookie: true,
      modestBranding: true,
      controls: true,
      HTMLAttributes: {
        class: "rounded-md",
      },
    }),
    TaskList.configure({
      HTMLAttributes: {
        class: "task-list not-prose",
      },
    }),
    TaskItem.configure({
      nested: true,
      HTMLAttributes: {
        class: "task-item",
      },
    }),
    Table.configure({
      resizable: true,
      HTMLAttributes: {
        class: "doc-table",
      },
    }),
    TableRow,
    TableHeader,
    TableCell,
    // Details (collapsible "toggle") — the insert affordances (toolbar
    // button, slash "Toggle", mobile sheet tile) were removed: the block
    // rendered as a confusing empty box and Callouts cover the "highlight a
    // section" need. These nodes stay REGISTERED so any older note that
    // already contains a details block still parses + round-trips instead of
    // dropping content; there's just no longer a way to insert a new one.
    Details.configure({
      persist: true,
      openClassName: "is-open",
      HTMLAttributes: {
        class: "doc-details",
      },
    }),
    DetailsSummary,
    DetailsContent,
    // Coloured info/warning/success/danger callout boxes (our own node —
    // no Pro dependency). Variant persists via ``data-variant``.
    CalloutExtension,
    // Multi-column layouts (our own nodes — no Pro dependency).
    Columns,
    Column,
    // Manual page breaks (WP-4.5): a new page in print, PDF and Word.
    PageBreakExtension,
    // LaTeX maths (KaTeX, already a dependency) — inline and block nodes
    // holding their source in ``data-latex`` (WP-4.5). A click edits it.
    Mathematics.configure({
      katexOptions: { throwOnError: false },
      inlineOptions: {
        onClick: (node, pos) =>
          document.dispatchEvent(new CustomEvent(EDIT_MATH_EVENT, { detail: { kind: "inline", pos, latex: node.attrs.latex } })),
      },
      blockOptions: {
        onClick: (node, pos) =>
          document.dispatchEvent(new CustomEvent(EDIT_MATH_EVENT, { detail: { kind: "block", pos, latex: node.attrs.latex } })),
      },
    }),
    // Find & replace (WP-4.5) — highlights only; writes on replace.
    FindReplaceExtension,
    // Move the current block up / down (Alt+Shift+↑/↓; phone block bar).
    BlockMoveExtension,
    // Comment highlights (WP-4.5, R-227): decorations from the threads'
    // Yjs-anchored ranges; nothing is written into the document.
    CommentsExtension,
    // Suggestion mode (track changes): suggested insertions / deletions,
    // accepted or rejected later (Stage 6 stretch).
    SuggestionExtension.configure({ author: user ? { id: user.id, name: user.name } : null }),
    // The "/" block menu the Placeholder text promises. Commands reuse
    // the toolbar's chains; image/audio delegate to the toolbar's picker
    // via a CustomEvent (see SlashCommandExtension for why).
    SlashCommandExtension.configure({
      hasWikiLink: Boolean(wikiLink),
    }),
    // Real-time spell-checking (nspell + Hunspell dictionaries). The plugin
    // only decorates once the editor host loads a dictionary and pushes the
    // config in; registered always so every note/document can use it. Clicking
    // a squiggle fires a DOM CustomEvent the host listens for to open the
    // suggestion popover (keeps this factory free of React state).
    SpellCheckExtension.configure({
      onWordClick: (info) =>
        document.dispatchEvent(
          new CustomEvent(SPELLCHECK_WORD_EVENT, { detail: info })
        ),
    }),
  ];

  // Workspace notes opt into the ``[[`` wiki-link autocomplete. The
  // extension only inserts a Link mark (in-app relative href) via normal
  // chains, so it coexists with Collaboration without fighting the CRDT.
  if (wikiLink) {
    extensions.push(
      WikiLinkExtension.configure({
        items: wikiLink.items,
        // People and dates were built but never passed through (R-232).
        mentions: wikiLink.mentions,
        onMention: wikiLink.onMention,
      })
    );
  }

  // ``Collaboration`` binds the editor state to the Y.Doc. Register
  // it as soon as a Y.Doc exists — the provider is NOT required for
  // this (the Y.Doc is a plain CRDT; keystrokes flow into it
  // immediately and the provider just syncs its state to/from the
  // server whenever it's connected). Gating this behind ``provider``
  // too caused the editor to mount without Collaboration on the
  // first render (provider is always async), so every keystroke
  // typed before the websocket opened was lost from the Y.Doc and
  // never reached the collab service's ``store`` hook.
  if (ydoc) {
    extensions.push(
      Collaboration.configure({
        document: ydoc,
      })
    );
  }

  // ``CollaborationCaret`` (v2's CollaborationCursor) needs the live awareness channel, which
  // lives on the provider. Register it separately so its absence
  // during the async connect window doesn't block ``Collaboration``.
  if (provider) {
    extensions.push(
      CollaborationCaret.configure({
        provider,
        user: user ?? {
          id: "anonymous",
          name: "Anonymous",
          color: "#D97757",
        },
      })
    );
  }

  return extensions;
}
