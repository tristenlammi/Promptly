import { Component, useEffect, type ReactNode } from "react";

import { DOCK_FEEDS } from "./registry";
import { latestCards, useDockStore } from "./store";
import type { DockCardData, DockFeed } from "./types";

/** What a card shows, as text: the store only updates when this changes. */
function signature(cards: DockCardData[]): string {
  return JSON.stringify(
    cards.map((c) => [
      c.id,
      c.priority,
      c.tone ?? "",
      c.icon.displayName ?? "",
      c.title,
      c.detail ?? "",
      c.progress == null ? "" : Math.round(c.progress * 100),
      c.since ?? "",
      !!c.onOpen,
      (c.actions ?? []).map((a) => [a.id, a.label, !!a.pressed, !!a.danger, !!a.quick]),
    ]),
  );
}

/** Runs one feed's hook and reports its cards. Renders nothing. */
function FeedRunner({ feed }: { feed: DockFeed }) {
  const cards = feed.useCards();
  const setFeed = useDockStore((s) => s.setFeed);
  // Handlers always come from the newest render.
  for (const c of cards) latestCards.set(c.id, c);
  const sig = signature(cards);
  useEffect(() => {
    setFeed(feed.id, cards);
    // ``sig`` stands for ``cards`` (a new array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.id, sig, setFeed]);
  useEffect(() => () => setFeed(feed.id, []), [feed.id, setFeed]);
  return null;
}

/** A feed that throws shows nothing, and the others carry on. */
class FeedBoundary extends Component<{ feedId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    useDockStore.getState().setFeed(this.props.feedId, []);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Mounted once (in AppLayout): keeps every feed running so the dock in
 *  the sidebar, the rail and the phone menu all read the same cards. */
export function DockFeeds() {
  return (
    <>
      {DOCK_FEEDS.map((feed) => (
        <FeedBoundary key={feed.id} feedId={feed.id}>
          <FeedRunner feed={feed} />
        </FeedBoundary>
      ))}
    </>
  );
}
