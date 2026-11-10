import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { porchApi, type SearchResult } from "@/api/porch";
import { Sheet, TextInput } from "@/items/ui";
import { apiErrorMessage } from "@/utils/apiError";

import { PorchAvatar } from "./ui";

/**
 * Porch's search (build §3.10): posts you can see, by their words, places
 * and photo descriptions, and photos by what's in them ("beach", "the cake
 * Sam posted"). Results are a grid with the poster's name. Nothing anyone
 * hasn't shared with you can turn up.
 */
export function SearchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <SearchBody onClose={onClose} />;
}

function SearchBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 300);
    return () => window.clearTimeout(t);
  }, [text]);
  const res = useQuery({
    queryKey: ["porch", "search", q],
    queryFn: ({ signal }) => porchApi.search(q, signal),
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
  const open = (r: SearchResult) => {
    onClose();
    navigate(r.href);
  };
  const results = res.data?.results ?? [];

  return (
    <Sheet open onClose={onClose} title="Search Porch" size="lg">
      <label className="relative mb-3 block">
        <span className="sr-only">Search posts</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
        <TextInput
          data-autofocus
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search posts: “beach”, “Sam's birthday”, “Noosa”"
          className="pl-9"
          maxLength={200}
        />
      </label>

      <div aria-live="polite">
        {q.length < 2 ? (
          <p className="px-1 py-6 text-center text-sm text-[var(--text-muted)]">
            Find posts you can see by their words or place, and photos by what's in them.
          </p>
        ) : res.isPending ? (
          <p className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Searching…
          </p>
        ) : res.isError ? (
          <p className="px-1 py-6 text-center text-sm text-[var(--text-muted)]">{apiErrorMessage(res.error, "Couldn't search right now. Try again.")}</p>
        ) : results.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-[var(--text-muted)]">
            Nothing you can see matches “{q}”.
            {!res.data?.photos_searched && " Photos can only be found by their words right now."}
          </p>
        ) : (
          <>
            <p className="mb-2 px-1 text-xs text-[var(--text-muted)]">
              {results.length === 1 ? "1 post" : `${results.length} posts`}
              {!res.data?.photos_searched && " · photos are searched by their words only right now"}
            </p>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => open(r)}
                    aria-label={`${r.title}, ${r.subtitle}`}
                    className="group flex w-full flex-col gap-1.5 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
                  >
                    {r.thumb ? (
                      <img src={r.thumb} alt="" loading="lazy" className="aspect-square w-full rounded-xl bg-[var(--surface-2)] object-cover transition group-hover:opacity-90" />
                    ) : (
                      <span className="flex aspect-square w-full items-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_10%,var(--surface))] p-3 text-sm font-medium leading-snug text-[var(--text)] transition group-hover:bg-[color-mix(in_srgb,var(--item-accent)_16%,var(--surface))]">
                        <span className="line-clamp-5 break-words">{r.title}</span>
                      </span>
                    )}
                    <span className="flex min-w-0 items-center gap-1.5 px-0.5">
                      <PorchAvatar user={r.author} size={20} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-[var(--text)]">{r.author?.name ?? "Someone"}</span>
                        {r.thumb && <span className="block truncate text-xs text-[var(--text-muted)]">{r.title}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Sheet>
  );
}
