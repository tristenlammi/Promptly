import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  FolderOpen,
  Home,
  Images,
  Import,
  LayoutGrid,
  Loader2,
  Menu,
  ShieldCheck,
  ShieldAlert,
  Share2,
  Star,
  Trash2,
  X,
  Sparkles,
} from "lucide-react";
import { createContext, Suspense, useContext, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom";

import { filesShellApi } from "@/api/filesShell";
import { useSubfolders } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import { useAuthStore } from "@/store/authStore";
import { useFilesShellStore } from "@/store/filesShellStore";
import { cn } from "@/utils/cn";

import { DriveAiDialog, useDriveAi } from "./DriveAiDialog";
import { DriveFolderTree } from "./DriveFolderTree";
import { formatRelativeTime, humanSize } from "./helpers";
import { NewMenu } from "./NewMenu";

/** True inside the Files shell — pages drop their own sub-nav then. */
const FilesShellContext = createContext(false);
export const useInFilesShell = () => useContext(FilesShellContext);

/**
 * The Files area's frame (WP-3.5, Part C §2.2 / §2.4):
 *
 * * 1024 px and wider — a rail: + New, Home, My files with its folder
 *   tree, Shared, Workspaces, Starred, Trash, "From chats", the storage
 *   meter and when your data was last backed up. The app sidebar is an
 *   icon strip here (AppLayout).
 * * 768–1023 px — the same rail as a drawer (the page's Files menu button).
 * * Below 768 px — bottom tabs: Home · Files · Shared · More (the drawer),
 *   with a "+" for New.
 *
 * Editor pages (``/files/doc|sheet|whiteboard/:id``) sit outside it.
 */
export function FilesShell() {
  const isPhone = useIsMobile();
  const drawerOpen = useFilesShellStore((s) => s.drawerOpen);
  const setDrawerOpen = useFilesShellStore((s) => s.setDrawerOpen);
  const location = useLocation();
  useEffect(() => setDrawerOpen(false), [location.pathname, location.search, setDrawerOpen]);

  return (
    <FilesShellContext.Provider value={true}>
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Files"
          className="promptly-scroll hidden w-60 shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)]/30 lg:block"
        >
          <FilesRail />
        </aside>
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", isPhone && "pb-16")}>
          {/* Pages are lazy — keep the rail on screen while one loads. */}
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </div>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Files menu">
          <button
            type="button"
            aria-label="Close Files menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="promptly-scroll absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-[var(--surface)] shadow-xl">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
              <span className="text-sm font-semibold">Files</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--hover)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <FilesRail />
          </div>
        </div>
      )}

      {isPhone && <FilesBottomTabs />}
    </FilesShellContext.Provider>
  );
}

/** The "Files menu" button pages show below 1024 px (opens the drawer). */
export function FilesMenuButton({ className }: { className?: string }) {
  const setDrawerOpen = useFilesShellStore((s) => s.setDrawerOpen);
  return (
    <button
      type="button"
      onClick={() => setDrawerOpen(true)}
      aria-label="Files menu"
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 text-sm hover:bg-[var(--hover)] lg:hidden",
        className
      )}
    >
      <Menu className="h-4 w-4" />
      <span className="hidden sm:inline">Files menu</span>
    </button>
  );
}

