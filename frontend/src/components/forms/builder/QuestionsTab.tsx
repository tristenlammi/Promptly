import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FileInput, Heading, Image as ImageIcon, Palette, Plus, SeparatorHorizontal, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { FormDefinition, FormItem, ItemKind } from "@/api/forms";
import { useIsMobile } from "@/hooks/useIsMobile";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { FormHeader } from "../FormRenderer";
import { duplicateItem, isQuestion, liveItems, newItem, sectionsOf, type SectionInfo } from "../model";
import { themeVars } from "../theme";
import { ImportQuestions } from "./ImportQuestions";
import { ItemCard, goToChoices } from "./ItemCard";
import { MakeWithAi } from "./MakeWithAi";
import { PicturePicker } from "./PicturePicker";
import { AutoTextarea, fieldCls } from "./ui";
import type { FormDoc } from "./useFormDoc";

/**
 * The Questions tab: the title card, then one card per question, block and
 * section, on the form's own colour. Drag a card by its handle (long-press
 * on a phone, or Space and the arrow keys), or use Move up / Move down in
 * its "…" menu. The add bar floats beside the cards on a computer and sits
 * along the bottom on a phone.
 */
export function QuestionsTab({
  doc,
  fileId,
  readOnly,
  onOpenLook,
  aside,
}: {
  doc: FormDoc;
  fileId: string;
  readOnly: boolean;
  onOpenLook: () => void;
  /** The preview pane, beside the cards on a computer. */
  aside?: ReactNode;
}) {
  const { def } = doc;
  const isPhone = useIsMobile();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pickImage, setPickImage] = useState(false);
  const [importing, setImporting] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const live = useMemo(() => liveItems(def), [def]);
  const sections = useMemo(() => sectionsOf(def), [def]);
  const sectionOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sections) {
      if (s.item) m.set(s.item.id, s.index);
      for (const it of s.items) m.set(it.id, s.index);
    }
    return m;
  }, [sections]);
  const invalidId = doc.status.kind === "invalid" ? doc.status.itemId : null;

  // The save's complaint points at an item: open it.
  useEffect(() => {
    if (invalidId) setActiveId(invalidId);
  }, [invalidId]);

  // Undo with Ctrl/Cmd+Z when not typing (fields keep their own undo).
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || t.isContentEditable)) return;
      e.preventDefault();
      doc.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, readOnly]);

  const setItems = (fn: (items: FormItem[]) => FormItem[]) => doc.update((d) => ({ ...d, items: fn(d.items) }));
  /** Reorder the live items; deleted (answered) ones keep their place at the end. */
  const setLiveOrder = (order: FormItem[]) =>
    doc.update((d) => ({ ...d, items: [...order.map((o) => d.items.find((x) => x.id === o.id) ?? o), ...d.items.filter((x) => x.deleted)] }));

  const insert = (made: FormItem) => {
    setItems((items) => {
      const at = activeId ? items.findIndex((x) => x.id === activeId) : -1;
      if (at < 0) return [...items.filter((x) => !x.deleted), made, ...items.filter((x) => x.deleted)];
      return [...items.slice(0, at + 1), made, ...items.slice(at + 1)];
    });
    setActiveId(made.id);
    window.setTimeout(() => document.querySelector(`[data-item="${made.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
  };
  const add = (kind: ItemKind) => {
    if (live.length >= 200) {
      toast.error("A form can have at most 200 questions and blocks.");
      return;
    }
    if (kind === "section" && sections.length >= 50) {
      toast.error("A form can have at most 50 sections.");
      return;
    }
    insert(newItem(kind));
  };

  const remove = (item: FormItem) => {
    const at = def.items.findIndex((x) => x.id === item.id);
    setItems((items) => items.filter((x) => x.id !== item.id));
    if (activeId === item.id) setActiveId(null);
    const what = isQuestion(item) ? "Question" : item.kind === "section" ? "Section" : item.kind === "image" ? "Picture" : "Text";
    toast.info(`${what} deleted`, {
      action: {
        label: "Undo",
        onClick: () =>
          doc.update((d) => {
            if (d.items.some((x) => x.id === item.id && !x.deleted)) return d;
            const items = d.items.filter((x) => x.id !== item.id);
            items.splice(Math.min(at, items.length), 0, item);
            return { ...d, items };
          }),
      },
    });
  };
  const duplicate = (item: FormItem) => {
    const copy = duplicateItem(item);
    setItems((items) => {
      const at = items.findIndex((x) => x.id === item.id);
      return [...items.slice(0, at + 1), copy, ...items.slice(at + 1)];
    });
    setActiveId(copy.id);
  };
  const move = (item: FormItem, delta: -1 | 1) => {
    const i = live.findIndex((x) => x.id === item.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= live.length) return;
    setLiveOrder(arrayMove(live, i, j));
    window.setTimeout(() => {
      const el = document.querySelector(`[data-item="${item.id}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const titleOf = (id: string | number) => {
    const it = live.find((x) => x.id === id);
    return it ? `“${it.title || "untitled"}”` : "the item";
  };
  const posOf = (id: string | number) => live.findIndex((x) => x.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}, position ${posOf(active.id)} of ${live.length}.`,
    onDragOver: ({ active, over }) => (over ? `${titleOf(active.id)} is now at position ${posOf(over.id)} of ${live.length}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `Dropped ${titleOf(active.id)} at position ${posOf(over.id)} of ${live.length}.` : `Dropped ${titleOf(active.id)}.`),
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id)} was cancelled.`,
  };
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const i = live.findIndex((x) => x.id === active.id);
    const j = live.findIndex((x) => x.id === over.id);
    if (i < 0 || j < 0) return;
    setLiveOrder(arrayMove(live, i, j));
  };

  // Footers ("After section N") go just before the next section's card,
  // and at the very end for the last section.
  const multi = sections.length > 1;
  const footer = (s: SectionInfo) =>
    multi && !readOnly ? (
      <SectionAfter
        key={`after-${s.index}`}
        section={s}
        sections={sections}
        onChange={(v) =>
          doc.update((d) =>
            s.index === 0
              ? { ...d, after: v }
              : { ...d, items: d.items.map((x) => (x.id === s.id ? { ...x, config: { ...(x.config as object), after: v } } : x)) as FormItem[] }
          )
        }
      />
    ) : null;

  const rows: ReactNode[] = [];
  live.forEach((item) => {
    const si = sectionOf.get(item.id) ?? 0;
    if (item.kind === "section" && si > 0) rows.push(footer(sections[si - 1]));
    rows.push(
      <SortableItem
        key={item.id}
        item={item}
        disabled={readOnly}
        render={(sortable) => (
          <ItemCard
            ref={sortable.setNodeRef}
            style={sortable.style}
            dragging={sortable.isDragging}
            handle={sortable.handle}
            item={item}
            sectionIndex={si}
            sections={sections}
            active={activeId === item.id}
            onActivate={() => setActiveId(item.id)}
            onChange={(fn, coalesce) =>
              doc.update((d) => ({ ...d, items: d.items.map((x) => (x.id === item.id ? fn(x) : x)) }), { coalesce })
            }
            onDuplicate={() => duplicate(item)}
            onDelete={() => remove(item)}
            onMove={(delta) => move(item, delta)}
            canMoveUp={live[0]?.id !== item.id}
            canMoveDown={live[live.length - 1]?.id !== item.id}
            fileId={fileId}
            assetUrls={doc.assetUrls}
            addAssetUrl={doc.addAssetUrl}
            error={invalidId === item.id && doc.status.kind === "invalid" ? doc.status.message : null}
            readOnly={readOnly}
          />
        )}
      />
    );
  });
  if (multi) rows.push(footer(sections[sections.length - 1]));

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="pf-theme promptly-scroll min-h-0 flex-1 overflow-y-auto"
        data-scheme="app"
        style={themeVars(def.theme.accent, def.theme.font)}
      >
        <div className={cn("mx-auto flex w-full max-w-3xl gap-3 px-3 pt-4 sm:px-4", isPhone ? "pb-28" : "pb-16")}>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {multi && (
              <span className="-mb-2 self-start rounded-t-lg px-3 py-1 text-xs font-semibold" style={{ background: "var(--pf-accent)", color: "var(--pf-on-accent)" }}>
                Section 1 of {sections.length}
              </span>
            )}
            <TitleCard def={def} doc={doc} readOnly={readOnly} onOpenLook={onOpenLook} onFocus={() => setActiveId(null)} />
            {doc.status.kind === "invalid" && !invalidId && (
              <p role="alert" className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {doc.status.message}
              </p>
            )}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements }}>
              <SortableContext items={live.map((x) => x.id)} strategy={verticalListSortingStrategy}>
                {rows}
              </SortableContext>
            </DndContext>
            {live.length === 0 && !readOnly && (
              <div className="pf-card flex flex-col items-center gap-3 px-4 py-8 text-center">
                <p className="text-sm" style={{ color: "var(--pf-muted)" }}>
                  No questions yet. Add your first one, or describe your form and let AI suggest some.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => add("multiple_choice")}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-full px-5 text-sm font-semibold"
                    style={{ background: "var(--pf-accent)", color: "var(--pf-on-accent)" }}
                  >
                    <Plus className="h-4 w-4" /> Add question
                  </button>
                  <button
                    type="button"
                    onClick={() => setAiOpen(true)}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-full border px-5 text-sm font-semibold"
                    style={{ borderColor: "var(--pf-border)" }}
                  >
                    <Sparkles className="h-4 w-4" /> Describe your form
                  </button>
                </div>
              </div>
            )}
          </div>
          {!readOnly && !isPhone && (
            <div className="sticky top-4 hidden self-start md:block">
              <AddBar onAdd={add} onAddImage={() => setPickImage(true)} onImport={() => setImporting(true)} onAi={() => setAiOpen(true)} vertical />
            </div>
          )}
        </div>
      </div>
      {aside}
      {!readOnly && isPhone && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface)] pb-safe">
          <AddBar onAdd={add} onAddImage={() => setPickImage(true)} onImport={() => setImporting(true)} onAi={() => setAiOpen(true)} />
        </div>
      )}
      {pickImage && (
        <PicturePicker
          open
          onClose={() => setPickImage(false)}
          fileId={fileId}
          onPicked={(a) => {
            doc.addAssetUrl(a.id, a.url);
            insert({ ...newItem("image"), image_asset_id: a.id });
          }}
        />
      )}
      {aiOpen && (
        <MakeWithAi
          fileId={fileId}
          open
          onClose={() => setAiOpen(false)}
          untitled={!def.title.trim() || /^untitled form$/i.test(def.title.trim())}
          onTitle={(title, description) =>
            doc.update((d) => ({ ...d, title: title.slice(0, 300), description: d.description || description }))
          }
          onAdd={(items) => {
            if (live.length + items.length > 200) {
              toast.error("That would make more than 200 questions and blocks.");
              return false;
            }
            setItems((all) => {
              const at = activeId ? all.findIndex((x) => x.id === activeId) : -1;
              if (at < 0) return [...all.filter((x) => !x.deleted), ...items, ...all.filter((x) => x.deleted)];
              return [...all.slice(0, at + 1), ...items, ...all.slice(at + 1)];
            });
            toast.success(items.length === 1 ? "Added 1 question" : `Added ${items.length}`);
            return true;
          }}
        />
      )}
      {importing && (
        <ImportQuestions
          fileId={fileId}
          onClose={() => setImporting(false)}
          onImport={(items) => {
            if (live.length + items.length > 200) {
              toast.error("That would make more than 200 questions and blocks.");
              return;
            }
            setItems((all) => {
              const at = activeId ? all.findIndex((x) => x.id === activeId) : -1;
              if (at < 0) return [...all.filter((x) => !x.deleted), ...items, ...all.filter((x) => x.deleted)];
              return [...all.slice(0, at + 1), ...items, ...all.slice(at + 1)];
            });
            toast.success(`Added ${items.length} question${items.length === 1 ? "" : "s"}`);
          }}
        />
      )}
    </div>
  );
}

function SortableItem({
  item,
  disabled,
  render,
}: {
  item: FormItem;
  disabled: boolean;
  render: (s: {
    setNodeRef: (el: HTMLDivElement | null) => void;
    style: React.CSSProperties;
    isDragging: boolean;
    handle: { attributes: ReturnType<typeof useSortable>["attributes"]; listeners: ReturnType<typeof useSortable>["listeners"]; setActivatorNodeRef: (el: HTMLElement | null) => void };
  }) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  return (
    <>
      {render({
        setNodeRef,
        style: { transform: CSS.Translate.toString(transform), transition },
        isDragging,
        handle: { attributes, listeners, setActivatorNodeRef },
      })}
    </>
  );
}

function TitleCard({
  def,
  doc,
  readOnly,
  onOpenLook,
  onFocus,
}: {
  def: FormDefinition;
  doc: FormDoc;
  readOnly: boolean;
  onOpenLook: () => void;
  onFocus: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="group relative">
        <FormHeader definition={def} assetUrls={doc.assetUrls} />
        {!readOnly && (
          <button
            type="button"
            onClick={onOpenLook}
            className="absolute bottom-2 right-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-black/55 px-3 text-xs font-medium text-white hover:bg-black/70"
          >
            <Palette className="h-3.5 w-3.5" /> Change the look
          </button>
        )}
      </div>
      <div className="pf-card overflow-hidden" onFocus={onFocus}>
        <div className="h-2" style={{ background: "var(--pf-accent)" }} />
        <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">
          {readOnly ? (
            <>
              <h2 className="text-2xl font-semibold [overflow-wrap:anywhere]">{def.title || "Untitled form"}</h2>
              {def.description && <p className="whitespace-pre-line text-[15px]">{def.description}</p>}
            </>
          ) : (
            <>
              <AutoTextarea
                aria-label="Form title"
                placeholder="Form title"
                value={def.title}
                maxLength={300}
                onChange={(e) => doc.update((d) => ({ ...d, title: e.target.value.replace(/\n/g, " ") }), { coalesce: "form:title" })}
                className={cn(fieldCls, "border-transparent bg-transparent px-1 text-2xl font-semibold hover:border-[var(--border)]")}
              />
              <AutoTextarea
                aria-label="Form description"
                placeholder="Description (optional). Links people can click and line breaks are kept."
                value={def.description}
                maxLength={5000}
                onChange={(e) => doc.update((d) => ({ ...d, description: e.target.value }), { coalesce: "form:desc" })}
                className={cn(fieldCls, "border-transparent bg-transparent px-1 text-[15px] hover:border-[var(--border)]")}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionAfter({ section, sections, onChange }: { section: SectionInfo; sections: SectionInfo[]; onChange: (v: string) => void }) {
  const last = section.index === sections.length - 1;
  const choices = goToChoices(sections, section.index).map((c) =>
    c.value === "" ? { value: "continue", label: last ? "Submit form (it's the last section)" : "Continue to the next section" } : c
  );
  const value = section.after || "continue";
  return (
    <label className="flex flex-col gap-1 px-1 text-sm sm:flex-row sm:items-center sm:gap-2">
      <span style={{ color: "var(--pf-muted)" }}>After section {section.index + 1}</span>
      <select className={cn(fieldCls, "h-10 sm:w-auto")} value={value} onChange={(e) => onChange(e.target.value)}>
        {choices
          .filter((c) => !(last && c.value === "submit"))
          .map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        {!choices.some((c) => c.value === value) && <option value={value}>An earlier section (ends the form)</option>}
      </select>
    </label>
  );
}

function AddBar({
  onAdd,
  onAddImage,
  onImport,
  onAi,
  vertical,
}: {
  onAdd: (kind: ItemKind) => void;
  onAddImage: () => void;
  onImport: () => void;
  onAi: () => void;
  vertical?: boolean;
}) {
  const actions = [
    { label: "Add question", icon: Plus, onClick: () => onAdd("multiple_choice") },
    { label: "Add title & text", icon: Heading, onClick: () => onAdd("text") },
    { label: "Add image", icon: ImageIcon, onClick: onAddImage },
    { label: "Add section", icon: SeparatorHorizontal, onClick: () => onAdd("section") },
    { label: "Import questions", icon: FileInput, onClick: onImport },
    { label: "Make with AI", icon: Sparkles, onClick: onAi },
  ];
  return (
    <div
      role="toolbar"
      aria-label="Add to the form"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={cn(
        "flex",
        vertical
          ? "flex-col gap-1 rounded-card border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-md)]"
          : "items-stretch justify-around px-1 py-1"
      )}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={a.onClick}
          title={a.label}
          aria-label={a.label}
          className={cn(
            "flex items-center justify-center rounded-md text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            vertical ? "h-10 w-10" : "min-h-[52px] flex-1 flex-col gap-0.5 text-[11px] text-[var(--text-muted)]"
          )}
        >
          <a.icon className="h-5 w-5" aria-hidden="true" />
          {!vertical && <span aria-hidden="true">{a.label.replace(/^Add /, "").replace("Import questions", "Import").replace("Make with AI", "AI").replace("title & text", "Text").replace(/^\w/, (c) => c.toUpperCase())}</span>}
        </button>
      ))}
    </div>
  );
}
