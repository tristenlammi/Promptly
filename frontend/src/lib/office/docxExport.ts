/**
 * Promptly document → .docx, in the browser (WP-4.3, Part C §3.7).
 *
 * The document's HTML is parsed through the editor's own schema into
 * TipTap JSON, and this walker writes it with the ``docx`` library. The
 * node mapping is adapted from prosemirror-docx (MIT) for TipTap's
 * camelCase nodes plus ours (task lists, callouts, columns, details).
 * "Good enough to send" — it reads well in Word and LibreOffice; it isn't
 * a pixel copy of the editor.
 */
import { generateJSON, type JSONContent } from "@tiptap/core";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertMillimetersToTwip,
  type ISectionOptions,
  type ParagraphChild,
} from "docx";

import { buildExtensions } from "@/components/files/documents/extensions";
import { resolveAssetUrl } from "@/lib/assetLinks";
import { DEFAULT_PAGE_SETUP, PAPER_MM, numberParts, type PageSetup } from "@/lib/pageSetup";

type Block = Paragraph | Table;
type Mark = { type: string; attrs?: Record<string, unknown> };

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];
const MAX_IMAGE_WIDTH = 600;

interface Ctx {
  /** Images fetched ahead of the walk (src → bytes + size). */
  images: Map<string, { data: ArrayBuffer; type: "png" | "jpg" | "gif" | "bmp"; width: number; height: number }>;
  /** Next numbered-list instance, so each list restarts at 1. */
  nextList: number;
}

/** Paragraph alignment from TextAlign (WP-4.5). */
const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
  left: AlignmentType.LEFT,
};
const alignOf = (node: JSONContent) =>
  typeof node.attrs?.textAlign === "string" ? ALIGN[node.attrs.textAlign] : undefined;

/** The first family of a CSS font stack, unquoted ("Georgia, serif" → Georgia). */
const firstFont = (stack: unknown): string | undefined => {
  if (typeof stack !== "string" || !stack.trim()) return undefined;
  return stack.split(",")[0].trim().replace(/^['"]|['"]$/g, "") || undefined;
};
/** "14pt" / "18px" → Word half-points. */
const halfPoints = (size: unknown): number | undefined => {
  if (typeof size !== "string") return undefined;
  const m = /^([\d.]+)(pt|px)$/.exec(size.trim());
  if (!m) return undefined;
  const pt = m[2] === "px" ? Number(m[1]) * 0.75 : Number(m[1]);
  return Number.isFinite(pt) && pt > 0 ? Math.round(pt * 2) : undefined;
};
const CALLOUT_FILL: Record<string, [string, string]> = {
  info: ["E0F2FE", "38BDF8"],
  warning: ["FEF3C7", "F59E0B"],
  success: ["D1FAE5", "10B981"],
  danger: ["FFE4E6", "F43F5E"],
};

const hex = (c: unknown): string | undefined => {
  if (typeof c !== "string") return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  return m ? m[1].toUpperCase() : undefined;
};

function textRuns(nodes: JSONContent[] | undefined, ctx: Ctx): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") {
      out.push(new TextRun({ text: "", break: 1 }));
      continue;
    }
    if (node.type === "image") {
      const run = imageRun(node, ctx);
      if (run) out.push(run);
      continue;
    }
    if (node.type === "inlineMath") {
      // The LaTeX source, set like maths (Word has no LaTeX renderer).
      out.push(new TextRun({ text: String(node.attrs?.latex ?? ""), italics: true, font: "Cambria Math" }));
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const marks = (node.marks ?? []) as Mark[];
    const has = (t: string) => marks.some((m) => m.type === t);
    const style = marks.find((m) => m.type === "textStyle")?.attrs;
    const color = hex(style?.color);
    const highlight = marks.find((m) => m.type === "highlight");
    const run = new TextRun({
      text: node.text,
      bold: has("bold"),
      italics: has("italic"),
      strike: has("strike"),
      subScript: has("subscript") || undefined,
      superScript: has("superscript") || undefined,
      underline: has("underline") || has("link") ? {} : undefined,
      font: has("code") ? "Courier New" : firstFont(style?.fontFamily),
      size: halfPoints(style?.fontSize),
      color: has("link") ? "2563EB" : color,
      shading: highlight
        ? { type: ShadingType.CLEAR, fill: hex(highlight.attrs?.color) ?? "FFF59D", color: "auto" }
        : undefined,
    });
    const link = marks.find((m) => m.type === "link");
    const href = typeof link?.attrs?.href === "string" ? link.attrs.href : null;
    out.push(href && /^(https?:|mailto:|tel:)/i.test(href) ? new ExternalHyperlink({ link: href, children: [run] }) : run);
  }
  return out;
}

