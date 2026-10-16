import { ResizableNodeView } from "@tiptap/core";
import Image from "@tiptap/extension-image";

import { isAssetUrl, resolveAssetUrl } from "@/lib/assetLinks";

/**
 * The editor's image: TipTap's Image with resize handles, plus a caption
 * and an alignment (WP-4.5, R-226 "image resize and captions"). Both are
 * plain node attributes, so they sync through the Y.Doc and render as
 * ``data-caption`` / ``data-align`` on the ``<img>`` (the server snapshot
 * turns them into a ``<figure>``).
 *
 * The node view is our own (WP-4.6, R-228): a document stores an uploaded
 * picture's *path*, and the view swaps in a short-lived signed link before
 * showing it — the stored ``src`` never carries a credential.
 */
export type ImageAlign = "left" | "center" | "right";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docImage: {
      setImageCaption: (caption: string | null) => ReturnType;
      setImageAlign: (align: ImageAlign | null) => ReturnType;
    };
  }
}

/** Point ``el`` at ``src`` — via a signed link when it's a document asset. */
function showSource(el: HTMLImageElement | HTMLAudioElement, src: string | null | undefined): void {
  const want = src ?? "";
  if (el.dataset.src === want) return;
  el.dataset.src = want;
  if (!want) {
    el.removeAttribute("src");
    return;
  }
  if (!isAssetUrl(want)) {
    el.setAttribute("src", want);
    return;
  }
  resolveAssetUrl(want).then(
    (url) => {
      if (el.dataset.src === want) el.setAttribute("src", url);
    },
    () => {
      // Gone, or not yours to see: an honest broken image, not a stale one.
      if (el.dataset.src === want) el.setAttribute("src", "data:,");
    }
  );
}
export { showSource as showAssetSource };

export const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      caption: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-caption") || null,
        renderHTML: (attrs) => (attrs.caption ? { "data-caption": attrs.caption } : {}),
      },
      align: {
        default: null,
        parseHTML: (el) => {
          const a = el.getAttribute("data-align");
          return a === "left" || a === "center" || a === "right" ? a : null;
        },
        renderHTML: (attrs) => (attrs.align ? { "data-align": attrs.align } : {}),
      },
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setImageCaption:
        (caption) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { caption: caption?.trim() || null }),
      setImageAlign:
        (align) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { align }),
    };
  },

  addNodeView() {
    const resize = this.options.resize;
    return ({ node, getPos, editor }) => {
      const img = document.createElement("img");
      img.draggable = false;
      img.className = "rounded-md max-w-full h-auto";
      const sync = (n: typeof node) => {
        showSource(img, n.attrs.src as string | null);
        for (const key of ["alt", "title"] as const) {
          const v = n.attrs[key] as string | null;
          if (v) img.setAttribute(key, v);
          else img.removeAttribute(key);
        }
        const w = Number(n.attrs.width);
        img.style.width = w > 0 ? `${w}px` : "";
        img.style.height = "";
      };
      sync(node);

      const caption = document.createElement("div");
      caption.className = "doc-image-caption";
      caption.contentEditable = "false";
      const paint = (n: typeof node, dom: HTMLElement) => {
        const text = (n.attrs.caption as string | null) ?? "";
        caption.textContent = text;
        caption.style.display = text ? "" : "none";
        const align = n.attrs.align as string | null;
        if (align) dom.setAttribute("data-align", align);
        else dom.removeAttribute("data-align");
      };

      if (!resize || !resize.enabled) {
        const dom = document.createElement("div");
        dom.className = "doc-image";
        dom.dataset.resizeContainer = "";
        dom.dataset.node = "image";
        dom.style.display = "flex";
        dom.append(img, caption);
        paint(node, dom);
        return {
          dom,
          update: (n) => {
            if (n.type !== node.type) return false;
            sync(n);
            paint(n, dom);
            return true;
          },
        };
      }

      const view = new ResizableNodeView({
        element: img,
        editor,
        node,
        getPos,
        onResize: (width, height) => {
          img.style.width = `${width}px`;
          img.style.height = `${height}px`;
        },
        onCommit: (width) => {
          const pos = getPos();
          if (pos === undefined) return;
          editor.chain().setNodeSelection(pos).updateAttributes("image", { width, height: null }).run();
        },
        onUpdate: (n) => {
          if (n.type !== node.type) return false;
          sync(n);
          paint(n, view.dom as HTMLElement);
          return true;
        },
        options: {
          directions: resize.directions,
          min: { width: resize.minWidth, height: resize.minHeight },
          preserveAspectRatio: resize.alwaysPreserveAspectRatio === true,
        },
      });
      const dom = view.dom as HTMLElement;
      dom.classList.add("doc-image");
      dom.appendChild(caption);
      paint(node, dom);
      return view;
    };
  },
});
