// Small, valid test files generated on demand (nothing binary is checked in).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { BACKEND, E2E_ROOT } from "./stack";

const DIR = path.join(E2E_ROOT, "files");

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A 64×64 PNG in two colours. */
export function png(name = "e2e-photo.png"): string {
  const w = 64, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const warm = x < w / 2;
      raw[o] = warm ? 224 : 40;
      raw[o + 1] = warm ? 122 : 90;
      raw[o + 2] = warm ? 95 : 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return write(name, file);
}

/** A PDF that says `text` — one page per string when given several. */
export function pdf(name = "e2e-report.pdf", text: string | string[] = "Promptly end-to-end test"): string {
  const pages = Array.isArray(text) ? text : [text];
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, then a page + its content stream per page.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((t, i) => {
    const stream = `BT /F1 24 Tf 72 720 Td (${t}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    );
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return write(name, Buffer.from(body, "latin1"));
}

/** A one-page PDF form with a "Full name" text field (WP-6.5). */
export function pdfForm(name = "e2e-form.pdf"): string {
  const content = "BT /F1 14 Tf 72 700 Td (Full name:) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 3 0 R >> >> >> >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 3 0 R >> >> /Annots [5 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (full_name) /TU (Full name) /Rect [170 690 470 716] /F 4 /P 4 0 R /DA (/Helv 12 Tf 0 g) /MK << /BG [0.93 0.95 1] >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return write(name, Buffer.from(body, "latin1"));
}

function write(name: string, data: Buffer): string {
  fs.mkdirSync(DIR, { recursive: true });
  const p = path.join(DIR, name);
  fs.writeFileSync(p, data);
  return p;
}

/** A small Word file: a heading, bold text, red text (which won't convert),
 *  a bullet list, a table, a picture and a comment (WP-4.3). Built with the
 *  frontend's JSZip so nothing binary is checked in. */
export async function wordDoc(name = "e2e-plan.docx"): Promise<string> {
  // @ts-expect-error — the minified bundle ships without its own typings path.
  const JSZip = ((await import("../../frontend/node_modules/jszip/dist/jszip.min.js")) as { default: new () => {
    file: (name: string, data: string | Buffer) => void;
    generateAsync: (o: { type: "nodebuffer"; compression: "DEFLATE" }) => Promise<Buffer>;
  } }).default;
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const pic = fs.readFileSync(png("e2e-docx-pic.png"));
  const run = (text: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const para = (body: string, style = "") => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${body}</w:p>`;
  const bullet = (text: string) =>
    `<w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(text)}</w:p>`;
  const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${para(run(text))}</w:tc>`;
  const image = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="dot.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const body = [
    para(run("Quarterly plan"), "Heading1"),
    para(`${run("We ship the ")}${run("new onboarding", "<w:b/>")}${run(" in March.")}<w:commentRangeStart w:id="0"/><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>`),
    para(run("This sentence is red.", '<w:color w:val="C01010"/>')),
    bullet("Hire two engineers"),
    bullet("Open the Sydney office"),
    `<w:tbl><w:tblPr><w:tblW w:w="4800" w:type="dxa"/></w:tblPr><w:tr>${cell("Owner")}${cell("Due")}</w:tr><w:tr>${cell("Sam")}${cell("31 March")}</w:tr></w:tbl>`,
    image,
  ].join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/dot.png"/></Relationships>`
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/></w:style></w:styles>`
  );
  zip.file(
    "word/numbering.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
  );
  zip.file(
    "word/comments.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:comments ${W}><w:comment w:id="0" w:author="Reviewer"><w:p><w:r><w:t>Check the date</w:t></w:r></w:p></w:comment></w:comments>`
  );
  zip.file("word/media/dot.png", pic);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W} ${R}><w:body>${body}</w:body></w:document>`);
  return write(name, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

/** A small Excel workbook: a merged bold title, a filled header row, money
 *  in a number format, a total formula saved without its result (as a
 *  script would write it), a wide first column and a second tab (WP-4.4). */
export async function xlsxDoc(name = "e2e-budget.xlsx"): Promise<string> {
  // @ts-expect-error — the minified bundle ships without its own typings path.
  const JSZip = ((await import("../../frontend/node_modules/jszip/dist/jszip.min.js")) as { default: new () => {
    file: (name: string, data: string | Buffer) => void;
    generateAsync: (o: { type: "nodebuffer"; compression: "DEFLATE" }) => Promise<Buffer>;
  } }).default;
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const str = (ref: string, text: string, s = 0) => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ""}><is><t>${text}</t></is></c>`;
  const num = (ref: string, n: number, s = 0) => `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${n}</v></c>`;
  const budget =
    `<?xml version="1.0" encoding="UTF-8"?><worksheet ${S} ${R}><cols><col min="1" max="1" width="28" customWidth="1"/></cols><sheetData>` +
    `<row r="1">${str("A1", "Quarterly budget", 1)}</row>` +
    `<row r="2">${str("A2", "Item", 2)}${str("B2", "Cost", 2)}${str("C2", "Due", 2)}</row>` +
    `<row r="3">${str("A3", "Rent")}${num("B3", 1200.5, 3)}</row>` +
    `<row r="4">${str("A4", "Power")}${num("B4", 180, 3)}</row>` +
    `<row r="5">${str("A5", "Total", 1)}<c r="B5" s="3"><f>SUM(B3:B4)</f></c></row>` +
    `</sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>`;
  const notes = `<?xml version="1.0" encoding="UTF-8"?><worksheet ${S}><sheetData><row r="1">${str("A1", "Ask Sam about power")}</row></sheetData></worksheet>`;
  const styles =
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${S}>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
    `</styleSheet>`;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?><workbook ${S} ${R}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  );
  zip.file("xl/styles.xml", styles);
  zip.file("xl/worksheets/sheet1.xml", budget);
  zip.file("xl/worksheets/sheet2.xml", notes);
  return write(name, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

/** A short video, made by the backend container's ffmpeg (the host may have
 *  none). H.264 in MP4 by default; ``hevc`` makes an iPhone-style .MOV the
 *  browser can't play until the media worker converts it. */
export function video(name = "e2e-clip.mp4", { hevc = false, seconds = 6 } = {}): string {
  const out = `/tmp/${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
  const codec = hevc
    ? ["-c:v", "libx265", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]
    : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  execFileSync("docker", [
    "exec", BACKEND, "ffmpeg", "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=duration=${seconds}:size=640x360:rate=25`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-shortest", ...codec, "-c:a", "aac", out,
  ]);
  const data = execFileSync("docker", ["exec", BACKEND, "sh", "-c", `cat '${out}' && rm -f '${out}'`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return write(name, data);
}

/** A big text file (WP-8.2: over the resumable-upload threshold), made
 *  once and reused. Every line is numbered, so no two chunks are alike. */
export function bigText(name = "e2e-big.txt", megabytes = 120): string {
  const p = path.join(DIR, name);
  if (fs.existsSync(p) && fs.statSync(p).size >= megabytes * 1024 * 1024) return p;
  fs.mkdirSync(DIR, { recursive: true });
  const fd = fs.openSync(p, "w");
  const line = (i: number) => `line ${String(i).padStart(9, "0")} of the big e2e upload, nothing to see here
`;
  let written = 0;
  for (let block = 0; written < megabytes * 1024 * 1024; block++) {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) lines.push(line(block * 10_000 + i));
    const buf = Buffer.from(lines.join(""));
    fs.writeSync(fd, buf);
    written += buf.length;
  }
  fs.closeSync(fd);
  return p;
}

