import { Folder as FolderIcon, Users } from "lucide-react";

import type { FileScope } from "@/api/files";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

interface DriveScopeTabsProps {
  scope: FileScope;
  onChange: (next: FileScope) => void;
  /** When true, hide the "Shared" tab. Used on surfaces that only
   *  deal with the caller's own files (e.g. ``/files/recent``). */
  mineOnly?: boolean;
}

export function DriveScopeTabs({ scope, onChange, mineOnly }: DriveScopeTabsProps) {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  if (mineOnly) return null;

  return (
    <div className="mb-4 flex items-center gap-1 rounded-input border border-[var(--border)] bg-[var(--surface)] p-1">
      <ScopeTab
        active={scope === "mine"}
        onClick={() => onChange("mine")}
        icon={<FolderIcon className="h-3.5 w-3.5" />}
        label="My files"
      />
      <ScopeTab
        active={scope === "shared"}
        onClick={() => onChange("shared")}
        icon={<Users className="h-3.5 w-3.5" />}
        label={isAdmin ? "Shared pool" : "Shared"}
        hint={!isAdmin ? "read-only" : undefined}
      />
    </div>
  );
}

function ScopeTab({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm transition",
        active
          ? "bg-[var(--bg)] text-[var(--text)] shadow-sm"
          : "text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {icon}
      <span className="font-medium">{label}</span>
      {hint && (
        <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
          {hint}
        </span>
      )}
    </button>
  );
}
