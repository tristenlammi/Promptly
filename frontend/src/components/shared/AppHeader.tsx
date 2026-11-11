import type { ComponentType, KeyboardEvent, ReactNode } from "react";

import { cn } from "@/utils/cn";

/* ----------------------------------------------------------------------
   The shared app header (UI plan A7). One bar, the same in every app, so
   people always know where they are:

     [lead] (icon) Name      tabs  /  search            main action
     └─ left ──────────┘  └──── middle ─────┘   └──── right ────┘

   Fixed height: 56px (``APP_HEADER_HEIGHT``), plus the top safe area on a
   phone. It does not scroll with the page: put it above your scrolling
   area in a flex column (``flex h-full flex-col`` → AppHeader → a
   ``min-h-0 flex-1 overflow-y-auto`` body).

     <AppHeader
       icon={Images}
       name="Photos"
       tint="#D97757"                       // the app's own colour: icon mark only
       tabs={[
         { id: "photos", label: "Photos" },
         { id: "albums", label: "Albums" },
         { id: "people", label: "People", badge: 3 },
       ]}
       activeTab={tab}
       onTabChange={setTab}
       actions={<Button variant="primary" size="sm" onClick={upload}>Add photos</Button>}
     />

     <AppHeader icon={NotebookPen} name="Notes" tint="#EAB308"
       middle={<SearchBox … />}             // a search box instead of tabs
       actions={<MenuButton label="More" items={…} />} />

   Props
     icon         the app's icon: a lucide icon / any component taking
                  ``className``. Drawn white-on-tint in a rounded square.
     name         the app's name. One or two words.
     tint         the app's colour (any CSS colour). Used for the icon mark
                  ONLY; buttons, tabs and selection stay terracotta
                  (``var(--accent)``). Default: the accent.
     detail       a short quiet line after the name on wide screens (a
                  count: "128 people"; a folder name). Optional.
     onNameClick  makes the icon + name a button (go to the app's home).
     lead         something before the icon: a back button, a drawer button
                  on phones. Give it a 40px target.
     tabs / activeTab / onTabChange
                  the app's top-level sections, in the middle. Arrow keys
                  move between them. Scrolls sideways on a phone; keep it to
                  about five. ``badge`` shows a small count.
     middle       anything else for the middle (a search box, a title, a
                  month switcher). Shown after ``tabs`` if both are given;
                  it takes the spare width.
     actions      the right-hand side: ONE main action (a primary button),
                  optionally a "⋯" MenuButton for the rest.
     className    extra classes on the bar.

   On a phone the name hides when there are tabs or a middle (the icon
   stays), so the controls keep their room.

   Not adopted by any app yet: apps move onto it in wave 2.
   ---------------------------------------------------------------------- */

/** Height of the bar in px, without the phone's top safe area. */
export const APP_HEADER_HEIGHT = 56;

export interface AppHeaderTab<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  /** A small count beside the label (unread, to review). Hidden when 0 / empty. */
  badge?: number | string | null;
}

export function AppHeader<T extends string = string>({
  icon: Icon,
  name,
  tint,
  detail,
  onNameClick,
  lead,
  tabs,
  activeTab,
  onTabChange,
  middle,
  actions,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  name: string;
  tint?: string;
  detail?: ReactNode;
  onNameClick?: () => void;
  lead?: ReactNode;
  tabs?: AppHeaderTab<T>[];
  activeTab?: T;
  onTabChange?: (id: T) => void;
  middle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const hasMiddle = !!(tabs?.length || middle);

  const mark = (
    <>
      {Icon && (
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-white"
          style={{ background: tint ?? "var(--accent)" }}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
      )}
      <span className={cn("min-w-0 truncate text-base font-semibold text-[var(--text)]", hasMiddle && Icon && "hidden md:inline")}>{name}</span>
    </>
  );

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!tabs?.length || !onTabChange) return;
    const at = tabs.findIndex((t) => t.id === activeTab);
    let next = -1;
    if (e.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onTabChange(tabs[next].id);
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[next]?.focus();
    buttons[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-3 pt-safe md:gap-4 md:px-5",
        className,
      )}
    >
      <div className="flex h-14 min-w-0 shrink-0 items-center gap-2">
        {lead}
        {onNameClick ? (
          <button
            type="button"
            onClick={onNameClick}
            aria-label={name}
            className="-mx-1 flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1 hover:bg-[var(--hover)]"
          >
            {mark}
          </button>
        ) : (
          <h1 className="flex min-w-0 items-center gap-2.5">{mark}</h1>
        )}
        {detail && <span className="hidden truncate text-sm text-[var(--text-muted)] lg:inline">{detail}</span>}
      </div>

      <div className="flex h-14 min-w-0 flex-1 items-center gap-3">
        {!!tabs?.length && (
          <div
            role="tablist"
            aria-label={`${name} sections`}
            onKeyDown={onTabKey}
            className="flex h-full min-w-0 items-stretch gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tabs.map((t) => {
              const on = t.id === activeTab;
              const TabIcon = t.icon;
              const badge = t.badge === 0 || t.badge === "" ? null : t.badge;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  tabIndex={on || activeTab === undefined ? 0 : -1}
                  onClick={() => onTabChange?.(t.id)}
                  className={cn(
                    "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium outline-none transition-colors",
                    "focus-visible:bg-[var(--hover)]",
                    on ? "text-[var(--text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
                  )}
                >
                  {TabIcon && <TabIcon className="h-4 w-4" />}
                  {t.label}
                  {badge != null && (
                    <span className="rounded-full bg-[var(--accent-strong)] px-1.5 text-xs font-semibold leading-5 text-white">{badge}</span>
                  )}
                  {/* The "you are here" line, in the suite's accent. */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[var(--accent-strong)] transition-opacity",
                      on ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
              );
            })}
          </div>
        )}
        {middle && <div className="flex min-w-0 flex-1 items-center">{middle}</div>}
      </div>

      {actions && <div className="flex h-14 shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}