/** A small two-part Google Takeout (WP-10.1): photos in one part, their
 *  JSON in the other, an album, a Drive file. Made in the backend container
 *  (Pillow writes the JPEGs); ``tag`` makes the photos this run's own. */
export function takeout(tag: string): string[] {
  const py = `
import io, json, zipfile, base64, sys
from PIL import Image
tag = ${JSON.stringify(tag)}
def jpeg(c):
    b = io.BytesIO(); Image.new("RGB", (16, 12), c).save(b, "JPEG"); return b.getvalue() + tag.encode()
def docx():
    import docx as d
    doc = d.Document(); doc.add_paragraph("Packing list " + tag); b = io.BytesIO(); doc.save(b); return b.getvalue()
def side(title, ts, lat=0.0, lon=0.0, **kw):
    return json.dumps({"title": title, "photoTakenTime": {"timestamp": str(ts)}, "geoData": {"latitude": lat, "longitude": lon}, **kw}).encode()
P = "Takeout/Google Photos/"
one = {P + "Photos from 2018/IMG_" + tag + "_1.jpg": jpeg((200, 50, 50)), P + "Photos from 2018/IMG_" + tag + "_2.jpg": jpeg((50, 200, 50)),
       P + "Camping " + tag + "/IMG_" + tag + "_1.jpg": jpeg((200, 50, 50)), P + "Camping " + tag + "/metadata.json": json.dumps({"title": "Camping " + tag}).encode(),
       "Takeout/Drive/Notes " + tag + ".docx": docx()}
two = {P + "Photos from 2018/IMG_" + tag + "_1.jpg.supplemental-metadata.json": side("IMG_" + tag + "_1.jpg", 1530000000, -27.47, 153.02, description="Camp fire"),
       P + "Photos from 2018/IMG_" + tag + "_2.jpg.supplemental-metadata.json": side("IMG_" + tag + "_2.jpg", 1530003600),
       P + "Camping " + tag + "/IMG_" + tag + "_1.jpg.supplemental-metadata.json": side("IMG_" + tag + "_1.jpg", 1530000000)}
out = []
for members in (one, two):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for k, v in members.items(): z.writestr(k, v)
    out.append(base64.b64encode(b.getvalue()).decode())
print(json.dumps(out))
`;
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py, maxBuffer: 16 * 1024 * 1024 });
  const parts = JSON.parse(out.toString()) as string[];
  return parts.map((b64, i) => write(`takeout-${tag}-00${i + 1}.zip`, Buffer.from(b64, "base64")));
}