function imageRun(node: JSONContent, ctx: Ctx): ImageRun | null {
  const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
  const img = ctx.images.get(src);
  if (!img) return null;
  // A resized image keeps the width it was given in the editor (WP-4.5).
  const wanted = Number(node.attrs?.width) > 0 ? Number(node.attrs?.width) : img.width;
  const scale = Math.min(wanted, MAX_IMAGE_WIDTH) / Math.max(1, img.width);
  return new ImageRun({
    type: img.type,
    data: img.data,
    transformation: { width: Math.round(img.width * scale), height: Math.round(img.height * scale) },
    altText: typeof node.attrs?.alt === "string" && node.attrs.alt
      ? { name: node.attrs.alt, description: node.attrs.alt, title: node.attrs.alt }
      : undefined,
  });
}

function list(node: JSONContent, ctx: Ctx, level: number, ordered: boolean, instance: number): Block[] {
  const out: Block[] = [];
  for (const item of node.content ?? []) {
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        const nestedOrdered = child.type === "orderedList";
        out.push(...list(child, ctx, level + 1, nestedOrdered, nestedOrdered ? ctx.nextList++ : 0));
      } else if (child.type === "paragraph" || child.type === "heading") {
        out.push(
          new Paragraph({
            children: textRuns(child.content, ctx),
            numbering: ordered
              ? { reference: "numbers", level: Math.min(level, 8), instance }
              : { reference: "bullets", level: Math.min(level, 8) },
          })
        );
      } else {
        out.push(...blocks([child], ctx, { indent: 720 * (level + 1) }));
      }
    }
  }
  return out;
}

function taskList(node: JSONContent, ctx: Ctx, level: number): Block[] {
  const out: Block[] = [];
  for (const item of node.content ?? []) {
    const box = item.attrs?.checked ? "☑ " : "☐ ";
    let first = true;
    for (const child of item.content ?? []) {
      if (child.type === "taskList") {
        out.push(...taskList(child, ctx, level + 1));
      } else if (child.type === "paragraph") {
        out.push(
          new Paragraph({
            indent: { left: 360 * (level + 1) },
            children: [new TextRun(first ? box : "   "), ...textRuns(child.content, ctx)],
          })
        );
        first = false;
      }
    }
  }
  return out;
}

