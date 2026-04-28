import { useEffect, useMemo, useRef, useState } from "react";

/**
 * HTML previewer — sandboxed iframe loaded from a blob URL.
 *
 * Security posture: ``sandbox="allow-scripts"`` without
 * ``allow-same-origin``. This is the strongest practical sandbox
 * we can give untrusted HTML while still letting the snippet run
 * client-side scripts (which is the whole point of a live
 * preview). No cookie access, no fetching same-origin APIs, no
 * top-level navigation. Mirrors the posture the study whiteboard
 * already uses successfully.
 *
 * The iframe reloads when ``source`` changes, debounced by the
 * parent (the ``draft`` field only updates on editor idle, so
 * typing doesn't thrash the iframe).
 */
export function HtmlPreview({ source }: { source: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const html = useMemo(() => {
    // If the snippet is a fragment (no <html> / <body>) we wrap it
    // in a minimal document so headless fragments render OK.
    const looksLikeDoc = /<\s*html[\s>]|<\s*body[\s>]|<!doctype/i.test(source);
    if (looksLikeDoc) return source;
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
</style>
</head>
<body>
${source}
</body>
</html>`;
  }, [source]);

  useEffect(() => {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [html]);

  if (!blobUrl) return null;

  return (
    <iframe
      ref={iframeRef}
      src={blobUrl}
      title="HTML preview"
      sandbox="allow-scripts"
      className="h-full w-full rounded-md border border-[var(--border)] bg-white"
    />
  );
}
