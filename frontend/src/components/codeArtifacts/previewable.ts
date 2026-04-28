/**
 * Central language/preview taxonomy for Code Artifacts.
 *
 * - {@link normaliseLanguage} folds the dozens of ReactMarkdown /
 *   highlight.js aliases down to a single canonical key so every
 *   downstream lookup (previewer, CodeMirror extension, MIME, save
 *   extension) agrees.
 * - {@link isPreviewableLanguage} tells the chat "Open" button and
 *   the side-panel tab switcher whether a live preview makes sense.
 * - {@link shouldShowOpenButton} is the single source of truth for
 *   the heuristic: we only inject the Open button when the code is
 *   substantial (>= 8 lines) OR the language has a live preview.
 * - {@link driveArtifactMeta} maps a canonical language to the
 *   filename / MIME we'll use when the user clicks "Save to Drive",
 *   so round-tripping back through the Drive preview renders with
 *   the exact same tabs.
 */

export type ArtifactLanguage =
  | "html"
  | "svg"
  | "markdown"
  | "json"
  | "csv"
  | "javascript"
  | "typescript"
  | "tsx"
  | "jsx"
  | "python"
  | "css"
  | "scss"
  | "xml"
  | "yaml"
  | "sql"
  | "bash"
  | "powershell"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "php"
  | "kotlin"
  | "swift"
  | "toml"
  | "ini"
  | "dockerfile"
  | "plain";

/** Minimum line count (inclusive) to surface the Open button for
 *  non-previewable languages. Previewable languages always show. */
export const OPEN_BUTTON_LINE_THRESHOLD = 8;

/** Languages that get a live Preview tab alongside the Code tab. */
const PREVIEWABLE: ReadonlySet<ArtifactLanguage> = new Set([
  "html",
  "svg",
  "markdown",
  "json",
  "csv",
]);

/** Fold the messy universe of highlight.js / markdown fence aliases
 *  down to a single canonical value. Unknown languages => "plain". */
export function normaliseLanguage(raw: string | undefined | null): ArtifactLanguage {
  const key = (raw ?? "").trim().toLowerCase();
  switch (key) {
    case "html":
    case "htm":
    case "xhtml":
      return "html";
    case "svg":
      return "svg";
    case "md":
    case "markdown":
    case "mdown":
      return "markdown";
    case "json":
    case "jsonc":
      return "json";
    case "csv":
      return "csv";
    case "js":
    case "javascript":
    case "node":
      return "javascript";
    case "ts":
    case "typescript":
      return "typescript";
    case "jsx":
      return "jsx";
    case "tsx":
      return "tsx";
    case "py":
    case "python":
    case "python3":
      return "python";
    case "css":
      return "css";
    case "scss":
    case "sass":
      return "scss";
    case "xml":
    case "vue":
    case "svelte":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    case "sql":
    case "postgresql":
    case "mysql":
      return "sql";
    case "sh":
    case "bash":
    case "shell":
    case "zsh":
      return "bash";
    case "ps1":
    case "powershell":
    case "pwsh":
      return "powershell";
    case "rust":
    case "rs":
      return "rust";
    case "go":
    case "golang":
      return "go";
    case "java":
      return "java";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "c++":
    case "cxx":
    case "hpp":
      return "cpp";
    case "cs":
    case "csharp":
    case "c#":
      return "csharp";
    case "rb":
    case "ruby":
      return "ruby";
    case "php":
      return "php";
    case "kt":
    case "kotlin":
      return "kotlin";
    case "swift":
      return "swift";
    case "toml":
      return "toml";
    case "ini":
    case "cfg":
    case "conf":
      return "ini";
    case "dockerfile":
    case "docker":
      return "dockerfile";
    default:
      return "plain";
  }
}

export function isPreviewableLanguage(lang: ArtifactLanguage): boolean {
  return PREVIEWABLE.has(lang);
}

