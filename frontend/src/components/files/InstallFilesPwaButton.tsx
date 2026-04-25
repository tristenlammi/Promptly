import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useIsStandalone } from "@/hooks/useIsStandalone";
import { cn } from "@/utils/cn";

/**
 * "Install Promptly Files as an App" indicator rendered only on
 * Drive routes.
 *
 * Behaviour:
 *   - Chrome/Android/Edge: listens for ``beforeinstallprompt``,
 *     stashes the deferred prompt, and fires it from our Install
 *     button. Once accepted or dismissed the event is consumed and
 *     the button hides itself.
 *   - iOS Safari: never fires ``beforeinstallprompt``, so we fall
 *     back to a short instructions sheet ("Share → Add to Home
 *     Screen"). Detected via user-agent sniffing — this is the one
 *     legitimate place for it, since the spec gives us no other
 *     feature test.
 *   - Already installed (``display-mode: standalone``): render
 *     nothing at all. Done, dusted.
 *   - User-dismissed: suppressed for ``DISMISS_DAYS`` via
 *     ``localStorage``. The key is Files-specific so this doesn't
 *     conflict with the main Promptly install banner.
 *
 * The component is visually tiny by design — a single pill-shaped
 * chip that slots into ``DriveSubNav`` next to the storage indicator.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "promptly-files:install-dismissed-until";
const DISMISS_DAYS = 14;

export function InstallFilesPwaButton({ className }: { className?: string }) {
  const standalone = useIsStandalone();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [showIosSheet, setShowIosSheet] = useState(false);
  const [dismissedUntil, setDismissedUntil] = useState<number>(() =>
    readDismissedUntil()
  );

  const isIos = useIsIos();

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
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

  // Never render if: already installed, already dismissed recently,
  // or (Chromium path) we haven't captured the install prompt AND
  // this isn't iOS. iOS is the one platform where we show the chip
  // without a deferred event because there's no API — the chip
  // opens our instructions sheet instead.
  const dismissed = dismissedUntil > Date.now();
  const canInstallChromium = !!deferred;
  const canShowIosHelp = isIos && !standalone;
  if (installed || standalone || dismissed) return null;
  if (!canInstallChromium && !canShowIosHelp) return null;

  const onInstallClick = async () => {
    if (deferred) {
      try {
        await deferred.prompt();
        await deferred.userChoice;
      } finally {
        setDeferred(null);
      }
      return;
    }
    if (isIos) {
      setShowIosSheet(true);
    }
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

function StepNumber({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/15 text-[11px] font-semibold text-[var(--accent)]">
      {children}
    </span>
  );
}
