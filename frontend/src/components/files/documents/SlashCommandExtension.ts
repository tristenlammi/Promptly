import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";

/**
 * ``/`` block-insert menu for the Drive Documents editor (and workspace
 * notes, which reuse it). The Placeholder extension has promised
 * "hit / for commands…" since day one — this extension makes it true.
 *
 * Mirrors the ``[[`` wiki-link autocomplete's approach exactly (see
 * WikiLinkExtension.ts): a dependency-free popup ``<div>`` positioned
 * from the caret rect, keyboard handled in ``onKeyDown``, styled with
 * CSS-var tokens so it's theme-aware. Every command delegates to the
 * same TipTap chains the toolbar buttons use, so the two surfaces can't
 * drift.
 *
 * Image / audio need the toolbar's upload plumbing (hidden file input +
 * ``documentsApi.uploadAsset`` with the document id, which this extension
 * doesn't know) — those items fire a ``promptly:doc-insert-asset``
 * CustomEvent that DocumentToolbar listens for and routes to its own
 * picker. One upload path, two entry points.
 */

export interface SlashItem {
  title: string;
  /** Muted hint shown right-aligned in the row. */
  hint: string;
  /** Extra strings the filter matches besides the title. */
  keywords: string[];
  command: (ctx: { editor: Editor; range: Range }) => void;
}

export const SlashCommandPluginKey = new PluginKey("slashCommand");

/** Event the Image/Audio items fire; DocumentToolbar opens its picker. */
export const INSERT_ASSET_EVENT = "promptly:doc-insert-asset";

