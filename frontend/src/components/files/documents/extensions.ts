import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Color } from "@tiptap/extension-color";
import Details from "@tiptap/extension-details";
import DetailsContent from "@tiptap/extension-details-content";
import DetailsSummary from "@tiptap/extension-details-summary";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextStyle from "@tiptap/extension-text-style";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import Youtube from "@tiptap/extension-youtube";
import { common, createLowlight } from "lowlight";
import type { Doc as YDoc } from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";

import { AudioExtension } from "./AudioExtension";
import { CalloutExtension } from "./CalloutExtension";
import { Column, Columns } from "./ColumnsExtension";
import { MentionMark } from "./MentionMark";
import { SlashCommandExtension } from "./SlashCommandExtension";
import { WikiLinkExtension, type WikiTarget } from "./WikiLinkExtension";

/**
 * Build the TipTap extension array used by the Drive Documents editor.
 *
 * This is where the "feature rich doc editor" request lands — one
 * flat array listing every block / mark the user asked for. A few
 * non-obvious configuration notes:
 *
 *   - ``StarterKit.history`` is disabled when collab is on because
 *     ``y-prosemirror`` ships its own yUndoPlugin; running both
 *     history managers at once corrupts the CRDT.
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
  wikiLink?: { items: (query: string) => Promise<WikiTarget[]> };
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
  const collabActive = Boolean(ydoc && provider);

  const extensions: Extensions = [
    StarterKit.configure({
      // When Collaboration is active, y-prosemirror installs its own
      // undo plugin. Two history managers fight over the transactions
      // and eventually corrupt the Y.Doc — always leave one of the
      // two disabled.
      history: collabActive ? false : {},
      // Replaced by CodeBlockLowlight below so we get syntax
      // highlighting.
      codeBlock: false,
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
    Underline,
    // Smart typography — curly quotes, em/en dashes, ellipsis, ©/™/… (MIT).
    Typography,
    // Text colour: the Color mark rides on TextStyle (both MIT). Renders as
    // ``<span style="color:…">`` — allow-listed + handled by the walker.
    TextStyle,
    Color,
    Highlight.configure({
      multicolor: true,
    }),
    // Person-mention chip styling (@people). Registered always so any doc
    // can parse/preserve an existing mention, even opened outside a
    // workspace; only workspace notes actually insert them.
    MentionMark,
    Link.configure({
      openOnClick: false,
      autolink: true,
      protocols: ["http", "https", "mailto", "tel"],
      HTMLAttributes: {
        rel: "noopener noreferrer",
        target: "_blank",
      },
    }),
    Image.configure({
      allowBase64: false,
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
    // The "/" block menu the Placeholder text promises. Commands reuse
    // the toolbar's chains; image/audio delegate to the toolbar's picker
    // via a CustomEvent (see SlashCommandExtension for why).
    SlashCommandExtension.configure({
      hasWikiLink: Boolean(wikiLink),
    }),
  ];

  // Workspace notes opt into the ``[[`` wiki-link autocomplete. The
  // extension only inserts a Link mark (in-app relative href) via normal
  // chains, so it coexists with Collaboration without fighting the CRDT.
  if (wikiLink) {
    extensions.push(
      WikiLinkExtension.configure({
        items: wikiLink.items,
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

  // ``CollaborationCursor`` needs the live awareness channel, which
  // lives on the provider. Register it separately so its absence
  // during the async connect window doesn't block ``Collaboration``.
  if (provider) {
    extensions.push(
      CollaborationCursor.configure({
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
