// The vault's shell: what state are we in, and the main layout once unlocked.
import { FolderTools, KitGate, MainNotices, VAULT_PREFS } from "./Connections";
import { type VaultInfo } from "../core/vault";
import { openPasskeyUnlock, type PasskeyUnlock } from "../core/connections";
import {
  Activity,
  Archive,
  CreditCard,
  FileKey2,
  Folder,
  FolderPlus,
  KeyRound,
  Lock,
  Menu,
  MonitorSmartphone,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  Upload,
  User,
  Users,
  Wand2,
  X,
  Bookmark,
} from "lucide-react";
import { BookmarksScreen } from "./Bookmarks";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, OfflineError } from "../core/api";
import { hostOf } from "../core/match";
import { type Item, type ItemKind, newBody } from "../core/model";
import { MemoryStore } from "../core/store";
import { VaultClient } from "../core/vault";
import { CREATABLE, ItemEditor, KIND_LABEL } from "./ItemEditor";
import { ItemView } from "./ItemView";
import { Button, Callout, type Ctx, DEFAULT_SETTINGS, IconButton, inputClass, Modal, type Settings, Spinner, useVault, VaultContext } from "./kit";
import { Onboarding } from "./Onboarding";
import type { Platform } from "./platform";
import { QrCameraHost } from "./qr";
import { ActivityScreen, CodesScreen, ConnectScreen, DevicesScreen, GeneratorScreen, SettingsScreen, TrashScreen } from "./Screens";
import { JoinDevice, Unlock } from "./Unlock";

const SecurityScreen = lazy(() => import("./Security").then((m) => ({ default: m.SecurityScreen })));
const TransferScreen = lazy(() => import("./Transfer").then((m) => ({ default: m.TransferScreen })));
const SharedScreen = lazy(() => import("./Shared").then((m) => ({ default: m.SharedScreen })));
const SendsScreen = lazy(() => import("./Sends").then((m) => ({ default: m.SendsScreen })));

type Phase = "boot" | "signin" | "unavailable" | "onboarding" | "join" | "locked" | "open";

function deviceLabel(kind: Platform["kind"]): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  if (kind === "windows") return "Windows app";
  return os ? `${browser} on ${os}` : browser;
}

