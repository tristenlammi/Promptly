import { useEffect, useMemo, useState } from "react";
import { transform } from "sucrase";

// React's UMD builds, inlined as text and injected into the sandbox. This is
// deliberately not a CDN: the app ships a strict CSP that blocks external
// hosts, and a self-hosted install has to keep working with no internet at
// all. 144 kB of runtime lives in this chunk, which is why the whole preview
// is lazy-loaded by the caller — nobody pays for it until they render a
// component.
import reactUmd from "virtual:react-umd/react";
import reactDomUmd from "virtual:react-umd/react-dom";

/**
 * Live React component preview.
 *
 * The model writes a single-file component; we transform the JSX/TS with
 * Sucrase and run it inside the same sandbox posture as ``HtmlPreview``
 * (``allow-scripts`` with no ``allow-same-origin``, so no cookies, no
 * same-origin fetches, no top-level navigation).
 *
 * Single-file is the contract. Bare imports other than React can't be
 * resolved without a bundler and a network, so instead of failing with a
 * cryptic ``require is not defined`` at runtime we detect them up front and
 * say which module isn't available.
 */

/** Modules we can satisfy from the injected UMD globals. */
const REACT_MODULES = new Set(["react", "react-dom", "react-dom/client"]);

interface Prepared {
  code: string;
  root: string;
  /** The source already calls ``createRoot(...).render`` / ``ReactDOM.render``
   *  itself, so we must not mount a second root over the same container. */
  selfMounts: boolean;
  error: string | null;
}

/** Rewrite ESM syntax into something a classic <script> can run.
 *
 *  Exported (with {@link buildDocument}) so the transform pipeline can be
 *  driven headlessly — it's all string-in/string-out, which is the part
 *  worth checking against real component sources.
 *
 *  Deliberately not an import map: maps plus blob/data URLs inside an
 *  opaque-origin iframe are fiddly and fail in ways that are hard to
 *  explain to a user. A single-file component only ever imports React, so
 *  rewriting those few forms by hand is both simpler and easier to give a
 *  good error message for.
 */
