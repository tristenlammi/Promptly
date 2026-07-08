import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";

/**
 * Wiki-link (``[[``) autocomplete for workspace notes.
 *
 * ## Why this is "just a Link mark"
 *
 * A wiki-link is deliberately *not* a custom node or mark. The note's
 * Y.Doc is snapshotted to HTML and run through ``bleach`` server-side
 * (see ``backend/app/files/document_render.py``); any bespoke node or a
 * ``wsitem:`` protocol would be stripped on the way out. Instead we emit
 * a plain TipTap ``Link`` mark whose ``href`` is an **in-app relative URL**:
 *
 *   ``/workspaces/<wid>?item=<itemId>&kind=<kind>&ref=<refId>``
 *
 * Relative hrefs survive the bleach pass, and the backend backlinks scan
 * just greps the saved HTML for the substring ``item=<itemId>``. The note
 * pane intercepts clicks on these anchors to open the target item inline
 * (it never actually navigates the browser).
 *
 * ## The popup
 *
 * Rather than pull in tippy.js / floating-ui (neither is a direct
 * dependency), the suggestion renders a small self-contained ``<div>``
 * appended to ``document.body`` and positioned from the caret rect the
 * Suggestion plugin hands us. Keyboard (↑/↓/Enter/Tab/Esc) is handled in
 * ``onKeyDown``; the styling mirrors the ``@``-mention popover's CSS-var
 * tokens so the two feel like siblings.
 */

/** A single selectable wiki-link target.
 *
 * The ``@`` menu reuses this shape for people and dates too, discriminated
 * by ``kind``: a normal item (note/board/…) inserts a wiki Link mark; a
 * ``"person"`` inserts a mention chip (``@name``); a ``"date"`` inserts
 * ``insertText`` as plain text. ``[[`` only ever yields items. */
export interface WikiTarget {
  id: string;
  kind: string;
  refId: string | null;
  title: string;
  workspaceId: string;
  /** For ``kind === "date"`` — the literal text to drop in (e.g. the
   *  formatted date); ignored for items/people. */
  insertText?: string;
}

export interface WikiLinkOptions {
  /** Resolve the popup list for the current ``[[`` query (items only). */
  items: (query: string) => Promise<WikiTarget[]>;
  /** Resolve the ``@`` menu — items + people + dates. Falls back to
   *  ``items`` when absent (so ``@`` still links items). */
  mentions?: (query: string) => Promise<WikiTarget[]>;
}

export const WikiLinkPluginKey = new PluginKey("wikiLink");
/** Second trigger — ``@`` — sharing the wiki-link machinery. Same item
 *  targets, same relative-href Link mark; only the trigger char differs, so
 *  ``@Kitchen`` and ``[[Kitchen`` produce identical links. Needs its own
 *  plugin key so the two Suggestion plugins don't collide. */
export const MentionPluginKey = new PluginKey("wikiMention");

/** Build the in-app relative href the Link mark carries. Relative on
 *  purpose — survives the Yjs → HTML → bleach snapshot pipeline, and the
 *  backend backlinks scan looks for the ``item=<id>`` substring. */
export function buildWikiHref(target: WikiTarget): string {
  const params = new URLSearchParams();
  params.set("item", target.id);
  params.set("kind", target.kind);
  if (target.refId) params.set("ref", target.refId);
  return `/workspaces/${target.workspaceId}?${params.toString()}`;
}

/** Parse the ``item`` / ``kind`` / ``ref`` params back out of a wiki href.
 *  Returns ``null`` when the href isn't a wiki-link (no ``item=``). Tolerant
 *  of absolute hrefs too in case the browser resolved the relative URL. */