export function countLines(source: string): number {
  if (!source) return 0;
  // trimEnd so a single trailing newline (common in fenced code) doesn't
  // inflate the count into showing the button unnecessarily.
  const trimmed = source.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

/** Single source of truth for whether a code block in the chat
 *  bubble should expose the "Open in panel" button. */
export function shouldShowOpenButton(source: string, lang: ArtifactLanguage): boolean {
  if (isPreviewableLanguage(lang)) return true;
  return countLines(source) >= OPEN_BUTTON_LINE_THRESHOLD;
}

/** Human-friendly label for the panel header. */
export function humanLanguageLabel(lang: ArtifactLanguage): string {
  const map: Record<ArtifactLanguage, string> = {
    html: "HTML",
    svg: "SVG",
    markdown: "Markdown",
    json: "JSON",
    csv: "CSV",
    javascript: "JavaScript",
    typescript: "TypeScript",
    jsx: "JSX",
    tsx: "TSX",
    python: "Python",
    css: "CSS",
    scss: "SCSS",
    xml: "XML",
    yaml: "YAML",
    sql: "SQL",
    bash: "Bash",
    powershell: "PowerShell",
    rust: "Rust",
    go: "Go",
    java: "Java",
    c: "C",
    cpp: "C++",
    csharp: "C#",
    ruby: "Ruby",
    php: "PHP",
    kotlin: "Kotlin",
    swift: "Swift",
    toml: "TOML",
    ini: "INI",
    dockerfile: "Dockerfile",
    plain: "Text",
  };
  return map[lang] ?? "Text";
}

/** Default filename stem + extension + MIME type for Save to Drive.
 *  Choosing these carefully is what lets Drive route the file back
 *  into the CodeArtifact preview when it's re-opened. */
export interface DriveArtifactMeta {
  extension: string;
  mime: string;
}

export function driveArtifactMeta(lang: ArtifactLanguage): DriveArtifactMeta {
  switch (lang) {
    case "html":
      return { extension: "html", mime: "text/html" };
    case "svg":
      return { extension: "svg", mime: "image/svg+xml" };
    case "markdown":
      return { extension: "md", mime: "text/markdown" };
    case "json":
      return { extension: "json", mime: "application/json" };
    case "csv":
      return { extension: "csv", mime: "text/csv" };
    case "javascript":
      return { extension: "js", mime: "application/javascript" };
    case "typescript":
      return { extension: "ts", mime: "text/x-typescript" };
    case "jsx":
      return { extension: "jsx", mime: "application/javascript" };
    case "tsx":
      return { extension: "tsx", mime: "text/x-typescript" };
    case "python":
      return { extension: "py", mime: "text/x-python" };
    case "css":
      return { extension: "css", mime: "text/css" };
    case "scss":
      return { extension: "scss", mime: "text/x-scss" };
    case "xml":
      return { extension: "xml", mime: "application/xml" };
    case "yaml":
      return { extension: "yaml", mime: "application/x-yaml" };
    case "sql":
      return { extension: "sql", mime: "application/sql" };
    case "bash":
      return { extension: "sh", mime: "application/x-sh" };
    case "powershell":
      return { extension: "ps1", mime: "text/plain" };
    case "rust":
      return { extension: "rs", mime: "text/x-rust" };
    case "go":
      return { extension: "go", mime: "text/x-go" };
    case "java":
      return { extension: "java", mime: "text/x-java" };
    case "c":
      return { extension: "c", mime: "text/x-c" };
    case "cpp":
      return { extension: "cpp", mime: "text/x-c++" };
    case "csharp":
      return { extension: "cs", mime: "text/x-csharp" };
    case "ruby":
      return { extension: "rb", mime: "text/x-ruby" };
    case "php":
      return { extension: "php", mime: "application/x-httpd-php" };
    case "kotlin":
      return { extension: "kt", mime: "text/x-kotlin" };
    case "swift":
      return { extension: "swift", mime: "text/x-swift" };
    case "toml":
      return { extension: "toml", mime: "application/toml" };
    case "ini":
      return { extension: "ini", mime: "text/plain" };
    case "dockerfile":
      return { extension: "Dockerfile", mime: "text/plain" };
    case "plain":
    default:
      return { extension: "txt", mime: "text/plain" };
  }
}

/** Reverse lookup — given a Drive file (mime + filename), decide if
 *  we should route preview into the CodeArtifact view and, if so,
 *  which canonical language to render it as. This is what makes
 *  "open in Drive like chat" work. */
export function artifactLanguageFromFile(
  mime: string | null | undefined,
  filename: string
): ArtifactLanguage | null {
  const m = (mime ?? "").toLowerCase().trim();
  const lower = filename.toLowerCase();
  const ext = lower.split(".").pop() ?? "";

  // MIME-first because the backend now tags uploads precisely.
  if (m === "text/html" || ext === "html" || ext === "htm") return "html";
  if (m === "image/svg+xml" || ext === "svg") return "svg";
  if (m === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (m === "application/json" || ext === "json") return "json";
  if (m === "text/csv" || ext === "csv") return "csv";
  return null;
}