export function prepare(source: string): Prepared {
  let code = source;
  const unsupported = new Set<string>();

  // import Default, { named as alias } from "mod"
  code = code.replace(
    /^[ \t]*import\s+([\s\S]*?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm,
    (_full, clause: string, mod: string) => {
      if (!REACT_MODULES.has(mod)) {
        unsupported.add(mod);
        return "";
      }
      const globalName = mod === "react" ? "React" : "ReactDOM";
      const parts: string[] = [];
      const named = clause.match(/\{([\s\S]*?)\}/);
      if (named) {
        // `as` → `:` turns an import alias into a destructuring rename.
        const inner = named[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.replace(/\s+as\s+/, ": "))
          .join(", ");
        if (inner) parts.push(`const { ${inner} } = ${globalName};`);
      }
      // `const React = React;` is a TDZ error, not a no-op — and the near
      // universal `import React from "react"` lands exactly there. When the
      // local name already is the global, leave the global alone.
      const bind = (local: string) => {
        if (local !== globalName) parts.push(`const ${local} = ${globalName};`);
      };
      const def = clause.replace(/\{[\s\S]*?\}/, "").replace(/,/g, "").trim();
      if (def && !def.startsWith("*")) bind(def);
      if (/\*\s+as\s+(\w+)/.test(clause)) {
        bind(clause.match(/\*\s+as\s+(\w+)/)![1]);
      }
      return parts.join("\n");
    },
  );

  // Side-effect imports (`import "./styles.css"`) — harmless to drop, but a
  // stylesheet won't apply, so don't pretend otherwise for non-CSS.
  code = code.replace(
    /^[ \t]*import\s*["']([^"']+)["'];?[ \t]*$/gm,
    (_full, mod: string) => {
      if (!/\.(css|scss|sass|less)$/i.test(mod)) unsupported.add(mod);
      return "";
    },
  );

  if (unsupported.size > 0) {
    return {
      code: "",
      root: "",
      selfMounts: false,
      error:
        `This preview runs a single self-contained React component, so it ` +
        `can only import React itself. Not available here: ` +
        `${[...unsupported].map((m) => `"${m}"`).join(", ")}.`,
    };
  }

  // Find the component to mount, and flatten exports (a classic script has
  // no module scope, so `export` is a syntax error).
  let root = "";
  code = code.replace(
    /^[ \t]*export\s+default\s+(function|class)\s+(\w+)/m,
    (_f, kind: string, name: string) => {
      root = name;
      return `${kind} ${name}`;
    },
  );
  if (!root) {
    code = code.replace(/^[ \t]*export\s+default\s+/m, () => {
      root = "__ArtifactDefault";
      return "const __ArtifactDefault = ";
    });
  }
  code = code.replace(/^[ \t]*export\s+(?=(const|let|var|function|class)\s)/gm, "");
  // `export { A as default }` / `export { A }`
  code = code.replace(
    /^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm,
    (_f, inner: string) => {
      const asDefault = inner.match(/(\w+)\s+as\s+default/);
      if (asDefault && !root) root = asDefault[1];
      return "";
    },
  );

  if (!root) {
    // No explicit default. Prefer a component literally called App, else the
    // last PascalCase declaration — which is the conventional shape of these
    // one-file artifacts.
    const names = [...code.matchAll(/(?:function|const|class)\s+([A-Z]\w*)/g)].map(
      (m) => m[1],
    );
    root = names.includes("App") ? "App" : names[names.length - 1] || "";
  }

  // Some artifacts ship their own bootstrap (`createRoot(...).render(<App/>)`).
  // Mounting a second root over the same container would make React complain
  // and double-render, so in that case we stand back and let it mount itself.
  const selfMounts = /(?:createRoot\s*\([\s\S]*?\)\s*\.\s*render|ReactDOM\s*\.\s*(?:createRoot|render)\s*\()/.test(
    code,
  );

  if (!root && selfMounts) return { code, root: "", selfMounts, error: null };

  if (!root) {
    return {
      code: "",
      root: "",
      selfMounts: false,
      error:
        "Couldn't find a component to render. Export a default component " +
        "(or name one `App`) and it will appear here.",
    };
  }

  return { code, root, selfMounts, error: null };
}

export function buildDocument(
  compiled: string,
  root: string,
  selfMounts = false,
): string {
  // A literal `</script>` inside the component's own source would end the
  // script tag early and break the document.
  const safe = compiled.replace(/<\/script/gi, "<\\/script");
  const mount =
    selfMounts || !root
      ? "    // The artifact mounts itself; nothing to do here."
      : `    var Root = ${root};
    if (typeof Root !== "function" && typeof Root !== "object") {
      throw new Error(${JSON.stringify(
        root === "__ArtifactDefault"
          ? "The default export isn't a React component."
          : `\`${root}\` is not a React component.`,
      )});
    }
    ReactDOM.createRoot(document.getElementById("root")).render(
      React.createElement(React.StrictMode, null, React.createElement(Root))
    );`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  html, body { margin: 0; padding: 16px; font-family: system-ui, -apple-system, sans-serif; color: #111; background: #fff; }
  @media (prefers-color-scheme: dark) {
    html, body { background: #0b0b0c; color: #e7e7e9; }
    a { color: #7aa8ff; }
  }
  #__err { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
           font-size: 12px; color: #b42318; background: #fef3f2; border: 1px solid #fda29b;
           border-radius: 8px; padding: 12px; }
  @media (prefers-color-scheme: dark) {
    #__err { color: #fda29b; background: #2a1210; border-color: #7a271a; }
  }
</style>
</head>
<body>
<div id="root"></div>
<div id="__err" hidden></div>
<script>${reactUmd}</script>
<script>${reactDomUmd}</script>
<script>
(function () {
  var box = document.getElementById("__err");
  function fail(label, err) {
    box.hidden = false;
    box.textContent = label + "\\n\\n" + (err && err.stack ? err.stack : String(err));
  }
  // A component that throws during render would otherwise leave a blank
  // frame with the real reason buried in a console nobody opens.
  window.addEventListener("error", function (e) { fail("Runtime error", e.error || e.message); });
  window.addEventListener("unhandledrejection", function (e) { fail("Unhandled promise rejection", e.reason); });
  try {
${safe}
${mount}
  } catch (err) {
    fail("Error", err);
  }
})();
</script>
</body>
</html>`;
}

export function ReactPreview({ source }: { source: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const { html, error } = useMemo(() => {
    const prepared = prepare(source);
    if (prepared.error) return { html: null, error: prepared.error };
    try {
      const out = transform(prepared.code, {
        transforms: ["jsx", "typescript"],
        jsxRuntime: "classic",
        production: true,
      }).code;
      return {
        html: buildDocument(out, prepared.root, prepared.selfMounts),
        error: null,
      };
    } catch (e) {
      // Sucrase reports the offending line, which is the single most useful
      // thing to show — the model can then fix it on a follow-up.
      return {
        html: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }, [source]);

  useEffect(() => {
    if (!html) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([html], { type: "text/html;charset=utf-8" }),
    );
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [html]);

  if (error) {
    return (
      <div className="h-full w-full overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg)] p-4">
        <div className="text-sm font-medium text-[var(--danger)]">
          This component couldn't be rendered
        </div>
        <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-[var(--text-muted)]">
          {error}
        </pre>
      </div>
    );
  }

  if (!blobUrl) return null;

  return (
    <iframe
      src={blobUrl}
      title="React component preview"
      // Same posture as HtmlPreview: scripts yes, same-origin no.
      sandbox="allow-scripts"
      className="h-full w-full rounded-md border border-[var(--border)] bg-white"
    />
  );
}