export function parseWikiHref(
  href: string | null | undefined
): { item: string; kind: string; ref: string | null } | null {
  if (!href || !href.includes("item=")) return null;
  // Parse against a dummy base so a relative href resolves cleanly.
  let search: string;
  try {
    search = new URL(href, "http://x").search;
  } catch {
    // Fall back to whatever follows the first ``?``.
    const qi = href.indexOf("?");
    search = qi >= 0 ? href.slice(qi) : "";
  }
  const params = new URLSearchParams(search);
  const item = params.get("item");
  if (!item) return null;
  return {
    item,
    kind: params.get("kind") ?? "note",
    ref: params.get("ref"),
  };
}

/** Small, dependency-free popup that lists wiki targets. Owns its own DOM
 *  element + highlight state; the Suggestion render lifecycle drives it. */
class WikiLinkPopup {
  el: HTMLDivElement;
  private items: WikiTarget[] = [];
  private highlighted = 0;
  private onPick: (target: WikiTarget) => void;
  private header: string;

  constructor(onPick: (target: WikiTarget) => void, header: string) {
    this.onPick = onPick;
    this.header = header;
    this.el = document.createElement("div");
    this.el.className = "wiki-link-popup";
    // Inline the structural styles so the popup works without a CSS
    // import; colours/tokens come through CSS variables (theme-aware).
    Object.assign(this.el.style, {
      position: "absolute",
      zIndex: "60",
      maxHeight: "18rem",
      width: "20rem",
      overflowY: "auto",
      borderRadius: "0.75rem",
      border: "1px solid var(--border)",
      background: "var(--surface)",
      boxShadow:
        "0 10px 15px -3px rgba(0,0,0,0.25), 0 4px 6px -4px rgba(0,0,0,0.25)",
      fontSize: "0.75rem",
      padding: "0.25rem",
    } satisfies Partial<CSSStyleDeclaration>);
    // Keep editor focus when clicking a row — mirrors the @-mention popover.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.appendChild(this.el);
  }

  setItems(items: WikiTarget[]) {
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

  /** Commit the current highlight. Returns ``true`` when a row was picked. */
  select(): boolean {
    const target = this.items[this.highlighted];
    if (!target) return false;
    this.onPick(target);
    return true;
  }

  position(rect: DOMRect | null) {
    if (!rect) return;
    // Anchor just below the caret. Flip above if it would overflow the
    // bottom of the viewport.
    const margin = 6;
    const top = rect.bottom + margin;
    const el = this.el;
    el.style.left = `${Math.round(rect.left + window.scrollX)}px`;
    el.style.top = `${Math.round(top + window.scrollY)}px`;
    // Defer overflow correction until after layout so offsetHeight is real.
    requestAnimationFrame(() => {
      const h = el.offsetHeight;
      if (rect.bottom + margin + h > window.innerHeight && rect.top - margin - h > 0) {
        el.style.top = `${Math.round(rect.top - margin - h + window.scrollY)}px`;
      }
    });
  }

  private render() {
    const el = this.el;
    el.replaceChildren();

    const header = document.createElement("div");
    header.style.cssText =
      "padding:0.375rem 0.5rem 0.25rem;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)";
    header.textContent = this.header;
    el.appendChild(header);

    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText =
        "padding:0.5rem;color:var(--text-muted);font-size:0.75rem";
      empty.textContent = "No matches.";
      el.appendChild(empty);
      return;
    }

    this.items.forEach((target, i) => {
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
        "background:" + (active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent"),
        "color:var(--text)",
      ].join(";");
      row.addEventListener("mouseenter", () => {
        this.highlighted = i;
        this.render();
      });
      // Commit on mousedown, not click. The popup lives in document.body,
      // so a click races the editor blur that tears the popup down before
      // the click fires — which is why Enter worked but clicking a row did
      // nothing. preventDefault keeps editor focus; select() commits the
      // pick synchronously on press.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.highlighted = i;
        this.select();
      });

      const kind = document.createElement("span");
      kind.style.cssText =
        "flex:0 0 auto;font-size:10px;color:var(--text-muted);text-transform:capitalize";
      kind.textContent = target.kind;

      const title = document.createElement("span");
      title.style.cssText =
        "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500";
      // People read as "@name"; dates show their formatted value inline.
      title.textContent =
        target.kind === "person"
          ? `@${target.title}`
          : target.kind === "date"
            ? `${target.title} — ${target.insertText ?? ""}`
            : target.title || "Untitled";

      row.append(title, kind);
      el.appendChild(row);
    });

    const footer = document.createElement("div");
    footer.style.cssText =
      "padding:0.25rem 0.5rem;font-size:10px;color:var(--text-muted);border-top:1px solid var(--border);margin-top:0.25rem";
    footer.textContent = "↑↓ navigate · click or Enter to insert · Esc to close";
    el.appendChild(footer);
  }

  destroy() {
    this.el.remove();
  }
}

