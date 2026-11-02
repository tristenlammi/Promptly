import { cleanTitle, parseWhen } from "@/lib/quickdate";

import type { Repeat, TaskList } from "./types";

/*
 * Quick add: "Pay rent every month on the 1st #home !3" → the fields. The
 * dates, times and repeats are Promptly's shared wording (``lib/quickdate``
 * — Calendar reads them the same way); on top of it:
 *
 *   other   #list (or a #tag if no list has that name), @tag, !1–!3 / p1–p3
 *
 * What's left is the title.
 */

export interface Parsed {
  title: string;
  due: string | null;
  time: string | null;
  repeat: Repeat | null;
  priority: number | null;
  listId: string | null;
  tags: string[];
}

export function parseQuick(input: string, lists: TaskList[], today: string, weekStart = 0): Parsed {
  const when = parseWhen(input, today, weekStart);
  let s = when.rest;
  const out: Parsed = { title: "", due: when.due, time: when.time, repeat: when.repeat, priority: null, listId: null, tags: [] };
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean | void) => {
    const m = re.exec(s);
    if (!m) return false;
    if (fn(m) === false) return false;
    s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
    return true;
  };

  // ---- priority, list, tags
  take(/\s!([1-3])(?=\s)/, (m) => {
    out.priority = Number(m[1]);
  }) ||
    take(/\s(!{1,3})(?=\s)/, (m) => {
      out.priority = m[1].length;
    }) ||
    take(/\sp([1-3])(?=\s)/i, (m) => {
      out.priority = 4 - Number(m[1]); // Todoist: p1 is the most urgent
    });
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  for (let guard = 0; guard < 10; guard++) {
    const hit = take(/\s#([\p{L}\p{N}_-]+)/u, (m) => {
      const lst = lists.find((l) => norm(l.name) === norm(m[1]) || l.id === m[1].toLowerCase());
      if (lst && !out.listId) out.listId = lst.id;
      else if (!out.tags.includes(m[1])) out.tags.push(m[1]);
    });
    if (!hit) break;
  }
  for (let guard = 0; guard < 10; guard++) {
    if (!take(/\s@([\p{L}\p{N}_-]+)/u, (m) => void (out.tags.includes(m[1]) || out.tags.push(m[1])))) break;
  }

  out.title = cleanTitle(s);
  return out;
}
