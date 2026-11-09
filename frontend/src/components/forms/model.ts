import {
  AlignLeft,
  CalendarDays,
  CheckSquare,
  ChevronDownSquare,
  CircleDot,
  Clock,
  Grid3x3,
  Heading,
  Image as ImageIcon,
  LayoutGrid,
  MapPin,
  SeparatorHorizontal,
  SlidersHorizontal,
  Star,
  Type,
  Upload,
  type LucideIcon,
} from "lucide-react";

import type {
  ConfigByKind,
  FormDefinition,
  FormItem,
  FormOption,
  GridLine,
  ItemKind,
  QuestionKind,
} from "@/api/forms";

/**
 * The form definition as the builder edits it: item kinds and their
 * defaults (the same defaults the server fills in, so a save round-trips
 * unchanged), conversions between kinds, sections, and a three-way merge
 * for when the same form was saved somewhere else meanwhile.
 */

export const QUESTION_KINDS: QuestionKind[] = [
  "short_text",
  "paragraph",
  "multiple_choice",
  "checkboxes",
  "dropdown",
  "linear_scale",
  "rating",
  "date",
  "time",
  "file_upload",
  "choice_grid",
  "checkbox_grid",
  "location",
];
export const GRID_KINDS: ItemKind[] = ["choice_grid", "checkbox_grid"];
/** Grids stay usable on a phone: at most this many rows and columns. */
export const GRID_MAX_ROWS = 20;
export const GRID_MAX_COLUMNS = 8;
export const GRID_COLUMN_CHARS = 40;
export const CHOICE_KINDS: ItemKind[] = ["multiple_choice", "checkboxes", "dropdown"];
export const BRANCHING_KINDS: ItemKind[] = ["multiple_choice", "dropdown"];

export const KIND_META: Record<ItemKind, { label: string; icon: LucideIcon }> = {
  short_text: { label: "Short answer", icon: Type },
  paragraph: { label: "Paragraph", icon: AlignLeft },
  multiple_choice: { label: "Multiple choice", icon: CircleDot },
  checkboxes: { label: "Checkboxes", icon: CheckSquare },
  dropdown: { label: "Dropdown", icon: ChevronDownSquare },
  linear_scale: { label: "Linear scale", icon: SlidersHorizontal },
  rating: { label: "Rating", icon: Star },
  date: { label: "Date", icon: CalendarDays },
  time: { label: "Time", icon: Clock },
  file_upload: { label: "File upload", icon: Upload },
  choice_grid: { label: "Multiple-choice grid", icon: Grid3x3 },
  checkbox_grid: { label: "Checkbox grid", icon: LayoutGrid },
  location: { label: "Location", icon: MapPin },
  text: { label: "Title & text", icon: Heading },
  image: { label: "Image", icon: ImageIcon },
  section: { label: "Section", icon: SeparatorHorizontal },
};

export function isQuestion(item: Pick<FormItem, "kind">): boolean {
  return (QUESTION_KINDS as string[]).includes(item.kind);
}

export function newId(prefix = "q"): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

export function newOption(label = ""): FormOption {
  return { id: newId("o"), label, go_to: null, limit: null, image_asset_id: null };
}

export function newGridLine(prefix: "r" | "c", label = ""): GridLine {
  return { id: newId(prefix), label };
}

export function defaultConfig<K extends ItemKind>(kind: K): ConfigByKind[K] {
  const c: { [P in ItemKind]: ConfigByKind[P] } = {
    short_text: { validation: { kind: "any", min: null, max: null, integer: false }, min_length: null, max_length: null },
    paragraph: { min_length: null, max_length: 5000 },
    multiple_choice: { options: [newOption("Option 1")], other: false, shuffle: false, branching: false },
    checkboxes: { options: [newOption("Option 1")], other: false, shuffle: false, min_selected: null, max_selected: null },
    dropdown: { options: [newOption("Option 1")], branching: false },
    linear_scale: { min: 1, max: 5, min_label: "", max_label: "" },
    rating: { max: 5, icon: "star" },
    date: { include_time: false, include_year: true },
    time: { mode: "time" },
    file_upload: { kinds: ["images", "pdf"], max_files: 1, max_size_mb: 10 },
    choice_grid: {
      rows: [newGridLine("r", "Row 1")],
      columns: [newGridLine("c", "Column 1")],
      each_row: false,
      shuffle_rows: false,
      one_per_column: false,
    },
    checkbox_grid: { rows: [newGridLine("r", "Row 1")], columns: [newGridLine("c", "Column 1")], each_row: false, shuffle_rows: false },
    location: { ask: "address" },
    text: {},
    image: { alt: "" },
    section: { after: "continue" },
  };
  return c[kind];
}

