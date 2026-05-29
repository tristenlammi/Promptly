import { useEffect, useId, useRef, useState } from "react";
import { Code2, Workflow } from "lucide-react";

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
  const renderSeq = useRef(0);

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

  return (
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
        <div
          className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full"
          // SVG comes from mermaid with securityLevel "strict" (no
          // scripts / foreignObject HTML), so injecting it is safe.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      <button
        type="button"
        onClick={() => setShowSource((s) => !s)}
        className={cn(
          "absolute right-2 top-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
          "bg-black/[0.04] text-[var(--text-muted)] opacity-0 transition",
          "hover:text-[var(--text)] group-hover:opacity-100 focus:opacity-100",
          "dark:bg-white/[0.06]"
        )}
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
  );
}
