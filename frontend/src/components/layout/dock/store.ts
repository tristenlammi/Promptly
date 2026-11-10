import { create } from "zustand";

import type { DockCardData } from "./types";

interface DockState {
  /** Each feed's cards, as last reported. */
  byFeed: Record<string, DockCardData[]>;
  setFeed: (feedId: string, cards: DockCardData[]) => void;
}

export const useDockStore = create<DockState>((set) => ({
  byFeed: {},
  setFeed: (feedId, cards) =>
    set((s) => {
      if (cards.length === 0 && !(s.byFeed[feedId]?.length)) return s;
      return { byFeed: { ...s.byFeed, [feedId]: cards } };
    }),
}));

/** The newest version of every card, so a button always runs the handler
 *  from the feed's latest render (the store only updates when what a card
 *  shows changes). */
export const latestCards = new Map<string, DockCardData>();

/** Every feed's cards, most important first. */
export function sortCards(byFeed: Record<string, DockCardData[]>): DockCardData[] {
  return Object.values(byFeed)
    .flat()
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

/** How many things are happening now (the phone menu button's dot). */
export function useDockCount(): number {
  return useDockStore((s) => Object.values(s.byFeed).reduce((n, list) => n + list.length, 0));
}
