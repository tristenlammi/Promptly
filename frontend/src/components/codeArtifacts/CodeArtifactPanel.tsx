import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Copy,
  Download,
  FolderOpen,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useCodeArtifactStore } from "@/stores/codeArtifactStore";
import { filesApi } from "@/api/files";
import { cn } from "@/utils/cn";

import { CodeArtifactView } from "./CodeArtifactView";
import {
  driveArtifactMeta,
  humanLanguageLabel,
  isPreviewableLanguage,
} from "./previewable";

/**
 * Split-pane companion for the chat — NOT a modal overlay.
 *
 * Mounted by ``ChatPage`` as a sibling of the chat column inside a
 * horizontal flex row. When closed, this component renders nothing
 * and the chat column owns the full width. When open, the panel
 * takes its width from a CSS variable ``--artifact-panel-width``
 * which is driven by the resizer ``<button>`` on its left edge.
 *
 * The width is persisted to ``localStorage`` so the user's last
 * preferred split survives a refresh / new chat. Default is 50 %
 * of the parent flex row, clamped to 320–80 % so the chat is
 * never crushed and the panel never disappears.
 *
 * Why a button, not a div, for the resizer? It's keyboard-
 * focusable and screen-readers announce it correctly with
 * ``aria-orientation="vertical"``. Mouse / touch drag is layered
 * on top via pointer events (mousedown + pointercapture).
 */
const STORAGE_KEY = "promptly:codeArtifactPanel:widthPx";
const DEFAULT_WIDTH_PX = 560;
const MIN_WIDTH_PX = 320;

export function CodeArtifactPanel() {
  const open = useCodeArtifactStore((s) => s.open);
  const payload = useCodeArtifactStore((s) => s.payload);
  const draft = useCodeArtifactStore((s) => s.draft);
  const activeTab = useCodeArtifactStore((s) => s.activeTab);
  const setDraft = useCodeArtifactStore((s) => s.setDraft);
  const resetDraft = useCodeArtifactStore((s) => s.resetDraft);
  const setActiveTab = useCodeArtifactStore((s) => s.setActiveTab);
  const closeArtifact = useCodeArtifactStore((s) => s.closeArtifact);

  const [widthPx, setWidthPx] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_WIDTH_PX;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    const n = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(n) && n >= MIN_WIDTH_PX ? n : DEFAULT_WIDTH_PX;
  });

  // Persist to localStorage on commit (drag end), not on every
  // mousemove — saves a few hundred storage writes per drag.
  const persistWidth = useCallback((next: number) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(next)));
    } catch {
      // Ignore storage quota / private-mode failures.
    }
  }, []);

  // Esc closes — same affordance as before, plus ``Ctrl+\`` toggles
  // the panel which is what most editors use for sidebars.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeArtifact();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeArtifact]);

  if (!open || !payload) return null;

  const { language, filenameStem, sourceFileId } = payload;
  const meta = driveArtifactMeta(language);
  const filename = `${filenameStem || "artifact"}.${meta.extension}`;

  return (
    <>
      <Resizer
        widthPx={widthPx}
        onResize={setWidthPx}
        onCommit={persistWidth}
      />
      <aside
        style={{ width: `${widthPx}px`, flexShrink: 0 }}
        className={cn(
          "flex h-full min-w-0 flex-col",
          "border-l border-[var(--border)] bg-[var(--bg)]"
        )}
        aria-label="Code artifact panel"
      >
        <Header
          title={filename}
          subtitle={`${humanLanguageLabel(language)}${
            isPreviewableLanguage(language) ? " · live preview" : ""
          }`}
          onClose={closeArtifact}
        />

        <div className="min-h-0 flex-1">
          <CodeArtifactView
            source={draft}
            language={language}
            onChange={setDraft}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
          />
        </div>

        <Footer
          draft={draft}
          filename={filename}
          mime={meta.mime}
          canSaveToDrive={!sourceFileId}
          onReset={resetDraft}
        />
      </aside>
    </>
  );
}

/** Vertical drag handle between the chat column and the panel.
 *  Mouse / touch dragging via pointer events; keyboard
 *  arrow-keys nudge the width 24 px at a time. The bar is only 4
 *  px wide visually but has a 12-px hit area so users on a
 *  trackpad can still grab it without pixel-perfect aim. */
