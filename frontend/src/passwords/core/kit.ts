// The recovery kit: a printable PDF made here, on this device. Holds the Secret Key,
// a QR of it, the server's address and a space to write the master password. The PDF
// is a hand-built, minimal, text-and-rectangles file so nothing gets uploaded or
// fetched, and it works under the vault page's strict CSP.
import QRCode from "qrcode";

import { utf8 } from "./bytes";

export function kitQrText(serverUrl: string, secretKey: string, username: string): string {
  const q = new URLSearchParams({ server: serverUrl, user: username, sk: secretKey });
  return `promptly-kit:1?${q}`;
}

export function parseKitQr(text: string): { serverUrl: string; secretKey: string; username: string } | null {
  if (!text.startsWith("promptly-kit:1?")) return null;
  const q = new URLSearchParams(text.slice("promptly-kit:1?".length));
  const secretKey = q.get("sk");
  const serverUrl = q.get("server");
  if (!secretKey || !serverUrl) return null;
  return { secretKey, serverUrl, username: q.get("user") ?? "" };
}

/** PDF strings: printable ASCII only, with the three special characters escaped. */
function pdfText(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (c) => `\\${c}`);
}

export function buildKitPdf(opts: { secretKey: string; serverUrl: string; username: string; createdOn: string }): Uint8Array {
  const qr = QRCode.create(kitQrText(opts.serverUrl, opts.secretKey, opts.username), { errorCorrectionLevel: "M" });
  const ops: string[] = [];
  const text = (x: number, y: number, size: number, s: string, font = "F1") => {
    ops.push(`BT /${font} ${size} Tf ${x} ${y} Td (${pdfText(s)}) Tj ET`);
  };
  const line = (x1: number, y1: number, x2: number, y2: number) => ops.push(`${x1} ${y1} m ${x2} ${y2} l S`);

  // A4 in points, top-down from 800.
  ops.push("0.851 0.467 0.341 rg 50 770 495 4 re f 0 0 0 rg");
  text(50, 745, 20, "Promptly Passwords: Recovery Kit", "F2");
  text(50, 722, 11, `For ${opts.username} on ${opts.serverUrl}`);
  text(50, 707, 11, `Made ${opts.createdOn}`);

  text(50, 672, 13, "Your Secret Key", "F2");
  text(50, 648, 15, opts.secretKey, "F3");

  text(50, 612, 13, "Your master password", "F2");
  text(50, 596, 10, "Write it here if you want to. Keep this page somewhere safe, like with your passport.");
  line(50, 566, 545, 566);

  text(50, 530, 13, "Scan this on a new device", "F2");
  const size = qr.modules.size;
  const box = Math.min(180 / size, 5);
  const left = 50;
  const top = 515;
  ops.push("0 0 0 rg");
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.modules.get(row, col)) {
        ops.push(`${(left + col * box).toFixed(2)} ${(top - (row + 1) * box).toFixed(2)} ${box.toFixed(2)} ${box.toFixed(2)} re f`);
      }
    }
  }

  const below = top - size * box - 30;
  text(50, below, 13, "What this is for", "F2");
  const notes = [
    "You need the Secret Key and your master password to open your vault on a new device.",
    "If you lose both this page and your master password, your vault is gone for good.",
    "Nobody can recover it. Not your server's admin, not anyone.",
    "Anyone holding this page and your master password can open your vault. Keep them apart if you can.",
  ];
  notes.forEach((n, i) => text(50, below - 18 - i * 15, 10, n));

  const stream = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return utf8(body);
}
