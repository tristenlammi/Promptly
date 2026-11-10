import { Check, MoreHorizontal } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "@/utils/cn";

import { Popover, type PopoverAnchor, type PopoverPlacement } from "./Popover";

/* ----------------------------------------------------------------------
   The shared Menu (UI plan A2). One menu for the whole suite: the "⋯"
   (kebab) menu, right-click menus, sort / filter pickers.

   WHAT YOU GET
   - Arrow Up / Down move (and wrap), Home / End jump, typing a letter jumps
     to the next row starting with it, Enter or Space picks, Escape closes
     (only the menu, not the dialog or sheet under it), Tab closes.
   - Focus goes to the first row on open and back to the trigger on close.
   - Pops in and out (motion set); stays on screen; 40px rows under a
     finger, 36px with a mouse.
   - Dividers, section labels, red "danger" rows, ticks for the chosen row
     of a sort menu, a right-hand hint (a shortcut, a count).

   THREE WAYS TO USE IT

   1. A "⋯" button (most cases):

        <MenuButton
          label="More"                       // aria-label + tooltip text
          items={[
            { label: "Rename", icon: Pencil, onSelect: rename },
            { label: "Share", icon: Share2, onSelect: share },
            { type: "divider" },
            { label: "Delete", icon: Trash2, danger: true, onSelect: remove },
          ]}
        />

      Pass ``children`` for a different trigger face (text, another icon),
      ``className`` to style the trigger, ``placement`` for the side
      (default "bottom-end").

   2. A right-click menu:

        const ctx = useContextMenu<Row>();
        <li onContextMenu={(e) => ctx.open(e, row)}>…</li>
        <Menu {...ctx.menuProps} items={ctx.target ? rowItems(ctx.target) : []} />

      ``ctx.open`` also accepts an element instead of an event, to open the
      same menu from a row's "⋯" button: ``ctx.open(buttonEl, row)``.

   3. Your own trigger (a sort button, a chip):

        const [open, setOpen] = useState(false);
        const btn = useRef<HTMLButtonElement>(null);
        <button ref={btn} aria-haspopup="menu" aria-expanded={open}
                onClick={() => setOpen((o) => !o)}>Sort</button>
        <Menu open={open} onClose={() => setOpen(false)} anchor={btn.current}
              label="Sort by"
              items={[
                { label: "Name", checked: sort === "name", onSelect: () => setSort("name") },
                { label: "Date", checked: sort === "date", onSelect: () => setSort("date") },
              ]} />

   ITEMS
     { label, onSelect }          a row. Optional: icon (a lucide icon or any
                                  component taking className), danger,
                                  disabled, checked (shows a tick; rows
                                  without one line up), hint (right-hand
                                  text), keepOpen (don't close on pick, for
                                  toggles), text (plain text for type-ahead
                                  when label isn't a string), id (React key).
     { type: "divider" }          a line.
     { type: "label", label }     a small section heading.
     false | null | undefined     skipped, so ``canEdit && { … }`` works.
     Leading, trailing and doubled dividers are dropped for you.

   The menu closes first and hands focus back to its trigger, THEN runs
   onSelect, so a dialog opened by the action returns focus to the trigger
   when it closes.
   ---------------------------------------------------------------------- */

export type MenuItem =
  | {
      type?: "item";
      id?: string;
      label: ReactNode;
      /** Plain text for type-ahead when ``label`` isn't a string. */
      text?: string;
      icon?: ComponentType<{ className?: string }>;
      onSelect?: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** Show a tick (sort / view pickers). */
      checked?: boolean;
      /** Right-hand text: a shortcut, a count. */
      hint?: ReactNode;
      /** Keep the menu open after picking (toggles). */
      keepOpen?: boolean;
    }
  | { type: "divider" }
  | { type: "label"; label: ReactNode }
  | false
  | null
  | undefined;

type Row = Exclude<MenuItem, false | null | undefined>;

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** The trigger element, or ``{x, y}`` for a right-click. */
  anchor: PopoverAnchor;
  items: MenuItem[];
  /** Read out by screen readers ("Sort by", "File actions"). */
  label?: string;
  /** Default "bottom-start". */
  placement?: PopoverPlacement;
  /** Extra classes for the panel (e.g. a width). */
  className?: string;
  /** At least as wide as the trigger. */
  matchWidth?: boolean;
}

function tidy(items: MenuItem[]): Row[] {
  const rows: Row[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it.type === "divider" && (rows.length === 0 || rows[rows.length - 1].type === "divider")) continue;
    rows.push(it);
  }
  while (rows.length && rows[rows.length - 1].type === "divider") rows.pop();
  return rows;
}

const isAction = (r: Row): r is Extract<Row, { label: ReactNode; type?: "item" }> => r.type === undefined || r.type === "item";

