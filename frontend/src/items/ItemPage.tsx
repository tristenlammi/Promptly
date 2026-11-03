import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  ArrowLeft,
  ExternalLink,
  Check,
  CloudOff,
  Download,
  History,
  Loader2,
  MoreHorizontal,
  Share2,
  Sparkles,
  Star,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { filesApi } from "@/api/files";
import { downloadAuthed, extractError } from "@/components/files/helpers";
import { ShareGrantsModal } from "@/components/files/ShareGrantsModal";
import { VersionHistoryPanel } from "@/components/files/VersionHistoryPanel";
import { ErrorState } from "@/components/shared/Callout";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { itemsApi, loadItemDoc, type ItemDoc } from "./api";
import { isOffline } from "./offlineStore";
import { ItemAiPanel } from "./ItemAiPanel";
import { itemIcon, loadModule } from "./registry";
import type { ItemModule } from "./types";
import { useItem, type ItemHandle } from "./useItem";
import { setItemTimeZone } from "./ui/format";
import { useAuthStore } from "@/store/authStore";
import { useRecordOpen } from "@/hooks/useRecordOpen";
import "./ui/items.css";

const AI_OPEN_KEY = "promptly.items.aiOpen";

/**
 * ``/files/item/:fileId`` — an Item Store file opened as its app.
 *
 * The shell is the same for every kind: header (back, icon, name you can
 * rename, save state, the kind's quick action, Ask, ⋯ for share / history /
 * download / undo), the kind's **tabs**, and the **AI panel** — a side
 * panel on desktop, the last tab ("Ask") on a phone. The kind module
 * supplies only its tab views.
 */
export function ItemPage({ standalone = false }: { standalone?: boolean } = {}) {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const { data: doc, error, isLoading } = useQuery({
    queryKey: ["item", fileId],
    queryFn: () => loadItemDoc(fileId),
    retry: (n, e) => n < 2 && !isOffline(e),
    staleTime: Infinity,
    gcTime: 0,
  });
  // Today's "Recent" strip (filed as the app's file server-side).
  useRecordOpen("file", doc ? fileId : null);
  const [module, setModule] = useState<ItemModule | null | undefined>(undefined);

  useEffect(() => {
    if (!doc) return;
    let live = true;
    loadModule(doc.kind)
      .then((m) => live && setModule(m))
      .catch(() => live && setModule(null));
    return () => {
      live = false;
    };
  }, [doc]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <ErrorState>This item couldn't be opened — {extractError(error)}</ErrorState>
      </div>
    );
  }
  if (isLoading || !doc || module === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  return <ItemShell key={doc.file_id} doc={doc} module={module} standalone={standalone} />;
}

