/**
 * A sheet's structure as shared-editing entries (WP-6.3).
 *
 * Cells were already live (one Y.Map entry per cell); tabs, merges, frozen
 * panes, column widths, images, conditional formats… only travelled in the
 * saved workbook JSON, so the last save won. Here that structure becomes
 * entries in a second Y.Map, keyed finely enough that two people changing
 * different things at once both keep their change:
 *
 *   <tab>|tab                  {name, order, color, hide}
 *   <tab>|frozen               the frozen panes
 *   <tab>|size                 {row, column, defaultRowHeight, defaultColWidth, showGridLines}
 *   <tab>|merge|<r_c>          one merged range
 *   <tab>|columnlen|<c>        one column's width        (rowlen|<r>: a row's height)
 *   <tab>|colhidden|<c>        a hidden column           (rowhidden|<r>)
 *   <tab>|hyperlink|<r_c>      one link                  (dv|<r_c>: one validation rule)
 *   <tab>|borders | images | cf | filter    the whole list / object
 *
 * The functions here only read and write plain workbook JSON (the Fortune
 * shape the sheet is saved in); the editor-specific part — applying changes
 * to a live workbook — is the adapter in ``fortuneStructure.ts``, so another
 * engine could sit behind the same entries.
 */

export type Workbook = Array<Record<string, unknown>>;

const PER_KEY: Record<string, (s: Record<string, unknown>) => Record<string, unknown> | undefined> = {
  merge: (s) => cfg(s).merge as Record<string, unknown> | undefined,
  columnlen: (s) => cfg(s).columnlen as Record<string, unknown> | undefined,
  rowlen: (s) => cfg(s).rowlen as Record<string, unknown> | undefined,
  colhidden: (s) => cfg(s).colhidden as Record<string, unknown> | undefined,
  rowhidden: (s) => cfg(s).rowhidden as Record<string, unknown> | undefined,
  hyperlink: (s) => s.hyperlink as Record<string, unknown> | undefined,
  dv: (s) => s.dataVerification as Record<string, unknown> | undefined,
};

const WHOLE: Record<string, (s: Record<string, unknown>) => unknown> = {
  frozen: (s) => s.frozen,
  borders: (s) => cfg(s).borderInfo,
  images: (s) => s.images,
  cf: (s) => s.luckysheet_conditionformat_save,
  filter: (s) => (s.filter_select || s.filter ? { filter_select: s.filter_select ?? null, filter: s.filter ?? null } : undefined),
};

function cfg(s: Record<string, unknown>): Record<string, unknown> {
  return (s.config as Record<string, unknown> | undefined) ?? {};
}

function empty(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** The id a tab is known by in the shared entries. */
export function tabId(sheet: Record<string, unknown>, index: number): string {
  return String(sheet.id ?? `#${index}`);
}

/** Every structure entry of a workbook. */
export function structEntries(sheets: Workbook): Map<string, unknown> {
  const out = new Map<string, unknown>();
  sheets.forEach((s, i) => {
    const id = tabId(s, i);
    out.set(`${id}|tab`, {
      name: s.name ?? `Sheet${i + 1}`,
      order: typeof s.order === "number" ? s.order : i,
      color: s.color ?? null,
      hide: s.hide ? 1 : 0,
    });
    const size = {
      row: s.row ?? null,
      column: s.column ?? null,
      defaultRowHeight: s.defaultRowHeight ?? null,
      defaultColWidth: s.defaultColWidth ?? null,
      showGridLines: s.showGridLines ?? null,
    };
    if (Object.values(size).some((v) => v != null)) out.set(`${id}|size`, size);
    for (const [field, read] of Object.entries(PER_KEY)) {
      const m = read(s);
      if (!m) continue;
      for (const [k, v] of Object.entries(m)) if (v != null && v !== false) out.set(`${id}|${field}|${k}`, v);
    }
    for (const [field, read] of Object.entries(WHOLE)) {
      const v = read(s);
      if (!empty(v)) out.set(`${id}|${field}`, v);
    }
  });
  return out;
}

export interface StructKey {
  tab: string;
  field: string;
  key?: string;
}

export function parseStructKey(k: string): StructKey | null {
  const parts = k.split("|");
  if (parts.length < 2) return null;
  const [tab, field, ...rest] = parts;
  return rest.length ? { tab, field, key: rest.join("|") } : { tab, field };
}

/**
 * A tab's structure rebuilt from the shared entries, merged onto ``base``
 * (the tab as the editor has it — its cells and anything not shared). The
 * result is the tab the editor should show.
 */
export function tabFromEntries(base: Record<string, unknown>, tab: string, entries: Map<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base, id: base.id ?? tab };
  const config: Record<string, unknown> = { ...cfg(base) };
  const perKey: Record<string, Record<string, unknown>> = {};
  for (const field of Object.keys(PER_KEY)) perKey[field] = {};
  let whole: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    const p = parseStructKey(k);
    if (!p || p.tab !== tab) continue;
    if (p.field === "tab" && v && typeof v === "object") {
      const t = v as { name?: string; order?: number; color?: string | null; hide?: number };
      if (t.name != null) out.name = t.name;
      if (t.order != null) out.order = t.order;
      out.color = t.color ?? undefined;
      out.hide = t.hide ? 1 : 0;
    } else if (p.field === "size" && v && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v as object)) if (sv != null) out[sk] = sv;
    } else if (p.key != null && p.field in perKey) {
      perKey[p.field][p.key] = v;
    } else if (p.field in WHOLE) {
      whole = { ...whole, [p.field]: v };
    }
  }
  config.merge = perKey.merge;
  config.columnlen = perKey.columnlen;
  config.rowlen = perKey.rowlen;
  config.colhidden = perKey.colhidden;
  config.rowhidden = perKey.rowhidden;
  config.borderInfo = (whole.borders as unknown[]) ?? [];
  out.config = config;
  out.hyperlink = perKey.hyperlink;
  out.dataVerification = perKey.dv;
  out.frozen = whole.frozen ?? undefined;
  out.images = (whole.images as unknown[]) ?? [];
  out.luckysheet_conditionformat_save = (whole.cf as unknown[]) ?? [];
  const f = whole.filter as { filter_select?: unknown; filter?: unknown } | undefined;
  out.filter_select = f?.filter_select ?? undefined;
  out.filter = f?.filter ?? undefined;
  return out;
}

/** The tab ids that exist in the shared entries, in their order. */
export function tabsInEntries(entries: Map<string, unknown>): { id: string; order: number; name: string }[] {
  const out: { id: string; order: number; name: string }[] = [];
  for (const [k, v] of entries) {
    const p = parseStructKey(k);
    if (!p || p.field !== "tab" || p.key != null || !v || typeof v !== "object") continue;
    const t = v as { order?: number; name?: string };
    out.push({ id: p.tab, order: t.order ?? 0, name: t.name ?? p.tab });
  }
  return out.sort((a, b) => a.order - b.order);
}

export const sig = (v: unknown): string => JSON.stringify(v);