export function Menu({ open, onClose, anchor, items, label, placement = "bottom-start", className, matchWidth }: MenuProps) {
  const rows = tidy(items);
  const panel = useRef<HTMLDivElement | null>(null);
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  // What had focus before the menu opened (a right-click menu has no
  // trigger element to go back to). Captured in the render that opens it.
  const back = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") back.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  const anyTick = rows.some((r) => isAction(r) && r.checked !== undefined);
  const anyIcon = rows.some((r) => isAction(r) && r.icon);

  const buttons = () => Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? []);

  // Start on the ticked row if there is one, else the first.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const all = buttons();
      (all.find((b) => b.getAttribute("aria-checked") === "true") ?? all[0] ?? panel.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    const all = buttons();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown") next = all[(at + 1) % all.length];
    else if (e.key === "ArrowUp") next = all[(at - 1 + all.length) % all.length];
    else if (e.key === "Home" || e.key === "PageUp") next = all[0];
    else if (e.key === "End" || e.key === "PageDown") next = all[all.length - 1];
    else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: letters typed within a moment of each other build a prefix.
      const now = Date.now();
      const t = typed.current;
      t.text = now - t.at > 600 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
      t.at = now;
      const order = [...all.slice(at + (t.text.length === 1 ? 1 : 0)), ...all.slice(0, at + (t.text.length === 1 ? 1 : 0))];
      next = order.find((b) => (b.dataset.text ?? "").startsWith(t.text));
      if (!next) return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  };

  const pick = (row: Extract<Row, { label: ReactNode; type?: "item" }>) => {
    if (row.disabled) return;
    if (row.keepOpen) {
      row.onSelect?.();
      return;
    }
    // Focus back to the trigger before the action runs, so anything the
    // action opens remembers the trigger (not a row that's about to vanish).
    (anchor instanceof HTMLElement ? anchor : back.current)?.focus?.({ preventScroll: true });
    onClose();
    row.onSelect?.();
  };

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      placement={placement}
      matchWidth={matchWidth}
      role="menu"
      aria-label={label}
      focusOnOpen="panel"
      panelRef={panel}
      className={cn("min-w-[11rem] max-w-[min(20rem,calc(100vw-16px))] py-1", className)}
    >
      <div onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
        {rows.map((row, i) => {
          if (row.type === "divider") return <div key={`d${i}`} role="separator" className="my-1 h-px bg-[var(--border)]" />;
          if (row.type === "label")
            return (
              <div key={`l${i}`} role="presentation" className="px-3 pb-1 pt-2 text-xs font-semibold text-[var(--text-muted)]">
                {row.label}
              </div>
            );
          const Icon = row.icon;
          const text = (row.text ?? (typeof row.label === "string" ? row.label : "")).toLowerCase();
          return (
            <button
              key={row.id ?? `i${i}`}
              type="button"
              role={row.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={row.checked === undefined ? undefined : row.checked}
              disabled={row.disabled}
              data-text={text}
              tabIndex={-1}
              onClick={() => pick(row)}
              onPointerMove={(e) => {
                // The pointer and the keyboard share one highlight.
                if (e.pointerType === "mouse" && document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
              }}
              className={cn(
                "promptly-menu-row flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm outline-none",
                "focus:bg-[var(--hover)] disabled:cursor-default disabled:opacity-40",
                row.danger ? "text-[var(--danger)]" : "text-[var(--text)]",
              )}
            >
              {anyTick && (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--accent)]">
                  {row.checked && <Check className="h-4 w-4" aria-hidden />}
                </span>
              )}
              {anyIcon && (
                <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center", !row.danger && "text-[var(--text-muted)]")}>
                  {Icon && <Icon className="h-4 w-4" />}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.hint !== undefined && <span className="shrink-0 pl-3 text-xs text-[var(--text-muted)]">{row.hint}</span>}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

/**
 * A button that opens a Menu. With no ``children`` it is the standard "⋯"
 * icon button (40px on touch via the global tap-target rule). See the
 * comment at the top of this file.
 */
export function MenuButton({
  label,
  items,
  children,
  className,
  placement = "bottom-end",
  menuClassName,
  disabled,
  onOpenChange,
}: {
  /** Names the button for screen readers, and the menu. */
  label: string;
  items: MenuItem[];
  /** The trigger's face. Default: a "⋯" icon. */
  children?: ReactNode;
  /** Classes for the trigger button (replaces the default look when given). */
  className?: string;
  placement?: PopoverPlacement;
  menuClassName?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <button
        ref={setBtn}
        type="button"
        aria-label={children ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={
          className ??
          cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition",
            "hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-40",
            open && "bg-[var(--hover)] text-[var(--text)]",
          )
        }
      >
        {children ?? <MoreHorizontal className="h-5 w-5" aria-hidden />}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={btn} items={items} label={label} placement={placement} className={menuClassName} />
    </>
  );
}

/**
 * State for a right-click menu shared by many rows. ``open(e, target)``
 * from ``onContextMenu`` (it calls preventDefault for you), or
 * ``open(element, target)`` to hang the same menu off a row's "⋯" button.
 * Spread ``menuProps`` onto one ``<Menu>`` and build its items from
 * ``target``.
 */
export function useContextMenu<T = undefined>() {
  const [state, setState] = useState<{ anchor: PopoverAnchor; target: T; open: boolean } | null>(null);
  const open = useCallback((from: ReactMouseEvent | MouseEvent | HTMLElement, target: T) => {
    if (from instanceof HTMLElement) {
      setState({ anchor: from, target, open: true });
      return;
    }
    from.preventDefault();
    from.stopPropagation();
    setState({ anchor: { x: from.clientX, y: from.clientY }, target, open: true });
  }, []);
  const close = useCallback(() => setState((s) => (s ? { ...s, open: false } : s)), []);
  return {
    open,
    close,
    /** What the menu is for; kept while it animates closed. */
    target: state?.target ?? null,
    isOpen: !!state?.open,
    menuProps: { open: !!state?.open, onClose: close, anchor: state?.anchor ?? null },
  };
}
