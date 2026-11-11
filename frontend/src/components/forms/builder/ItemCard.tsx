import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import {
  ArrowDown,
  ArrowUp,
  CircleDot,
  Copy,
  GripVertical,
  Image as ImageIcon,
  ImagePlus,
  KeyRound,
  Loader2,
  MoreVertical,
  Plus,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { editorAiApi } from "@/api/editorAi";
import { NO_MODEL_MESSAGE, useEditorModel } from "@/lib/editorModel";
import { useMapsReady } from "@/maps/useMapsReady";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import type {
  CheckboxesConfig,
  DateConfig,
  DropdownConfig,
  FileUploadConfig,
  FormItem,
  FormOption,
  ImageConfig,
  ItemKind,
  LinearScaleConfig,
  LocationConfig,
  MultipleChoiceConfig,
  ParagraphConfig,
  RatingConfig,
  ShortTextConfig,
  TimeConfig,
  UploadGroup,
} from "@/api/forms";
import { cn } from "@/utils/cn";

import { fileHint } from "../FormRenderer";
import { BRANCHING_KINDS, CHOICE_KINDS, KIND_META, changeKind, isQuestion, newOption, type SectionInfo } from "../model";
import { AnswerKey, MARKABLE, emptyQuiz, keySet, keyWords } from "./AnswerKey";
import { GridEditor } from "./GridEditor";
import { PicturePicker } from "./PicturePicker";
import { AutoTextarea, Menu, MenuItem, NumberBox, Switch, fieldCls, iconBtnCls } from "./ui";

/**
 * One item in the builder: a question, a block (title & text, image) or a
 * section break. Collapsed, it shows what people will see; tapped, it opens
 * for editing — the question, its type, the type's own options, and a
 * footer with Required, Duplicate, Delete and "…" (description, picture,
 * branching, shuffle, validation, limits, Move up / Move down).
 */
export interface ItemCardProps {
  item: FormItem;
  /** The section the item is in, and every section (go-to targets). */
  sectionIndex: number;
  sections: SectionInfo[];
  active: boolean;
  onActivate: () => void;
  onChange: (fn: (it: FormItem) => FormItem, coalesce?: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  fileId: string;
  assetUrls: Record<string, string>;
  addAssetUrl: (id: string, url: string) => void;
  /** The save's complaint about this item, shown on it. */
  error?: string | null;
  readOnly?: boolean;
  /** The form is a quiz: questions a quiz can mark get an Answer key. */
  quiz?: boolean;
  // dnd-kit
  handle?: { attributes: DraggableAttributes; listeners: DraggableSyntheticListeners; setActivatorNodeRef: (el: HTMLElement | null) => void };
  style?: CSSProperties;
  dragging?: boolean;
}

const KIND_GROUPS: { label: string; kinds: ItemKind[] }[] = [
  { label: "Text", kinds: ["short_text", "paragraph"] },
  { label: "Choices", kinds: ["multiple_choice", "checkboxes", "dropdown"] },
  { label: "Scales", kinds: ["linear_scale", "rating"] },
  { label: "Grids", kinds: ["choice_grid", "checkbox_grid"] },
  { label: "Date and time", kinds: ["date", "time"] },
  { label: "Places", kinds: ["location"] },
  { label: "Files", kinds: ["file_upload"] },
];

export const ItemCard = forwardRef<HTMLDivElement, ItemCardProps>(function ItemCard(p, ref) {
  const { item, active, readOnly } = p;
  const meta = KIND_META[item.kind];
  const isSection = item.kind === "section";
  const [showDesc, setShowDesc] = useState(!!item.description);
  const [showValidation, setShowValidation] = useState(false);
  const [limitsOn, setLimitsOn] = useState(false);
  const [picker, setPicker] = useState<null | { target: "item" } | { target: "option"; optionId: string }>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const markable = !!p.quiz && MARKABLE.includes(item.kind);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (item.description) setShowDesc(true);
  }, [item.description]);
  useEffect(() => {
    if (active && !readOnly) {
      // Focus the question text on open (not when it opened by a click
      // inside a field — that click already placed the caret).
      const el = titleRef.current;
      if (el && !el.contains(document.activeElement) && !(document.activeElement instanceof HTMLInputElement) && !(document.activeElement instanceof HTMLTextAreaElement) && !(document.activeElement instanceof HTMLSelectElement)) {
        el.focus({ preventScroll: true });
      }
    }
  }, [active, readOnly]);

  const setTitle = (v: string) => p.onChange((it) => ({ ...it, title: v }), `${item.id}:title`);
  const setDesc = (v: string) => p.onChange((it) => ({ ...it, description: v }), `${item.id}:desc`);
  const setConfig = (fn: (c: never) => unknown, coalesce?: string) =>
    p.onChange((it) => ({ ...it, config: fn(it.config as never) as FormItem["config"] }), coalesce);

  const opts = (item.config as { options?: FormOption[] }).options;
  const limitsShown = limitsOn || !!opts?.some((o) => o.limit);
  const hasValidation = validationIsSet(item);
  const validationShown = showValidation || hasValidation;
  const label = isSection ? `Section ${p.sectionIndex + 1}` : meta.label;
  const titlePlaceholder =
    item.kind === "section" ? "Section title" : item.kind === "text" ? "Title" : item.kind === "image" ? "Caption (optional)" : "Question";

  const handle = p.handle && !readOnly && (
    <button
      type="button"
      ref={p.handle.setActivatorNodeRef}
      {...p.handle.attributes}
      {...p.handle.listeners}
      aria-label={`Drag to reorder: ${item.title || label}`}
      className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] active:cursor-grabbing"
    >
      <GripVertical className="h-4 w-4" />
    </button>
  );

  return (
    <div
      ref={ref}
      style={p.style}
      data-item={item.id}
      className={cn(
        // No overflow clipping: the card's "…" menu opens over its neighbours.
        "pf-card relative transition-shadow",
        active && "z-10 shadow-[var(--shadow-md)]",
        p.dragging && "z-20 opacity-90 shadow-[var(--shadow-lg)]",
        p.error && "!border-red-500"
      )}
    >
      {isSection && (
        <div className="rounded-t-[13px] px-4 py-1.5 text-xs font-semibold" style={{ background: "var(--pf-accent)", color: "var(--pf-on-accent)" }}>
          Section {p.sectionIndex + 1} of {p.sections.length}
        </div>
      )}
      {active && <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1 rounded-l-[14px]" style={{ background: "var(--pf-accent)" }} />}

      {!active || readOnly ? (
        <div className="flex items-start gap-1 py-2 pl-1 pr-3">
          {handle}
          <button
            type="button"
            onClick={p.onActivate}
            disabled={readOnly}
            aria-label={`Edit ${isQuestion(item) ? "question" : label.toLowerCase()}: ${item.title || "untitled"}`}
            className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-default"
          >
            <Summary item={item} label={label} assetUrls={p.assetUrls} />
            {markable && <KeyLine item={item} />}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 py-3 pl-1 pr-3 sm:pr-4">
          <div className="flex items-start gap-1">
            {handle}
            <div className="flex min-w-0 flex-1 flex-col gap-3 pl-1">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <AutoTextarea
                  ref={titleRef}
                  aria-label={isSection ? "Section title" : item.kind === "text" ? "Title" : item.kind === "image" ? "Caption" : "Question"}
                  placeholder={titlePlaceholder}
                  value={item.title}
                  maxLength={1000}
                  onChange={(e) => setTitle(e.target.value)}
                  className={cn(fieldCls, "min-h-[44px] flex-1 text-base font-medium")}
                />
                {isQuestion(item) && (
                  <label className="flex flex-col gap-1 sm:w-48">
                    <span className="sr-only">Question type</span>
                    <select
                      className={cn(fieldCls, "h-11")}
                      value={item.kind}
                      onChange={(e) => p.onChange((it) => changeKind(it, e.target.value as ItemKind))}
                    >
                      {KIND_GROUPS.map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.kinds.map((k) => (
                            <option key={k} value={k}>
                              {KIND_META[k].label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {(showDesc || item.kind === "text" || isSection) && (
                <AutoTextarea
                  aria-label="Description"
                  placeholder={item.kind === "text" ? "Text" : "Description (optional)"}
                  value={item.description}
                  maxLength={5000}
                  onChange={(e) => setDesc(e.target.value)}
                  className={cn(fieldCls, "min-h-[40px]")}
                />
              )}
              {item.image_asset_id && item.kind !== "image" && (
                <ItemPicture
                  url={p.assetUrls[item.image_asset_id]}
                  onRemove={() => p.onChange((it) => ({ ...it, image_asset_id: null }))}
                  onReplace={() => setPicker({ target: "item" })}
                />
              )}
              <KindEditor
                {...p}
                setConfig={setConfig}
                limitsShown={limitsShown}
                validationShown={validationShown}
                onPickOptionImage={(optionId) => setPicker({ target: "option", optionId })}
              />
              {p.error && (
                <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
                  {p.error}
                </p>
              )}
              {markable && keyOpen && (
                <AnswerKey
                  item={item}
                  onChange={(fn, coalesce) => p.onChange((it) => ({ ...it, quiz: fn(it.quiz ?? emptyQuiz(it)) }), coalesce)}
                  onDone={() => setKeyOpen(false)}
                />
              )}
            </div>
          </div>
          <Footer
            keyButton={
              markable ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!item.quiz) p.onChange((it) => ({ ...it, quiz: emptyQuiz(it) }));
                    setKeyOpen((o) => !o);
                  }}
                  aria-expanded={keyOpen}
                  className={cn(
                    "mr-auto inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-2 text-sm font-medium hover:bg-[var(--hover)]",
                    item.quiz?.suggested ? "text-amber-700 dark:text-amber-400" : "text-[var(--accent-text)]"
                  )}
                >
                  <KeyRound className="h-4 w-4" aria-hidden="true" /> Answer key
                  <span className="font-normal text-[var(--text-muted)]">· {keyWords(item)}</span>
                </button>
              ) : undefined
            }
            {...p}
            showDesc={showDesc}
            onToggleDesc={() => {
              if (showDesc && item.description) setDesc("");
              setShowDesc((s) => !s);
            }}
            onAddImage={() => setPicker({ target: "item" })}
            validationShown={validationShown}
            onToggleValidation={() => {
              if (validationShown) {
                setShowValidation(false);
                if (hasValidation) setConfig(() => clearValidation(item));
              } else setShowValidation(true);
            }}
            limitsShown={limitsShown}
            onToggleLimits={() => {
              if (limitsShown) {
                setLimitsOn(false);
                setConfig((c: { options: FormOption[] }) => ({ ...c, options: c.options.map((o) => ({ ...o, limit: null })) }));
              } else setLimitsOn(true);
            }}
          />
        </div>
      )}
      {picker && (
        <PicturePicker
          open
          onClose={() => setPicker(null)}
          fileId={p.fileId}
          onPicked={(a) => {
            p.addAssetUrl(a.id, a.url);
            if (picker.target === "item") p.onChange((it) => ({ ...it, image_asset_id: a.id }));
            else {
              const optionId = picker.optionId;
              setConfig((c: { options: FormOption[] }) => ({
                ...c,
                options: c.options.map((o) => (o.id === optionId ? { ...o, image_asset_id: a.id } : o)),
              }));
            }
          }}
        />
      )}
    </div>
  );
});

function validationIsSet(item: FormItem): boolean {
  switch (item.kind) {
    case "short_text": {
      const c = item.config as ShortTextConfig;
      return c.validation.kind !== "any" || c.min_length !== null || c.max_length !== null;
    }
    case "paragraph": {
      const c = item.config as ParagraphConfig;
      return c.min_length !== null || c.max_length !== 5000;
    }
    case "checkboxes": {
      const c = item.config as CheckboxesConfig;
      return c.min_selected !== null || c.max_selected !== null;
    }
    default:
      return false;
  }
}

function clearValidation(item: FormItem): FormItem["config"] {
  switch (item.kind) {
    case "short_text":
      return { ...(item.config as ShortTextConfig), validation: { kind: "any", min: null, max: null, integer: false }, min_length: null, max_length: null };
    case "paragraph":
      return { ...(item.config as ParagraphConfig), min_length: null, max_length: 5000 };
    case "checkboxes":
      return { ...(item.config as CheckboxesConfig), min_selected: null, max_selected: null };
    default:
      return item.config;
  }
}

// ---------------------------------------------------------------------
// Collapsed view
// ---------------------------------------------------------------------

function Summary({ item, label, assetUrls }: { item: FormItem; label: string; assetUrls: Record<string, string> }) {
  const Icon = KIND_META[item.kind].icon;
  const opts = (item.config as { options?: FormOption[] }).options;
  const img = item.image_asset_id ? assetUrls[item.image_asset_id] : undefined;
  return (
    <span className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
        {item.required && <span className="text-red-600 dark:text-red-400">· Required</span>}
      </span>
      <span className={cn("text-[15px] font-medium [overflow-wrap:anywhere]", !item.title && "italic text-[var(--text-muted)]")}>
        {item.title || (item.kind === "section" ? "Untitled section" : item.kind === "image" ? "Picture" : item.kind === "text" ? "Untitled text" : "Untitled question")}
      </span>
      {item.description && <span className="line-clamp-2 whitespace-pre-line text-sm text-[var(--text-muted)]">{item.description}</span>}
      {img && <img src={img} alt="" className="max-h-40 w-full rounded-md object-cover" />}
      {item.kind === "image" && !img && <span className="text-sm text-[var(--text-muted)]">No picture yet</span>}
      {(item.kind === "choice_grid" || item.kind === "checkbox_grid") && <GridSummary item={item} />}
      {item.kind === "location" && (
        <span className="text-sm text-[var(--text-muted)]">{ASK_WORDS[(item.config as LocationConfig).ask] ?? ASK_WORDS.any}</span>
      )}
      {opts && opts.length > 0 && (
        <span className="flex flex-col gap-1 text-sm text-[var(--text)]">
          {opts.slice(0, 6).map((o) => (
            <span key={o.id} className="flex items-center gap-2">
              {item.kind === "checkboxes" ? (
                <Square className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              ) : item.kind === "dropdown" ? (
                <span className="w-3.5 shrink-0 text-center text-xs text-[var(--text-muted)]" aria-hidden="true">•</span>
              ) : (
                <CircleDot className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              )}
              <span className="truncate">{o.label || "Untitled option"}</span>
              {o.limit ? <span className="shrink-0 text-xs text-[var(--text-muted)]">· {o.limit} {o.limit === 1 ? "place" : "places"}</span> : null}
            </span>
          ))}
          {opts.length > 6 && <span className="text-xs text-[var(--text-muted)]">and {opts.length - 6} more</span>}
        </span>
      )}
    </span>
  );
}

/** "2 points · key set" / "No answer key yet" / "AI suggested — check it" on a collapsed quiz question. */
function KeyLine({ item }: { item: FormItem }) {
  const set = keySet(item);
  return (
    <span
      className={cn(
        "mt-1 inline-flex items-center gap-1 text-xs",
        item.quiz?.suggested ? "font-medium text-amber-700 dark:text-amber-400" : set ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]"
      )}
    >
      {item.quiz?.suggested ? <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> : <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
      {item.quiz?.suggested ? "AI suggested this answer — check it" : keyWords(item)}
    </span>
  );
}

function GridSummary({ item }: { item: FormItem }) {
  const c = item.config as { rows: { id: string; label: string }[]; columns: { id: string; label: string }[] };
  const rows = c.rows.map((r, i) => r.label || `Row ${i + 1}`);
  const cols = c.columns.map((x, i) => x.label || `Column ${i + 1}`);
  return (
    <span className="flex flex-col gap-0.5 text-sm text-[var(--text)]">
      <span className="truncate">
        <span className="text-[var(--text-muted)]">Rows: </span>
        {rows.slice(0, 6).join(", ")}
        {rows.length > 6 ? ` and ${rows.length - 6} more` : ""}
      </span>
      <span className="truncate">
        <span className="text-[var(--text-muted)]">Columns: </span>
        {cols.join(", ")}
      </span>
    </span>
  );
}

function ItemPicture({ url, onRemove, onReplace }: { url?: string; onRemove: () => void; onReplace: () => void }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-[var(--border)]">
      {url ? (
        <img src={url} alt="" className="max-h-64 w-full object-contain" />
      ) : (
        <div className="flex h-24 items-center justify-center text-sm text-[var(--text-muted)]">Picture</div>
      )}
      <div className="absolute right-1 top-1 flex gap-1">
        <button type="button" onClick={onReplace} className="rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white hover:bg-black/75">
          Change
        </button>
        <button type="button" onClick={onRemove} aria-label="Remove picture" className="rounded-md bg-black/60 p-1 text-white hover:bg-black/75">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Footer: Required · Duplicate · Delete · …
// ---------------------------------------------------------------------

function Footer(
  p: ItemCardProps & {
    keyButton?: ReactNode;
    showDesc: boolean;
    onToggleDesc: () => void;
    onAddImage: () => void;
    validationShown: boolean;
    onToggleValidation: () => void;
    limitsShown: boolean;
    onToggleLimits: () => void;
  }
) {
  const { item } = p;
  const q = isQuestion(item);
  const cfg = item.config as { branching?: boolean; shuffle?: boolean; options?: FormOption[] };
  const hasValidationUi = item.kind === "short_text" || item.kind === "paragraph" || item.kind === "checkboxes";
  const toggleCfg = (key: "branching" | "shuffle") =>
    p.onChange((it) => {
      const c = it.config as { branching?: boolean; shuffle?: boolean; options?: FormOption[] };
      const on = !c[key];
      const next = { ...c, [key]: on } as typeof c;
      // Branching off: the options' targets stay (for turning it back on)
      // but stop applying.
      return { ...it, config: next as FormItem["config"] };
    });
  return (
    <div className="flex flex-wrap items-center justify-end gap-1 border-t border-[var(--border)] pl-3 pt-2">
      {p.keyButton}
      <button type="button" className={iconBtnCls} onClick={p.onDuplicate} title="Duplicate" aria-label="Duplicate">
        <Copy className="h-4 w-4" />
      </button>
      <button type="button" className={iconBtnCls} onClick={p.onDelete} title="Delete" aria-label="Delete">
        <Trash2 className="h-4 w-4" />
      </button>
      {q && (
        <>
          <span aria-hidden="true" className="mx-1 h-6 w-px bg-[var(--border)]" />
          <Switch
            checked={item.required}
            onChange={(v) => p.onChange((it) => ({ ...it, required: v }))}
            label="Required"
            className="items-center"
          />
        </>
      )}
      <Menu label="More" icon={<MoreVertical className="h-4 w-4" />} up>
        {(close) => (
          <>
            {item.kind !== "text" && item.kind !== "section" && (
              <MenuItem onClick={() => { p.onToggleDesc(); close(); }} checked={p.showDesc}>
                Description
              </MenuItem>
            )}
            {item.kind !== "image" && item.kind !== "section" && (
              <MenuItem onClick={() => { p.onAddImage(); close(); }}>
                <ImagePlus className="h-4 w-4" /> {item.image_asset_id ? "Change picture" : "Add picture"}
              </MenuItem>
            )}
            {BRANCHING_KINDS.includes(item.kind) && (
              <MenuItem onClick={() => { toggleCfg("branching"); close(); }} checked={!!cfg.branching}>
                Go to section based on answer
              </MenuItem>
            )}
            {(item.kind === "multiple_choice" || item.kind === "checkboxes") && (
              <MenuItem onClick={() => { toggleCfg("shuffle"); close(); }} checked={!!cfg.shuffle}>
                Shuffle options
              </MenuItem>
            )}
            {CHOICE_KINDS.includes(item.kind) && (
              <MenuItem onClick={() => { p.onToggleLimits(); close(); }} checked={p.limitsShown}>
                Limit places per option
              </MenuItem>
            )}
            {hasValidationUi && (
              <MenuItem onClick={() => { p.onToggleValidation(); close(); }} checked={p.validationShown}>
                {item.kind === "checkboxes" ? "How many to tick" : item.kind === "paragraph" ? "Length limit" : "Answer rules"}
              </MenuItem>
            )}
            <div role="separator" className="my-1 h-px bg-[var(--border)]" />
            <MenuItem onClick={() => { p.onMove(-1); close(); }} disabled={!p.canMoveUp}>
              <ArrowUp className="h-4 w-4" /> Move up
            </MenuItem>
            <MenuItem onClick={() => { p.onMove(1); close(); }} disabled={!p.canMoveDown}>
              <ArrowDown className="h-4 w-4" /> Move down
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}

// ---------------------------------------------------------------------
// The type's own options
// ---------------------------------------------------------------------

type KindEditorProps = ItemCardProps & {
  setConfig: (fn: (c: never) => unknown, coalesce?: string) => void;
  limitsShown: boolean;
  validationShown: boolean;
  onPickOptionImage: (optionId: string) => void;
};

function KindEditor(p: KindEditorProps) {
  const { item, setConfig } = p;
  switch (item.kind) {
    case "short_text":
      return p.validationShown ? <ShortTextRules item={item as FormItem<"short_text">} setConfig={setConfig} /> : <Hint>Short answer text</Hint>;
    case "paragraph": {
      const c = item.config as ParagraphConfig;
      return p.validationShown ? (
        <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
          <NumberBox label="Shortest (characters)" value={c.min_length} min={1} max={10000} onChange={(v) => setConfig((x: ParagraphConfig) => ({ ...x, min_length: v ? Math.round(v) : null }), `${item.id}:minl`)} />
          <NumberBox label="Longest (characters)" value={c.max_length} min={1} max={10000} onChange={(v) => setConfig((x: ParagraphConfig) => ({ ...x, max_length: v ? Math.min(10000, Math.round(v)) : 5000 }), `${item.id}:maxl`)} />
        </div>
      ) : (
        <Hint>Long answer text (up to {c.max_length.toLocaleString()} characters)</Hint>
      );
    }
    case "multiple_choice":
    case "checkboxes":
    case "dropdown":
      return <ChoiceEditor {...p} />;
    case "linear_scale": {
      const c = item.config as LinearScaleConfig;
      return (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              From
              <select className={cn(fieldCls, "h-10 w-24")} value={c.min} onChange={(e) => setConfig((x: LinearScaleConfig) => ({ ...x, min: Number(e.target.value) as 0 | 1 }))}>
                <option value={0}>0</option>
                <option value={1}>1</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              To
              <select className={cn(fieldCls, "h-10 w-24")} value={c.max} onChange={(e) => setConfig((x: LinearScaleConfig) => ({ ...x, max: Number(e.target.value) }))}>
                {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              Label for {c.min} (optional)
              <input className={fieldCls} maxLength={100} placeholder="e.g. Not at all" value={c.min_label} onChange={(e) => setConfig((x: LinearScaleConfig) => ({ ...x, min_label: e.target.value }), `${item.id}:minlabel`)} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              Label for {c.max} (optional)
              <input className={fieldCls} maxLength={100} placeholder="e.g. Very much" value={c.max_label} onChange={(e) => setConfig((x: LinearScaleConfig) => ({ ...x, max_label: e.target.value }), `${item.id}:maxlabel`)} />
            </label>
          </div>
        </div>
      );
    }
    case "rating": {
      const c = item.config as RatingConfig;
      return (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            How many
            <select className={cn(fieldCls, "h-10 w-24")} value={c.max} onChange={(e) => setConfig((x: RatingConfig) => ({ ...x, max: Number(e.target.value) }))}>
              {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs text-[var(--text-muted)]">Shape</legend>
            <div className="flex overflow-hidden rounded-md border border-[var(--border)]">
              {(["star", "heart", "thumb"] as const).map((icon) => (
                <label key={icon} className={cn("flex h-10 cursor-pointer items-center px-3 text-sm", c.icon === icon ? "bg-[var(--accent-strong)] text-white" : "hover:bg-[var(--hover)]")}>
                  <input type="radio" className="sr-only" name={`${item.id}-icon`} checked={c.icon === icon} onChange={() => setConfig((x: RatingConfig) => ({ ...x, icon }))} />
                  {icon === "star" ? "Stars" : icon === "heart" ? "Hearts" : "Thumbs"}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      );
    }
    case "date": {
      const c = item.config as DateConfig;
      return (
        <div className="flex flex-col gap-2">
          <Switch checked={c.include_time} onChange={(v) => setConfig((x: DateConfig) => ({ ...x, include_time: v }))} label="Ask for a time too" />
          <Switch checked={c.include_year} onChange={(v) => setConfig((x: DateConfig) => ({ ...x, include_year: v }))} label="Ask for the year" hint="Turn off for birthdays." />
        </div>
      );
    }
    case "time": {
      const c = item.config as TimeConfig;
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs text-[var(--text-muted)]">Answer</legend>
          <div className="flex w-fit overflow-hidden rounded-md border border-[var(--border)]">
            {(["time", "duration"] as const).map((mode) => (
              <label key={mode} className={cn("flex h-10 cursor-pointer items-center px-3 text-sm", c.mode === mode ? "bg-[var(--accent-strong)] text-white" : "hover:bg-[var(--hover)]")}>
                <input type="radio" className="sr-only" name={`${item.id}-mode`} checked={c.mode === mode} onChange={() => setConfig((x: TimeConfig) => ({ ...x, mode }))} />
                {mode === "time" ? "Time of day" : "How long (a duration)"}
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case "choice_grid":
    case "checkbox_grid":
      return <GridEditor item={item as FormItem<"choice_grid">} setConfig={setConfig} />;
    case "location":
      return <LocationEditor item={item as FormItem<"location">} setConfig={setConfig} />;
    case "file_upload":
      return <UploadEditor item={item as FormItem<"file_upload">} setConfig={setConfig} />;
    case "image":
      return <ImageBlockEditor {...p} />;
    default:
      return null;
  }
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="border-b border-dotted border-[var(--border)] pb-2 text-sm text-[var(--text-muted)] sm:w-2/3">{children}</p>;
}

function ShortTextRules({ item, setConfig }: { item: FormItem<"short_text">; setConfig: KindEditorProps["setConfig"] }) {
  const c = item.config;
  const v = c.validation;
  const setV = (patch: Partial<ShortTextConfig["validation"]>, key?: string) =>
    setConfig((x: ShortTextConfig) => {
      const next = { ...x.validation, ...patch };
      if (next.kind !== "number") Object.assign(next, { min: null, max: null, integer: false });
      return { ...x, validation: next };
    }, key);
  return (
    <div className="flex flex-col gap-3 rounded-md bg-[var(--hover)]/60 p-3">
      <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)] sm:max-w-xs">
        The answer must be
        <select className={cn(fieldCls, "h-10")} value={v.kind} onChange={(e) => setV({ kind: e.target.value as ShortTextConfig["validation"]["kind"] })}>
          <option value="any">Any text</option>
          <option value="number">A number</option>
          <option value="email">An email address</option>
          <option value="url">A web link</option>
        </select>
      </label>
      {v.kind === "number" && (
        <div className="flex flex-wrap items-end gap-2">
          <NumberBox className="w-32" label="Smallest" value={v.min} onChange={(n) => setV({ min: n }, `${item.id}:nmin`)} />
          <NumberBox className="w-32" label="Largest" value={v.max} onChange={(n) => setV({ max: n }, `${item.id}:nmax`)} />
          <Switch checked={v.integer} onChange={(on) => setV({ integer: on })} label="Whole numbers only" className="pb-2" />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <NumberBox className="w-40" label="Shortest (characters)" value={c.min_length} min={1} max={1000} onChange={(n) => setConfig((x: ShortTextConfig) => ({ ...x, min_length: n ? Math.round(n) : null }), `${item.id}:minl`)} />
        <NumberBox className="w-40" label="Longest (characters)" value={c.max_length} min={1} max={1000} onChange={(n) => setConfig((x: ShortTextConfig) => ({ ...x, max_length: n ? Math.min(1000, Math.round(n)) : null }), `${item.id}:maxl`)} />
      </div>
    </div>
  );
}

const ASK_WORDS: Record<LocationConfig["ask"], string> = {
  address: "Asks for an address",
  town: "Asks for a suburb or town",
  any: "Asks for any place",
};

function LocationEditor({ item, setConfig }: { item: FormItem<"location">; setConfig: KindEditorProps["setConfig"] }) {
  const c = item.config;
  const maps = useMapsReady();
  const choices: { key: LocationConfig["ask"]; label: string }[] = [
    { key: "address", label: "An address" },
    { key: "town", label: "A suburb or town" },
    { key: "any", label: "Any place" },
  ];
  return (
    <div className="flex flex-col gap-2">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-[var(--text-muted)]">Ask for</legend>
        <div className="flex w-fit flex-wrap overflow-hidden rounded-md border border-[var(--border)]">
          {choices.map((o) => (
            <label key={o.key} className={cn("flex h-10 cursor-pointer items-center px-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-[var(--accent)]", c.ask === o.key ? "bg-[var(--accent-strong)] text-white" : "hover:bg-[var(--hover)]")}>
              <input type="radio" className="sr-only" name={`${item.id}-ask`} checked={c.ask === o.key} onChange={() => setConfig((x: LocationConfig) => ({ ...x, ask: o.key }))} />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-[var(--text-muted)]">
        {c.ask === "town" ? "People can answer without giving a street address. " : ""}
        {maps
          ? "People type a place or pick one of the suggestions. Picked places can be shown on a map in Responses."
          : "Suggestions need P Maps; people can still type a place."}{" "}
        Nobody is asked for their location.
      </p>
    </div>
  );
}

const UPLOAD_GROUPS: { key: UploadGroup; label: string }[] = [
  { key: "images", label: "Images" },
  { key: "pdf", label: "PDF" },
  { key: "documents", label: "Documents" },
  { key: "spreadsheets", label: "Spreadsheets" },
  { key: "audio", label: "Audio" },
  { key: "video", label: "Video" },
];

function UploadEditor({ item, setConfig }: { item: FormItem<"file_upload">; setConfig: KindEditorProps["setConfig"] }) {
  const c = item.config;
  return (
    <div className="flex flex-col gap-3">
      <fieldset>
        <legend className="mb-1.5 text-xs text-[var(--text-muted)]">Kinds of file people can send</legend>
        <div className="flex flex-wrap gap-1.5">
          {UPLOAD_GROUPS.map((g) => {
            const on = c.kinds.includes(g.key);
            return (
              <label key={g.key} className={cn("flex min-h-[36px] cursor-pointer items-center gap-2 rounded-full border px-3 text-sm", on ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] hover:bg-[var(--hover)]")}>
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={on}
                  onChange={() =>
                    setConfig((x: FileUploadConfig) => {
                      const kinds = on ? x.kinds.filter((k) => k !== g.key) : [...x.kinds, g.key];
                      return { ...x, kinds: kinds.length ? kinds : x.kinds };
                    })
                  }
                />
                {g.label}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Most files
          <select className={cn(fieldCls, "h-10 w-24")} value={c.max_files} onChange={(e) => setConfig((x: FileUploadConfig) => ({ ...x, max_files: Number(e.target.value) }))}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Biggest file
          <select className={cn(fieldCls, "h-10 w-28")} value={c.max_size_mb} onChange={(e) => setConfig((x: FileUploadConfig) => ({ ...x, max_size_mb: Number(e.target.value) }))}>
            {[1, 5, 10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} MB
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        {fileHint(c)} People without an account can only send pictures and PDFs, and only if you allow it in Settings. Files
        aren&apos;t checked for viruses on this server, so open files from people you don&apos;t know with care.
      </p>
    </div>
  );
}

function ImageBlockEditor(p: KindEditorProps) {
  const { item } = p;
  const [pick, setPick] = useState(false);
  const url = item.image_asset_id ? p.assetUrls[item.image_asset_id] : undefined;
  const c = item.config as ImageConfig;
  return (
    <div className="flex flex-col gap-2">
      {item.image_asset_id ? (
        <ItemPicture url={url} onReplace={() => setPick(true)} onRemove={() => p.onChange((it) => ({ ...it, image_asset_id: null }))} />
      ) : (
        <button
          type="button"
          onClick={() => setPick(true)}
          className="flex h-28 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-[var(--border)] text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          <ImageIcon className="h-5 w-5" /> Choose a picture
        </button>
      )}
      <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
        Describe the picture for people who can&apos;t see it
        <input className={fieldCls} maxLength={500} value={c.alt} onChange={(e) => p.setConfig((x: ImageConfig) => ({ ...x, alt: e.target.value }), `${item.id}:alt`)} />
      </label>
      {pick && (
        <PicturePicker
          open
          onClose={() => setPick(false)}
          fileId={p.fileId}
          onPicked={(a) => {
            p.addAssetUrl(a.id, a.url);
            p.onChange((it) => ({ ...it, image_asset_id: a.id }));
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Options (multiple choice, checkboxes, dropdown)
// ---------------------------------------------------------------------

export function goToChoices(sections: SectionInfo[], fromIndex: number): { value: string; label: string }[] {
  const out = [{ value: "", label: "Continue to the next section" }];
  for (const s of sections) {
    if (s.index <= fromIndex || !s.id) continue;
    out.push({ value: s.id, label: `Go to section ${s.index + 1}${s.item?.title ? ` (${s.item.title.slice(0, 40)})` : ""}` });
  }
  out.push({ value: "submit", label: "Submit form" });
  return out;
}

/** "Suggest options" (AI, WP-F1.7): a few options for this question, shown
 *  first — Add them, or don't. */
function SuggestOptions({
  fileId,
  question,
  existing,
  room,
  onAdd,
}: {
  fileId: string;
  question: string;
  existing: string[];
  room: number;
  onAdd: (labels: string[]) => void;
}) {
  const { providerId, modelId } = useEditorModel();
  const [busy, setBusy] = useState(false);
  const [got, setGot] = useState<string[] | null>(null);
  const run = async () => {
    if (!question.trim()) {
      toast.error("Give the question a title first, so the AI knows what to suggest.");
      return;
    }
    if (!providerId || !modelId) {
      toast.error(NO_MODEL_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      const r = await editorAiApi.form(fileId, {
        provider_id: providerId,
        model_id: modelId,
        mode: "options",
        question,
        existing: existing.filter((x) => !/^Option \d+$/.test(x)),
      });
      setGot(r.options.map((o) => o.label).slice(0, Math.max(0, room)));
    } catch (e) {
      toast.error(apiErrorMessage(e, "No options came back. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-2 font-medium text-[var(--accent-text)] hover:bg-[var(--hover)] disabled:opacity-40"
        disabled={busy || room <= 0}
        onClick={() => void run()}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />} Suggest options
      </button>
      {got && (
        <div className="mt-1 flex w-full flex-col gap-2 rounded-md border border-dashed border-[var(--border)] p-2" role="group" aria-label="Suggested options">
          <ul className="flex flex-wrap gap-1.5">
            {got.map((l) => (
              <li key={l} className="rounded-full bg-[var(--hover)] px-2.5 py-1 text-xs text-[var(--text-muted)]">
                {l}
              </li>
            ))}
          </ul>
          <span className="flex gap-1">
            <button
              type="button"
              className="min-h-[36px] rounded-md bg-[var(--accent-strong)] px-3 text-xs font-medium text-white"
              onClick={() => {
                onAdd(got);
                setGot(null);
              }}
            >
              Add these
            </button>
            <button type="button" className="min-h-[36px] rounded-md px-3 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]" onClick={() => setGot(null)}>
              No thanks
            </button>
          </span>
        </div>
      )}
    </>
  );
}

function ChoiceEditor(p: KindEditorProps) {
  const { item, setConfig } = p;
  const c = item.config as MultipleChoiceConfig | CheckboxesConfig | DropdownConfig;
  const kind = item.kind;
  const branching = BRANCHING_KINDS.includes(kind) && !!(c as MultipleChoiceConfig).branching;
  const other = kind !== "dropdown" && !!(c as MultipleChoiceConfig).other;
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (focusId) {
      // A new option starts as "Option N", selected, so typing replaces it.
      const el = inputs.current.get(focusId);
      el?.focus();
      el?.select();
      setFocusId(null);
    }
    // Only when focusId changes: with the options in here too, typing fast
    // into the new option re-ran this before focusId was cleared, selected
    // what had been typed so far, and the next letter replaced it.
  }, [focusId]);

  const targets = goToChoices(p.sections, p.sectionIndex);
  const setOptions = (fn: (o: FormOption[]) => FormOption[], key?: string) =>
    setConfig((x: { options: FormOption[] }) => ({ ...x, options: fn(x.options) }), key);
  const addAfter = (idx: number, labels: string[] = [""]) => {
    if (c.options.length + labels.length > 100) return;
    const made = labels.map((l, i) => newOption(l || (labels.length === 1 ? `Option ${c.options.length + 1}` : `Option ${idx + 2 + i}`)));
    setOptions((o) => [...o.slice(0, idx + 1), ...made, ...o.slice(idx + 1)]);
    setFocusId(made[made.length - 1].id);
  };
  const Marker = ({ i }: { i: number }) =>
    kind === "checkboxes" ? (
      <Square className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
    ) : kind === "dropdown" ? (
      <span className="w-4 shrink-0 text-right text-sm text-[var(--text-muted)]" aria-hidden="true">{i + 1}.</span>
    ) : (
      <CircleDot className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
    );

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5" aria-label="Options">
        {c.options.map((o, i) => (
          <li key={o.id} className="flex flex-col gap-1.5 rounded-md sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Marker i={i} />
              {o.image_asset_id && p.assetUrls[o.image_asset_id] && (
                <span className="relative shrink-0">
                  <img src={p.assetUrls[o.image_asset_id]} alt="" className="h-10 w-10 rounded object-cover" />
                  <button
                    type="button"
                    aria-label={`Remove the picture from option ${i + 1}`}
                    onClick={() => setOptions((list) => list.map((x) => (x.id === o.id ? { ...x, image_asset_id: null } : x)))}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-black/70 p-0.5 text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              <input
                ref={(el) => {
                  if (el) inputs.current.set(o.id, el);
                  else inputs.current.delete(o.id);
                }}
                aria-label={`Option ${i + 1}`}
                className={cn(fieldCls, "h-10 min-w-0 flex-1")}
                value={o.label}
                maxLength={500}
                onChange={(e) => setOptions((list) => list.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)), `${o.id}:label`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAfter(i);
                  } else if (e.key === "Backspace" && o.label === "" && c.options.length > 1) {
                    e.preventDefault();
                    const prev = c.options[i - 1] ?? c.options[i + 1];
                    setOptions((list) => list.filter((x) => x.id !== o.id));
                    if (prev) setFocusId(prev.id);
                  }
                }}
                onPaste={(e) => {
                  const lines = e.clipboardData.getData("text").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  if (lines.length < 2) return;
                  e.preventDefault();
                  const [first, ...rest] = lines;
                  setOptions((list) => list.map((x) => (x.id === o.id ? { ...x, label: (x.label + first).slice(0, 500) } : x)));
                  addAfter(i, rest.slice(0, 100 - c.options.length));
                }}
              />
              {kind !== "dropdown" && !o.image_asset_id && (
                <button type="button" className={iconBtnCls} aria-label={`Add a picture to option ${i + 1}`} title="Add picture" onClick={() => p.onPickOptionImage(o.id)}>
                  <ImagePlus className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                className={iconBtnCls}
                aria-label={`Remove option ${i + 1}`}
                title="Remove"
                disabled={c.options.length <= 1}
                onClick={() => setOptions((list) => list.filter((x) => x.id !== o.id))}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {(p.limitsShown || branching) && (
              <div className="flex flex-wrap items-center gap-2 pl-6 sm:pl-0">
                {p.limitsShown && (
                  <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                    Places
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={100000}
                      placeholder="Any"
                      aria-label={`Places for option ${i + 1}`}
                      className={cn(fieldCls, "h-10 w-20")}
                      value={o.limit ?? ""}
                      onChange={(e) => {
                        const n = Math.round(Number(e.target.value));
                        setOptions((list) => list.map((x) => (x.id === o.id ? { ...x, limit: e.target.value && n >= 1 ? Math.min(n, 100000) : null } : x)), `${o.id}:limit`);
                      }}
                    />
                  </label>
                )}
                {branching && (
                  <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                    <span className="sr-only">After option {i + 1}</span>
                    <select
                      className={cn(fieldCls, "h-10 max-w-[15rem]")}
                      value={o.go_to ?? ""}
                      onChange={(e) => setOptions((list) => list.map((x) => (x.id === o.id ? { ...x, go_to: e.target.value || null } : x)))}
                    >
                      {targets.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                      {o.go_to && !targets.some((t) => t.value === o.go_to) && (
                        <option value={o.go_to}>An earlier section (ends the form)</option>
                      )}
                    </select>
                  </label>
                )}
              </div>
            )}
          </li>
        ))}
        {other && (
          <li className="flex items-center gap-2">
            <Marker i={c.options.length} />
            <span className={cn(fieldCls, "flex h-10 flex-1 items-center italic text-[var(--text-muted)]")}>Other…</span>
            <button type="button" className={iconBtnCls} aria-label="Remove “Other”" onClick={() => setConfig((x: MultipleChoiceConfig) => ({ ...x, other: false }))}>
              <X className="h-4 w-4" />
            </button>
          </li>
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-x-1 text-sm">
        <button
          type="button"
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-2 font-medium text-[var(--accent-text)] hover:bg-[var(--hover)] disabled:opacity-40"
          disabled={c.options.length >= 100}
          onClick={() => addAfter(c.options.length - 1)}
        >
          <Plus className="h-4 w-4" /> Add option
        </button>
        <SuggestOptions
          fileId={p.fileId}
          question={item.title}
          existing={c.options.map((o) => o.label)}
          room={100 - c.options.length}
          onAdd={(labels) => {
            // Blank "Option 1"s the form started with make way for the suggestions.
            setOptions((list) => {
              const kept = list.filter((o) => !/^Option \d+$/.test(o.label) || o.limit || o.image_asset_id);
              return [...kept, ...labels.map((l) => newOption(l))].slice(0, 100);
            });
          }}
        />
        {kind !== "dropdown" && !other && (
          <>
            <span className="text-[var(--text-muted)]">or</span>
            <button
              type="button"
              className="min-h-[40px] rounded-md px-2 font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]"
              onClick={() => setConfig((x: MultipleChoiceConfig) => ({ ...x, other: true }))}
            >
              add “Other”
            </button>
          </>
        )}
      </div>
      {p.limitsShown && (
        <p className="text-xs text-[var(--text-muted)]">
          When an option&apos;s places are taken it disappears from the form. Leave a box empty for no limit.
        </p>
      )}
      {kind === "checkboxes" && p.validationShown && (
        <div className="flex flex-wrap gap-2 rounded-md bg-[var(--hover)]/60 p-3">
          <NumberBox className="w-28" label="Tick at least" value={(c as CheckboxesConfig).min_selected} min={1} max={100} onChange={(n) => setConfig((x: CheckboxesConfig) => ({ ...x, min_selected: n ? Math.round(n) : null }), `${item.id}:cmin`)} />
          <NumberBox className="w-28" label="Tick at most" value={(c as CheckboxesConfig).max_selected} min={1} max={100} onChange={(n) => setConfig((x: CheckboxesConfig) => ({ ...x, max_selected: n ? Math.round(n) : null }), `${item.id}:cmax`)} />
        </div>
      )}
    </div>
  );
}

