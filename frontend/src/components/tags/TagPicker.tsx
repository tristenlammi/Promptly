import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tag as TagIcon, X } from "lucide-react";

import { tagColor, tagsApi, type Tag, type TaggableKind } from "@/api/tags";
import { cn } from "@/utils/cn";

/**
 * The one tag editor every app uses (#tags): chips for the tags on a thing,
 * and an input that autocompletes from your shared set (Enter, comma or Tab
 * adds; Backspace on an empty input removes the last). A new name becomes a
 * shared tag as soon as the thing is saved.
 *
 * ``value`` is plain names — that's what app files store. For files,
 * events and albums use {@link EntityTags}, which loads and saves for you.
 */

export const TAGS_KEY = ["tags"] as const;

/** Your shared tags (cached; refreshed after edits). */
export function useTagSet() {
  return useQuery({ queryKey: TAGS_KEY, queryFn: () => tagsApi.list(), staleTime: 60_000 });
}

function norm(s: string): string {
  return s.trim().replace(/^[#@]+/, "").split(/\s+/).filter(Boolean).join(" ").slice(0, 40).trim();
}

export function TagChip({ tag, onRemove, link = true, className }: { tag: { name: string; color?: string | null; id?: string }; onRemove?: () => void; link?: boolean; className?: string }) {
  const color = tagColor(tag);
  const body = (
    <>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      <span className="truncate">{tag.name}</span>
    </>
  );
  const cls = cn(
    "inline-flex h-7 max-w-[14rem] items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium text-[var(--text)]",
    className,
  );
  const style = { borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` };
  return (
    <span className={cls} style={style}>
      {link && tag.id ? (
        <Link to={`/tags/${tag.id}`} className="inline-flex min-w-0 items-center gap-1.5 hover:underline" title={`Everything tagged ${tag.name}`}>
          {body}
        </Link>
      ) : (
        body
      )}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-1 rounded-full p-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
          aria-label={`Remove tag ${tag.name}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/** Read-only chips for tag names, linked to their tag pages. */
export function TagChips({ names, className }: { names: string[]; className?: string }) {
  const { data: all } = useTagSet();
  const byName = useMemo(() => new Map((all ?? []).map((t) => [t.name.toLowerCase(), t])), [all]);
  if (names.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {names.map((n) => (
        <TagChip key={n.toLowerCase()} tag={byName.get(n.toLowerCase()) ?? { name: n }} />
      ))}
    </div>
  );
}

export function TagPicker({
  value,
  onChange,
  placeholder = "Add a tag…",
  max,
  disabled,
  className,
}: {
  value: string[];
  onChange: (names: string[]) => void;
  placeholder?: string;
  /** The most this app allows on one thing. */
  max?: number;
  disabled?: boolean;
  className?: string;
}) {
  const { data: all } = useTagSet();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const byName = useMemo(() => new Map((all ?? []).map((t) => [t.name.toLowerCase(), t])), [all]);
  const have = useMemo(() => new Set(value.map((v) => v.toLowerCase())), [value]);
  const term = norm(text).toLowerCase();
  const suggestions = useMemo(() => {
    const pool = (all ?? []).filter((t) => !have.has(t.name.toLowerCase()));
    const hits = term ? pool.filter((t) => t.name.toLowerCase().includes(term)) : pool;
    hits.sort((a, b) => Number(b.name.toLowerCase().startsWith(term)) - Number(a.name.toLowerCase().startsWith(term)) || (b.count ?? 0) - (a.count ?? 0));
    const out: { name: string; tag?: Tag }[] = hits.slice(0, 8).map((t) => ({ name: t.name, tag: t }));
    if (term && !byName.has(term) && !have.has(term)) out.push({ name: norm(text) });
    return out;
  }, [all, have, term, text, byName]);
  useEffect(() => setCursor(0), [term]);

  const full = max !== undefined && value.length >= max;

  const add = (raw: string) => {
    const name = norm(raw);
    if (!name || have.has(name.toLowerCase()) || full) {
      setText("");
      return;
    }
    // Use the shared spelling when the tag already exists.
    onChange([...value, byName.get(name.toLowerCase())?.name ?? name]);
    setText("");
  };
  const remove = (name: string) => onChange(value.filter((v) => v.toLowerCase() !== name.toLowerCase()));

  return (
    <div
      className={cn(
        "relative flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 focus-within:border-[var(--accent)]",
        disabled && "opacity-60",
        className,
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((n) => (
        <TagChip key={n.toLowerCase()} tag={byName.get(n.toLowerCase()) ?? { name: n }} link={false} onRemove={disabled ? undefined : () => remove(n)} />
      ))}
      {!disabled && !full && (
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,\n]/.test(v)) {
              v.split(/[,\n]/).slice(0, -1).forEach(add);
              setText(v.split(/[,\n]/).pop() ?? "");
            } else setText(v);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Let a suggestion click land first.
            window.setTimeout(() => setOpen(false), 120);
            if (norm(text)) add(text);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || (e.key === "Tab" && norm(text))) {
              e.preventDefault();
              const pick = open && suggestions[cursor];
              add(pick ? pick.name : text);
            } else if (e.key === "Backspace" && !text && value.length) {
              remove(value[value.length - 1]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, Math.max(suggestions.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={value.length ? "" : placeholder}
          aria-label="Add a tag"
          className="h-7 min-w-[7rem] flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
        />
      )}
      {open && !disabled && !full && suggestions.length > 0 && (term || value.length === 0 || (all ?? []).length > 0) && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.name.toLowerCase() + (s.tag ? "" : "-new")}
              type="button"
              role="option"
              aria-selected={i === cursor}
              onMouseDown={(e) => {
                e.preventDefault();
                add(s.name);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text)]",
                i === cursor ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]",
              )}
            >
              {s.tag ? (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tagColor(s.tag) }} aria-hidden />
              ) : (
                <TagIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              )}
              <span className="min-w-0 flex-1 truncate">{s.tag ? s.name : `Create “${s.name}”`}</span>
              {s.tag?.count ? <span className="text-xs text-[var(--text-muted)]">{s.tag.count}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Tags on a file, calendar event or album (stored in the shared set, not
 * in an app file): loads them, edits with {@link TagPicker}, saves each
 * change. Read-only chips when ``readOnly``.
 */
export function EntityTags({ kind, id, readOnly, className }: { kind: TaggableKind; id: string; readOnly?: boolean; className?: string }) {
  const qc = useQueryClient();
  const key = ["tags", "entity", kind, id];
  const { data, isError } = useQuery({ queryKey: key, queryFn: () => tagsApi.forEntity(kind, id), retry: false });
  const [error, setError] = useState<string | null>(null);
  if (isError) return null;
  const names = (data ?? []).map((t) => t.name);
  const save = async (next: string[]) => {
    setError(null);
    qc.setQueryData(key, next.map((n) => (data ?? []).find((t) => t.name.toLowerCase() === n.toLowerCase()) ?? { id: "", name: n, color: null }));
    try {
      const saved = await tagsApi.setForEntity(kind, id, next);
      qc.setQueryData(key, saved);
      void qc.invalidateQueries({ queryKey: TAGS_KEY, exact: true });
    } catch {
      setError("Couldn't save tags.");
      void qc.invalidateQueries({ queryKey: key });
    }
  };
  if (readOnly) {
    return data && data.length ? (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {data.map((t) => (
          <TagChip key={t.id || t.name} tag={t} />
        ))}
      </div>
    ) : null;
  }
  return (
    <div className={className}>
      <TagPicker value={names} onChange={(n) => void save(n)} />
      {data && data.some((t) => t.id) && (
        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-[var(--text-muted)]">
          {data.filter((t) => t.id).map((t) => (
            <Link key={t.id} to={`/tags/${t.id}`} className="hover:underline">
              All “{t.name}” →
            </Link>
          ))}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
