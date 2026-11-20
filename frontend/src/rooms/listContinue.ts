// Lists that carry on as you type. When a new line is started straight after
// a list line ("1. milk", "- milk"), the next number or bullet is put in for
// you; a new line after an empty item ends the list instead.

const ITEM = /^(\s*)(?:(\d{1,4})([.)])|([-*•]))(\s+)(.*)$/;

export interface ListEdit {
  value: string;
  caret: number;
}

/**
 * `prev` is the text before the edit, `next` after it, `caret` where the
 * cursor now is. Returns the adjusted text and cursor when the edit was one
 * new line typed at the end of a list line, else null.
 */
export function continueList(prev: string, next: string, caret: number): ListEdit | null {
  if (next.length !== prev.length + 1 || caret < 1 || next[caret - 1] !== "\n") return null;
  // The only change must be that one new line.
  if (next.slice(0, caret - 1) + next.slice(caret) !== prev) return null;
  // Only when the cursor was at the end of its line.
  if (caret < next.length && next[caret] !== "\n") return null;

  const lineStart = next.lastIndexOf("\n", caret - 2) + 1;
  const line = next.slice(lineStart, caret - 1);
  const m = ITEM.exec(line);
  if (!m) return null;
  const [, indent, num, sep, bullet, gap, content] = m;

  if (!content.trim()) {
    // An empty item: drop its marker and the new line, leaving a blank line.
    const value = next.slice(0, lineStart) + next.slice(caret);
    return { value, caret: lineStart };
  }

  const marker = num !== undefined ? `${Number(num) + 1}${sep}` : bullet;
  const insert = `${indent}${marker}${gap.length ? " " : ""}`;
  let value = next.slice(0, caret) + insert + next.slice(caret);
  const at = caret + insert.length;
  if (num !== undefined) value = value.slice(0, at) + renumber(value.slice(at), indent, Number(num) + 2, sep);
  return { value, caret: at };
}

/** Keep the numbers below an inserted item in step, as far as the list runs. */
function renumber(rest: string, indent: string, from: number, sep: string): string {
  if (!rest.startsWith("\n")) return rest;
  const lines = rest.split("\n");
  let n = from;
  for (let i = 1; i < lines.length; i++) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[2] === undefined || m[1] !== indent || m[3] !== sep) break;
    lines[i] = `${indent}${n}${sep}${m[5]}${m[6]}`;
    n += 1;
  }
  return lines.join("\n");
}
