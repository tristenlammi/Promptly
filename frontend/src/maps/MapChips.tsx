import { MapPin, Navigation, Route as RouteIcon } from "lucide-react";
import { Suspense, lazy, useState } from "react";

import type { ActivityStep } from "@/components/chat/ToolActivityCard";

export interface MapCard {
  kind: "route" | "places" | "timeline";
  title?: string;
  stops?: { lat: number; lon: number; name: string }[];
  mode?: "drive" | "walk" | "cycle";
  km?: number;
  seconds?: number;
  adds_seconds?: number | null;
  warnings?: number;
  places?: { lat: number; lon: number; name: string; address?: string | null }[];
  stays?: { lat: number; lon: number; name: string }[];
  lines?: [number, number][][];
}

// The map library is big: only loaded once a chip is opened.
const MapCardModal = lazy(() => import("./MapCardModal").then((m) => ({ default: m.MapCardModal })));

function minutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

function chipText(card: MapCard): string {
  if (card.kind === "route" && card.stops?.length) {
    const end = card.stops[card.stops.length - 1].name;
    const via = card.stops.length > 2 ? `, ${card.stops.length - 2} stops` : "";
    const traffic = (card.adds_seconds ?? 0) >= 60 ? ` · +${minutes(card.adds_seconds ?? 0)} traffic` : "";
    const warned = card.warnings ? ` · ${card.warnings} ${card.warnings === 1 ? "warning" : "warnings"}` : "";
    return `${end}${via} · ${minutes(card.seconds ?? 0)}${traffic} · ${(card.km ?? 0).toFixed(1)} km${warned}`;
  }
  if (card.kind === "timeline") return `Your timeline · ${card.title ?? ""}`;
  const count = card.places?.length ?? 0;
  return count === 1 ? (card.places?.[0].name ?? "Place") : `${card.title ?? "Places"} · ${count} on the map`;
}

const ICON = { route: Navigation, places: MapPin, timeline: RouteIcon };

/** What a chat turn looked up on the map: a chip per answer, which opens it in a
 *  window. Saved in the chat, so an old chat still opens its trip. */
export function MapChips({ steps }: { steps: ActivityStep[] }) {
  const cards = steps
    .filter((s) => s.status === "ok" && s.meta && typeof s.meta === "object" && "map_card" in s.meta)
    .map((s) => (s.meta as { map_card: MapCard }).map_card);
  const [open, setOpen] = useState<MapCard | null>(null);
  if (cards.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {cards.map((card, i) => {
        const Icon = ICON[card.kind];
        return (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(card)}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text)] transition hover:border-[var(--accent)] hover:bg-[var(--hover)]"
          >
            <Icon className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
            <span className="truncate">{chipText(card)}</span>
          </button>
        );
      })}
      {open && (
        <Suspense fallback={null}>
          <MapCardModal card={open} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </div>
  );
}
