// Shared plumbing for the fourth hold-out corpus. Only the document skeleton and the
// window.__fixture test hook live here; every page writes its own markup, styles and script.

/** One expected field. frame is null for the top document, or the iframe chain from the top. */
export const x = (selector, role, frame = null) => ({ selector, role, frame });

/** One step. opts may carry wait and advance. */
export function step(kind, expected, honeypots = [], opts = {}) {
  const s = { kind };
  if (opts.wait) s.wait = opts.wait;
  s.expected = expected;
  s.honeypots = honeypots;
  if (opts.advance) s.advance = opts.advance;
  return s;
}

export function doc({ title, lang = 'en', dir, head = '', css = '', body, js = '' }) {
  return `<!doctype html>
<html lang="${lang}"${dir ? ` dir="${dir}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:,">
${head}<style>
${css.trim()}
</style>
</head>
<body>
${body.trim()}
<script>
${js.trim()}
</script>
</body>
</html>
`;
}

/**
 * State hook reading live values. map is role -> CSS selector, or role -> "js:<expression>".
 */
export function fxLive(map) {
  const lines = Object.entries(map).map(([k, v]) =>
    v.startsWith('js:') ? `o[${JSON.stringify(k)}] = ${v.slice(3)};` : `o[${JSON.stringify(k)}] = val(${JSON.stringify(v)});`,
  );
  return `window.__fixture = { state: function () {
  function val(s) { var el = document.querySelector(s); return el ? el.value : ''; }
  var o = {};
  ${lines.join('\n  ')}
  return o;
} };`;
}

export const fxNone = 'window.__fixture = { state: function () { return {}; } };';
