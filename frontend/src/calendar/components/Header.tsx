import { Check, ChevronDown, ChevronLeft, ChevronRight, Menu, PenLine, Plus, Search } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ItemButton, Segmented } from "@/items/ui";
import { cn } from "@/utils/cn";

import type { View } from "../model";
import { Popover } from "./ui";

const VIEWS: { value: View; label: string; key: string }[] = [
  { value: "day", label: "Day", key: "d" },
  { value: "week", label: "Week", key: "w" },
  { value: "month", label: "Month", key: "m" },
  { value: "agenda", label: "Schedule", key: "a" },
];

const MENU_W = 216;

export function Header({
  title,
  view,
  onView,
  onPrev,
  onNext,
  onToday,
  onNew,
  onMenu,
  showMenu,
  isPhone,
  onSearch,
  searchOpen,
  quickAdd,
  onQuickAdd,
  weekLabel = "Week",
}: {
  title: string;
  view: View;
  onView: (v: View) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onNew: () => void;
  onMenu: () => void;
  showMenu: boolean;
  isPhone: boolean;
  onSearch: () => void;
  searchOpen: boolean;
  /** Desktop: the quick-add box (shown when there's room). */
  quickAdd?: ReactNode;
  /** Quick add in a sheet (when the box doesn't fit). */
  onQuickAdd: () => void;
  /** What "week" is called here (a phone shows three days). */
  weekLabel?: string;
}) {
  const navBtn = "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]";
  // Phone: the view switch's menu (views, search, and stepping without a swipe).
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const label = (v: View) => (v === "week" ? weekLabel : VIEWS.find((x) => x.value === v)!.label);

  if (isPhone) {
    const tap = "flex h-10 shrink-0 items-center justify-center rounded-full text-[var(--text)] hover:bg-[var(--hover)] active:bg-[var(--hover)]";
    const row = "flex h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] active:bg-[var(--hover)]";
    const pick = (fn: () => void) => () => {
      setMenu(null);
      fn();
    };
    return (
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--bg)] px-2">
        <button type="button" aria-label="Calendars" onClick={onMenu} className={cn(tap, "w-10 text-[var(--text-muted)]")}>
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate pl-1 text-base font-semibold text-[var(--text)]">{title}</h1>
        <button type="button" onClick={onToday} className={cn(tap, "px-3 text-sm font-medium")}>
          Today
        </button>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          aria-label={`View: ${label(view)}`}
          data-cal-keep-popover
          onClick={(e) => {
            if (menu) return setMenu(null);
            const r = e.currentTarget.getBoundingClientRect();
            // The popover sits beside its anchor: hand it a point that lands it under the button.
            setMenu(new DOMRect(r.right - MENU_W - 8, r.bottom + 12, 0, 0));
          }}
          className={cn(tap, "gap-1 border border-[var(--border)] bg-[var(--surface)] pl-3 pr-2 text-sm font-medium")}
        >
          {label(view)}
          <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
        </button>
        {menu && (
          <Popover anchor={menu} onClose={() => setMenu(null)} width={MENU_W}>
            <div role="menu" aria-label="View" className="p-1.5">
              {VIEWS.map((v) => (
                <button key={v.value} type="button" role="menuitemradio" aria-checked={v.value === view} onClick={pick(() => onView(v.value))} className={row}>
                  <span className="min-w-0 flex-1 truncate">{label(v.value)}</span>
                  {v.value === view && <Check className="h-4 w-4 text-[var(--item-accent)]" />}
                </button>
              ))}
              <div className="my-1.5 border-t border-[var(--border)]" />
              <button type="button" role="menuitem" onClick={pick(onSearch)} className={row}>
                <Search className="h-4 w-4 text-[var(--text-muted)]" />
                Search events
              </button>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5 border-t border-[var(--border)] pt-1.5">
                <button type="button" role="menuitem" onClick={onPrev} className={cn(row, "justify-center")}>
                  <ChevronLeft className="h-4 w-4 text-[var(--text-muted)]" />
                  Earlier
                </button>
                <button type="button" role="menuitem" onClick={onNext} className={cn(row, "justify-center")}>
                  Later
                  <ChevronRight className="h-4 w-4 text-[var(--text-muted)]" />
                </button>
              </div>
            </div>
          </Popover>
        )}
      </header>
    );
  }
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-4">
      {showMenu && (
        <button type="button" aria-label="Calendars" onClick={onMenu} className={navBtn}>
          <Menu className="h-5 w-5" />
        </button>
      )}
      <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={onNew} title="New event (c)">
        New event
      </ItemButton>
      <ItemButton onClick={onToday} title="Today (t)" className="ml-2">
        Today
      </ItemButton>
      <div className="flex">
        <button type="button" aria-label="Previous" title="Previous (← or p)" onClick={onPrev} className={navBtn}>
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button type="button" aria-label="Next" title="Next (→ or n)" onClick={onNext} className={navBtn}>
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-[var(--text)]">{title}</h1>
      {quickAdd && <div className="hidden w-72 shrink 2xl:block min-[1800px]:w-96">{quickAdd}</div>}
      {/* When the box doesn't fit: a plainly labelled button (just the pen where it's tight). */}
      <ItemButton icon={<PenLine className="h-4 w-4" />} onClick={onQuickAdd} title="Type it in one line, like “Lunch with Sam tomorrow 1pm” (q)" className="!hidden xl:!inline-flex 2xl:!hidden">
        Quick add
      </ItemButton>
      <button type="button" aria-label="Quick add" title="Quick add (q)" onClick={onQuickAdd} className={`${navBtn} xl:hidden`}>
        <PenLine className="h-[18px] w-[18px]" />
      </button>
      <button
        type="button"
        aria-label="Search"
        title="Search (/)"
        aria-expanded={searchOpen}
        data-cal-search-toggle
        onClick={onSearch}
        className={`${navBtn} ${searchOpen ? "bg-[var(--hover)] text-[var(--text)]" : ""}`}
      >
        <Search className="h-[18px] w-[18px]" />
      </button>
      <Segmented
        value={view}
        onChange={onView}
        options={VIEWS.map((v) => ({ value: v.value, label: <span title={`${v.label} (${v.key})`}>{v.label}</span> }))}
      />
    </header>
  );
}