function table(node: JSONContent, ctx: Ctx): Table {
  const rows = (node.content ?? []).map((row) => {
    const cells = row.content ?? [];
    const isHeader = cells.length > 0 && cells.every((c) => c.type === "tableHeader");
    return new TableRow({
      tableHeader: isHeader,
      children: cells.map((cell) => {
        const inner = blocks(cell.content ?? [], ctx);
        return new TableCell({
          columnSpan: Number(cell.attrs?.colspan) > 1 ? Number(cell.attrs?.colspan) : undefined,
          rowSpan: Number(cell.attrs?.rowspan) > 1 ? Number(cell.attrs?.rowspan) : undefined,
          shading: cell.type === "tableHeader" ? { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" } : undefined,
          children: inner.length ? inner : [new Paragraph("")],
        });
      }),
    });
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

function blocks(nodes: JSONContent[], ctx: Ctx, opts: { indent?: number } = {}): Block[] {
  const out: Block[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        out.push(
          new Paragraph({
            alignment: alignOf(node),
            children: textRuns(node.content, ctx),
            indent: opts.indent ? { left: opts.indent } : undefined,
          })
        );
        break;
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
        out.push(new Paragraph({ heading: HEADINGS[level - 1], alignment: alignOf(node), children: textRuns(node.content, ctx) }));
        break;
      }
      case "pageBreak":
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case "blockMath":
        out.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: String(node.attrs?.latex ?? ""), italics: true, font: "Cambria Math" })],
          })
        );
        break;
      case "bulletList":
        out.push(...list(node, ctx, 0, false, 0));
        break;
      case "orderedList":
        out.push(...list(node, ctx, 0, true, ctx.nextList++));
        break;
      case "taskList":
        out.push(...taskList(node, ctx, 0));
        break;
      case "blockquote":
        // Indented and ruled on the left, like the editor shows it.
        for (const child of node.content ?? []) {
          if (child.type === "paragraph" || child.type === "heading") {
            out.push(
              new Paragraph({
                indent: { left: 720 },
                border: { left: { style: BorderStyle.SINGLE, size: 12, color: "BBBBBB", space: 8 } },
                children: textRuns(child.content, ctx),
              })
            );
          } else {
            out.push(...blocks([child], ctx, { indent: 720 }));
          }
        }
        break;
      case "codeBlock": {
        const text = (node.content ?? []).map((t) => t.text ?? "").join("");
        for (const line of text.split("\n")) {
          out.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, fill: "F5F5F5", color: "auto" },
              children: [new TextRun({ text: line || " ", font: "Courier New", size: 20 })],
            })
          );
        }
        break;
      }
      case "horizontalRule":
        out.push(
          new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 } }, children: [] })
        );
        break;
      case "table":
        out.push(table(node, ctx));
        out.push(new Paragraph(""));
        break;
      case "image": {
        const run = imageRun(node, ctx);
        const align = typeof node.attrs?.align === "string" ? ALIGN[node.attrs.align] : AlignmentType.CENTER;
        if (run) out.push(new Paragraph({ alignment: align, children: [run] }));
        const caption = typeof node.attrs?.caption === "string" ? node.attrs.caption.trim() : "";
        if (caption) {
          out.push(
            new Paragraph({
              alignment: align,
              children: [new TextRun({ text: caption, italics: true, size: 18, color: "666666" })],
            })
          );
        }
        break;
      }
      case "callout": {
        const [fill, rule] = CALLOUT_FILL[String(node.attrs?.variant ?? "info")] ?? CALLOUT_FILL.info;
        for (const child of node.content ?? []) {
          out.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, fill, color: "auto" },
              border: { left: { style: BorderStyle.SINGLE, size: 18, color: rule, space: 6 } },
              alignment: alignOf(child),
              children: textRuns(child.content, ctx),
            })
          );
        }
        break;
      }
      case "details":
        for (const child of node.content ?? []) {
          if (child.type === "detailsSummary") {
            out.push(new Paragraph({ children: [new TextRun({ text: "▸ ", bold: true }), ...textRuns(child.content, ctx)] }));
          } else {
            out.push(...blocks(child.content ?? [], ctx, { indent: 360 }));
          }
        }
        break;
      case "youtube":
      case "audio": {
        const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
        const label = node.type === "youtube" ? "Video" : "Audio";
        out.push(
          new Paragraph({
            children: /^https?:/i.test(src)
              ? [new ExternalHyperlink({ link: src, children: [new TextRun({ text: `${label}: ${src}`, color: "2563EB", underline: {} })] })]
              : [new TextRun({ text: `[${label}]`, italics: true })],
          })
        );
        break;
      }
      default:
        // Columns, column and anything new: keep the content, in order.
        if (node.content?.length) out.push(...blocks(node.content, ctx, opts));
    }
  }
  return out;
}

/** Fetch every image the document shows (same-origin signed URLs), as
 *  a format Word takes; WebP is redrawn as PNG. */
async function loadImages(doc: JSONContent): Promise<Ctx["images"]> {
  const srcs = new Set<string>();
  const walk = (n: JSONContent) => {
    if (n.type === "image" && typeof n.attrs?.src === "string") srcs.add(n.attrs.src);
    n.content?.forEach(walk);
  };
  walk(doc);
  const images: Ctx["images"] = new Map();
  await Promise.all(
    [...srcs].map(async (src) => {
      try {
        // A document asset is stored as a path — fetch it through a
        // short-lived signed link (R-228).
        const res = await fetch(await resolveAssetUrl(src), { credentials: "same-origin" });
        if (!res.ok) return;
        let blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const { width, height } = bitmap;
        let type: "png" | "jpg" | "gif" | "bmp" | null =
          blob.type === "image/png" ? "png" : blob.type === "image/jpeg" ? "jpg" : blob.type === "image/gif" ? "gif" : blob.type === "image/bmp" ? "bmp" : null;
        if (!type) {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png")
          );
          type = "png";
        }
        bitmap.close();
        images.set(src, { data: await blob.arrayBuffer(), type, width, height });
      } catch {
        /* an image that won't load is left out */
      }
    })
  );
  return images;
}

