import { useEffect, useMemo, useState } from "react";
import { Download, Share, X } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useIsStandalone } from "@/hooks/useIsStandalone";
import { cn } from "@/utils/cn";

/**
 * "Install Promptly Files as an App" indicator rendered on every
 * Drive route.
 *
 * This chip is the user's path to installing the *Files* PWA as a
 * distinct app on their home screen. Importantly, it must stay
 * visible **even when the user is already inside the main Promptly
 * PWA** — installing a second PWA is the whole point, so
 * ``display-mode: standalone`` alone is not a reason to hide it.
 *
 * Behaviour by platform:
 *
 *   - Chrome/Android/Edge (browser or inside main Promptly PWA):
 *     listens for ``beforeinstallprompt``, stashes the deferred
 *     event, and fires it on click. Works because the Files
 *     manifest declares a narrower ``scope: "/files/"`` + unique
 *     ``id`` so the browser treats it as an app distinct from any
 *     already-installed Promptly app.
 *
 *   - When no ``beforeinstallprompt`` fires (e.g. in the installed
 *     main PWA's restricted surface, or before the engagement
 *     heuristic has triggered): the chip still works — tapping it
 *     opens a manual-install help sheet appropriate for the
 *     detected platform (Android or iOS).
 *
 *   - iOS Safari never fires ``beforeinstallprompt``; the chip
 *     always opens the iOS help sheet with the Share → Add to
 *     Home Screen walkthrough.
 *
 * Hidden conditions:
 *   - User confirmed the Files PWA install (``appinstalled`` fired
 *     *or* they've since launched a session inside the Files PWA —
 *     see ``isInsideFilesPwa()`` below).
 *   - User dismissed the chip — suppressed for ``DISMISS_DAYS`` via
 *     a Files-specific ``localStorage`` key.
 *
 * The component slots into ``DriveSubNav`` next to the storage
 * pill, which is why it stays visually tiny.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "promptly-files:install-dismissed-until";
const INSTALLED_KEY = "promptly-files:installed";
const DISMISS_DAYS = 14;

export function InstallFilesPwaButton({ className }: { className?: string }) {
  const standalone = useIsStandalone();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() =>
    readInstalledFlag()
  );
  const [showIosSheet, setShowIosSheet] = useState(false);
  const [showAndroidSheet, setShowAndroidSheet] = useState(false);
  const [dismissedUntil, setDismissedUntil] = useState<number>(() =>
    readDismissedUntil()
  );

  const isIos = useIsIos();
  // Detect whether *this* running window is the Files PWA itself
  // (as opposed to the main Promptly PWA, or a regular browser tab).
  // We rely on the launched ``start_url`` marker plus the scoped
  // ``display-mode: standalone``: if both are true the user already
  // has the Files app installed and is using it right now.
  const insideFilesPwa = useInsideFilesPwa(standalone);

  // Persist "user has the Files PWA" so we can keep the chip hidden
  // on subsequent sessions when the user visits /files from inside
  // the main Promptly PWA.
  useEffect(() => {
    if (insideFilesPwa && !installed) {
      writeInstalledFlag(true);
      setInstalled(true);
    }
  }, [insideFilesPwa, installed]);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      writeInstalledFlag(true);
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismissed = dismissedUntil > Date.now();

  // Hide only when we're sure the user already has it — or they
  // asked us to shut up. Crucially we do **not** hide just because
  // ``standalone`` is true: that's how we stayed invisible inside
  // the main Promptly PWA before.
  if (installed || insideFilesPwa || dismissed) return null;

  const onInstallClick = async () => {
    // Chromium happy path — we have a deferred install event.
    if (deferred) {
      try {
        await deferred.prompt();
        const choice = await deferred.userChoice;
        if (choice.outcome === "accepted") {
          writeInstalledFlag(true);
          setInstalled(true);
        }
      } finally {
        setDeferred(null);
      }
      return;
    }
    // No native prompt available — fall back to platform-specific
    // instructions. Order matters: iOS first because the
    // user-agent check is more specific.
    if (isIos) {
      setShowIosSheet(true);
      return;
    }
    setShowAndroidSheet(true);
  };

  const onDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    const until = Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000;
    try {
      localStorage.setItem(DISMISS_KEY, String(until));
    } catch {
      /* localStorage unavailable — silently skip persistence */
    }
    setDismissedUntil(until);
  };

  return (
    <>
      <div
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 pl-2 pr-1 py-0.5 text-[11px] font-medium text-[var(--accent)]",
          "shadow-sm",
          className
        )}
      >
        <button
          type="button"
          onClick={onInstallClick}
          className="inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 transition hover:bg-[var(--accent)]/15"
          title="Install Promptly Files as an app"
          aria-label="Install Promptly Files as an app"
        >
          <Download className="h-3 w-3" />
          <span className="hidden sm:inline">Install Files app</span>
          <span className="sm:hidden">Install</span>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss install prompt"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--accent)]/70 transition hover:bg-[var(--accent)]/15 hover:text-[var(--accent)]"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <IosInstallSheet
        open={showIosSheet}
        onClose={() => setShowIosSheet(false)}
      />
      <AndroidInstallSheet
        open={showAndroidSheet}
        hostPwa={standalone}
        onClose={() => setShowAndroidSheet(false)}
        onMarkInstalled={() => {
          writeInstalledFlag(true);
          setInstalled(true);
          setShowAndroidSheet(false);
        }}
      />
    </>
  );
}