export function VaultApp({ platform }: { platform: Platform }) {
  const vault = useMemo(() => new VaultClient(platform.api, platform.store, platform.kind), [platform]);
  const [phase, setPhase] = useState<Phase>("boot");
  const [username, setUsername] = useState("");
  const [preview, setPreview] = useState(true);
  const [notice, setNotice] = useState("");
  const [passkeyUnlock, setPasskeyUnlock] = useState<PasskeyUnlock | null>(null);
  // Only offered once it's been turned on here, and the host can still do it.
  const [helloOn, setHelloOn] = useState(false);
  useEffect(() => {
    if (phase !== "locked" || !platform.hello) return;
    void (async () => {
      const enabled = await platform.store.getMeta<boolean>("hello_enabled");
      setHelloOn(!!enabled && (await platform.hello!.available().catch(() => false)));
    })();
  }, [phase, platform]);
  useEffect(() => {
    if (phase === "locked" && platform.kind === "web") void platform.store.getMeta<PasskeyUnlock>("passkey_unlock").then((v) => setPasskeyUnlock(v ?? null));
  }, [phase, platform]);

  const connectCode = useMemo(() => (location.pathname.startsWith("/passwords/connect") ? new URLSearchParams(location.search).get("code") : null), []);

  const boot = useCallback(async () => {
    try {
      const pre = await platform.api.prelogin();
      setPreview(pre.preview);
      if (!pre.enabled) return setPhase("unavailable");
      if (connectCode) return setPhase("locked");
      if (!pre.exists) {
        try {
          const r = await fetch("/api/auth/me", { credentials: "same-origin", headers: { Authorization: `Bearer ${await platform.api.auth()}` } });
          if (r.ok) setUsername(((await r.json()) as { username?: string }).username ?? "");
        } catch {
          /* only used for the kit's label */
        }
        return setPhase("onboarding");
      }
      if (!(await vault.hasDeviceKit())) return setPhase("join");
      const open = await platform.restore?.();
      if (open) {
        await vault.restoreSession(open.secret, open.session);
        return setPhase("open");
      }
      setPhase("locked");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (platform.signIn) platform.signIn();
        setPhase("signin");
      } else if (e instanceof ApiError && e.status === 403) {
        setPhase("unavailable");
      } else if (e instanceof OfflineError || (e instanceof ApiError && e.status >= 500)) {
        // The server's down. If this device has a copy, it still opens.
        const cached = await platform.store.getAccount();
        if (cached && (await vault.hasDeviceKit())) {
          setNotice("The server can't be reached. Your vault works from this device's copy.");
          setPhase("locked");
        } else {
          setNotice("The server can't be reached, and this device has no copy of your vault yet.");
          setPhase("unavailable");
        }
      } else {
        setNotice(e instanceof Error ? e.message : "Something went wrong");
        setPhase("unavailable");
      }
    }
  }, [platform, vault, connectCode]);

  useEffect(() => {
    boot();
  }, [boot]);

  if (connectCode && phase !== "boot" && phase !== "signin") return <ConnectScreen api={platform.api} code={connectCode} />;

  switch (phase) {
    case "boot":
    case "signin":
      return <main className="flex min-h-[100dvh] items-center justify-center"><Spinner label="Loading…" /></main>;
    case "unavailable":
      return (
        <main className="mx-auto flex min-h-[100dvh] max-w-md items-center p-4">
          <Callout kind="warn">{notice || "Passwords is turned off on this server."}</Callout>
        </main>
      );
    case "onboarding":
      return <Onboarding vault={vault} username={username || "you"} preview={preview} serverUrl={platform.baseUrl} onDone={() => setPhase("open")} />;
    case "join":
      return <JoinDevice vault={vault} deviceName={deviceLabel(platform.kind)} onReady={() => setPhase("open")} />;
    case "locked":
      return (
        <>
          {notice && <div className="fixed left-0 right-0 top-0 z-10 p-2"><Callout kind="warn">{notice}</Callout></div>}
          <Unlock
            vault={vault}
            preview={preview}
            delegate={
              platform.unlock
                ? async (password) => {
                    await platform.unlock!(password);
                    const open = await platform.restore?.();
                    if (open) await vault.restoreSession(open.secret, open.session);
                  }
                : undefined
            }
            onOpen={() => setPhase("open")}
            resetKind={platform.kind}
            resetUrl={platform.baseUrl}
            pin={
              platform.pin?.has()
                ? async (p) => {
                    const secret = await platform.pin!.open(p);
                    await platform.adoptSecret?.(secret);
                    await vault.unlockWithSecret(secret);
                    secret.fill(0);
                  }
                : undefined
            }
            passkey={
              passkeyUnlock
                ? async () => {
                    const secret = await openPasskeyUnlock(passkeyUnlock);
                    await vault.unlockWithSecret(secret);
                    secret.fill(0);
                  }
                : undefined
            }
            hello={
              platform.hello && helloOn
                ? async () => {
                    const secret = await platform.hello!.unlock();
                    if (!secret) throw new Error("Windows Hello didn't confirm it's you");
                    await vault.unlockWithSecret(secret);
                  }
                : undefined
            }
          />
        </>
      );
    case "open":
      return <Main platform={platform} vault={vault} preview={preview} onLock={() => setPhase("locked")} />;
  }
}

type Filter = { kind?: ItemKind; favorite?: boolean; archived?: boolean; folderId?: string; tag?: string; vaultId?: string };

const SECTIONS: { id: string; label: string; icon: ReactNode; filter?: Filter }[] = [
  { id: "all", label: "All items", icon: <KeyRound className="h-4 w-4" />, filter: {} },
  { id: "favorites", label: "Favourites", icon: <Star className="h-4 w-4" />, filter: { favorite: true } },
  { id: "logins", label: "Logins", icon: <KeyRound className="h-4 w-4" />, filter: { kind: "login" } },
  { id: "cards", label: "Cards", icon: <CreditCard className="h-4 w-4" />, filter: { kind: "card" } },
  { id: "identities", label: "Identities", icon: <User className="h-4 w-4" />, filter: { kind: "identity" } },
  { id: "notes", label: "Secure notes", icon: <NotebookPen className="h-4 w-4" />, filter: { kind: "note" } },
  { id: "other", label: "Keys and documents", icon: <FileKey2 className="h-4 w-4" /> },
];