export const WikiLinkExtension = Extension.create<WikiLinkOptions>({
  name: "wikiLink",

  addOptions() {
    return {
      items: async () => [],
    };
  },

  addProseMirrorPlugins() {
    const extensionThis = this;
    // One suggestion config, parameterised by trigger char + plugin key, so
    // ``[[`` and ``@`` share every behaviour (items, insert command, popup).
    const makeSuggestion = (
      char: string,
      pluginKey: PluginKey
    ): Omit<SuggestionOptions<WikiTarget>, "editor"> => ({
      pluginKey,
      char,
      // ``[[`` triggers anywhere (wiki-links are typed mid-word); ``@`` only
      // at line-start or after a space, so it doesn't fire inside emails
      // (``foo@bar``) — mirroring the chat composer's ``(?:^|\s)@`` rule.
      allowedPrefixes: char === "@" ? [" "] : null,
      // Query is the run of non-whitespace after the trigger; substring-filter
      // client-side. (Allowing spaces would make the greedy regex run to
      // end-of-line since there's no closing token to anchor on.)
      allowSpaces: false,

      // ``@`` pulls the richer people+dates+items list when provided;
      // ``[[`` stays items-only.
      items: ({ query }) =>
        char === "@" && extensionThis.options.mentions
          ? extensionThis.options.mentions(query)
          : extensionThis.options.items(query),

      // Insert the picked target over the suggestion range (which deletes
      // the trigger text). Three shapes:
      //   · date   → the formatted date as plain text
      //   · person → "@name" carrying the mention chip mark
      //   · item   → the title carrying an in-app wiki Link mark
      command: ({ editor, range, props }) => {
        const target = props;
        if (target.kind === "date") {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: "text", text: target.insertText || target.title },
              { type: "text", text: " " },
            ])
            .run();
          return;
        }
        if (target.kind === "person") {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "text",
                text: `@${target.title}`,
                marks: [{ type: "mention" }],
              },
              { type: "text", text: " " },
            ])
            // Drop the mention mark so subsequent typing isn't chipped.
            .unsetMark("mention")
            .run();
          return;
        }
        const href = buildWikiHref(target);
        const label = target.title || "Untitled";
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: "text",
              text: label,
              marks: [{ type: "link", attrs: { href } }],
            },
            { type: "text", text: " " },
          ])
          // Drop the link mark so subsequent typing isn't linked.
          .unsetMark("link")
          .run();
      },

      render: () => {
        let popup: WikiLinkPopup | null = null;
        let currentCommand:
          | ((target: WikiTarget) => void)
          | null = null;

        return {
          onStart: (props: SuggestionProps<WikiTarget>) => {
            currentCommand = props.command;
            popup = new WikiLinkPopup(
              (target) => currentCommand?.(target),
              char === "@"
                ? "Mention a person, item, or date"
                : "Link to a workspace item"
            );
            popup.setItems(props.items);
            popup.position(props.clientRect?.() ?? null);
          },

          onUpdate: (props: SuggestionProps<WikiTarget>) => {
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
    });

    return [
      Suggestion({ editor: this.editor, ...makeSuggestion("[[", WikiLinkPluginKey) }),
      Suggestion({ editor: this.editor, ...makeSuggestion("@", MentionPluginKey) }),
    ];
  },
});
