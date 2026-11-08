import { AtSign, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import type { PorchUser } from "@/api/porch";
import { TextArea } from "@/items/ui";
import { cn } from "@/utils/cn";

import { PorchAvatar } from "../ui";

const AT = /(^|[\s(])@([\p{L}\p{N}._-]{0,40})$/u;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Is ``@username`` still in the words? */
export function mentionedIn(body: string, u: PorchUser): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}._-])@${escape(u.username)}(?![\\p{L}\\p{N}_-])`, "iu").test(body);
}

/**
 * The caption, with @mentions: type "@" and the people who'd see the post
 * (only them: ``audience``) are offered. Mentioned people show as chips
 * under it; one who can't see the post any more (the groups changed) turns
 * grey and won't be told.
 */
export function MentionBox({
  value,
  onChange,
  mentions,
  onMentions,
  audience,
  audienceReady,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  mentions: PorchUser[];
  onMentions: (m: PorchUser[]) => void;
  /** Everyone who would see the post (not you). */
  audience: PorchUser[];
  audienceReady: boolean;
  label: string;
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [hi, setHi] = useState(0);
  const inAudience = useMemo(() => new Set(audience.map((u) => u.id)), [audience]);

  const matches = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return audience
      .filter((u) => !q || u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.username.toLowerCase().startsWith(q)) - Number(!b.username.toLowerCase().startsWith(q)))
      .slice(0, 6);
  }, [audience, query]);
  const open = query !== null && matches.length > 0;

  const look = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = AT.exec(before);
    setQuery(m ? m[2] : null);
    setHi(0);
  };
  const insert = (u: PorchUser) => {
    const el = ref.current;
    if (!el) return;
    const at = el.selectionStart ?? value.length;
    const before = value.slice(0, at).replace(/@[\p{L}\p{N}._-]{0,40}$/u, `@${u.username} `);
    const next = before + value.slice(at).replace(/^\s/, "");
    onChange(next);
    if (!mentions.some((m) => m.id === u.id)) onMentions([...mentions, u]);
    setQuery(null);
    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };
  const change = (v: string) => {
    onChange(v);
    // Someone whose @name was taken out isn't mentioned any more.
    const kept = mentions.filter((m) => mentionedIn(v, m));
    if (kept.length !== mentions.length) onMentions(kept);
  };

  return (
    <div className="relative flex flex-col gap-1">
      <label htmlFor={`${listId}-box`} className="text-xs font-medium text-[var(--text-muted)]">
        {label}
      </label>
      <TextArea
        id={`${listId}-box`}
        ref={ref}
        value={value}
        rows={4}
        maxLength={5000}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? `${listId}-list` : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-opt-${hi}` : undefined}
        onChange={(e) => {
          change(e.target.value);
          look(e.target);
        }}
        onClick={(e) => look(e.currentTarget)}
        onKeyUp={(e) => {
          if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) look(e.currentTarget);
        }}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => (h + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => (h - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            insert(matches[hi]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setQuery(null);
          }
        }}
      />
      {open && (
        <ul
          id={`${listId}-list`}
          role="listbox"
          aria-label="People who'll see this post"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-md)]"
        >
          {matches.map((u, i) => (
            <li
              key={u.id}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === hi}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(u);
              }}
              onMouseEnter={() => setHi(i)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5", i === hi && "bg-[var(--hover)]")}
            >
              <PorchAvatar user={u} size={28} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-[var(--text)]">{u.name}</span>
                <span className="truncate text-xs text-[var(--text-muted)]">@{u.username}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {query !== null && !open && audienceReady && (
        <p className="text-xs text-[var(--text-muted)]">
          {audience.length ? `Nobody called “${query}” will see this post.` : "Nobody else will see this post yet, so there's no one to mention."}
        </p>
      )}
      {mentions.length > 0 && (
        <ul aria-label="Mentioned" className="mt-1 flex flex-col gap-1.5">
          {mentions.map((m) => {
            const can = !audienceReady || inAudience.has(m.id);
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border pl-1 pr-1 text-xs font-medium",
                    can
                      ? "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                      : "border-dashed border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]",
                  )}
                >
                  <AtSign className="h-3.5 w-3.5" aria-hidden />
                  {m.name}
                  <button
                    type="button"
                    aria-label={`Don't mention ${m.name}`}
                    onClick={() => onMentions(mentions.filter((x) => x.id !== m.id))}
                    className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </span>
                {!can && <span className="text-xs text-[var(--text-muted)]">{m.name} can't see this post and won't be told.</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
