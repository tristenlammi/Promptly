import { Skeleton } from "@/components/shared/Skeleton";

/** Grey shapes where photos and albums are about to be, so the page keeps
 *  its layout while it loads. */

// Tile shapes that look like a justified row of mixed photos.
const WIDTHS = [1.5, 1, 1.33, 0.75, 1.5, 1.33, 1, 1.78, 0.75, 1.33, 1.5, 1];

/** Rows of photo-shaped tiles. ``height`` clips them to a known space. */
export function TileGridSkeleton({
  rows = 3,
  tile = 200,
  height,
  className,
}: {
  rows?: number;
  tile?: number;
  height?: number;
  className?: string;
}) {
  return (
    <div aria-hidden className={className} style={height ? { height, overflow: "hidden" } : undefined}>
      <div className="flex flex-col gap-1">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-1 overflow-hidden" style={{ height: tile }}>
            {Array.from({ length: 10 }, (_, k) => (
              <div key={k} className="h-full shrink-0" style={{ width: tile * WIDTHS[(r * 5 + k) % WIDTHS.length] }}>
                <Skeleton className="h-full w-full rounded-sm" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The timeline while it loads: a month title, a day, some rows. */
export function TimelineSkeleton({ phone }: { phone: boolean }) {
  return (
    <div role="status" aria-label="Loading your photos" className={phone ? "mx-2 pt-4" : "ml-4 mr-10 pt-4"}>
      <Skeleton className="mb-4 h-5 w-36" />
      <Skeleton className="mb-2 h-3.5 w-24" />
      <TileGridSkeleton rows={2} tile={phone ? 110 : 200} />
      <Skeleton className="mb-2 mt-5 h-3.5 w-24" />
      <TileGridSkeleton rows={3} tile={phone ? 110 : 200} />
    </div>
  );
}

/** Album / place cards: a square cover and two lines. */
export function CardGridSkeleton({ count = 10, label = "Loading" }: { count?: number; label?: string }) {
  return (
    <ul role="status" aria-label={label} className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} aria-hidden>
          <Skeleton className="aspect-square w-full rounded-lg" />
          <Skeleton className="mt-2 h-4 w-3/4" />
          <Skeleton className="mt-1.5 h-3 w-1/3" />
        </li>
      ))}
    </ul>
  );
}