function Resizer({
  widthPx,
  onResize,
  onCommit,
}: {
  widthPx: number;
  onResize: (next: number) => void;
  onCommit: (final: number) => void;
}) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = widthPx;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging.current) return;
    // Drag left to grow the panel (which is on the right).
    const delta = startX.current - e.clientX;
    const proposed = startWidth.current + delta;
    const max = Math.max(MIN_WIDTH_PX + 100, window.innerWidth - 320);
    const next = Math.min(Math.max(proposed, MIN_WIDTH_PX), max);
    onResize(next);
  };

  const finish = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer may already be released; ignore.
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onCommit(widthPx);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const STEP = e.shiftKey ? 96 : 24;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const next = Math.min(widthPx + STEP, window.innerWidth - 320);
      onResize(next);
      onCommit(next);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = Math.max(widthPx - STEP, MIN_WIDTH_PX);
      onResize(next);
      onCommit(next);
    }
  };

  return (
    <button
      type="button"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize artifact panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      // Slim visible bar inside a fatter hit area. The translate
      // / hover-color is what gives the user feedback that this is
      // a drag handle without us having to draw a fat divider.
      className={cn(
        "group relative h-full w-1.5 shrink-0 cursor-col-resize",
        "bg-[var(--border)] transition-colors hover:bg-[var(--accent)]",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      )}
    >
      <span className="absolute inset-y-0 -left-1.5 -right-1.5" aria-hidden="true" />
    </button>
  );
}

function Header({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-[var(--text)]" title={title}>
          {title}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
          {subtitle}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close (Esc)"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg)] hover:text-[var(--text)]"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

function Footer({
  draft,
  filename,
  mime,
  canSaveToDrive,
  onReset,
}: {
  draft: string;
  filename: string;
  mime: string;
  canSaveToDrive: boolean;
  onReset: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <FooterButton
        onClick={onReset}
        icon={<RotateCcw className="h-3.5 w-3.5" />}
        label="Reset"
        title="Revert to original source"
      />
      <div className="ml-auto flex items-center gap-2">
        <CopyButton text={draft} />
        <DownloadButton text={draft} filename={filename} mime={mime} />
        {canSaveToDrive && (
          <SaveToDriveButton text={draft} filename={filename} mime={mime} />
        )}
      </div>
    </div>
  );
}

function FooterButton({
  onClick,
  icon,
  label,
  title,
  variant = "ghost",
  disabled = false,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: React.ReactNode;
  title: string;
  variant?: "ghost" | "primary";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition",
        variant === "primary"
          ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
          : "border border-[var(--border)] bg-[var(--bg)] text-[var(--text)] hover:bg-[var(--surface-1)]",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <FooterButton
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          // Clipboard may be unavailable on insecure origins.
        }
      }}
      icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      label={copied ? "Copied" : "Copy"}
      title="Copy to clipboard"
    />
  );
}

function DownloadButton({
  text,
  filename,
  mime,
}: {
  text: string;
  filename: string;
  mime: string;
}) {
  return (
    <FooterButton
      onClick={() => {
        const blob = new Blob([text], { type: `${mime};charset=utf-8` });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}
      icon={<Download className="h-3.5 w-3.5" />}
      label="Download"
      title="Download to your computer"
    />
  );
}

function SaveToDriveButton({
  text,
  filename,
  mime,
}: {
  text: string;
  filename: string;
  mime: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const save = useCallback(async () => {
    setState("saving");
    setErrMsg(null);
    try {
      const blob = new Blob([text], { type: `${mime};charset=utf-8` });
      const file = new File([blob], filename, { type: mime });
      await filesApi.upload("mine", file, null, "generated");
      await qc.invalidateQueries({ queryKey: ["files"] });
      await qc.invalidateQueries({ queryKey: ["quota"] });
      setState("saved");
    } catch (e) {
      setState("error");
      setErrMsg(e instanceof Error ? e.message : String(e));
    }
  }, [text, filename, mime, qc]);

  if (state === "saved") {
    return (
      <FooterButton
        onClick={() => navigate("/files")}
        icon={<FolderOpen className="h-3.5 w-3.5" />}
        label="Open in Drive"
        title="Saved — jump to Drive"
        variant="primary"
      />
    );
  }

  return (
    <FooterButton
      onClick={save}
      disabled={state === "saving"}
      icon={<Save className="h-3.5 w-3.5" />}
      label={
        state === "saving"
          ? "Saving…"
          : state === "error"
            ? "Retry save"
            : "Save to Drive"
      }
      title={errMsg || "Save a copy to your personal Drive"}
      variant="primary"
    />
  );
}