// ---------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------
function FilesRail() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const folderMatch = useMatch("/files/folder/:folderId");
  const onMyFiles = useMatch({ path: "/files", end: true }) !== null || (folderMatch !== null && params.get("scope") !== "shared");
  const currentFolderId = onMyFiles ? (folderMatch?.params.folderId ?? null) : null;
  const treeVersion = useFilesShellStore((s) => s.treeVersion);
  const bumpTree = useFilesShellStore((s) => s.bumpTree);
  const { data: root } = useSubfolders("mine", null);
  const system = (kind: string) => root?.folders.find((f) => f.system_kind === kind);
  const chatUploads = system("chat_uploads");
  const generated = system("generated_root");
  const [chatsOpen, setChatsOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(() => /^\/files\/workspaces/.test(window.location.pathname));
  const { data: workspaces } = useWorkspaces();

  return (
    <div className="flex flex-col gap-3 p-3">
      <NewMenu variant="rail" folderId={currentFolderId} onChanged={bumpTree} />

      <nav aria-label="Files sections" className="flex flex-col gap-0.5 text-sm">
        <RailLink to="/files/home" icon={Home} label="Home" />
        <RailLink to="/files/photos" icon={Images} label="Photos" />
        <RailLink to="/files" icon={FolderOpen} label="My files" end active={onMyFiles} />
        {onMyFiles && (
          <DriveFolderTree
            embedded
            scope="mine"
            currentFolderId={currentFolderId}
            onNavigate={(id) => navigate(id ? `/files/folder/${id}` : "/files")}
            version={treeVersion}
          />
        )}
        <RailLink to="/files/shared" icon={Share2} label="Shared" />
        <button
          type="button"
          onClick={() => setWsOpen((o) => !o)}
          aria-expanded={wsOpen}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <LayoutGrid className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">Workspaces</span>
          {wsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        {wsOpen && (
          <ul className="flex flex-col gap-0.5 pl-3">
            {(workspaces ?? []).map((w) => (
              <li key={w.id}>
                <RailLink to={`/files/workspaces/${w.id}`} label={w.title || "Untitled workspace"} small />
              </li>
            ))}
            {workspaces && workspaces.length === 0 && (
              <li className="px-2 py-1 text-xs text-[var(--text-muted)]">No workspaces yet</li>
            )}
          </ul>
        )}
        <RailLink to="/files/starred" icon={Star} label="Starred" />
        <RailLink to="/files/recent" icon={Clock} label="Recent" />
        <RailLink to="/files/trash" icon={Trash2} label="Trash" hint="Deleted forever after 30 days" />
        <RailLink to="/files/import" icon={Import} label="Import & export" />

        {(chatUploads || generated) && (
          <>
            <button
              type="button"
              onClick={() => setChatsOpen((o) => !o)}
              aria-expanded={chatsOpen}
              className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <Bot className="h-4 w-4 shrink-0" />
              <span className="flex-1 truncate">From chats</span>
              {chatsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
            {chatsOpen && (
              <ul className="flex flex-col gap-0.5 pl-3">
                {chatUploads && (
                  <li>
                    <RailLink to={`/files/folder/${chatUploads.id}`} label={chatUploads.name} small />
                  </li>
                )}
                {generated && (
                  <li>
                    <RailLink to={`/files/folder/${generated.id}`} label={generated.name} small />
                  </li>
                )}
              </ul>
            )}
          </>
        )}
      </nav>

      <AiSearchRow />
      <StorageMeter />
    </div>
  );
}

/** "AI search · On (n files)" — opens the Ask-your-Drive settings (WP-5.1). */
function AiSearchRow() {
  const [open, setOpen] = useState(false);
  const { data } = useDriveAi();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        <Sparkles className="h-3.5 w-3.5 text-[var(--accent-text)]" />
        <span className="flex-1">AI search</span>
        <span className="tabular-nums">
          {!data ? "" : !data.enabled ? "Off" : data.pending > 0 ? "Indexing…" : `On · ${data.indexed}`}
        </span>
      </button>
      <DriveAiDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function RailLink({
  to,
  icon: Icon,
  label,
  end,
  active,
  small,
  hint,
}: {
  to: string;
  icon?: typeof Home;
  label: string;
  end?: boolean;
  active?: boolean;
  small?: boolean;
  hint?: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={hint}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-md px-2 text-left transition",
          small ? "py-1 text-[13px]" : "py-1.5",
          (active ?? isActive)
            ? "bg-[var(--accent)]/10 font-medium text-[var(--text)]"
            : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        )
      }
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" />}
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

/** Storage used (files · trash, plus versions kept for recovery) and when
 *  the server last backed everything up. */
function StorageMeter() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const { data } = useQuery({
    queryKey: ["files-storage"],
    queryFn: () => filesShellApi.storage(),
    staleTime: 60_000,
  });
  if (!data) return null;
  const capped = !!data.cap_bytes;
  const pct = capped ? Math.min(1, data.used_bytes / Math.max(1, data.cap_bytes ?? 1)) : 0;
  const backedUp = data.last_offsite_at ?? data.last_backup_at;
  const stale = !backedUp || Date.now() - new Date(backedUp).getTime() > 48 * 3600 * 1000;
  const badge = (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs",
        stale ? "text-[var(--warning)]" : "text-[var(--text-muted)]"
      )}
    >
      {stale ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
      {backedUp ? `Backed up ${formatRelativeTime(backedUp)}` : "Not backed up yet"}
      {data.last_offsite_at ? " · off-site" : ""}
    </span>
  );
  return (
    <div className="mt-1 space-y-2 border-t border-[var(--border)] pt-3">
      <div className="text-xs text-[var(--text-muted)]">
        <div className="mb-1 flex justify-between gap-2">
          <span>Storage</span>
          <span className="tabular-nums">
            {humanSize(data.used_bytes)}
            {capped ? ` of ${humanSize(data.cap_bytes ?? 0)}` : ""}
          </span>
        </div>
        {capped && (
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
            <div
              className={cn(
                "h-full rounded-full",
                pct >= 0.95 ? "bg-red-500" : pct >= 0.8 ? "bg-amber-500" : "bg-[var(--accent)]"
              )}
              style={{ width: `${Math.max(2, Math.round(pct * 100))}%` }}
            />
          </div>
        )}
        <dl className="mt-1.5 space-y-0.5 text-[11px]">
          <div className="flex justify-between">
            <dt>Files</dt>
            <dd className="tabular-nums">{humanSize(data.files_bytes)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>
              <Link to="/files/trash" className="hover:underline">
                Trash
              </Link>
            </dt>
            <dd className="tabular-nums">{humanSize(data.trash_bytes)}</dd>
          </div>
          {data.office_pending_bytes > 0 && (
            <div className="flex justify-between" title="Spreadsheets and whiteboards start counting toward your storage soon">
              <dt>Sheets &amp; boards (free for now)</dt>
              <dd className="tabular-nums">{humanSize(data.office_pending_bytes)}</dd>
            </div>
          )}
          <div
            className="flex justify-between"
            title={
              data.versions_counted
                ? "Earlier versions of your documents, sheets and whiteboards"
                : "Earlier versions of your documents, sheets and whiteboards — they start counting toward your storage on the date shown"
            }
          >
            <dt>
              {data.versions_counted
                ? "Versions"
                : data.versions_counted_from
                  ? `Versions (free until ${new Date(data.versions_counted_from).toLocaleDateString(undefined, { day: "numeric", month: "short" })})`
                  : "Versions (free)"}
            </dt>
            <dd className="tabular-nums">{humanSize(data.versions_bytes)}</dd>
          </div>
        </dl>
      </div>
      {isAdmin ? (
        <Link to="/admin?tab=backups" className="block hover:underline">
          {badge}
        </Link>
      ) : (
        badge
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Phone: bottom tabs
// ---------------------------------------------------------------------
function FilesBottomTabs() {
  const setDrawerOpen = useFilesShellStore((s) => s.setDrawerOpen);
  const folderMatch = useMatch("/files/folder/:folderId");
  const [params] = useSearchParams();
  const folderId = folderMatch && params.get("scope") !== "shared" ? folderMatch.params.folderId ?? null : null;
  const bumpTree = useFilesShellStore((s) => s.bumpTree);
  const tab = "flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[11px]";
  const tone = ({ isActive }: { isActive: boolean }) =>
    cn(tab, isActive ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]");
  return (
    <nav
      aria-label="Files tabs"
      className="fixed inset-x-0 bottom-0 z-40 flex items-end border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom,0)]"
    >
      <NavLink to="/files/home" className={tone}>
        <Home className="h-5 w-5" />
        Home
      </NavLink>
      <NavLink to="/files" end className={tone}>
        <FolderOpen className="h-5 w-5" />
        Files
      </NavLink>
      <div className="-mt-5 flex flex-1 justify-center">
        <NewMenu variant="fab" folderId={folderId} onChanged={bumpTree} />
      </div>
      {/* Photos takes Shared's place on a phone; Shared is under More. */}
      <NavLink to="/files/photos" className={tone}>
        <Images className="h-5 w-5" />
        Photos
      </NavLink>
      <button type="button" onClick={() => setDrawerOpen(true)} className={cn(tab, "text-[var(--text-muted)]")}>
        <Menu className="h-5 w-5" />
        More
      </button>
    </nav>
  );
}