function buildItems(hasWikiLink: boolean): SlashItem[] {
  const items: SlashItem[] = [
    {
      title: "Text",
      hint: "plain paragraph",
      keywords: ["paragraph", "plain", "body"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setParagraph().run(),
    },
    {
      title: "Heading 1",
      hint: "big section",
      keywords: ["h1", "title", "section"],
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setHeading({ level: 1 })
          .run(),
    },
    {
      title: "Heading 2",
      hint: "subsection",
      keywords: ["h2", "subtitle"],
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setHeading({ level: 2 })
          .run(),
    },
    {
      title: "Heading 3",
      hint: "small heading",
      keywords: ["h3"],
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setHeading({ level: 3 })
          .run(),
    },
    {
      title: "Bullet list",
      hint: "• item",
      keywords: ["ul", "unordered", "list"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      title: "Numbered list",
      hint: "1. item",
      keywords: ["ol", "ordered", "list"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      title: "To-do list",
      hint: "checkboxes",
      keywords: ["task", "todo", "check", "checkbox"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleTaskList().run(),
    },
    {
      title: "Table",
      hint: "3×3 grid",
      keywords: ["grid", "rows", "columns"],
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      title: "Quote",
      hint: "blockquote",
      keywords: ["blockquote", "citation"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      title: "Code block",
      hint: "syntax highlighted",
      keywords: ["code", "pre", "snippet"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      title: "Divider",
      hint: "horizontal rule",
      keywords: ["hr", "rule", "separator", "line"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
    {
      title: "Callout",
      hint: "highlighted box",
      keywords: ["callout", "admonition", "note", "info", "warning", "aside"],
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setCallout({ variant: "info" })
          .run(),
    },
    {
      title: "2 columns",
      hint: "side-by-side",
      keywords: ["columns", "column", "layout", "grid", "split", "two"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setColumns(2).run(),
    },
    {
      title: "3 columns",
      hint: "three-up layout",
      keywords: ["columns", "column", "layout", "grid", "split", "three"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setColumns(3).run(),
    },
    {
      title: "Image",
      hint: "upload a picture",
      keywords: ["photo", "picture", "upload", "img"],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();
        document.dispatchEvent(
          new CustomEvent(INSERT_ASSET_EVENT, { detail: { kind: "image" } })
        );
      },
    },
    {
      title: "Audio",
      hint: "upload a recording",
      keywords: ["sound", "voice", "recording", "upload"],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();
        document.dispatchEvent(
          new CustomEvent(INSERT_ASSET_EVENT, { detail: { kind: "audio" } })
        );
      },
    },
    {
      title: "YouTube",
      hint: "embed a video",
      keywords: ["video", "embed", "yt"],
      command: ({ editor, range }) => {
        // Same flow as the toolbar button — a plain prompt keeps the two
        // entry points identical.
        const url = window.prompt("YouTube URL");
        if (!url) {
          editor.chain().focus().deleteRange(range).run();
          return;
        }
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setYoutubeVideo({ src: url })
          .run();
      },
    },
  ];
  if (hasWikiLink) {
    items.push({
      title: "Link to item",
      hint: "wiki-link — [[",
      keywords: ["wiki", "workspace", "mention", "reference"],
      // Re-typing the trigger hands over to the wiki-link suggestion,
      // popup and all — no duplicated item-picker.
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).insertContent("[[").run(),
    });
  }
  return items;
}

/** Same shell as WikiLinkPopup — kept separate rather than abstracted:
 *  the two row layouts differ and the file is small enough to read. */
class SlashPopup {
  el: HTMLDivElement;
  private items: SlashItem[] = [];
  private highlighted = 0;
  private onPick: (item: SlashItem) => void;

  constructor(onPick: (item: SlashItem) => void) {
    this.onPick = onPick;
    this.el = document.createElement("div");
    this.el.className = "slash-command-popup";
    Object.assign(this.el.style, {
      position: "absolute",
      zIndex: "60",
      maxHeight: "18rem",
      width: "16rem",
      overflowY: "auto",
      borderRadius: "0.75rem",
      border: "1px solid var(--border)",
      background: "var(--surface)",
      boxShadow:
        "0 10px 15px -3px rgba(0,0,0,0.25), 0 4px 6px -4px rgba(0,0,0,0.25)",
      fontSize: "0.75rem",
      padding: "0.25rem",
    } satisfies Partial<CSSStyleDeclaration>);
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.appendChild(this.el);
  }

  setItems(items: SlashItem[]) {
    this.items = items;
    if (this.highlighted >= items.length) this.highlighted = 0;
    this.render();
  }

  move(delta: number) {
    if (this.items.length === 0) return;
    this.highlighted =
      (this.highlighted + delta + this.items.length) % this.items.length;
    this.render();
  }

  select(): boolean {
    const item = this.items[this.highlighted];
    if (!item) return false;
    this.onPick(item);
    return true;
  }

  position(rect: DOMRect | null) {
    if (!rect) return;
    const margin = 6;
    const el = this.el;
    el.style.left = `${Math.round(rect.left + window.scrollX)}px`;
    el.style.top = `${Math.round(rect.bottom + margin + window.scrollY)}px`;
    requestAnimationFrame(() => {
      const h = el.offsetHeight;
      if (
        rect.bottom + margin + h > window.innerHeight &&
        rect.top - margin - h > 0
      ) {
        el.style.top = `${Math.round(rect.top - margin - h + window.scrollY)}px`;
      }
    });
  }

  private render() {
    const el = this.el;
    el.replaceChildren();

    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText =
        "padding:0.5rem;color:var(--text-muted);font-size:0.75rem";
      empty.textContent = "No matching blocks.";
      el.appendChild(empty);
      return;
    }

    this.items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      const active = i === this.highlighted;
      row.style.cssText = [
        "display:flex",
        "width:100%",
        "align-items:center",
        "gap:0.5rem",
        "padding:0.375rem 0.5rem",
        "text-align:left",
        "border-radius:0.5rem",
        "font-size:0.75rem",
        "cursor:pointer",
        "background:" +
          (active
            ? "color-mix(in srgb, var(--accent) 12%, transparent)"
            : "transparent"),
        "color:var(--text)",
      ].join(";");
      row.addEventListener("mouseenter", () => {
        this.highlighted = i;
        this.render();
      });
      row.addEventListener("click", () => {
        this.highlighted = i;
        this.select();
      });

      const title = document.createElement("span");
      title.style.cssText =
        "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500";
      title.textContent = item.title;

      const hint = document.createElement("span");
      hint.style.cssText =
        "flex:0 0 auto;font-size:10px;color:var(--text-muted)";
      hint.textContent = item.hint;

      row.append(title, hint);
      el.appendChild(row);
    });

    const footer = document.createElement("div");
    footer.style.cssText =
      "padding:0.25rem 0.5rem;font-size:10px;color:var(--text-muted);border-top:1px solid var(--border);margin-top:0.25rem";
    footer.textContent = "↑↓ navigate · Enter to insert · Esc to close";
    el.appendChild(footer);
  }

  destroy() {
    this.el.remove();
  }
}

export interface SlashCommandOptions {
  /** Adds the "Link to item" row (workspace notes only). */
  hasWikiLink: boolean;
}

export const SlashCommandExtension = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return { hasWikiLink: false };
  },

  addProseMirrorPlugins() {
    const extensionThis = this;
    const suggestion: Omit<SuggestionOptions<SlashItem>, "editor"> = {
      pluginKey: SlashCommandPluginKey,
      char: "/",
      // Default prefix rule (start of line or after whitespace) — typing
      // "and/or" mid-word must not open the menu.
      allowSpaces: false,

      items: ({ query }) => {
        const all = buildItems(extensionThis.options.hasWikiLink);
        const q = query.trim().toLowerCase();
        if (!q) return all;
        return all.filter(
          (item) =>
            item.title.toLowerCase().includes(q) ||
            item.keywords.some((k) => k.includes(q))
        );
      },

      command: ({ editor, range, props }) => {
        props.command({ editor, range });
      },

      render: () => {
        let popup: SlashPopup | null = null;
        let currentCommand: ((item: SlashItem) => void) | null = null;

        return {
          onStart: (props: SuggestionProps<SlashItem>) => {
            currentCommand = props.command;
            popup = new SlashPopup((item) => currentCommand?.(item));
            popup.setItems(props.items);
            popup.position(props.clientRect?.() ?? null);
          },

          onUpdate: (props: SuggestionProps<SlashItem>) => {
            currentCommand = props.command;
            popup?.setItems(props.items);
            popup?.position(props.clientRect?.() ?? null);
          },

          onKeyDown: (props: SuggestionKeyDownProps) => {
            if (!popup) return false;
            switch (props.event.key) {
              case "ArrowDown":
                popup.move(1);
                return true;
              case "ArrowUp":
                popup.move(-1);
                return true;
              case "Enter":
              case "Tab":
                return popup.select();
              case "Escape":
                popup.destroy();
                popup = null;
                return true;
              default:
                return false;
            }
          },

          onExit: () => {
            popup?.destroy();
            popup = null;
            currentCommand = null;
          },
        };
      },
    };

    return [
      Suggestion({
        editor: this.editor,
        ...suggestion,
      }),
    ];
  },
});
