import { LayoutGrid, List as ListIcon } from "lucide-react";

import { cn } from "@/utils/cn";

/** List / grid switch for Drive views (My files, a workspace's drive). */
export function ViewToggle({
  mode,
  onChange,
}: {
  mode: "list" | "grid";
  onChange: (m: "list" | "grid") => void;
}) {
  const btn = (active: boolean, leading: boolean) =>
    cn(
      "px-2 py-1.5 transition",
      leading && "border-l border-[var(--border)]",
      active
        ? "bg-[var(--accent)]/15 text-[var(--accent-text)]"
        : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
    );
  return (
    <div className="inline-flex shrink-0 items-stretch overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        aria-label="List view"
        aria-pressed={mode === "list"}
        title="List view"
        onClick={() => onChange("list")}
        className={btn(mode === "list", false)}
      >
        <ListIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Grid view"
        aria-pressed={mode === "grid"}
        title="Grid view"
        onClick={() => onChange("grid")}
        className={btn(mode === "grid", true)}
      >
        <LayoutGrid className="h-4 w-4" />
      </button>
    </div>
  );
}
