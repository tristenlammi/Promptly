import type { FormDefinition, FormItem, FormOption } from "@/api/forms";

import { BRANCHING_KINDS, isQuestion, sectionsOf, type SectionInfo } from "./model";

/**
 * What answers look like, how a respondent moves through the sections,
 * and what makes an answer acceptable. The preview and the answer page use
 * this (through ``FormRenderer``); the server walks the same path again on
 * submit (WP-F1.3), so these rules must match it.
 *
 * Answer values, by question kind:
 * - short_text, paragraph: string
 * - multiple_choice: ``{option: id}`` or ``{other: text}``
 * - dropdown: ``{option: id}``
 * - checkboxes: ``{options: id[], other?: text}`` (``other`` present = ticked)
 * - linear_scale, rating: number
 * - date: ``YYYY-MM-DD``, ``YYYY-MM-DDTHH:MM`` with time, ``MM-DD`` /
 *   ``MM-DDTHH:MM`` without the year
 * - time: ``HH:MM``, or a duration ``H:MM:SS``
 * - file_upload: upload ids
 *
 * Branching: when a section ends, the last question in it with branching on
 * whose chosen option has a ``go_to`` decides; otherwise the section's own
 * ``after``. "continue" is the next section (or the end), "submit" ends the
 * form, and a section id jumps there. A jump to the same or an earlier
 * section ends the form instead, so a form can never loop.
 */

export type ChoiceAnswer = { option: string } | { other: string };
export type CheckboxAnswer = { options: string[]; other?: string };
export type AnswerValue = string | number | ChoiceAnswer | CheckboxAnswer | string[];
export type Answers = Record<string, AnswerValue | undefined>;

export function isEmpty(item: FormItem, v: AnswerValue | undefined): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return Number.isNaN(v);
  if (Array.isArray(v)) return v.length === 0;
  if (item.kind === "checkboxes") {
    const c = v as CheckboxAnswer;
    return (c.options?.length ?? 0) === 0 && c.other === undefined;
  }
  const c = v as Partial<{ option: string; other: string }>;
  return !c.option && c.other === undefined;
}

/** Where section ``index`` leads, given the answers so far. */
export function nextSection(sections: SectionInfo[], index: number, answers: Answers): number | "submit" {
  const sec = sections[index];
  let target: string | null = null;
  for (const q of sec.items) {
    if (!BRANCHING_KINDS.includes(q.kind)) continue;
    const cfg = q.config as { branching?: boolean; options?: FormOption[] };
    if (!cfg.branching) continue;
    const v = answers[q.id] as ChoiceAnswer | undefined;
    const chosen = v && "option" in v ? cfg.options?.find((o) => o.id === v.option) : undefined;
    if (chosen?.go_to) target = chosen.go_to;
  }
  const where = target ?? sec.after ?? "continue";
  if (where === "submit") return "submit";
  if (where === "continue") return index + 1 < sections.length ? index + 1 : "submit";
  const to = sections.findIndex((s) => s.id === where);
  return to > index ? to : "submit";
}

/** The sections a respondent with these answers passes through, in order. */
export function walkPath(def: FormDefinition, answers: Answers): number[] {
  const sections = sectionsOf(def);
  const path = [0];
  for (let guard = 0; guard < sections.length; guard++) {
    const n = nextSection(sections, path[path.length - 1], answers);
    if (n === "submit") break;
    path.push(n);
  }
  return path;
}