export function newItem<K extends ItemKind>(kind: K, title = ""): FormItem<K> {
  return {
    id: newId(kind === "section" ? "s" : kind === "text" || kind === "image" ? "b" : "q"),
    kind,
    title,
    description: "",
    image_asset_id: null,
    required: false,
    config: defaultConfig(kind),
    deleted: false,
  };
}

/** ``item`` as another kind: choices keep their options between choice
 *  kinds, grids keep their rows and columns between the two grids;
 *  anything else (a grid to a choice, say) starts with the new kind's
 *  defaults. Answers already given stay on the server (shown as text). */
export function changeKind(item: FormItem, kind: ItemKind): FormItem {
  if (item.kind === kind) return item;
  const config = defaultConfig(kind) as FormItem["config"];
  if (GRID_KINDS.includes(kind) && GRID_KINDS.includes(item.kind)) {
    const old = item.config as { rows: GridLine[]; columns: GridLine[]; each_row: boolean; shuffle_rows: boolean };
    Object.assign(config as object, { rows: old.rows, columns: old.columns, each_row: old.each_row, shuffle_rows: old.shuffle_rows });
  }
  const oldOpts = (item.config as { options?: FormOption[] }).options;
  if (CHOICE_KINDS.includes(kind) && oldOpts?.length) {
    const keepGoTo = BRANCHING_KINDS.includes(kind);
    (config as { options: FormOption[] }).options = oldOpts.map((o) => ({ ...o, go_to: keepGoTo ? o.go_to : null }));
    const oldCfg = item.config as { other?: boolean; shuffle?: boolean; branching?: boolean };
    if (kind !== "dropdown") {
      (config as { other: boolean }).other = !!oldCfg.other;
      (config as { shuffle: boolean }).shuffle = !!oldCfg.shuffle;
    }
    if (keepGoTo) (config as { branching: boolean }).branching = !!oldCfg.branching;
  }
  const block = kind === "text" || kind === "image" || kind === "section";
  return { ...item, kind, config, required: block ? false : item.required };
}

/** A copy with new ids (the item's and its options'). */
export function duplicateItem(item: FormItem): FormItem {
  const copy: FormItem = JSON.parse(JSON.stringify(item));
  copy.id = newId(item.kind === "section" ? "s" : "q");
  const opts = (copy.config as { options?: FormOption[] }).options;
  if (opts) for (const o of opts) o.id = newId("o");
  copy.title = item.title ? `${item.title} (copy)`.slice(0, 1000) : "";
  return copy;
}

// ---------------------------------------------------------------- sections

export interface SectionInfo {
  /** null for section 1 (the part before the first section block). */
  id: string | null;
  index: number;
  item: FormItem | null;
  items: FormItem[];
  /** Where it goes when it ends: "continue", "submit" or a section id. */
  after: string;
}

/** The form's sections (deleted items left out). */
export function sectionsOf(def: FormDefinition): SectionInfo[] {
  const out: SectionInfo[] = [{ id: null, index: 0, item: null, items: [], after: def.after || "continue" }];
  for (const it of def.items) {
    if (it.deleted) continue;
    if (it.kind === "section") {
      out.push({
        id: it.id,
        index: out.length,
        item: it,
        items: [],
        after: (it.config as { after?: string }).after || "continue",
      });
    } else {
      out[out.length - 1].items.push(it);
    }
  }
  return out;
}

export function sectionLabel(s: SectionInfo, total: number): string {
  const t = s.index === 0 ? "" : s.item?.title?.trim();
  return `Section ${s.index + 1} of ${total}${t ? `: ${t}` : ""}`;
}

/** Live (not deleted) items. */
export function liveItems(def: FormDefinition): FormItem[] {
  return def.items.filter((i) => !i.deleted);
}

/** Go-to targets pointing at sections that no longer exist (after a
 *  section is deleted) set back to "carry on", so a save isn't refused. */
