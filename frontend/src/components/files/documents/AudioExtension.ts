import { Node, mergeAttributes } from "@tiptap/core";

/**
 * Custom block node for embedded audio clips inside a document.
 *
 * TipTap ships an Image extension but no Audio equivalent, so we
 * roll a minimal one that mirrors Image's API:
 *
 *  - Serialises to ``<audio controls src="…">`` in the rendered HTML.
 *  - Parses the same shape back on paste / load.
 *  - Exposes a ``setAudio({ src })`` command the toolbar uploader
 *    can call after a successful POST to
 *    ``/api/documents/{id}/assets``.
 *
 * The node is a block (not inline) so dropping an audio clip
 * breaks out of surrounding paragraph flow — matches the editor's
 * Image behaviour and matches the layout you'd get if you pasted
 * a clip into Google Docs / Notion.
 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    audio: {
      /** Insert an inline audio node pointing at ``src``. */
      setAudio: (options: { src: string }) => ReturnType;
    };
  }
}

export interface AudioOptions {
  HTMLAttributes: Record<string, unknown>;
}

export const AudioExtension = Node.create<AudioOptions>({
  name: "audio",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "audio[src]",
        getAttrs: (el) => ({
          src: (el as HTMLAudioElement).getAttribute("src"),
        }),
      },
      {
        tag: "audio",
        getAttrs: (el) => {
          const audio = el as HTMLAudioElement;
          const source = audio.querySelector("source");
          const src = audio.getAttribute("src") || source?.getAttribute("src");
          return src ? { src } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "audio",
      mergeAttributes(
        {
          controls: "",
          preload: "metadata",
          "data-type": "audio",
        },
        this.options.HTMLAttributes,
        HTMLAttributes
      ),
    ];
  },

  addCommands() {
    return {
      setAudio:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: options,
          }),
    };
  },
});
