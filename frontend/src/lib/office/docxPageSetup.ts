/**
 * A Word file's page setup → a Doc's (WP-6.4): paper size, orientation and
 * margins from the body's last section, and the default header and footer —
 * their text, and a page-number field as page numbers. So a .docx opened in
 * Promptly Docs and saved back keeps its page.
 */
import type JSZip from "jszip";

import { DEFAULT_PAGE_SETUP, PAPER_MM, normalisePageSetup, type PageSetup, type PaperSize } from "@/lib/pageSetup";

const TWIP_PER_MM = 1440 / 25.4;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const twipsToMm = (v: string | null): number | undefined => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? Math.round((n / TWIP_PER_MM) * 10) / 10 : undefined;
};

/** The named paper within 2 mm of ``w`` × ``h`` (either way round). */
function paperFor(wMm: number, hMm: number): PaperSize | undefined {
  const [a, b] = [Math.min(wMm, hMm), Math.max(wMm, hMm)];
  return (Object.keys(PAPER_MM) as PaperSize[]).find(
    (k) => Math.abs(PAPER_MM[k][0] - a) <= 2 && Math.abs(PAPER_MM[k][1] - b) <= 2
  );
}

interface PartText {
  text: string;
  page: boolean;
  total: boolean;
  wordy: boolean;
  right: boolean;
}

/** A header/footer part's text, with any page-number field noted. A
 *  paragraph holding a PAGE field is the number line: its own text ("Page …
 *  of …") becomes the number style rather than header/footer text. */
function readPart(xml: string): PartText {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out: PartText = { text: "", page: false, total: false, wordy: false, right: false };
  const lines: string[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS(W, "p"))) {
    let inResult = false;
    let hasPage = false;
    const parts: string[] = [];
    const note = (instr: string) => {
      if (/\bNUMPAGES\b|\bSECTIONPAGES\b/i.test(instr)) out.total = true;
      else if (/\bPAGE\b/i.test(instr)) hasPage = true;
    };
    for (const el of Array.from(p.getElementsByTagNameNS(W, "*"))) {
      if (el.localName === "fldChar") {
        const type = el.getAttributeNS(W, "fldCharType");
        if (type === "separate") inResult = true;
        if (type === "end") inResult = false;
      } else if (el.localName === "instrText") {
        note(el.textContent ?? "");
      } else if (el.localName === "fldSimple") {
        note(el.getAttributeNS(W, "instr") ?? "");
      } else if (el.localName === "t" && !inResult && !el.closest("fldSimple")) {
        parts.push(el.textContent ?? "");
      }
    }
    const text = parts.join("").trim();
    if (hasPage) {
      out.page = true;
      out.wordy = /page/i.test(text);
      const jc = p.getElementsByTagNameNS(W, "jc")[0]?.getAttributeNS(W, "val");
      out.right = jc === "right" || jc === "end";
    } else if (text) {
      lines.push(text);
    }
  }
  out.text = lines.join("  ");
  return out;
}

/** The page setup of a .docx, or null when it says nothing usable. */
export async function pageSetupFromDocx(zip: JSZip): Promise<PageSetup | null> {
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return null;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const body = doc.getElementsByTagNameNS(W, "body")[0];
  // The body's own sectPr is the last section — the one most pages use.
  const sect = body ? Array.from(body.children).reverse().find((el) => el.localName === "sectPr") : undefined;
  if (!sect) return null;
  const setup: PageSetup = structuredClone(DEFAULT_PAGE_SETUP);

  const sz = sect.getElementsByTagNameNS(W, "pgSz")[0];
  if (sz) {
    const w = twipsToMm(sz.getAttributeNS(W, "w"));
    const h = twipsToMm(sz.getAttributeNS(W, "h"));
    if (w && h) {
      const paper = paperFor(w, h);
      if (paper) setup.size = paper;
      setup.orientation = sz.getAttributeNS(W, "orient") === "landscape" || w > h ? "landscape" : "portrait";
    }
  }
  const mar = sect.getElementsByTagNameNS(W, "pgMar")[0];
  if (mar) {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const mm = twipsToMm(mar.getAttributeNS(W, side));
      // Negative top/bottom ("text may overlap the header") read as their size.
      if (mm !== undefined) setup.margins[side] = Math.abs(mm);
    }
  }

  // Default header and footer, through the document's relationships.
  const rels = await zip.file("word/_rels/document.xml.rels")?.async("string");
  const targets = new Map<string, string>();
  if (rels) {
    const rd = new DOMParser().parseFromString(rels, "application/xml");
    for (const rel of Array.from(rd.getElementsByTagName("Relationship"))) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (id && target) targets.set(id, target.replace(/^\/?word\//, ""));
    }
  }
  const part = async (kind: "headerReference" | "footerReference"): Promise<PartText | null> => {
    const ref = Array.from(sect.getElementsByTagNameNS(W, kind)).find(
      (el) => (el.getAttributeNS(W, "type") ?? "default") === "default"
    );
    const target = ref ? targets.get(ref.getAttributeNS(R, "id") ?? "") : undefined;
    const partXml = target ? await zip.file(`word/${target}`)?.async("string") : undefined;
    return partXml ? readPart(partXml) : null;
  };
  const header = await part("headerReference");
  const footer = await part("footerReference");
  setup.header = header?.text ?? "";
  setup.footer = footer?.text ?? "";
  const numbered = footer?.page ? footer : header?.page ? header : null;
  if (numbered) {
    setup.pageNumbers = numbered === header ? "top-right" : numbered.right ? "bottom-right" : "bottom-center";
    setup.numberStyle = numbered.total ? "page-n-of-m" : numbered.wordy ? "page-n" : "n";
  }
  return normalisePageSetup(setup);
}
