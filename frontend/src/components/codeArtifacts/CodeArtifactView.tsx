import { useEffect, useMemo, useState } from "react";

import { ArtifactCodeEditor } from "./ArtifactCodeEditor";
import { HtmlPreview } from "./previews/HtmlPreview";
import { SvgPreview } from "./previews/SvgPreview";
import { MarkdownPreview } from "./previews/MarkdownPreview";
import { JsonPreview } from "./previews/JsonPreview";
import { CsvPreview } from "./previews/CsvPreview";
import {
  type ArtifactLanguage,
  humanLanguageLabel,
  isPreviewableLanguage,
} from "./previewable";
import { cn } from "@/utils/cn";

/**
 * Body of the Code Artifact experience — the Preview / Code tab
 * switcher plus the two tab contents. Rendered standalone by:
 *
 * 1. The ``CodeArtifactPanel`` (over-chat side panel with header
 *    + footer). It owns edit state and Save-to-Drive.
 * 2. The Drive ``FilePreviewModal`` — which loads a file's body,
 *    wraps it in this view, and makes the Code tab read-only
 *    (edits in Drive don't round-trip to the file without an
 *    explicit save, which we don't build in this MVP).
 *
 * Debouncing the editor -> preview sync (250 ms) keeps the HTML
 * iframe from reloading on every keystroke.
 */
export function CodeArtifactView({
  source,
  language,
  readOnly = false,
  onChange,
  activeTab,
  onActiveTabChange,
}: {
  source: string;
  language: ArtifactLanguage;
  readOnly?: boolean;
  onChange?: (next: string) => void;
  /** Controlled active tab. If omitted we manage state locally. */
  activeTab?: "preview" | "code";
  onActiveTabChange?: (tab: "preview" | "code") => void;
}) {
  const canPreview = isPreviewableLanguage(language);

  // Internal state when the parent doesn't control it (e.g. used
  // from FilePreviewModal where the modal chrome has no tabs).
  const [internalTab, setInternalTab] = useState<"preview" | "code">(
    canPreview ? "preview" : "code"
  );
  const tab = activeTab ?? internalTab;
  const setTab = (next: "preview" | "code") => {
    if (onActiveTabChange) onActiveTabChange(next);
    else setInternalTab(next);
  };

  // Force Code tab whenever preview is unavailable (prevents a
  // stale "preview" tab selection after the user opens an artifact
  // in a non-previewable language from the store).
  useEffect(() => {
    if (!canPreview && tab !== "code") setTab("code");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPreview]);

  // Debounce what the preview sees so an iframe isn't recreated on
  // every keystroke. The editor is always in sync with ``source``.
  const debouncedSource = useDebouncedValue(source, 250);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5">
        <TabButton
          active={tab === "preview"}
          disabled={!canPreview}
          onClick={() => setTab("preview")}
          label={canPreview ? "Preview" : "Preview (not available)"}
        >
          Preview
        </TabButton>
        <TabButton
          active={tab === "code"}
          onClick={() => setTab("code")}
          label="Code"
        >
          Code
        </TabButton>
        <div className="ml-auto text-xs text-[var(--text-muted)]">
          {humanLanguageLabel(language)}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        {tab === "preview" && canPreview ? (
          <PreviewForLanguage language={language} source={debouncedSource} />
        ) : (
          <ArtifactCodeEditor
            value={source}
            language={language}
            onChange={readOnly ? undefined : onChange}
            readOnly={readOnly}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  label,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        "rounded-md px-3 py-1 text-sm transition",
        active
          ? "bg-[var(--bg)] text-[var(--text)] shadow-sm"
          : "text-[var(--text-muted)] hover:bg-[var(--bg)] hover:text-[var(--text)]",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[var(--text-muted)]"
      )}
    >
      {children}
    </button>
  );
}

function PreviewForLanguage({
  language,
  source,
}: {
  language: ArtifactLanguage;
  source: string;
}) {
  switch (language) {
    case "html":
      return <HtmlPreview source={source} />;
    case "svg":
      return <SvgPreview source={source} />;
    case "markdown":
      return <MarkdownPreview source={source} />;
    case "json":
      return <JsonPreview source={source} />;
    case "csv":
      return <CsvPreview source={source} />;
    default:
      return (
        <div className="flex h-full w-full items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg)] p-6 text-sm text-[var(--text-muted)]">
          No preview available for this language.
        </div>
      );
  }
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return useMemo(() => debounced, [debounced]);
}