function readDismissedUntil(): number {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function readInstalledFlag(): boolean {
  try {
    return localStorage.getItem(INSTALLED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInstalledFlag(v: boolean) {
  try {
    if (v) localStorage.setItem(INSTALLED_KEY, "1");
    else localStorage.removeItem(INSTALLED_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Best-effort detection of whether this window is running as the
 * Files PWA itself (rather than the main Promptly PWA or a normal
 * browser tab). We rely on two signals:
 *   - ``display-mode: standalone`` is true, AND
 *   - The initial navigation was into /files with ``?source=pwa``
 *     (our ``start_url`` marker) OR ``?source=pwa-shortcut``
 *     (launched from a manifest shortcut).
 * The ``source=pwa`` marker is stashed in ``sessionStorage`` the
 * first time we see it so that subsequent in-PWA navigation
 * (which strips the query string) still counts.
 */
function useInsideFilesPwa(standalone: boolean): boolean {
  return useMemo(() => {
    if (typeof window === "undefined") return false;
    if (!standalone) return false;
    const onDrive =
      window.location.pathname === "/files" ||
      window.location.pathname.startsWith("/files/");
    if (!onDrive) return false;
    const qs = new URLSearchParams(window.location.search);
    const source = qs.get("source");
    const markedThisLoad = source === "pwa" || source === "pwa-shortcut";
    const SESSION_KEY = "promptly-files:pwa-session";
    try {
      if (markedThisLoad) sessionStorage.setItem(SESSION_KEY, "1");
      return markedThisLoad || sessionStorage.getItem(SESSION_KEY) === "1";
    } catch {
      return markedThisLoad;
    }
  }, [standalone]);
}

function useIsIos(): boolean {
  const [isIos, setIsIos] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = navigator.userAgent || "";
    // iPad on iPadOS 13+ reports as Mac; sniff ``Macintosh`` + touch.
    const hasTouch =
      "maxTouchPoints" in navigator && (navigator as Navigator).maxTouchPoints > 1;
    const looksIos =
      /iP(ad|hone|od)/.test(ua) ||
      (ua.includes("Macintosh") && hasTouch);
    const notInAppBrowser = !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    setIsIos(looksIos && notInAppBrowser);
  }, []);
  return isIos;
}

function IosInstallSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Install Promptly Files"
      description="Keep your files one tap away — add Promptly Files to your home screen."
      footer={
        <Button variant="primary" size="sm" onClick={onClose}>
          Got it
        </Button>
      }
    >
      <ol className="space-y-3 text-sm">
        <li className="flex items-start gap-3">
          <StepNumber>1</StepNumber>
          <span>
            Tap the <span className="mx-1 inline-flex items-center gap-1 rounded-md bg-[var(--bg)] px-1.5 py-0.5 font-medium"><Share className="h-3 w-3" />Share</span>
            button at the bottom (Safari) or top (iPad) of the screen.
          </span>
        </li>
        <li className="flex items-start gap-3">
          <StepNumber>2</StepNumber>
          <span>
            Scroll down and choose <span className="font-medium">Add to Home Screen</span>.
          </span>
        </li>
        <li className="flex items-start gap-3">
          <StepNumber>3</StepNumber>
          <span>
            Confirm the name (<span className="font-medium">Promptly Files</span>) and tap <span className="font-medium">Add</span>.
            The Files app icon will appear on your home screen.
          </span>
        </li>
      </ol>
      <p className="mt-4 text-xs text-[var(--text-muted)]">
        Opening Promptly Files from the home screen launches it as a standalone app —
        no browser chrome, just your Drive. You can still use Promptly Chat from its
        own icon at the same time.
      </p>
    </Modal>
  );
}

/**
 * Android install walkthrough shown when Chrome didn't give us a
 * deferred install event. Two realistic reasons that happens:
 *   1. The page is being viewed inside the main Promptly PWA — the
 *      Android system's ``beforeinstallprompt`` is often suppressed
 *      in an already-standalone surface. The fix is to open this
 *      URL in Chrome proper and install from there.
 *   2. Chrome's engagement heuristic hasn't triggered yet. Same
 *      Chrome-menu path still works.
 * Either way we walk the user through the Chrome overflow menu —
 * the one action the user can always take to install a PWA
 * manually on Android.
 */
function AndroidInstallSheet({
  open,
  onClose,
  onMarkInstalled,
  hostPwa,
}: {
  open: boolean;
  onClose: () => void;
  onMarkInstalled: () => void;
  /** True if the chip was tapped from inside a standalone PWA
   *  (meaning the user must jump to Chrome first). */
  hostPwa: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Install Promptly Files"
      description="Add a dedicated Files icon to your home screen."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onMarkInstalled}>
            I installed it
          </Button>
        </>
      }
    >
      <ol className="space-y-3 text-sm">
        {hostPwa && (
          <li className="flex items-start gap-3">
            <StepNumber>1</StepNumber>
            <span>
              Tap the <span className="font-medium">⋮</span> menu in the top-right
              of the Promptly app, then choose{" "}
              <span className="font-medium">Open in Chrome</span> (or
              <span className="font-medium"> Open in browser</span>).
            </span>
          </li>
        )}
        <li className="flex items-start gap-3">
          <StepNumber>{hostPwa ? 2 : 1}</StepNumber>
          <span>
            In Chrome, make sure the URL bar shows <span className="font-mono">/files</span>.
          </span>
        </li>
        <li className="flex items-start gap-3">
          <StepNumber>{hostPwa ? 3 : 2}</StepNumber>
          <span>
            Tap the <span className="font-medium">⋮</span> menu in Chrome and choose{" "}
            <span className="font-medium">Install app</span> (sometimes labelled{" "}
            <span className="font-medium">Add to Home screen</span>).
          </span>
        </li>
        <li className="flex items-start gap-3">
          <StepNumber>{hostPwa ? 4 : 3}</StepNumber>
          <span>
            Confirm the name (<span className="font-medium">Promptly Files</span>) and tap{" "}
            <span className="font-medium">Install</span>. The Files icon will appear on
            your home screen and open straight into your Drive.
          </span>
        </li>
      </ol>
      <p className="mt-4 text-xs text-[var(--text-muted)]">
        Promptly Files is a separate app from Promptly Chat — installing one doesn't
        remove the other, and they can both run at the same time.
      </p>
    </Modal>
  );
}

function StepNumber({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/15 text-[11px] font-semibold text-[var(--accent)]">
      {children}
    </span>
  );
}
