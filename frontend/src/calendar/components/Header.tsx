import { ChevronLeft, ChevronRight, Menu, Plus, Search, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { ItemButton, Segmented } from "@/items/ui";

import type { View } from "../model";

const VIEWS: { value: View; label: string; key: string }[] = [
  { value: "day", label: "Day", key: "d" },
  { value: "week", label: "Week", key: "w" },
  { value: "month", label: "Month", key: "m" },
  { value: "agenda", label: "Schedule", key: "a" },
];

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
}) {
  const navBtn = "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]";
  if (isPhone) {
    const today = new Date().getDate();
    return (
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--bg)] px-2">
        <button type="button" aria-label="Calendars" onClick={onMenu} className={navBtn}>
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate pl-1 text-[15px] font-semibold text-[var(--text)]">{title}</h1>
        <button type="button" aria-label="Search" onClick={onSearch} className={navBtn}>
          <Search className="h-5 w-5" />
        </button>
        <button type="button" aria-label="Previous" onClick={onPrev} className={navBtn}>
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button type="button" aria-label="Next" onClick={onNext} className={navBtn}>
          <ChevronRight className="h-5 w-5" />
        </button>
        <button type="button" aria-label="Today" title="Today" onClick={onToday} className={navBtn}>
          <span className="flex h-6 w-6 items-center justify-center rounded-md border-2 border-current text-[10px] font-bold tabular-nums">{today}</span>
        </button>
        <select
          value={view}
          onChange={(e) => onView(e.target.value as View)}
          aria-label="View"
          className="h-9 shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1.5 text-xs font-medium text-[var(--text)]"
        >
          {VIEWS.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
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
        <button type="button" aria-label="Previous" title="Previous (←)" onClick={onPrev} className={navBtn}>
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button type="button" aria-label="Next" title="Next (→)" onClick={onNext} className={navBtn}>
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-[var(--text)]">{title}</h1>
      {quickAdd && <div className="hidden w-72 shrink 2xl:block min-[1800px]:w-96">{quickAdd}</div>}
      <button type="button" aria-label="Quick add" title="Quick add (q)" onClick={onQuickAdd} className={`${navBtn} 2xl:hidden`}>
        <Sparkles className="h-[18px] w-[18px]" />
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
