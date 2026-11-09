import { useQuery } from "@tanstack/react-query";
import { Image as ImageIcon, Loader2, MapPin, PenLine, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { apiClient } from "@/api/client";
import type { PostPlace } from "@/api/porch";
import { Sheet, TextInput } from "@/items/ui";

/** One P Maps search result (``GET /api/maps/search``). */
interface MapHit {
  kind: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
}

export interface PlaceOption {
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
}

function Row({ icon: Icon, name, address, onClick }: { icon: typeof MapPin; name: string; address?: string | null; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-[var(--text)]">{name}</span>
          {address && <span className="truncate text-xs text-[var(--text-muted)]">{address}</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * Add a place: where your photos were taken first (the town Photos found),
 * then P Maps' search. If the map can't be searched, or you'd rather, the
 * words you typed can be the place on their own.
 */
export function PlaceSheet({
  open,
  onClose,
  onPick,
  fromPhotos,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (p: PostPlace) => void;
  fromPhotos: PlaceOption[];
}) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    if (open) {
      setText("");
      setQ("");
    }
  }, [open]);
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 300);
    return () => window.clearTimeout(t);
  }, [text]);
  const res = useQuery({
    queryKey: ["porch", "compose", "place", q],
    queryFn: async () => (await apiClient.get<{ results: MapHit[] }>("/maps/search", { params: { q } })).data.results,
    enabled: open && q.length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const pick = (o: { name: string; lat: number | null; lon: number | null }) => {
    onPick({ name: o.name.slice(0, 200), lat: o.lat, lon: o.lon });
    onClose();
  };
  const hits = (res.data ?? []).filter((h) => h.lat !== null && h.lon !== null && h.kind !== "contact" && h.kind !== "home" && h.kind !== "work").slice(0, 8);
  return (
    <Sheet open={open} onClose={onClose} title="Add a place">
      <label className="relative block">
        <span className="sr-only">Search for a place</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
        <TextInput data-autofocus type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search for a place" className="pl-9" maxLength={200} />
      </label>
      <ul className="-mx-2 mt-3 flex flex-col">
        {!q &&
          fromPhotos.map((p) => <Row key={`${p.name}-${p.lat}`} icon={ImageIcon} name={p.name} address={p.address ? `Where your photos were taken · ${p.address}` : "Where your photos were taken"} onClick={() => pick(p)} />)}
        {q.length >= 2 && res.isPending && (
          <li className="flex items-center gap-2 px-2 py-3 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Searching the map…
          </li>
        )}
        {q.length >= 2 && hits.map((h, i) => <Row key={`${h.name}-${h.lat}-${i}`} icon={MapPin} name={h.name} address={h.address} onClick={() => pick(h)} />)}
        {q.length >= 2 && res.isError && <li className="px-2 py-2 text-sm text-[var(--text-muted)]">The map can't be searched right now. You can still use the name as you typed it.</li>}
        {q.length >= 2 && res.isSuccess && hits.length === 0 && <li className="px-2 py-2 text-sm text-[var(--text-muted)]">No places on the map match “{q}”.</li>}
        {text.trim() && <Row icon={PenLine} name={`Use “${text.trim()}”`} address="Just the name, without a spot on the map" onClick={() => pick({ name: text.trim(), lat: null, lon: null })} />}
        {!q && !fromPhotos.length && <li className="px-2 py-2 text-sm text-[var(--text-muted)]">Type a town, a beach, a café…</li>}
      </ul>
    </Sheet>
  );
}