const TOOLS: { id: string; label: string; icon: ReactNode }[] = [
  { id: "codes", label: "2FA codes", icon: <ShieldCheck className="h-4 w-4" /> },
  { id: "generator", label: "Generator", icon: <Wand2 className="h-4 w-4" /> },
  { id: "security", label: "Security check", icon: <ShieldCheck className="h-4 w-4" /> },
  { id: "shared", label: "Shared vaults", icon: <Users className="h-4 w-4" /> },
  { id: "sends", label: "Sends", icon: <Send className="h-4 w-4" /> },
  { id: "bookmarks", label: "Bookmarks", icon: <Bookmark className="h-4 w-4" /> },
  { id: "archive", label: "Archive", icon: <Archive className="h-4 w-4" /> },
  { id: "trash", label: "Trash", icon: <Trash2 className="h-4 w-4" /> },
  { id: "devices", label: "Devices", icon: <MonitorSmartphone className="h-4 w-4" /> },
  { id: "activity", label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { id: "transfer", label: "Import and export", icon: <Upload className="h-4 w-4" /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon className="h-4 w-4" /> },
];

function routeFromHash(): string {
  return location.hash.replace(/^#\/?/, "") || "all";
}

function Main({ platform, vault, preview, onLock }: { platform: Platform; vault: VaultClient; preview: boolean; onLock: () => void }) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  // A reload part-way through setup lands here, with the kit still unconfirmed.
  const [kitNeeded, setKitNeeded] = useState(false);
  const needKit = useCallback(() => setKitNeeded(true), []);
  const [route, setRoute] = useState(routeFromHash());
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: string }[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [offline, setOffline] = useState(false);
  const [rollback, setRollback] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const toastId = useRef(0);
  const clipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const go = useCallback((r: string) => {
    location.hash = `#/${r}`;
    setRoute(r);
    setDrawer(false);
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    vault.store.getMeta<Settings>("settings").then((s) => s && setSettingsState({ ...DEFAULT_SETTINGS, ...s }));
  }, [vault]);

  const setSettings = useCallback(
    (s: Settings) => {
      setSettingsState(s);
      vault.store.setMeta("settings", s);
    },
    [vault],
  );

  const toast = useCallback<Ctx["toast"]>((text, kind = "ok") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const copy = useCallback<Ctx["copy"]>(
    async (text, what, sensitive = false) => {
      try {
        await platform.copy(text, sensitive);
      } catch {
        return toast("Couldn't copy here", "err");
      }
      if (sensitive) {
        const secs = settingsRef.current.clipboardSeconds;
        toast(`${what} copied. Clears in ${secs} seconds.`);
        if (clipTimer.current) clearTimeout(clipTimer.current);
        clipTimer.current = setTimeout(() => platform.clearClipboard?.().catch(() => undefined), secs * 1000);
      } else {
        toast(`${what} copied`);
      }
    },
    [platform, toast],
  );

  const lock = useCallback(async () => {
    // Leave these screens first: they throw if they draw again on a locked vault.
    onLock();
    await vault.lock();
    await platform.lock?.();
  }, [vault, platform, onLock]);

  // Auto-lock: idle time and sleep. A timer that fires far later than asked means
  // the machine slept.
  useEffect(() => {
    let last = Date.now();
    let beat = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const events = ["mousemove", "keydown", "pointerdown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const t = setInterval(() => {
      const now = Date.now();
      const s = settingsRef.current;
      if (s.lockOnSleep && now - beat > 60_000) lock();
      else if (now - last > s.autoLockMinutes * 60_000) lock();
      beat = now;
    }, 5000);
    return () => {
      clearInterval(t);
      events.forEach((e) => window.removeEventListener(e, touch));
    };
  }, [lock]);

  useEffect(
    () =>
      platform.subscribeChanged?.(async () => {
        await vault.reload();
        bump();
      }),
    [platform, vault, bump],
  );

  useEffect(() => {
    vault.onChange = () => {
      bump();
      platform.notifyChanged?.();
    };
    let live = true;
    const tick = async () => {
      try {
        const r = await vault.sync();
        if (!live) return;
        setOffline(r.offline);
        if (r.rollback.length) setRollback(true);
      } catch (e) {
        if (live && e instanceof ApiError && e.status === 401) {
          // The vault session ended (or was revoked): prove again.
          lock();
        }
      }
    };
    tick();
    const t = setInterval(tick, 30_000);
    const focus = () => tick();
    window.addEventListener("focus", focus);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener("focus", focus);
      vault.onChange = undefined;
    };
  }, [vault, platform, bump, lock]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctx: Ctx = { platform, vault, settings, setSettings, preview, version, bump, go, route, toast, copy };
  const folders = vault.unlocked ? vault.allItems({ includeSystem: true }).filter((i) => i.body.kind === "folder") : [];
  const tags = useMemo(() => {
    void version;
    if (!vault.unlocked) return [];
    const set = new Set<string>();
    for (const i of vault.allItems()) for (const t of i.body.tags ?? []) set.add(t);
    return [...set].sort();
  }, [vault, version]);

  const [vaultRows, setVaultRows] = useState<VaultInfo[]>([]);
  useEffect(() => {
    void version;
    if (!vault.unlocked) return;
    vault.vaults().then((all) => setVaultRows(all.filter((v) => (v.accepted || v.kind === "personal") && !v.hidden)));
  }, [vault, version]);

  const nav = (
    <nav aria-label="Passwords" className="flex h-full flex-col gap-1 overflow-y-auto p-2 text-sm">
      <div className="flex items-center justify-between px-2 py-1">
        <a href="/" className="flex items-center gap-2 font-semibold text-[var(--text)]">
          <img src="/item-icons/passwords-192.png" alt="" className="h-6 w-6 rounded-md" /> Passwords
        </a>
        {preview && <span data-testid="preview-badge" className="rounded bg-[var(--warning)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[var(--text)]">Preview</span>}
      </div>
      {SECTIONS.map((s) => (
        <NavRow key={s.id} active={route === s.id} icon={s.icon} label={s.label} onClick={() => go(s.id)} />
      ))}
      {vaultRows.length > 1 && <div className="mt-2 px-2 text-xs font-medium text-[var(--text-muted)]">Vaults</div>}
      {vaultRows.length > 1 &&
        vaultRows.map((v) => <NavRow key={v.id} active={route === `vault/${v.id}`} icon={<Users className="h-4 w-4" />} label={v.displayName} onClick={() => go(`vault/${v.id}`)} />)}
      <div className="mt-2 flex items-center justify-between px-2 text-xs font-medium text-[var(--text-muted)]">
        Folders
        <IconButton label="New folder" onClick={() => setFolderOpen(true)}><FolderPlus className="h-3.5 w-3.5" /></IconButton>
      </div>
      {folders.map((f) => (
        <NavRow key={f.id} active={route === `folder/${f.id}`} icon={<Folder className="h-4 w-4" />} label={f.body.title} onClick={() => go(`folder/${f.id}`)} />
      ))}
      {tags.length > 0 && <div className="mt-2 px-2 text-xs font-medium text-[var(--text-muted)]">Tags</div>}
      {tags.map((t) => (
        <NavRow key={t} active={route === `tag/${t}`} icon={<Tag className="h-4 w-4" />} label={t} onClick={() => go(`tag/${t}`)} />
      ))}
      <div className="mt-2 border-t border-[var(--border)] pt-2" />
      {TOOLS.map((s) => (
        <NavRow key={s.id} active={route === s.id} icon={s.icon} label={s.label} onClick={() => go(s.id)} />
      ))}
      <div className="mt-auto pt-2">
        <Button className="w-full" onClick={lock}><Lock className="h-4 w-4" /> Lock</Button>
      </div>
    </nav>
  );

  let content: ReactNode;
  const f = /^(folder|tag|item|vault)\/(.+)$/.exec(route);
  if (route === "codes") content = <CodesScreen />;
  else if (route === "generator") content = <GeneratorScreen />;
  else if (route === "security") content = <SecurityScreen />;
  else if (route === "shared") content = <SharedScreen />;
  else if (route === "sends") content = <SendsScreen />;
  else if (route === "bookmarks") content = <BookmarksScreen />;
  else if (route === "trash") content = <TrashScreen />;
  else if (route === "devices") content = <DevicesScreen />;
  else if (route === "activity") content = <ActivityScreen />;
  else if (route === "transfer") content = <TransferScreen />;
  else if (route === "settings") content = <SettingsScreen />;
  else {
    const section = SECTIONS.find((s) => s.id === route);
    let filter: Filter = section?.filter ?? {};
    let title = section?.label ?? "All items";
    if (route === "archive") {
      filter = { archived: true };
      title = "Archive";
    }
    if (f?.[1] === "folder") {
      filter = { folderId: f[2] };
      title = folders.find((x) => x.id === f[2])?.body.title ?? "Folder";
    }
    if (f?.[1] === "tag") {
      filter = { tag: f[2] };
      title = f[2];
    }
    if (f?.[1] === "vault") {
      filter = { vaultId: f[2] };
      title = vaultRows.find((v) => v.id === f[2])?.displayName ?? "Vault";
    }
    content = <ItemsScreen title={title} filter={filter} other={route === "other"} initialId={f?.[1] === "item" ? f[2] : null} />;
  }

  return (
    <VaultContext.Provider value={ctx}>
      <div className="flex h-[100dvh] bg-[var(--bg)]">
        <aside className="hidden w-60 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] md:block">{nav}</aside>
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
            <aside className="absolute bottom-0 left-0 top-0 w-64 bg-[var(--surface)]">{nav}</aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <MainNotices onNeedKit={needKit} />
          {kitNeeded && <KitGate onDone={() => setKitNeeded(false)} />}
          <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] p-2 md:hidden">
            <IconButton label="Menu" onClick={() => setDrawer(true)}><Menu className="h-5 w-5" /></IconButton>
            <span className="font-semibold text-[var(--text)]">Passwords</span>
            {preview && <span className="rounded bg-[var(--warning)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[var(--text)]">Preview</span>}
            <div className="ml-auto">
              <IconButton label="Search" onClick={() => setPalette(true)}><Search className="h-5 w-5" /></IconButton>
            </div>
          </header>
          {offline && <div className="bg-[var(--warning)]/15 px-3 py-1 text-xs text-[var(--text)]">Working offline. Your changes will sync when the server's back.</div>}
          {rollback && <Callout kind="danger">The server is showing an older copy of a vault than this device has seen. That can mean a restored backup, or something worse. Nothing was overwritten here.</Callout>}
          <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
            <Suspense fallback={<Spinner label="Loading…" />}>{content}</Suspense>
          </div>
        </div>
      </div>
      <div aria-live="polite" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`rounded-lg px-3 py-2 text-sm shadow-md ${t.kind === "err" ? "bg-[var(--danger)] text-white" : "bg-[var(--text)] text-[var(--bg)]"}`}>{t.text}</div>
        ))}
      </div>
      <QrCameraHost />
      {palette && <Palette onClose={() => setPalette(false)} />}
      {folderOpen && <NewFolder onClose={() => setFolderOpen(false)} />}
    </VaultContext.Provider>
  );
}

