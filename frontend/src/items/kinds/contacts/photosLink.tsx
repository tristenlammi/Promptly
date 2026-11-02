import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ComponentType } from "react";

import { peopleApi, type ContactPhotosLink } from "@/api/people";
import type { ItemViewProps } from "@/items/types";
import { todayISO } from "@/items/ui";

import { daysFrom, displayName, fmtDate, fold, nextOccurrence, yearsOn } from "./model";
import type { Contact } from "./types";

/*
 * Contacts ↔ Photos: a contact can be someone in your Photos (one person per
 * contact, yours only — the link lives on the Photos person). Contacts shows
 * their face when the contact has no photo of its own and a "Photos"
 * section; the Photos person page shows the contact card. Shared by both
 * sides, so nothing here imports the Contacts views.
 */

/** Where the Photos person page is (inside Files — it works from any app). */
export function photosPersonPath(personId: string): string {
  return `/files/photos/people/${personId}`;
}

/** Contacts opened on one person (``?c=`` is the People tab's selection). */
export function contactPath(fileId: string, contactId: string): string {
  return `/apps/contacts/${fileId}?c=${encodeURIComponent(contactId)}`;
}

export const contactLinksKey = (fileId: string) => ["photos-contact-links", fileId] as const;

/** The contacts in this file who are someone in your Photos. Quiet when
 *  Photos isn't there or the app's offline (no faces, nothing else). */
export function useContactLinks(fileId: string | null | undefined) {
  return useQuery({
    queryKey: contactLinksKey(fileId ?? ""),
    queryFn: () => peopleApi.contactLinks(fileId!),
    enabled: !!fileId,
    staleTime: 60_000,
    retry: false,
  });
}

const LinksContext = createContext<Record<string, ContactPhotosLink> | null>(null);

/** The Photos person this contact is, inside a Contacts view (null outside one). */
export function useLinkedPerson(contactId: string): ContactPhotosLink | null {
  return useContext(LinksContext)?.[contactId] ?? null;
}

/** A Contacts tab view with the file's Photos links loaded for its avatars. */
export function withPhotosLinks<P extends ItemViewProps>(View: ComponentType<P>): ComponentType<P> {
  function WithPhotosLinks(props: P) {
    const { data } = useContactLinks(props.item.fileId);
    return (
      <LinksContext.Provider value={data ?? null}>
        <View {...props} />
      </LinksContext.Provider>
    );
  }
  WithPhotosLinks.displayName = `WithPhotosLinks(${View.displayName || View.name || "View"})`;
  return WithPhotosLinks;
}

/** How alike two names are, 0..1: the same name 1, the same words in
 *  another order ~0.9, a shared first name or a prefix ("Sam" / "Samantha")
 *  less. Accents and case don't count. */
export function nameScore(a: string | null | undefined, b: string | null | undefined): number {
  const x = fold(a ?? "");
  const y = fold(b ?? "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  const xs = x.split(" ");
  const ys = y.split(" ");
  const close = (t: string, u: string) => t === u || (t.length >= 3 && u.startsWith(t)) || (u.length >= 3 && t.startsWith(u));
  let hits = 0;
  for (const t of xs) if (ys.some((u) => close(t, u))) hits += 1;
  if (!hits) return 0;
  let score = (0.85 * hits) / Math.max(xs.length, ys.length);
  if (close(xs[0], ys[0])) score += 0.1; // the first names agree
  return Math.min(0.95, score);
}

/** The best of a contact's names (full, nickname, first) against ``name``. */
export function contactNameScore(c: Contact, name: string | null | undefined): number {
  const names = [displayName(c), c.nickname, c.nickname && c.last ? `${c.nickname} ${c.last}` : "", c.first];
  return Math.max(0, ...names.filter(Boolean).map((n) => nameScore(n, name)));
}

/** ``line``: "Birthday · 12 Nov (turns 36)", "Birthday today (turns 36)";
 *  ``short``: "Birthday 12 Nov", "Birthday today"; ``day``: "12 Nov". */
export function birthdayLabel(birthday: string | null | undefined, today: string = todayISO()): { line: string; short: string; day: string } | null {
  if (!birthday) return null;
  const next = nextOccurrence(birthday, today);
  const turns = yearsOn(birthday, next);
  const day = fmtDate(next, { year: false });
  const inDays = daysFrom(today, next);
  const when = inDays === 0 ? "Birthday today" : inDays === 1 ? "Birthday tomorrow" : `Birthday · ${day}`;
  return { line: `${when}${turns ? ` (turns ${turns})` : ""}`, short: when.replace(" · ", " "), day };
}