/** A zipped folder (WP-10.3): two photos with no date of their own (their
 *  date in the zip files them), Mac junk, and a document in a subfolder. */
export function photoFolder(tag: string): string {
  const py = `
import io, zipfile, base64
from PIL import Image
tag = ${JSON.stringify(tag)}
def jpeg(c):
    b = io.BytesIO(); Image.new("RGB", (16, 12), c).save(b, "JPEG"); return b.getvalue() + tag.encode()
def docx():
    import docx as d
    doc = d.Document(); doc.add_paragraph("Recipe " + tag); b = io.BytesIO(); doc.save(b); return b.getvalue()
b = io.BytesIO()
with zipfile.ZipFile(b, "w") as z:
    for name, data in (("Pictures/beach-" + tag + ".jpg", jpeg((10, 90, 200))), ("Pictures/dog-" + tag + ".jpg", jpeg((90, 60, 20))),
                       ("Pictures/.DS_Store", b"junk"), ("__MACOSX/Pictures/._beach.jpg", b"junk"),
                       ("Recipes/Pancakes " + tag + ".docx", docx())):
        z.writestr(zipfile.ZipInfo(name, date_time=(2013, 7, 14, 12, 0, 0)), data)
print(base64.b64encode(b.getvalue()).decode())
`;
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py, maxBuffer: 16 * 1024 * 1024 });
  return write(`Old laptop ${tag}.zip`, Buffer.from(out.toString().trim(), "base64"));
}

/** A JPEG taken now at Noosa Heads (GPS in its EXIF), made with Pillow in
 *  the backend container. */
export function gpsPhoto(name: string): string {
  const py = `
import io, base64, datetime
from PIL import Image
im = Image.new("RGB", (64, 48), (40, 120, 200))
exif = im.getexif()
exif.get_ifd(0x8769)[36867] = datetime.datetime.now().strftime("%Y:%m:%d %H:%M:%S")
gps = exif.get_ifd(0x8825)
gps[1] = "S"; gps[2] = (26.0, 23.0, 39.0); gps[3] = "E"; gps[4] = (153.0, 5.0, 27.0)
b = io.BytesIO(); im.save(b, "JPEG", exif=exif); print(base64.b64encode(b.getvalue()).decode())
`;
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py });
  return write(name, Buffer.from(out.toString().trim(), "base64"));
}

/** A picture of a word, big and black on white — what a search by what's
 *  in a photo can find without any real photos. */