/** Only the answers on the path (what a submit sends). */
export function answersOnPath(def: FormDefinition, answers: Answers, path: number[]): Answers {
  const sections = sectionsOf(def);
  const out: Answers = {};
  for (const i of path)
    for (const q of sections[i]?.items ?? []) if (isQuestion(q) && !isEmpty(q, answers[q.id])) out[q.id] = answers[q.id];
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

/** The problem with one answer, in the words shown under the question, or null. */
export function problemWith(item: FormItem, v: AnswerValue | undefined): string | null {
  if (!isQuestion(item)) return null;
  const empty = isEmpty(item, v);
  if (empty) return item.required ? "This question needs an answer." : null;
  switch (item.kind) {
    case "short_text": {
      const cfg = item.config as import("@/api/forms").ShortTextConfig;
      const s = String(v).trim();
      const val = cfg.validation;
      if (val.kind === "number") {
        const n = Number(s.replace(",", "."));
        if (!/^-?\d+([.,]\d+)?$/.test(s) || Number.isNaN(n)) return "Enter a number.";
        if (val.integer && !Number.isInteger(n)) return "Enter a whole number.";
        if (val.min !== null && n < val.min)
          return val.max !== null ? `Enter a number from ${val.min} to ${val.max}.` : `Enter ${val.min} or more.`;
        if (val.max !== null && n > val.max)
          return val.min !== null ? `Enter a number from ${val.min} to ${val.max}.` : `Enter ${val.max} or less.`;
      }
      if (val.kind === "email" && !EMAIL.test(s)) return "Enter an email like name@example.com.";
      if (val.kind === "url" && !URL_RE.test(s)) return "Enter a web link starting with https://";
      if (cfg.min_length && s.length < cfg.min_length) return `Write at least ${cfg.min_length} characters.`;
      if (cfg.max_length && s.length > cfg.max_length) return `Keep it to ${cfg.max_length} characters or fewer.`;
      return s.length > 1000 ? "Keep it to 1000 characters or fewer." : null;
    }
    case "paragraph": {
      const cfg = item.config as import("@/api/forms").ParagraphConfig;
      const s = String(v).trim();
      if (cfg.min_length && s.length < cfg.min_length) return `Write at least ${cfg.min_length} characters.`;
      if (s.length > cfg.max_length) return `Keep it to ${cfg.max_length} characters or fewer.`;
      return null;
    }
    case "multiple_choice": {
      const c = v as ChoiceAnswer;
      if ("other" in c && !c.other.trim()) return "Say what “Other” is.";
      return null;
    }
    case "checkboxes": {
      const cfg = item.config as import("@/api/forms").CheckboxesConfig;
      const c = v as CheckboxAnswer;
      if (c.other !== undefined && !c.other.trim()) return "Say what “Other” is.";
      const n = (c.options?.length ?? 0) + (c.other !== undefined ? 1 : 0);
      if (cfg.min_selected && cfg.max_selected && cfg.min_selected === cfg.max_selected && n !== cfg.min_selected)
        return `Tick exactly ${cfg.min_selected}.`;
      if (cfg.min_selected && n < cfg.min_selected) return `Tick at least ${cfg.min_selected}.`;
      if (cfg.max_selected && n > cfg.max_selected) return `Tick at most ${cfg.max_selected}.`;
      return null;
    }
    case "date": {
      const cfg = item.config as import("@/api/forms").DateConfig;
      const s = String(v);
      const re = cfg.include_year
        ? cfg.include_time
          ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
          : /^\d{4}-\d{2}-\d{2}$/
        : cfg.include_time
          ? /^\d{2}-\d{2}T\d{2}:\d{2}$/
          : /^\d{2}-\d{2}$/;
      return re.test(s) ? null : "Pick a full date.";
    }
    case "time": {
      const cfg = item.config as import("@/api/forms").TimeConfig;
      const s = String(v);
      if (cfg.mode === "duration") return /^\d{1,3}:[0-5]\d:[0-5]\d$/.test(s) ? null : "Enter hours, minutes and seconds.";
      return /^\d{2}:\d{2}$/.test(s) ? null : "Pick a time.";
    }
    default:
      return null;
  }
}

/** Problems in one section, by question id. */
export function sectionProblems(section: SectionInfo, answers: Answers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of section.items) {
    const p = problemWith(q, answers[q.id]);
    if (p) out[q.id] = p;
  }
  return out;
}

/** A stable shuffle (per form view) for "Shuffle options". */
export function shuffled<T>(list: T[], seed: number): T[] {
  const a = list.slice();
  let s = seed >>> 0 || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
