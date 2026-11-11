import { Bell, CheckSquare, Download, GitMerge, MoreHorizontal, Sparkles, Upload, type LucideIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { cn } from "@/utils/cn";

import { ImportSheet } from "./ImportSheet";
import { duplicateGroups } from "./model";
import { useHomeCountry, type Handle } from "./shared";
import { DuplicatesSheet, ExportSheet, SettingsSheet } from "./ToolSheets";

/*
 * "More" — the address book's tools in one menu: import, export, find
 * duplicates, reminders & display. It sits in the Contacts toolbar (and on
 * Groups, where these used to be the only way in) so they're one tap from
 * the list.
 */

type Tool = "import" | "export" | "dupes" | "settings";

export function ToolsMenu({
  item,
  title,
  ask,
  onSelectMode,
  className,
  align = "right",
}: {
  item: Handle;
  /** The file's name, for the export's filename. */
  title: string;
  ask: (prompt: string) => void;
  /** On the list: "Select contacts" starts picking several. */
  onSelectMode?: () => void;
  className?: string;
  /** Which edge of the button the menu lines up with. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<Tool | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopoverDismiss(open, ref, close);
  const cc = useHomeCountry(item);
  const dupes = useMemo(() => duplicateGroups(item.data, cc).length, [item.data, cc]);
  const can = item.canEdit;
  const pick = (t: Tool) => {
    setTool(t);
    setOpen(false);
  };
  // Arrow keys walk the menu.
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  };

  return (
    <div className={cn("relative shrink-0", className)}>
      <div ref={ref}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Import, export, duplicates and settings"
          onClick={() => setOpen((o) => !o)}
          className="relative inline-flex h-11 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] md:h-10"
        >
          <MoreHorizontal className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
          More
          {dupes > 0 && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-[var(--item-accent-fill)] ring-2 ring-[var(--bg)]" aria-hidden />}
        </button>
        {open && (
          <div
            role="menu"
            aria-label="More for Contacts"
            onKeyDown={onMenuKey}
            className={cn("absolute top-12 z-40 w-64", align === "left" ? "left-0" : "right-0", " max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)] md:top-11")}
          >
            {onSelectMode && item.data.contacts.length > 0 && (
              <>
                <ToolRow
                  icon={CheckSquare}
                  label="Select contacts"
                  hint="Group, export or delete several"
                  onClick={() => {
                    setOpen(false);
                    onSelectMode();
                  }}
                />
                <div className="my-1 border-t border-[var(--border)]" role="separator" />
              </>
            )}
            {can && <ToolRow icon={Upload} label="Import" hint="From Google, iCloud or Outlook" onClick={() => pick("import")} />}
            <ToolRow icon={Download} label="Export" hint="Save a copy of your contacts" onClick={() => pick("export")} />
            <ToolRow
              icon={GitMerge}
              label="Find duplicates"
              hint={dupes > 0 ? "Some people look like the same person" : "Same email, phone or name"}
              badge={dupes > 0 ? dupes : undefined}
              onClick={() => pick("dupes")}
            />
            <ToolRow icon={Bell} label="Reminders & display" hint="Birthday reminders, name order" onClick={() => pick("settings")} />
            {can && (
              <>
                <div className="my-1 border-t border-[var(--border)]" role="separator" />
                <ToolRow
                  icon={Sparkles}
                  label="Ask the assistant to tidy up"
                  onClick={() => {
                    setOpen(false);
                    ask("Tidy up my contacts: find duplicates, missing details and people who could use a tag or group. Tell me what you'd change before changing it.");
                  }}
                />
              </>
            )}
          </div>
        )}
      </div>
      <ImportSheet item={item} open={tool === "import"} onClose={() => setTool(null)} />
      <ExportSheet item={item} open={tool === "export"} onClose={() => setTool(null)} title={title} />
      <DuplicatesSheet item={item} open={tool === "dupes"} onClose={() => setTool(null)} />
      <SettingsSheet item={item} open={tool === "settings"} onClose={() => setTool(null)} />
    </div>
  );
}

function ToolRow({ icon: Icon, label, hint, badge, onClick }: { icon: LucideIcon; label: string; hint?: string; badge?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex min-h-[44px] w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
    >
      <Icon className="h-4 w-4 shrink-0 text-[var(--item-accent)]" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-[var(--text)]">{label}</span>
        {hint && <span className="block truncate text-xs text-[var(--text-muted)]">{hint}</span>}
      </span>
      {badge !== undefined && <span className="rounded-full bg-[var(--item-accent-fill)] px-2 py-0.5 text-xs font-semibold tabular-nums text-white">{badge}</span>}
    </button>
  );
}