function NavRow({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[var(--text)] ${active ? "bg-[var(--surface-2)] font-medium" : "hover:bg-[var(--surface-1)]"}`}
    >
      <span className="text-[var(--text-muted)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function NewFolder({ onClose }: { onClose: () => void }) {
  const { vault, bump } = useCtx();
  const [name, setName] = useState("");
  return (
    <Modal title="New folder" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await vault.saveNew(await vault.personalVaultId(), newBody("folder", name.trim()));
          vault.sync().catch(() => undefined);
          bump();
          onClose();
        }}
      >
        <input className={inputClass} autoFocus aria-label="Folder name" value={name} onChange={(e) => setName(e.target.value)} />
        <Button kind="primary" type="submit">Create</Button>
      </form>
    </Modal>
  );
}

function useCtx(): Ctx {
  const c = useContextSafe();
  return c;
}

import { useContext } from "react";
function useContextSafe(): Ctx {
  const c = useContext(VaultContext);
  if (!c) throw new Error("no vault context");
  return c;
}

function matchesFilter(i: Item, f: Filter, other: boolean): boolean {
  if (other) return !["login", "card", "identity", "note"].includes(i.body.kind);
  if (f.archived) return !!i.body.archived;
  if (i.body.archived) return false;
  if (f.kind && i.body.kind !== f.kind) return false;
  if (f.favorite && !i.body.favorite) return false;
  if (f.folderId && i.body.folderId !== f.folderId) return false;
  if (f.tag && !(i.body.tags ?? []).includes(f.tag)) return false;
  if (f.vaultId && i.vaultId !== f.vaultId) return false;
  return true;
}

function subtitle(i: Item): string {
  const b = i.body;
  if (b.username) return b.username;
  const host = b.urls?.[0]?.url ? hostOf(b.urls[0].url) : null;
  if (host) return host;
  if (b.cardNumber) return `•••• ${b.cardNumber.slice(-4)}`;
  if (b.email) return b.email;
  return KIND_LABEL[b.kind] ?? b.kind;
}

function ItemsScreen({ title, filter, other, initialId }: { title: string; filter: Filter; other: boolean; initialId: string | null }) {
  const { vault, version, bump, toast } = useCtx();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(initialId);
  const [creating, setCreating] = useState<ItemKind | null>(null);
  const [menu, setMenu] = useState(false);
  const [vid, setVid] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    vault.personalVaultId().then(setVid);
  }, [vault]);
  useEffect(() => setSelected(initialId), [initialId, title]);

  const list = useMemo(() => {
    void version;
    return vault.search(query).filter((i) => matchesFilter(i, filter, other));
  }, [vault, query, filter, other, version]);

  const current = selected ? vault.get(selected) : undefined;

  // Only worth saying which vault when it isn't your own.
  const [vaultNames, setVaultNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    void version;
    vault.vaults().then((all) => setVaultNames(new Map(all.filter((v) => v.kind !== "personal").map((v) => [v.id, v.displayName]))));
  }, [vault, version]);
  const iconVaults = useMemo(() => {
    void version;
    return new Set(vault.allItems({ includeSystem: true }).filter((i) => i.body.kind === "prefs" && i.body.title === VAULT_PREFS && i.body.icon).map((i) => i.vaultId));
  }, [vault, version]);

  const detail = creating ? (
    <ItemEditor
      vaultId={filter.vaultId ?? vid}
      initial={newBody(creating, "", creating === "login" ? { urls: [{ url: "" }] } : {})}
      onCancel={() => setCreating(null)}
      onDone={(id) => {
        setCreating(null);
        setSelected(id);
        bump();
        toast("Saved");
      }}
    />
  ) : current ? (
    <ItemView key={current.id} item={current} onClosed={() => setSelected(null)} />
  ) : (
    <p className="p-6 text-center text-sm text-[var(--text-muted)]">Pick an item to see it.</p>
  );

  const showDetailOnPhone = !!creating || !!current;

  return (
    <div className="flex h-full gap-3">
      <section className={`flex w-full flex-col gap-2 md:w-72 md:shrink-0 ${showDetailOnPhone ? "hidden md:flex" : ""}`}>
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold text-[var(--text)]">{title}</h1>
          {filter.folderId && <FolderTools folderId={filter.folderId} />}
          <div className="relative">
            <Button small kind="primary" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}><Plus className="h-3.5 w-3.5" /> New</Button>
            {menu && (
              <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-md">
                {CREATABLE.map((k) => (
                  <button
                    key={k}
                    role="menuitem"
                    type="button"
                    className="block w-full rounded px-2 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-1)]"
                    onClick={() => {
                      setCreating(k);
                      setSelected(null);
                      setMenu(false);
                    }}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-[var(--text-muted)]" />
          <input ref={searchRef} className={`${inputClass} pl-8`} placeholder="Search" aria-label="Search your vault" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button type="button" aria-label="Clear search" className="absolute right-2 top-2.5 text-[var(--text-muted)]" onClick={() => setQuery("")}><X className="h-4 w-4" /></button>
          )}
        </div>
        <ul aria-label="Items" className="min-h-0 flex-1 overflow-y-auto">
          {list.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                aria-current={selected === i.id ? "true" : undefined}
                onClick={() => {
                  setCreating(null);
                  setSelected(i.id);
                }}
                className={`flex w-full flex-col rounded-lg px-2 py-2 text-left ${selected === i.id ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-1)]"}`}
              >
                <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-[var(--text)]">
                  {(i.body.icon || iconVaults.has(i.vaultId)) && <SiteIcon url={i.body.urls?.[0]?.url} />}
                  {i.body.favorite ? "★ " : ""}{i.body.title || "(no name)"}
                </span>
                <span className="truncate text-xs text-[var(--text-muted)]">{subtitle(i)}{vaultNames.get(i.vaultId) ? ` · ${vaultNames.get(i.vaultId)}` : ""}</span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="p-3 text-sm text-[var(--text-muted)]">{query ? "Nothing matches that." : "Nothing here yet."}</li>}
        </ul>
        <button type="button" className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]" onClick={() => vault.sync().then(() => { bump(); toast("Synced"); }).catch(() => toast("Couldn't sync", "err"))}>
          <RefreshCw className="h-3 w-3" /> Sync now
        </button>
      </section>
      <section className={`min-w-0 flex-1 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 md:p-4 ${showDetailOnPhone ? "" : "hidden md:block"}`}>
        {showDetailOnPhone && (
          <button type="button" className="mb-2 text-sm text-[var(--accent-text)] md:hidden" onClick={() => { setSelected(null); setCreating(null); }}>← Back</button>
        )}
        {detail}
      </section>
    </div>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const { vault, go } = useCtx();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const places = [...SECTIONS, ...TOOLS];
  const results = useMemo(() => {
    const ql = q.toLowerCase();
    const p = places.filter((x) => !ql || x.label.toLowerCase().includes(ql)).map((x) => ({ id: `place:${x.id}`, label: x.label, hint: "Go to", route: x.id }));
    const items = ql ? vault.search(q).slice(0, 20).map((i) => ({ id: i.id, label: i.body.title, hint: subtitle(i), route: `item/${i.id}` })) : [];
    return [...items, ...p].slice(0, 30);
  }, [q, vault]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (r: { route: string }) => {
    go(r.route);
    onClose();
  };
  return (
    <Modal title="Find anything in your vault" onClose={onClose}>
      <input
        className={inputClass}
        autoFocus
        aria-label="Search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setAt((a) => Math.min(a + 1, results.length - 1));
          if (e.key === "ArrowUp") setAt((a) => Math.max(a - 1, 0));
          if (e.key === "Enter" && results[at]) choose(results[at]);
        }}
      />
      <ul className="mt-2 max-h-80 overflow-auto">
        {results.map((r, i) => (
          <li key={r.id}>
            <button type="button" onClick={() => choose(r)} className={`flex w-full justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-[var(--text)] ${i === at ? "bg-[var(--surface-2)]" : ""}`}>
              <span className="truncate">{r.label}</span>
              <span className="shrink-0 text-xs text-[var(--text-muted)]">{r.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export { MemoryStore };

/** Only for items that asked. Goes through your server, so the site sees the server and
 *  not you; the server sees the domain at that moment and keeps nothing. */
const iconCache = new Map<string, string | null>();
function SiteIcon({ url }: { url?: string }) {
  const { platform } = useVault();
  const host = url ? hostOf(url) : null;
  const [src, setSrc] = useState<string | null>(host ? iconCache.get(host) ?? null : null);
  useEffect(() => {
    if (!host || iconCache.has(host)) return;
    let live = true;
    platform.api
      .icon(host)
      .then((raw: ArrayBuffer) => {
        const made = URL.createObjectURL(new Blob([raw]));
        iconCache.set(host, made);
        if (live) setSrc(made);
      })
      .catch(() => iconCache.set(host, null));
    return () => {
      live = false;
    };
  }, [host, platform]);
  return src ? <img src={src} alt="" className="h-4 w-4 shrink-0 rounded-sm" /> : null;
}