const SMALL = { size: 18, color: "555555" };

/** The page setup (WP-6.4) as the section's page size, margins, header and
 *  footer — laid out like the PDF: header centred at the top, footer centred
 *  at the bottom, page numbers where chosen (sharing the footer's line when
 *  both sit bottom-centre). */
export function sectionFor(setup: PageSetup): Omit<ISectionOptions, "children"> {
  const [w, h] = PAPER_MM[setup.size];
  const m = setup.margins;
  const numberRuns = (): ParagraphChild[] => {
    const { before, between } = numberParts(setup.numberStyle);
    return [
      new TextRun({ ...SMALL, children: between ? [before, PageNumber.CURRENT, between, PageNumber.TOTAL_PAGES] : [before, PageNumber.CURRENT] }),
    ];
  };
  const line = (runs: ParagraphChild[], alignment: (typeof AlignmentType)[keyof typeof AlignmentType]) =>
    new Paragraph({ alignment, children: runs });
  const top: Paragraph[] = [];
  const bottom: Paragraph[] = [];
  if (setup.header) top.push(line([new TextRun({ ...SMALL, text: setup.header })], AlignmentType.CENTER));
  if (setup.pageNumbers === "top-right") top.push(line(numberRuns(), AlignmentType.RIGHT));
  if (setup.footer && setup.pageNumbers === "bottom-center") {
    bottom.push(line([new TextRun({ ...SMALL, text: `${setup.footer}  ·  ` }), ...numberRuns()], AlignmentType.CENTER));
  } else {
    if (setup.footer) bottom.push(line([new TextRun({ ...SMALL, text: setup.footer })], AlignmentType.CENTER));
    if (setup.pageNumbers === "bottom-center") bottom.push(line(numberRuns(), AlignmentType.CENTER));
    if (setup.pageNumbers === "bottom-right") bottom.push(line(numberRuns(), AlignmentType.RIGHT));
  }
  const twip = (mm: number) => convertMillimetersToTwip(mm);
  return {
    properties: {
      page: {
        // Portrait width/height; docx swaps them for landscape.
        size: {
          width: twip(w),
          height: twip(h),
          orientation: setup.orientation === "landscape" ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
        },
        margin: {
          top: twip(m.top),
          right: twip(m.right),
          bottom: twip(m.bottom),
          left: twip(m.left),
          header: twip(Math.min(12.7, m.top / 2)),
          footer: twip(Math.min(12.7, m.bottom / 2)),
        },
      },
    },
    ...(top.length ? { headers: { default: new Header({ children: top }) } } : {}),
    ...(bottom.length ? { footers: { default: new Footer({ children: bottom }) } } : {}),
  };
}

/** The document (as its sanitised HTML) as a .docx file. */
export async function htmlToDocx(html: string, title: string, setup: PageSetup = DEFAULT_PAGE_SETUP): Promise<Blob> {
  const extensions = buildExtensions({ ydoc: null, provider: null, user: null });
  const json = generateJSON(html || "<p></p>", extensions);
  const ctx: Ctx = { images: await loadImages(json), nextList: 1 };
  const children = blocks(json.content ?? [], ctx);
  const levels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (i: number) => string) =>
    Array.from({ length: 9 }, (_, i) => ({
      level: i,
      format,
      text: text(i),
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } },
    }));
  const doc = new Document({
    title,
    creator: "Promptly",
    numbering: {
      config: [
        { reference: "bullets", levels: levels(LevelFormat.BULLET, (i) => ["•", "◦", "▪"][i % 3]) },
        { reference: "numbers", levels: levels(LevelFormat.DECIMAL, (i) => `%${i + 1}.`) },
      ],
    },
    sections: [{ ...sectionFor(setup), children: children.length ? children : [new Paragraph("")] }],
  });
  return Packer.toBlob(doc);
}
