import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Check, ChevronDown, Images, Plus } from "lucide-react";
import { useState } from "react";

import { todayApi, type JournalDay } from "@/api/today";
import { cn } from "@/utils/cn";

/* "Your day" (#U7): the day's events and the photos you took, under the
   entry's header — tap one to add it to the entry. An event goes in as a
   line ("- 13:00 Lunch with Sam"), a photo as a Markdown image pointing at
   the photo (``![Photo](/photos?photo=<id>)``), which the entry shows as a
   thumbnail. Only ever your own calendar and library. */

export function photoRef(id: string): string {
  return `![Photo](/photos?photo=${id})`;
}

export function eventLine(e: JournalDay["events"][number]): string {
  return e.all_day ? `- ${e.title} (all day)` : `- ${e.time} ${e.title}`;
}

export function DayStrip({ fileId, date, body, onAdd }: { fileId: string; date: string; body: string; onAdd: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["journal-day", fileId, date],
    queryFn: () => todayApi.journalDay(fileId, date),
    staleTime: 60_000,
    retry: false,
  });
  if (!data || (data.events.length === 0 && data.photos.length === 0)) return null;
  const bits = [
    data.events.length ? `${data.events.length} event${data.events.length === 1 ? "" : "s"}` : "",
    data.photo_count ? `${data.photo_count} photo${data.photo_count === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <CalendarDays className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text)]">
          Your day <span className="font-normal text-[var(--text-muted)]">· {bits.join(" · ")} — add to this entry</span>
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-[var(--text-muted)] transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {data.events.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {data.events.map((e) => {
                const line = eventLine(e);
                const added = body.includes(line);
                return (
                  <button
                    key={e.id}
                    type="button"
                    disabled={added}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => onAdd(line)}
                    title={added ? "Already in this entry" : "Add to entry"}
                    className={cn(
                      "inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-xs",
                      added
                        ? "border-transparent bg-[var(--surface-2)] text-[var(--text-muted)]"
                        : "border-[var(--border)] text-[var(--text)] hover:border-[var(--item-accent)]",
                    )}
                  >
                    {added ? <Check className="h-3 w-3 shrink-0" /> : <Plus className="h-3 w-3 shrink-0" />}
                    <span className="truncate">{e.all_day ? e.title : `${e.time} ${e.title}`}</span>
                  </button>
                );
              })}
            </div>
          )}
          {data.photos.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                <Images className="h-3 w-3" /> Tap a photo to add it
              </div>
              <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:thin]">
                {data.photos.map((p) => {
                  const added = body.includes(photoRef(p.id));
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={added}
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => onAdd(photoRef(p.id))}
                      aria-label={added ? `${p.filename} (added)` : `Add ${p.filename} to entry`}
                      className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-[var(--surface-2)]"
                    >
                      {p.thumb && <img src={p.thumb} alt="" loading="lazy" className={cn("h-full w-full object-cover", added && "opacity-40")} />}
                      {added && (
                        <span className="absolute inset-0 flex items-center justify-center text-[var(--text)]">
                          <Check className="h-5 w-5" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
