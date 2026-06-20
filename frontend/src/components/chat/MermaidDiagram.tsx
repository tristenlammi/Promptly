import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Code2, Maximize2, Minus, Plus, Workflow, X } from "lucide-react";

import { cn } from "@/utils/cn";

// Mermaid is a heavy dependency, so it's dynamically imported on first
// use rather than bundled into the main chat chunk. ``initialize`` is
// idempotent but we guard it so theme/config is only set once.
let initPromise: Promise<typeof import("mermaid").default> | null = null;

async function getMermaid() {
  if (!initPromise) {
    initPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        // Model output is untrusted — ``strict`` strips scripts and
        // disallows HTML labels so a malicious diagram can't inject.
        securityLevel: "strict",
        theme: document.documentElement.classList.contains("dark")
          ? "dark"
          : "default",
        fontFamily: "inherit",
      });
      return mermaid;
    });
  }
  return initPromise;
}

/**
 * Renders a ` ```mermaid ` fenced block as an SVG diagram (Phase 2.3).
 *
 * While the reply is still streaming the fenced source is usually
 * incomplete / unparseable — in that case (and on any genuine syntax
 * error) we quietly fall back to showing the raw code so the user
 * never sees a broken render. A small toggle flips between the diagram
 * and its source.
 */
export function MermaidDiagram({ code }: { code: string }) {
  // ``useId`` yields a stable id with colons that are illegal in the
  // SVG element ids mermaid generates — strip them.
  const baseId = useId().replace(/[:]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [scale, setScale] = useState(1);
  const renderSeq = useRef(0);

  const openExpanded = () => {
    setScale(1);
    setExpanded(true);
  };

  // Close the lightbox on Escape; lock body scroll while it's open.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);

  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed) {
      setSvg(null);
      setFailed(false);
      return;
    }
    const seq = ++renderSeq.current;
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = await getMermaid();
        // ``parse`` throws on invalid syntax without mutating the DOM,
        // which is the cheap way to detect a mid-stream / broken block.
        await mermaid.parse(trimmed);
        const { svg: out } = await mermaid.render(
          `mermaid-${baseId}-${seq}`,
          trimmed
        );
        if (!cancelled && seq === renderSeq.current) {
          setSvg(out);
          setFailed(false);
        }
      } catch {
        if (!cancelled && seq === renderSeq.current) {
          setFailed(true);
          setSvg(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, baseId]);

  // Fallback: render the raw fenced source (streaming / unparseable).
  if (failed || svg == null) {
    return (
      <pre>
        <code className="language-mermaid">{code}</code>
      </pre>
    );
  }

  const toolbarBtn = cn(
    "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
    "bg-black/[0.04] text-[var(--text-muted)] opacity-0 transition",
    "hover:text-[var(--text)] group-hover:opacity-100 focus:opacity-100",
    "dark:bg-white/[0.06]"
  );

  return (
    <>
      <div
        className={cn(
          "group relative my-2 overflow-x-auto rounded-card border p-3",
          "border-[var(--border)] bg-[var(--surface)]"
        )}
      >
        {showSource ? (
          <pre className="overflow-x-auto">
            <code className="language-mermaid">{code}</code>
          </pre>
        ) : (
          <button
            type="button"
            onClick={openExpanded}
            title="Click to enlarge"
            className="flex w-full cursor-zoom-in justify-center [&_svg]:h-auto [&_svg]:max-w-full"
            // SVG comes from mermaid with securityLevel "strict" (no
            // scripts / foreignObject HTML), so injecting it is safe.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
        <div className="absolute right-2 top-2 flex items-center gap-1">
          {!showSource && (
            <button
              type="button"
              onClick={openExpanded}
              className={toolbarBtn}
              aria-label="Enlarge diagram"
              title="Enlarge diagram"
            >
              <Maximize2 className="h-3 w-3" />
              Enlarge
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowSource((s) => !s)}
            className={toolbarBtn}
            aria-label={showSource ? "Show diagram" : "Show source"}
            title={showSource ? "Show diagram" : "Show Mermaid source"}
          >
            {showSource ? (
              <>
                <Workflow className="h-3 w-3" />
                Diagram
              </>
            ) : (
              <>
                <Code2 className="h-3 w-3" />
                Source
              </>
            )}
          </button>
        </div>
      </div>

      {expanded &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex flex-col bg-black/80 backdrop-blur-sm"
            onClick={() => setExpanded(false)}
          >
            {/* Toolbar */}
            <div
              className="flex shrink-0 items-center justify-end gap-1.5 p-3"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(0.25, s - 0.25))}
                className="rounded-md bg-white/10 p-1.5 text-white transition hover:bg-white/20"
                aria-label="Zoom out"
                title="Zoom out"
              >
                <Minus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setScale(1)}
                className="rounded-md bg-white/10 px-2 py-1 text-xs tabular-nums text-white transition hover:bg-white/20"
                title="Reset zoom"
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(6, s + 0.25))}
                className="rounded-md bg-white/10 p-1.5 text-white transition hover:bg-white/20"
                aria-label="Zoom in"
                title="Zoom in"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="ml-2 rounded-md bg-white/10 p-1.5 text-white transition hover:bg-white/20"
                aria-label="Close"
                title="Close (Esc)"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Scrollable, zoomable canvas */}
            <div
              className="flex-1 overflow-auto p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="inline-block origin-top-left [&_svg]:h-auto"
                style={{ transform: `scale(${scale})` }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
