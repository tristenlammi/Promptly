import { forwardRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { memoriesApi } from "@/api/memories";

/** The memories along the top of the Photos home (PH-5) — nothing at all
 *  when there are none. */
export const MemoriesStrip = forwardRef<HTMLDivElement>(function MemoriesStrip(_, ref) {
  const { data } = useQuery({ queryKey: ["photo-memories"], queryFn: memoriesApi.list, staleTime: 5 * 60_000, retry: false });
  if (!data?.length) return <div ref={ref} />;
  return (
    <div ref={ref} className="px-4 pb-1 pt-3">
      <ul aria-label="Memories" className="flex gap-2 overflow-x-auto pb-2">
        {data.map((m) => (
          <li key={m.id} className="shrink-0">
            <Link
              to={`/files/photos/memories/${m.id}`}
              className="relative block h-36 w-28 overflow-hidden rounded-xl bg-[var(--hover)] sm:h-44 sm:w-36"
            >
              {m.cover?.thumb && <img src={m.cover.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />}
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-8 text-white">
                <span className="block text-sm font-semibold leading-tight">{m.title}</span>
                <span className="block truncate text-[11px] opacity-90">{m.subtitle}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
});