export function repairTargets(def: FormDefinition): FormDefinition {
  const ids = new Set(def.items.filter((i) => i.kind === "section" && !i.deleted).map((i) => i.id));
  const ok = (v: string | null | undefined) => !v || v === "continue" || v === "submit" || ids.has(v);
  let changed = false;
  const items = def.items.map((it) => {
    if (it.deleted) return it;
    if (it.kind === "section") {
      const after = (it.config as { after: string }).after;
      if (!ok(after) || after === it.id) {
        changed = true;
        return { ...it, config: { ...(it.config as object), after: "continue" } } as FormItem;
      }
      return it;
    }
    const opts = (it.config as { options?: FormOption[] }).options;
    if (opts && opts.some((o) => !ok(o.go_to))) {
      changed = true;
      return {
        ...it,
        config: { ...(it.config as object), options: opts.map((o) => (ok(o.go_to) ? o : { ...o, go_to: null })) },
      } as FormItem;
    }
    return it;
  });
  const after = ok(def.after) ? def.after : "continue";
  if (after !== def.after) changed = true;
  return changed ? { ...def, after, items } : def;
}

// ---------------------------------------------------------------- merging

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface MergeResult {
  definition: FormDefinition;
  /** Titles of items both sides changed (ours were kept). */
  clashes: string[];
}

/**
 * A three-way merge, item by item: ``base`` is what this tab last saved,
 * ``ours`` what it has now, ``theirs`` the newer save from somewhere else.
 * Whatever only one side changed is taken from that side; when both
 * changed the same item (or the title, description, theme), ours wins and
 * it's reported. Order: ours if we reordered, else theirs, with items new
 * on the other side placed after the item they follow there.
 */
export function merge3(base: FormDefinition, ours: FormDefinition, theirs: FormDefinition): MergeResult {
  const clashes: string[] = [];
  const pick = <T,>(b: T, o: T, t: T, what: string): T => {
    if (same(o, b)) return t;
    if (same(t, b) || same(t, o)) return o;
    clashes.push(what);
    return o;
  };
  const title = pick(base.title, ours.title, theirs.title, "the form's title");
  const description = pick(base.description, ours.description, theirs.description, "the form's description");
  const theme = pick(base.theme, ours.theme, theirs.theme, "the form's look");
  const after = pick(base.after, ours.after, theirs.after, "where section 1 goes");

  const byId = (d: FormDefinition) => new Map(d.items.map((i) => [i.id, i] as const));
  const B = byId(base);
  const O = byId(ours);
  const T = byId(theirs);
  const merged = new Map<string, FormItem>();
  for (const id of new Set([...O.keys(), ...T.keys(), ...B.keys()])) {
    const b = B.get(id);
    const o = O.get(id);
    const t = T.get(id);
    if (!b) {
      // New on one side (or both, which can't share an id by chance).
      if (o) merged.set(id, o);
      else if (t) merged.set(id, t);
      continue;
    }
    if (!o && !t) continue;
    if (!o) {
      // We deleted it; keep their version only if they changed it.
      if (t && !same(t, b)) {
        clashes.push(`“${t.title || "Untitled"}”`);
        merged.set(id, t);
      }
      continue;
    }
    if (!t) {
      // They deleted it; keep ours only if we changed it.
      if (!same(o, b)) merged.set(id, o);
      continue;
    }
    merged.set(id, pick(b, o, t, `“${o.title || "Untitled"}”`));
  }

  const orderOf = (d: FormDefinition) => d.items.map((i) => i.id);
  const weReordered = !same(
    orderOf(ours).filter((id) => B.has(id)),
    orderOf(base).filter((id) => O.has(id))
  );
  const primary = weReordered ? ours : theirs;
  const secondary = weReordered ? theirs : ours;
  const order = orderOf(primary).filter((id) => merged.has(id));
  const placed = new Set(order);
  const secOrder = orderOf(secondary);
  secOrder.forEach((id, i) => {
    if (placed.has(id) || !merged.has(id)) return;
    // After the nearest earlier item the other side had that we placed.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(secOrder[j]);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    order.splice(at, 0, id);
    placed.add(id);
  });
  const items = order.map((id) => merged.get(id)!);
  return {
    definition: repairTargets({ ...theirs, title, description, theme, after, items }),
    clashes,
  };
}
