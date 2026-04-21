import { create } from "zustand";

/**
 * Cross-component UI state that doesn't belong in any feature store.
 *
 * Currently just the mobile navigation drawer. AppLayout owns the actual
 * rendering of the drawer; TopNav exposes the hamburger button. They
 * communicate through this store so we don't have to prop-drill an
 * ``onMenuClick`` through every page.
 *
 * Desktop never reads or writes ``mobileNavOpen`` — the drawer markup
 * is gated on ``useIsMobile`` upstream, so this state is inert there.
 */
interface UIState {
  mobileNavOpen: boolean;
  openMobileNav: () => void;
  closeMobileNav: () => void;
  toggleMobileNav: () => void;

  /** Global full-text search palette (Ctrl/Cmd+K). Lives in the UI
   *  store so the sidebar "Search" entry and the keyboard shortcut
   *  can both flip it without prop-drilling through AppLayout. */
  searchPaletteOpen: boolean;
  openSearchPalette: () => void;
  closeSearchPalette: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  mobileNavOpen: false,
  openMobileNav: () => set({ mobileNavOpen: true }),
  closeMobileNav: () => set({ mobileNavOpen: false }),
  toggleMobileNav: () =>
    set((state) => ({ mobileNavOpen: !state.mobileNavOpen })),

  searchPaletteOpen: false,
  openSearchPalette: () => set({ searchPaletteOpen: true }),
  closeSearchPalette: () => set({ searchPaletteOpen: false }),
}));