function ItemShell({ doc, module, standalone }: { doc: ItemDoc<any>; module: ItemModule | null; standalone: boolean }) {
  const isPhone = useIsMobile();
  // Below this the assistant floats over the item instead of taking a column.
  const narrowDesktop = useIsMobile(1180);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const item = useItem<any>(doc);
  const spec = doc.spec;
  const tabs = module?.tabs ?? [];
  const tabParam = params.get("tab");
  const [tab, setTabState] = useState<string>(() => (tabParam && (tabs.some((t) => t.id === tabParam) || tabParam === "ask") ? tabParam : tabs[0]?.id ?? "ask"));
  const [aiOpen, setAiOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(AI_OPEN_KEY);
      return narrowDesktop ? saved === "1" : saved !== "0";
    } catch {
      return true;
    }
  });
  const [pending, setPending] = useState<{ text: string; send: boolean } | null>(null);
  const [title, setTitle] = useState(doc.title);
  const [menu, setMenu] = useState(false);
  const [share, setShare] = useState(false);
  const [history, setHistory] = useState(false);
  const [starred, setStarred] = useState(doc.starred);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(menu, menuRef, () => setMenu(false));

  const setTab = useCallback(
    (id: string) => {
      setTabState(id);
      const p = new URLSearchParams(params);
      if (id === tabs[0]?.id) p.delete("tab");
      else p.set("tab", id);
      setParams(p, { replace: true });
    },
    [params, setParams, tabs],
  );

  // The kind module loads after the first render: honour ?tab= once its tabs exist.
  const tabsReady = tabs.length > 0;
  useEffect(() => {
    if (tabsReady && tabParam && tabs.some((t) => t.id === tabParam)) setTabState(tabParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsReady]);

  // On desktop "Ask" isn't a tab — fall back to the first one.
  useEffect(() => {
    if (!isPhone && tab === "ask" && tabs[0]) setTabState(tabs[0].id);
  }, [isPhone, tab, tabs]);

  const toggleAi = (open: boolean) => {
    setAiOpen(open);
    try {
      localStorage.setItem(AI_OPEN_KEY, open ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  const ask = useCallback(
    (prompt: string, opts?: { send?: boolean }) => {
      setPending({ text: prompt, send: opts?.send !== false });
      if (isPhone) setTab("ask");
      else toggleAi(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isPhone, setTab],
  );

  const rename = async () => {
    const next = title.trim();
    if (!next || next === doc.title) {
      setTitle(doc.title);
      return;
    }
    try {
      await filesApi.renameFile(doc.file_id, `${next}${spec?.suffix ?? ""}`);
      qc.invalidateQueries({ queryKey: ["files"] });
    } catch (e) {
      toast.error(extractError(e));
      setTitle(doc.title);
    }
  };

  const toggleStar = async () => {
    try {
      await (starred ? filesApi.bulkUnstar : filesApi.bulkStar)({ file_ids: [doc.file_id], folder_ids: [] });
      setStarred(!starred);
    } catch (e) {
      toast.error(extractError(e));
    }
  };

  const accent = spec?.color ?? "#D97757";
  // Sheets and menus render in a portal, outside this tree: give the whole
  // page the item's accent while it's open.
  useEffect(() => {
    setItemTimeZone((useAuthStore.getState().user?.settings as { timezone?: string } | undefined)?.timezone);
    const root = document.documentElement;
    root.style.setProperty("--item-accent", accent);
    // Apps size their own touch targets; opt out of the global icon-button minimum.
    root.dataset.itemApp = "";
    return () => {
      root.style.removeProperty("--item-accent");
      delete root.dataset.itemApp;
    };
  }, [accent]);
  const style = { "--item-accent": accent } as CSSProperties;
  const Icon = module?.icon ?? itemIcon(spec?.icon);
  const onboarding = !!module?.needsOnboarding?.(item.data) && !!module.Onboarding && item.canEdit;
  const active = tabs.find((t) => t.id === tab) ?? tabs[0];
  const primary = module?.primaryAction?.(item, { goTo: setTab, ask }) ?? null;

  const viewProps = useMemo(
    () => ({ item, isPhone, ask, goTo: setTab, doc }),
    [item, isPhone, ask, setTab, doc],
  );

  const body = !module ? (
    <div className="p-6">
      <ErrorState tone="warning">
        {spec?.name ?? "This item"} can't be shown here: this server doesn't have the app for this file. Its data is
        safe — you can download it from the ⋯ menu.
      </ErrorState>
    </div>
  ) : onboarding && module.Onboarding ? (
    <module.Onboarding {...viewProps} />
  ) : active ? (
    <Suspense
      fallback={
        <div className="flex justify-center py-10 text-[var(--text-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      }
    >
      <active.View {...viewProps} />
    </Suspense>
  ) : null;

  const showAskTab = isPhone && spec;
  const phoneTabs = [...tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon })), ...(showAskTab ? [{ id: "ask", label: "Ask", icon: Sparkles }] : [])];

  return (
    <div style={style} className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg)] px-2 pt-safe pl-safe pr-safe md:gap-2 md:px-4">
        {/* As its own app there's nowhere to go back to. */}
        {!standalone && (
          <button
            type="button"
            aria-label="Back"
            onClick={() => (window.location.pathname.startsWith("/apps/") ? navigate("/apps") : navigate(-1))}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-white"
          style={{ background: accent }}
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          {item.canEdit && doc.is_owner ? (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setTitle(doc.title);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              aria-label="Name"
              className="w-full truncate rounded-lg bg-transparent px-1.5 py-1 text-[15px] font-semibold text-[var(--text)] outline-none hover:bg-[var(--hover)] focus:bg-[var(--surface)] focus:ring-2 focus:ring-[var(--item-accent)]"
            />
          ) : (
            <h1 className="truncate px-1.5 text-[15px] font-semibold text-[var(--text)]">{doc.title}</h1>
          )}
          <SaveState item={item} name={spec?.name ?? ""} />
        </div>
        {primary && !isPhone && (
          <button
            type="button"
            onClick={primary.onClick}
            className="hidden h-9 items-center gap-1.5 rounded-xl bg-[var(--item-accent)] px-3 text-sm font-semibold text-white shadow-[var(--shadow-sm)] hover:brightness-95 md:inline-flex"
          >
            {primary.icon}
            {primary.label}
          </button>
        )}
        {!isPhone && spec && (
          <button
            type="button"
            onClick={() => toggleAi(!aiOpen)}
            aria-pressed={aiOpen}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition",
              aiOpen
                ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] text-[var(--text)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            <Sparkles className="h-4 w-4 text-[var(--item-accent)]" /> Ask AI
          </button>
        )}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {menu && (
            <div role="menu" className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]">
              {item.canEdit && (
                <MenuItem icon={Undo2} label="Undo my last change" disabled={!item.canUndo} onClick={() => { item.undo(); setMenu(false); }} />
              )}
              {doc.is_owner && <MenuItem icon={Share2} label="Share" onClick={() => { setShare(true); setMenu(false); }} />}
              {doc.is_owner && <MenuItem icon={Star} label={starred ? "Unstar" : "Star"} onClick={() => { void toggleStar(); setMenu(false); }} />}
              <MenuItem icon={History} label="Version history" onClick={() => { setHistory(true); setMenu(false); }} />
              {standalone ? (
                <MenuItem
                  icon={ExternalLink}
                  label="Open in Promptly"
                  onClick={() => {
                    setMenu(false);
                    window.open(`/files/item/${doc.file_id}`, "_blank", "noopener");
                  }}
                />
              ) : (
                <MenuItem
                  icon={AppWindow}
                  label="Install as an app"
                  onClick={() => {
                    setMenu(false);
                    navigate(`/app/${doc.file_id}/`);
                  }}
                />
              )}
              <MenuItem
                icon={Download}
                label="Download (JSON)"
                onClick={() => {
                  setMenu(false);
                  void downloadAuthed({ id: doc.file_id, filename: `${doc.title}${spec?.suffix ?? ""}.json` });
                }}
              />
            </div>
          )}
        </div>
      </header>

      <FileBanners doc={doc} item={item} />

      {/* Desktop tab strip */}
      {!isPhone && tabs.length > 1 && !onboarding && (
        <nav aria-label={`${spec?.name ?? "Item"} sections`} className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] px-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={t.id === active?.id ? "page" : undefined}
              className={cn(
                "relative flex h-11 items-center gap-2 whitespace-nowrap px-3 text-sm font-medium transition",
                t.id === active?.id ? "text-[var(--text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
              {t.id === active?.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[var(--item-accent)]" />}
            </button>
          ))}
        </nav>
      )}

      {/* Body + AI panel */}
      <div className="flex min-h-0 flex-1">
        <main
          className={cn(
            "min-w-0 flex-1 overflow-y-auto",
            isPhone && !onboarding && phoneTabs.length > 1 && "pb-[calc(64px+env(safe-area-inset-bottom,0px))]",
            isPhone && tab === "ask" && "hidden",
          )}
        >
          {body}
        </main>
        {isPhone && tab === "ask" && spec && (
          <div className="min-h-0 flex-1 pb-[calc(64px+env(safe-area-inset-bottom,0px))]">
            <ItemAiPanel
              item={item}
              spec={spec}
              pendingPrompt={pending}
              onPendingTaken={() => setPending(null)}
              variant="tab"
              // During first-run setup there's no tab bar to get back with.
              onClose={onboarding ? () => setTab(tabs[0]?.id ?? "ask") : undefined}
            />
          </div>
        )}
        {!isPhone && aiOpen && spec && (
          <aside
            className={cn(
              "w-[380px] shrink-0 xl:w-[420px]",
              narrowDesktop && "fixed bottom-0 right-0 top-14 z-40 shadow-[var(--shadow-lg)]",
            )}
            aria-label="Assistant"
          >
            <ItemAiPanel
              item={item}
              spec={spec}
              pendingPrompt={pending}
              onPendingTaken={() => setPending(null)}
              onClose={() => toggleAi(false)}
              variant="side"
            />
          </aside>
        )}
      </div>

      {/* Phone tab bar */}
      {isPhone && !onboarding && phoneTabs.length > 1 && (
        <nav
          aria-label={`${spec?.name ?? "Item"} sections`}
          className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] pb-safe backdrop-blur"
        >
          {phoneTabs.map((t) => {
            const on = t.id === (tab === "ask" ? "ask" : active?.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition",
                  on ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]",
                )}
              >
                <t.icon className={cn("h-[22px] w-[22px]", on && "item-pop")} />
                {t.label}
              </button>
            );
          })}
        </nav>
      )}

      <ShareGrantsModal
        open={share}
        resource={share ? { type: "file", id: doc.file_id, name: doc.filename, supports_edit: true } : null}
        onClose={() => setShare(false)}
      />
      {history && (
        <VersionHistoryPanel
          fileId={doc.file_id}
          onClose={() => setHistory(false)}
          onRestored={() => {
            setHistory(false);
            void item.refresh();
          }}
        />
      )}
    </div>
  );
}

