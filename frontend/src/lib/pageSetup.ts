/**
 * A Doc's page setup — paper, margins, header/footer, page numbers (WP-6.4).
 *
 * Kept in the document's Y.Doc, in a ``pageSetup`` map with one key per
 * setting, so two people changing different settings keep both, and every
 * version and restore carries it. Mirrored by
 * ``backend/app/files/page_setup.py`` (which builds the PDF) — keep the two
 * in step. Also drives the .docx section properties and the browser's print
 * CSS.
 */
import * as Y from "yjs";

export type PaperSize = "A4" | "Letter" | "Legal" | "A5" | "A3";
export type Orientation = "portrait" | "landscape";
export type PageNumbers = "none" | "bottom-center" | "bottom-right" | "top-right";
export type NumberStyle = "n" | "page-n" | "page-n-of-m";

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageSetup {
  size: PaperSize;
  orientation: Orientation;
  /** Millimetres. */
  margins: Margins;
  header: string;
  footer: string;
  pageNumbers: PageNumbers;
  numberStyle: NumberStyle;
}

/** Width × height in millimetres, portrait. */
export const PAPER_MM: Record<PaperSize, [number, number]> = {
  A4: [210, 297],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  A5: [148, 210],
  A3: [297, 420],
};
export const PAPER_LABEL: Record<PaperSize, string> = {
  A4: "A4 (210 × 297 mm)",
  Letter: "Letter (8.5 × 11 in)",
  Legal: "Legal (8.5 × 14 in)",
  A5: "A5 (148 × 210 mm)",
  A3: "A3 (297 × 420 mm)",
};
export const MARGIN_PRESETS: { label: string; margins: Margins }[] = [
  { label: "Normal", margins: { top: 20, right: 20, bottom: 20, left: 20 } },
  { label: "Narrow", margins: { top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 } },
  { label: "Wide", margins: { top: 25.4, right: 50.8, bottom: 25.4, left: 50.8 } },
];
const PAGE_NUMBERS: PageNumbers[] = ["none", "bottom-center", "bottom-right", "top-right"];
const NUMBER_STYLES: NumberStyle[] = ["n", "page-n", "page-n-of-m"];
const MAX_MARGIN = 100;
const MIN_CONTENT = 40;
const MAX_TEXT = 200;

export const DEFAULT_PAGE_SETUP: PageSetup = {
  size: "A4",
  orientation: "portrait",
  margins: { top: 20, right: 20, bottom: 20, left: 20 },
  header: "",
  footer: "",
  pageNumbers: "none",
  numberStyle: "page-n-of-m",
};

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(Math.max(n, 0), MAX_MARGIN) * 10) / 10;
};
const text = (v: unknown): string => (typeof v === "string" ? v.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_TEXT) : "");

export function paperMm(setup: Pick<PageSetup, "size" | "orientation">): [number, number] {
  const [w, h] = PAPER_MM[setup.size];
  return setup.orientation === "landscape" ? [h, w] : [w, h];
}

/** Anything (the map's contents, a draft) → a valid setup. Same rules as the
 *  server: unknown values fall back, margins clamp, and margins leaving less
 *  than 4 cm of page are scaled back. */
export function normalisePageSetup(raw: unknown): PageSetup {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const m = (d.margins && typeof d.margins === "object" ? d.margins : {}) as Record<string, unknown>;
  const D = DEFAULT_PAGE_SETUP;
  const out: PageSetup = {
    size: typeof d.size === "string" && d.size in PAPER_MM ? (d.size as PaperSize) : D.size,
    orientation: d.orientation === "landscape" ? "landscape" : "portrait",
    margins: {
      top: num(m.top, D.margins.top),
      right: num(m.right, D.margins.right),
      bottom: num(m.bottom, D.margins.bottom),
      left: num(m.left, D.margins.left),
    },
    header: text(d.header),
    footer: text(d.footer),
    pageNumbers: PAGE_NUMBERS.includes(d.pageNumbers as PageNumbers) ? (d.pageNumbers as PageNumbers) : D.pageNumbers,
    numberStyle: NUMBER_STYLES.includes(d.numberStyle as NumberStyle) ? (d.numberStyle as NumberStyle) : D.numberStyle,
  };
  const [w, h] = paperMm(out);
  const fit = (a: "left" | "top", b: "right" | "bottom", room: number) => {
    const total = out.margins[a] + out.margins[b];
    if (total > room - MIN_CONTENT && total > 0) {
      const k = Math.max(room - MIN_CONTENT, 0) / total;
      out.margins[a] = Math.round(out.margins[a] * k * 10) / 10;
      out.margins[b] = Math.round(out.margins[b] * k * 10) / 10;
    }
  };
  fit("left", "right", w);
  fit("top", "bottom", h);
  return out;
}

export const PAGE_SETUP_KEY = "pageSetup";

export function readPageSetup(ydoc: Y.Doc): PageSetup {
  return normalisePageSetup(ydoc.getMap(PAGE_SETUP_KEY).toJSON());
}

/** Write only the settings that changed, one key each, in one transaction. */
export function writePageSetup(ydoc: Y.Doc, next: PageSetup): void {
  const map = ydoc.getMap(PAGE_SETUP_KEY);
  const clean = normalisePageSetup(next);
  ydoc.transact(() => {
    for (const [key, value] of Object.entries(clean)) {
      if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) map.set(key, value);
    }
  });
}

export function isDefaultPageSetup(setup: PageSetup): boolean {
  return JSON.stringify(setup) === JSON.stringify(DEFAULT_PAGE_SETUP);
}

// Control characters can't appear in a CSS string, so they're the point here.
// eslint-disable-next-line no-control-regex
const cssString = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\u0000-\u001f\u007f]/g, " ")}"`;

function numberContent(style: NumberStyle): string {
  if (style === "n") return "counter(page)";
  if (style === "page-n") return '"Page " counter(page)';
  return '"Page " counter(page) " of " counter(pages)';
}

/** The ``@page`` rule — the same layout the PDF gets: header centred at
 *  the top, footer centred at the bottom, page numbers where chosen. The
 *  browser's print honours the size and margins; the margin boxes (header,
 *  footer, numbers) need Chrome 131+ and are ignored elsewhere. */
export function pageCss(setup: PageSetup): string {
  const [w, h] = paperMm(setup);
  const boxes = new Map<string, string[]>();
  const add = (box: string, part: string) => boxes.set(box, [...(boxes.get(box) ?? []), part]);
  if (setup.header) add("top-center", cssString(setup.header));
  if (setup.footer) add("bottom-center", cssString(setup.footer));
  if (setup.pageNumbers !== "none") {
    if (boxes.get(setup.pageNumbers)?.length) add(setup.pageNumbers, '"  ·  "');
    add(setup.pageNumbers, numberContent(setup.numberStyle));
  }
  const rules = [...boxes]
    .map(([box, parts]) => `@${box} { content: ${parts.join(" ")}; font-size: 9pt; color: #555; }`)
    .join(" ");
  const { top, right, bottom, left } = setup.margins;
  return `@page { size: ${w}mm ${h}mm; margin: ${top}mm ${right}mm ${bottom}mm ${left}mm; ${rules} }`;
}

/** Page-number text for a footer/header outside CSS (the .docx). */
export function numberParts(style: NumberStyle): { before: string; between?: string } {
  if (style === "n") return { before: "" };
  if (style === "page-n") return { before: "Page " };
  return { before: "Page ", between: " of " };
}
