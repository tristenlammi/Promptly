import { useMemo } from "react";

/**
 * CSV previewer — a tiny hand-rolled parser + virtualisation-lite
 * table. Handles:
 * - Quoted fields (including commas and escaped quotes)
 * - CRLF and LF line endings
 * - Trailing empty lines
 *
 * We cap at 500 rows for the preview. Beyond that we show a
 * banner and let the user download the source file (they have
 * the Copy / Download buttons in the panel footer).
 */
const PREVIEW_ROW_CAP = 500;

export function CsvPreview({ source }: { source: string }) {
  const { header, rows, truncated, totalRows } = useMemo(() => parseCsv(source), [source]);

  if (rows.length === 0 && header.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg)] p-6 text-sm text-[var(--text-muted)]">
        No rows to preview.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)]">
      {truncated && (
        <div className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Showing the first {PREVIEW_ROW_CAP.toLocaleString()} of {totalRows.toLocaleString()}{" "}
          rows. Download the file to see the rest.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 bg-[var(--surface-1)] text-[var(--text)]">
            <tr>
              {header.map((h, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap border-b border-[var(--border)] px-3 py-2 text-left font-medium"
                >
                  {h || <span className="text-[var(--text-muted)]">col {i + 1}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr
                key={ri}
                className="even:bg-[var(--surface-1)]/40 hover:bg-[var(--accent)]/5"
              >
                {header.map((_, ci) => (
                  <td
                    key={ci}
                    className="whitespace-pre border-b border-[var(--border)]/60 px-3 py-1.5 align-top text-[var(--text)]"
                  >
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** RFC 4180–ish parser. Good enough for the 99 % common case —
 *  enough comma/quote awareness that typical AI-generated CSV
 *  previews correctly. Not suitable for pathological data. */
function parseCsv(source: string): {
  header: string[];
  rows: string[][];
  truncated: boolean;
  totalRows: number;
} {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.trim()) return { header: [], rows: [], truncated: false, totalRows: 0 };

  const allRows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      allRows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    allRows.push(row);
  }

  const [header = [], ...body] = allRows;
  const truncated = body.length > PREVIEW_ROW_CAP;
  const rows = truncated ? body.slice(0, PREVIEW_ROW_CAP) : body;
  return { header, rows, truncated, totalRows: body.length };
}