/** "Offline — this device's copy" and "This file is 85% full — archive". */
function FileBanners({ doc, item }: { doc: ItemDoc<any>; item: ItemHandle<any> }) {
  const [size, setSize] = useState(doc.size_bytes ?? 0);
  const [open, setOpen] = useState(false);
  const yearAgo = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const [before, setBefore] = useState(yearAgo);
  const [busy, setBusy] = useState(false);
  const max = doc.max_bytes ?? 0;
  const pct = max ? Math.round((size / max) * 100) : 0;
  const offline = !item.connected;

  const run = async () => {
    setBusy(true);
    try {
      const res = await itemsApi.archive(doc.file_id, before);
      item.accept(res.data, res.revision);
      setSize(res.size_bytes);
      setOpen(false);
      toast.success("Older data moved to an archive file next to this one.");
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {offline && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--warning-bg)] px-4 py-1.5 text-xs text-[var(--text)]" role="status">
          <CloudOff className="h-3.5 w-3.5 shrink-0 text-[var(--warning)]" />
          You're offline — working from this device's copy. Changes are kept here and save when you're back online.
        </div>
      )}
      {pct >= 75 && item.canEdit && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-1.5 text-xs text-[var(--text)]" role="status">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-[var(--warning)]" />
          <span className="min-w-0 flex-1">
            This file is {pct}% full.{" "}
            {doc.can_archive ? "Archive older data to keep it fast." : "Start a new file for the next period soon."}
          </span>
          {doc.can_archive && (
            <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-[var(--border)] px-2 py-1 font-medium hover:bg-[var(--hover)]">
              Archive older data
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 md:items-center" role="dialog" aria-modal="true" aria-label="Archive older data">
          <div className="w-full max-w-md rounded-t-3xl bg-[var(--bg)] p-5 shadow-[var(--shadow-lg)] md:rounded-2xl">
            <h2 className="text-base font-semibold text-[var(--text)]">Archive older data</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Everything before this date moves to a new file next to this one — still yours, still searchable, and your
              chats can still read it. This file keeps the rest.
            </p>
            <label className="mt-4 flex flex-col gap-1 text-xs font-medium text-[var(--text-muted)]">
              Archive everything before
              <input
                type="date"
                value={before}
                onChange={(e) => setBefore(e.target.value)}
                className="h-11 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base text-[var(--text)]"
              />
            </label>
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className="h-11 flex-1 rounded-xl border border-[var(--border)] text-sm">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !before}
                onClick={() => void run()}
                className="h-11 flex-1 rounded-xl bg-[var(--item-accent)] text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? "Archiving…" : "Archive"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SaveState({ item, name }: { item: ItemHandle<unknown>; name: string }) {
  const map = {
    saved: { icon: Check, text: "Saved", cls: "" },
    saving: { icon: Loader2, text: "Saving…", cls: "animate-spin" },
    offline: { icon: CloudOff, text: "Offline — will save when back", cls: "" },
    error: { icon: TriangleAlert, text: "Not saved", cls: "" },
    readonly: { icon: null, text: `View only · ${name}`, cls: "" },
  } as const;
  const s = map[item.status];
  return (
    <div className={cn("flex items-center gap-1 px-1.5 text-[11px] leading-tight", item.status === "offline" || item.status === "error" ? "text-[var(--warning)]" : "text-[var(--text-muted)]")} aria-live="polite">
      {s.icon && <s.icon className={cn("h-3 w-3", s.cls)} />}
      <span className="truncate">{item.status === "saved" ? name : s.text}</span>
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Share2;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40"
    >
      <Icon className="h-4 w-4 text-[var(--text-muted)]" />
      {label}
    </button>
  );
}
