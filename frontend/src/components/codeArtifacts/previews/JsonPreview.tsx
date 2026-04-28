import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * JSON previewer — parse + render as a collapsible tree. Invalid
 * JSON shows a friendly error with the parser's message.
 *
 * We implement our own tiny renderer instead of pulling in
 * ``react-json-view`` (which is 100+KB and unmaintained for R18).
 * The feature set is the minimum users actually need:
 * - Expand / collapse nested objects + arrays
 * - Key / value colour coding
 * - Copy-on-click value (via the footer Copy action already)
 * - Small tree keeps typography aligned with the rest of Promptly.
 */
export function JsonPreview({ source }: { source: string }) {
  const result = useMemo<ParseResult>(() => {
    const trimmed = source.trim();
    if (!trimmed) return { ok: true, value: null };
    try {
      const value = JSON.parse(trimmed) as JsonValue;
      return { ok: true, value };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }, [source]);

  if (!result.ok) {
    return (
      <div className="h-full w-full overflow-auto rounded-md border border-red-500/40 bg-red-500/5 p-4 font-mono text-xs text-red-500">
        <div className="mb-2 text-sm font-semibold">Invalid JSON</div>
        <div>{result.error}</div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg)] p-4 font-mono text-[13px] leading-relaxed text-[var(--text)]">
      <JsonNode value={result.value} depth={0} />
    </div>
  );
}

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

type ParseResult =
  | { ok: true; value: JsonValue }
  | { ok: false; error: string };

function JsonNode({ value, depth }: { value: JsonValue; depth: number }) {
  if (value === null) return <span className="text-[var(--text-muted)]">null</span>;
  if (typeof value === "string")
    return <span className="text-emerald-600 dark:text-emerald-400">&quot;{value}&quot;</span>;
  if (typeof value === "number")
    return <span className="text-blue-600 dark:text-blue-400">{String(value)}</span>;
  if (typeof value === "boolean")
    return <span className="text-purple-600 dark:text-purple-400">{String(value)}</span>;
  if (Array.isArray(value)) return <ArrayNode value={value} depth={depth} />;
  return <ObjectNode value={value} depth={depth} />;
}

function ObjectNode({
  value,
  depth,
}: {
  value: { [key: string]: JsonValue };
  depth: number;
}) {
  // Auto-collapse beyond depth 2 to keep the tree compact.
  const [open, setOpen] = useState(depth < 2);
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-[var(--text-muted)]">&#123;&#125;</span>;
  return (
    <span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex cursor-pointer items-center text-[var(--text-muted)] hover:text-[var(--text)]"
        aria-label={open ? "Collapse" : "Expand"}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>&#123;</span>
      </button>
      {!open && (
        <span className="text-[var(--text-muted)]">{` ${entries.length} keys `}</span>
      )}
      {open && (
        <div className="ml-4 border-l border-[var(--border)] pl-3">
          {entries.map(([key, v], i) => (
            <div key={key}>
              <span className="text-red-600 dark:text-red-400">&quot;{key}&quot;</span>
              <span className="text-[var(--text-muted)]">: </span>
              <JsonNode value={v} depth={depth + 1} />
              {i < entries.length - 1 && <span className="text-[var(--text-muted)]">,</span>}
            </div>
          ))}
        </div>
      )}
      <span>&#125;</span>
    </span>
  );
}

function ArrayNode({ value, depth }: { value: JsonValue[]; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (value.length === 0) return <span className="text-[var(--text-muted)]">[]</span>;
  return (
    <span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex cursor-pointer items-center text-[var(--text-muted)] hover:text-[var(--text)]"
        aria-label={open ? "Collapse" : "Expand"}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>[</span>
      </button>
      {!open && (
        <span className="text-[var(--text-muted)]">{` ${value.length} items `}</span>
      )}
      {open && (
        <div className="ml-4 border-l border-[var(--border)] pl-3">
          {value.map((v, i) => (
            <div key={i}>
              <JsonNode value={v} depth={depth + 1} />
              {i < value.length - 1 && <span className="text-[var(--text-muted)]">,</span>}
            </div>
          ))}
        </div>
      )}
      <span>]</span>
    </span>
  );
}