export function wordPhoto(name: string, word: string): string {
  const py = `
import io, base64
from PIL import Image, ImageDraw, ImageFont
im = Image.new("RGB", (400, 300), (255, 255, 255))
d = ImageDraw.Draw(im)
d.text((20, 100), ${JSON.stringify(word)}, fill=(0, 0, 0), font=ImageFont.load_default(size=72))
d.text((4, 286), ${JSON.stringify(name)}, fill=(235, 235, 235))  # each run its own photo (uploads dedupe)
b = io.BytesIO(); im.save(b, "JPEG", quality=90); print(base64.b64encode(b.getvalue()).decode())
`;
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py });
  return write(name, Buffer.from(out.toString().trim(), "base64"));
}

/** A JPEG whose EXIF says when it was taken ("2019:10:15 10:00:00", the
 *  wall clock there), with its name drawn in so each one is its own photo. */
export function datedPhoto(name: string, exifDate: string): string {
  const py = `
import io, base64
from PIL import Image, ImageDraw
im = Image.new("RGB", (96, 64), (200, 140, 60))
ImageDraw.Draw(im).text((2, 2), ${JSON.stringify(name)}, fill=(250, 250, 250))
exif = im.getexif()
exif.get_ifd(0x8769)[36867] = ${JSON.stringify(exifDate)}
b = io.BytesIO(); im.save(b, "JPEG", exif=exif); print(base64.b64encode(b.getvalue()).decode())
`;
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py });
  return write(name, Buffer.from(out.toString().trim(), "base64"));
}

/** Faces that look alike (synthetic AuraFace-sized vectors) in each of these
 *  photos of the user's (PH-3) — what face recognition would have found, for
 *  testing People without real faces. Returns the face ids. */
export function seedFaces(username: string, fileIds: string[], axis = 7): string[] {
  const py = `
import asyncio, json, random
from sqlalchemy import text
from app.database import SessionLocal
ids = ${JSON.stringify(fileIds)}
async def main():
    out = []
    async with SessionLocal() as db:
        uid = await db.scalar(text("SELECT id FROM users WHERE username = :u"), {"u": ${JSON.stringify(username)}})
        for fid in ids:
            v = [random.gauss(0, 0.004) for _ in range(512)]
            v[${axis}] = 1.0
            n = sum(x * x for x in v) ** 0.5
            lit = "[" + ",".join(f"{x / n:.6f}" for x in v) + "]"
            out.append(str(await db.scalar(text(
                "INSERT INTO photo_faces (file_id, user_id, box_x, box_y, box_w, box_h, score, size_px, model, embedding) "
                "VALUES (:f, :u, 0.3, 0.25, 0.3, 0.4, 0.95, 160, 'e2e', CAST(:v AS vector)) RETURNING id"),
                {"f": fid, "u": uid, "v": lit})))
        await db.commit()
    print(json.dumps(out))
asyncio.run(main())
`;
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py });
  return JSON.parse(out.toString().trim().split("\n").pop()!) as string[];
}

/** Forget a user's memories (PH-5) — a memory put away in an earlier run
 *  would otherwise stay put away. */
export function resetMemories(username: string): void {
  const py = `
import asyncio
from sqlalchemy import text
from app.database import SessionLocal
from app.redis_client import redis
async def main():
    async with SessionLocal() as db:
        uid = await db.scalar(text("SELECT id FROM users WHERE username = :u"), {"u": ${JSON.stringify(username)}})
        await db.execute(text("DELETE FROM photo_memories WHERE user_id = :u"), {"u": uid})
        await db.commit()
    await redis.delete(f"promptly:memories:fresh:{uid}")
    await redis.aclose()
asyncio.run(main())
`;
  execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py });
}

/** A two-slide PowerPoint file (python-pptx in the backend container). */
export function pptxDeck(name: string, title: string): string {
  const py = `
import io, base64
from pptx import Presentation
p = Presentation()
s = p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text = ${JSON.stringify(title)}; s.placeholders[1].text = "Made for the e2e suite"
s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = "Agenda"; s.placeholders[1].text = "One\\nTwo\\nThree"
b = io.BytesIO(); p.save(b); print(base64.b64encode(b.getvalue()).decode())
`;
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py, maxBuffer: 16 * 1024 * 1024 });
  return write(name, Buffer.from(out.toString().trim(), "base64"));
}
