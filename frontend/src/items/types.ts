import type { ComponentType, ReactNode } from "react";

import type { ItemDoc } from "./api";
import type { ItemHandle } from "./useItem";

/**
 * What an item kind's frontend exports (``src/items/kinds/<kind>/index.tsx``,
 * ``export default`` an {@link ItemModule}). The registry finds it on its own.
 *
 * The shell (``ItemShell``) owns the chrome — header, title, save state, the
 * AI panel (a side panel on desktop, an "Ask" tab on a phone), share,
 * history, download — and renders the module's **tabs**: a bottom tab bar on
 * a phone, a tab strip on desktop. Each tab gets the live item handle.
 */
export interface ItemModule<T = any> {
  kind: string;
  /** Tabs, in order. The first is where the item opens. 2–5 on a phone. */
  tabs: ItemTab<T>[];
  /** A lucide icon for Files / the Store, when the name in the spec isn't
   *  one the shared icon map knows. */
  icon?: ComponentType<{ className?: string; style?: React.CSSProperties }>;
  /** An optional quick action in the header ("Start workout", "Add expense").
   *  ``nav`` switches tab / asks the assistant; to open a view's own sheet,
   *  switch to the tab and have the view read a ``?do=`` param or listen
   *  for an event. */
  primaryAction?: (
    h: ItemHandle<T>,
    nav: { goTo: (tabId: string) => void; ask: (prompt: string, opts?: { send?: boolean }) => void },
  ) => { label: string; icon?: ReactNode; onClick: () => void } | null;
  /** Extra, kind-specific setup the first time a new file opens (a goal
   *  picker…) — shown full-screen instead of the tabs while it returns true. */
  needsOnboarding?: (data: T) => boolean;
  Onboarding?: ComponentType<ItemViewProps<T>>;
}

export interface ItemTab<T = any> {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  View: ComponentType<ItemViewProps<T>>;
}

export interface ItemViewProps<T = any> {
  item: ItemHandle<T>;
  /** True below 768px: lay out for one hand. */
  isPhone: boolean;
  /** Ask the AI panel something (opens it on a phone). */
  /** Ask the AI panel something (opens it on a phone). ``{ send: false }``
   *  only puts the text in the box ("We played …") for the person to finish. */
  ask: (prompt: string, opts?: { send?: boolean }) => void;
  /** Switch to another of this item's tabs. */
  goTo: (tabId: string) => void;
  doc: ItemDoc<T>;
}
