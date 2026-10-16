import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ChevronDown,
  RemoveFormatting,
  Sigma,
  Subscript as SubIcon,
  Superscript as SupIcon,
} from "lucide-react";

import { cn } from "@/utils/cn";

import { EDIT_MATH_EVENT } from "./extensions";
import { PromptPopover } from "./PromptPopover";

/**
 * The toolbar controls WP-4.5 adds (R-226 / §3.8): font family and size,
 * paragraph alignment, sub/superscript, clear formatting, and LaTeX maths
 * (insert + click-to-edit). Each is an ``editor.chain()`` command.
 */
export const FONT_FAMILIES: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Sans serif", value: "Arial, Helvetica, sans-serif" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Monospace", value: "'Courier New', Courier, monospace" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Trebuchet", value: "'Trebuchet MS', sans-serif" },
];
export const FONT_SIZES = ["8pt", "9pt", "10pt", "11pt", "12pt", "14pt", "16pt", "18pt", "24pt", "30pt", "36pt", "48pt"];

export function useAnchoredMenu() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return {
    anchor,
    toggle: (e: React.MouseEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setAnchor((a) => (a ? null : rect));
    },
    close: () => setAnchor(null),
  };
}

export function Menu({
  anchor,
  label,
  onClose,
  children,
  width = 180,
}: {
  anchor: DOMRect;
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return createPortal(
    <>
      <div className="fixed inset-0 z-[75]" onMouseDown={onClose} />
      <div
        data-esc-layer
        role="menu"
        aria-label={label}
        style={{
          position: "fixed",
          top: Math.min(anchor.bottom + 4, window.innerHeight - 320),
          left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
          width,
          zIndex: 76,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="promptly-scroll max-h-80 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl"
      >
        {children}
      </div>
    </>,
    document.body
  );
}

export function MenuItem({
  active,
  onClick,
  children,
  style,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={!!active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={style}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-[var(--hover)]",
        active ? "text-[var(--accent-text)]" : "text-[var(--text)]"
      )}
    >
      {children}
    </button>
  );
}

const triggerCls =
  "inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-[var(--muted)] transition hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10";

export function FontControls({ editor }: { editor: Editor | null }) {
  const family = useAnchoredMenu();
  const size = useAnchoredMenu();
  const attrs = editor?.getAttributes("textStyle") ?? {};
  const currentFamily = FONT_FAMILIES.find((f) => f.value && f.value === attrs.fontFamily)?.label ?? "Default";
  const currentSize = (attrs.fontSize as string | undefined) ?? "";
  return (
    <>
      <button
        type="button"
        title="Font"
        aria-label="Font"
        aria-haspopup="menu"
        onMouseDown={(e) => e.preventDefault()}
        onClick={family.toggle}
        className={cn(triggerCls, "w-[6.5rem] justify-between")}
      >
        <span className="truncate">{currentFamily}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      <button
        type="button"
        title="Font size"
        aria-label="Font size"
        aria-haspopup="menu"
        onMouseDown={(e) => e.preventDefault()}
        onClick={size.toggle}
        className={cn(triggerCls, "w-[3.75rem] justify-between")}
      >
        <span className="tabular-nums">{currentSize ? currentSize.replace("pt", "") : "Size"}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {family.anchor && editor && (
        <Menu anchor={family.anchor} label="Font" onClose={family.close}>
          {FONT_FAMILIES.map((f) => (
            <MenuItem
              key={f.label}
              active={currentFamily === f.label}
              style={f.value ? { fontFamily: f.value } : undefined}
              onClick={() => {
                if (f.value) editor.chain().focus().setFontFamily(f.value).run();
                else editor.chain().focus().unsetFontFamily().run();
                family.close();
              }}
            >
              {f.label}
            </MenuItem>
          ))}
        </Menu>
      )}
      {size.anchor && editor && (
        <Menu anchor={size.anchor} label="Font size" onClose={size.close} width={110}>
          <MenuItem
            active={!currentSize}
            onClick={() => {
              editor.chain().focus().unsetFontSize().run();
              size.close();
            }}
          >
            Default
          </MenuItem>
          {FONT_SIZES.map((s) => (
            <MenuItem
              key={s}
              active={currentSize === s}
              onClick={() => {
                editor.chain().focus().setFontSize(s).run();
                size.close();
              }}
            >
              {s.replace("pt", "")}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}

const BLOCK_STYLES = [
  { label: "Normal text", level: 0, cls: "text-sm" },
  { label: "Heading 1", level: 1, cls: "text-xl font-bold" },
  { label: "Heading 2", level: 2, cls: "text-lg font-semibold" },
  { label: "Heading 3", level: 3, cls: "text-base font-semibold" },
] as const;

/** "Normal text / Heading 1–3" — one menu instead of four buttons, as in
 *  Docs and Word (keeps the toolbar to one row). */
export function BlockStyleControl({ editor }: { editor: Editor | null }) {
  const menu = useAnchoredMenu();
  const current =
    BLOCK_STYLES.find((b) => b.level > 0 && editor?.isActive("heading", { level: b.level })) ?? BLOCK_STYLES[0];
  return (
    <>
      <button
        type="button"
        title="Text style"
        aria-label="Text style"
        aria-haspopup="menu"
        onMouseDown={(e) => e.preventDefault()}
        onClick={menu.toggle}
        className={cn(triggerCls, "w-[6.75rem] justify-between")}
      >
        <span className="truncate">{current.label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {menu.anchor && editor && (
        <Menu anchor={menu.anchor} label="Text style" onClose={menu.close} width={190}>
          {BLOCK_STYLES.map((b) => (
            <MenuItem
              key={b.label}
              active={current.label === b.label}
              onClick={() => {
                if (b.level === 0) editor.chain().focus().setParagraph().run();
                else editor.chain().focus().setHeading({ level: b.level }).run();
                menu.close();
              }}
            >
              <span className={b.cls}>{b.label}</span>
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}

const ALIGNMENTS = [
  { value: "left", label: "Align left", Icon: AlignLeft },
  { value: "center", label: "Centre", Icon: AlignCenter },
  { value: "right", label: "Align right", Icon: AlignRight },
  { value: "justify", label: "Justify", Icon: AlignJustify },
] as const;

export function AlignControl({ editor }: { editor: Editor | null }) {
  const menu = useAnchoredMenu();
  const current = ALIGNMENTS.find((a) => editor?.isActive({ textAlign: a.value })) ?? ALIGNMENTS[0];
  const Icon = current.Icon;
  return (
    <>
      <button
        type="button"
        title="Alignment"
        aria-label="Alignment"
        aria-haspopup="menu"
        onMouseDown={(e) => e.preventDefault()}
        onClick={menu.toggle}
        className={triggerCls}
      >
        <Icon className="h-4 w-4" />
        <ChevronDown className="h-3 w-3" />
      </button>
      {menu.anchor && editor && (
        <Menu anchor={menu.anchor} label="Alignment" onClose={menu.close} width={160}>
          {ALIGNMENTS.map((a) => (
            <MenuItem
              key={a.value}
              active={current.value === a.value}
              onClick={() => {
                if (a.value === "left") editor.chain().focus().unsetTextAlign().run();
                else editor.chain().focus().setTextAlign(a.value).run();
                menu.close();
              }}
            >
              <a.Icon className="h-4 w-4" />
              {a.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}

const iconBtn = (active?: boolean) =>
  cn(
    "inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted)] transition hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10",
    active && "bg-black/10 text-[var(--text)] dark:bg-white/15"
  );

export function ScriptControls({ editor }: { editor: Editor | null }) {
  return (
    <>
      <button
        type="button"
        title="Subscript"
        aria-label="Subscript"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().toggleSubscript().run()}
        className={iconBtn(editor?.isActive("subscript"))}
      >
        <SubIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="Superscript"
        aria-label="Superscript"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().toggleSuperscript().run()}
        className={iconBtn(editor?.isActive("superscript"))}
      >
        <SupIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="Clear formatting"
        aria-label="Clear formatting"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().unsetAllMarks().unsetTextAlign().run()}
        className={iconBtn()}
      >
        <RemoveFormatting className="h-4 w-4" />
      </button>
    </>
  );
}

/** Insert maths (inline / block), and edit an existing formula when it's
 *  clicked (the Mathematics extension fires ``EDIT_MATH_EVENT``). */
export function MathControl({ editor, hideButton = false }: { editor: Editor | null; hideButton?: boolean }) {
  const menu = useAnchoredMenu();
  const [prompt, setPrompt] = useState<
    { anchor: DOMRect; kind: "inline" | "block"; pos?: number; latex: string } | null
  >(null);

  useEffect(() => {
    if (!editor) return;
    const onEdit = (e: Event) => {
      if (!editor.isEditable) return;
      const d = (e as CustomEvent<{ kind: "inline" | "block"; pos?: number; latex?: string }>).detail;
      // No position: the "/" menu asking to insert a new formula.
      const dom = d.pos != null ? (editor.view.nodeDOM(d.pos) as HTMLElement | null) : null;
      const anchor = dom?.getBoundingClientRect?.() ?? new DOMRect(window.innerWidth / 2 - 190, 140, 0, 0);
      setPrompt({ anchor, kind: d.kind, pos: d.pos, latex: d.latex ?? "" });
    };
    document.addEventListener(EDIT_MATH_EVENT, onEdit);
    return () => document.removeEventListener(EDIT_MATH_EVENT, onEdit);
  }, [editor]);

  const apply = (latex: string) => {
    if (!editor || !prompt) return;
    const v = latex.trim();
    const c = editor.chain().focus();
    if (prompt.pos != null) {
      if (!v) {
        if (prompt.kind === "inline") c.deleteInlineMath({ pos: prompt.pos }).run();
        else c.deleteBlockMath({ pos: prompt.pos }).run();
      } else if (prompt.kind === "inline") c.updateInlineMath({ latex: v, pos: prompt.pos }).run();
      else c.updateBlockMath({ latex: v, pos: prompt.pos }).run();
      return;
    }
    if (!v) return;
    if (prompt.kind === "inline") c.insertInlineMath({ latex: v }).run();
    else c.insertBlockMath({ latex: v }).run();
  };

  return (
    <>
      {!hideButton && (
      <button
        type="button"
        title="Insert maths"
        aria-label="Insert maths"
        aria-haspopup="menu"
        onMouseDown={(e) => e.preventDefault()}
        onClick={menu.toggle}
        className={iconBtn()}
      >
        <Sigma className="h-4 w-4" />
      </button>
      )}
      {menu.anchor && (
        <Menu anchor={menu.anchor} label="Insert maths" onClose={menu.close}>
          <MenuItem
            onClick={() => {
              setPrompt({ anchor: menu.anchor!, kind: "inline", latex: "" });
              menu.close();
            }}
          >
            Inline formula
          </MenuItem>
          <MenuItem
            onClick={() => {
              setPrompt({ anchor: menu.anchor!, kind: "block", latex: "" });
              menu.close();
            }}
          >
            Formula on its own line
          </MenuItem>
        </Menu>
      )}
      {prompt && (
        <PromptPopover
          anchor={prompt.anchor}
          label="LaTeX formula"
          placeholder={prompt.kind === "inline" ? "e.g. E = mc^2" : "e.g. \\int_0^1 x^2\\,dx"}
          initial={prompt.latex}
          multiline={prompt.kind === "block"}
          hint={prompt.pos != null ? "Clear it to remove the formula." : prompt.kind === "block" ? "Ctrl+Enter to insert." : undefined}
          onSubmit={apply}
          onClose={() => setPrompt(null)}
        />
      )}
    </>
  );
}
