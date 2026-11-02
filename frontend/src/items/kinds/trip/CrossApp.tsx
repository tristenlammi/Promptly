import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Images, Loader2, RefreshCw, Tag, Wallet } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { thumbHashToDataURL } from "thumbhash";

import { crossApi } from "@/api/crossapp";
import { Card, ItemButton, Section, todayISO } from "@/items/ui";
import type { ItemHandle } from "@/items/useItem";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { money } from "./logic";
import type { Trip } from "./types";

/*
 * A trip, seen from the other apps: its Photos album (your own photos taken
 * between the trip's dates, kept up to date by Photos) and what your Budget
 * says you spent on it.
 */

function blur(hash: string | null): string | undefined {
  if (!hash) return undefined;
  try {
    return thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

const albumKey = (fileId: string, tripId: string) => ["trip", "album", fileId, tripId] as const;
const spendKey = (fileId: string, tripId: string) => ["trip", "spending", fileId, tripId] as const;

/** "Photos from the trip": a strip of the album's first photos, or the
 *  button that makes the album. */
export function TripAlbumStrip({ item }: { item: ItemHandle<Trip> }) {
  const t = item.data;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({
    queryKey: albumKey(item.fileId, t.id),
    queryFn: () => crossApi.tripAlbum(item.fileId, t.id),
    staleTime: 60_000,
    retry: false,
  });
  // Before the trip there are no photos to gather: offer it once it starts.
  if (!data || (!data.album && (!item.canEdit || (!!t.start && t.start > todayISO())))) return null;

  const make = async () => {
    setBusy(true);
    try {
      const out = await crossApi.makeTripAlbum(item.fileId, t.id);
      qc.setQueryData(albumKey(item.fileId, t.id), out);
      const n = out.album?.count ?? 0;
      toast.success(data.album ? "Trip album updated." : n ? `Made a trip album with ${n} photo${n === 1 ? "" : "s"}.` : "Made a trip album — photos you take on the trip will go in it.");
      void item.refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't make the album. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const album = data.album;
  return (
    <Section
      title="Trip photos"
      hint={album ? `${album.count} photo${album.count === 1 ? "" : "s"} · your photos from the trip's dates` : undefined}
      action={
        item.canEdit && album ? (
          <ItemButton size="sm" variant="ghost" icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} onClick={() => void make()} disabled={busy}>
            Update
          </ItemButton>
        ) : undefined
      }
    >
      {album ? (
        album.count > 0 ? (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {data.photos.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => navigate(album.href)}
                aria-label="Open the trip album"
                className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-[var(--hover)] bg-cover bg-center"
                style={{ backgroundImage: blur(p.thumbhash) ? `url(${blur(p.thumbhash)})` : undefined }}
              >
                {p.thumb && <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />}
              </button>
            ))}
            <button
              type="button"
              onClick={() => navigate(album.href)}
              className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-[var(--border)] text-xs font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]"
            >
              <Images className="h-5 w-5" />
              Open album
            </button>
          </div>
        ) : (
          <Card className="text-sm text-[var(--text-muted)]">
            No photos from these dates yet — the album fills itself as your photos arrive.{" "}
            <button type="button" onClick={() => navigate(album.href)} className="font-medium text-[var(--item-accent)] underline">
              Open album
            </button>
          </Card>
        )
      ) : (
        <Card className="flex flex-wrap items-center gap-3">
          <Images className="h-5 w-5 shrink-0 text-[var(--item-accent)]" />
          <p className="min-w-0 flex-1 text-sm text-[var(--text-muted)]">
            {data.can_make ? "Gather your photos from this trip into an album in Photos." : "Add the trip's dates to make an album of your photos from it."}
          </p>
          {data.can_make && (
            <ItemButton size="sm" icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Images className="h-3.5 w-3.5" />} onClick={() => void make()} disabled={busy}>
              Make a trip album
            </ItemButton>
          )}
        </Card>
      )}
    </Section>
  );
}

/** "From your Budget": purchases tagged to this trip, added up. */
export function BudgetSpentCard({ item }: { item: ItemHandle<Trip> }) {
  const t = item.data;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({
    queryKey: spendKey(item.fileId, t.id),
    queryFn: () => crossApi.tripSpending(item.fileId, t.id),
    staleTime: 30_000,
    retry: false,
  });
  if (!data) return null;

  const tag = async () => {
    setBusy(true);
    try {
      const out = await crossApi.tagTripSpending(item.fileId, t.id);
      qc.setQueryData(spendKey(item.fileId, t.id), out);
      toast.success(`Tagged ${out.tagged_now ?? 0} purchase${out.tagged_now === 1 ? "" : "s"} to this trip.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't tag them. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="From your Budget" hint="Purchases in your Budget tagged to this trip">
      <Card className="flex flex-col gap-2">
        {!data.has_budget ? (
          <p className="text-sm text-[var(--text-muted)]">Add Budget from the Item Store to see what you spent on this trip.</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Wallet className="h-4 w-4" /> Spent so far
              </span>
              <span className="text-lg font-semibold tabular-nums text-[var(--text)]">{money(data.spent_minor, data.currency)}</span>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              {data.count ? `${data.count} purchase${data.count === 1 ? "" : "s"}` : "Nothing tagged yet"}
              {data.converted && data.budget_currency ? ` · converted from ${data.budget_currency} at the trip's rate` : ""}
              {!data.converted && data.currency !== t.settings.home_currency ? ` · in your budget's currency (add a ${data.currency} rate to convert)` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {data.untagged > 0 && (
                <ItemButton size="sm" icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Tag className="h-3.5 w-3.5" />} onClick={() => void tag()} disabled={busy}>
                  Tag {data.untagged} purchase{data.untagged === 1 ? "" : "s"} from these dates
                </ItemButton>
              )}
              {data.budget_file_id && (
                <ItemButton size="sm" variant="ghost" onClick={() => navigate(`/apps/budget/${data.budget_file_id}`)}>
                  Open Budget
                </ItemButton>
              )}
            </div>
          </>
        )}
      </Card>
    </Section>
  );
}
