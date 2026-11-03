import { Tag as TagIcon } from "lucide-react";

import { tagColor } from "@/api/tags";

/** Tags matching the search box query (Ctrl+K), each opening its tag page. */
export function TagSearchHits({
  tags,
  onOpen,
}: {
  tags?: { id: string; name: string; color: string | null; count?: number; url: string }[];
  onOpen: (url: string) => void;
}) {
  if (!tags?.length) return null;
  return (
    <>
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        <TagIcon className="h-3 w-3" />
        Tags
      </div>
      {tags.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onOpen(t.url)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-[var(--surface-2)]"
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: tagColor(t) }} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{t.name}</span>
          {t.count ? <span className="text-xs text-[var(--text-muted)]">{t.count} {t.count === 1 ? "thing" : "things"}</span> : null}
        </button>
      ))}
    </>
  );
}
