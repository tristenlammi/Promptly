import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AvailableModel } from "@/api/types";

interface ModelState {
  available: AvailableModel[];
  /** "Currently active" pair — what the picker shows and what the
   *  next message will be sent with. Tracks per-conversation context:
   *  swapping chats updates this to the conversation's stored model
   *  (without persisting the swap as a new global default). */
  selectedProviderId: string | null;
  selectedModelId: string | null;
  /** User-level "every new chat starts here" preference, mirrored
   *  from ``user.settings.default_*`` after auth load. ``null`` means
   *  the user has not picked a default — in which case ``setAvailable``
   *  falls back to the first available model the way it always has. */
  defaultProviderId: string | null;
  defaultModelId: string | null;

  setAvailable: (models: AvailableModel[]) => void;
  setSelection: (providerId: string | null, modelId: string | null) => void;
  /** Mirror of ``user.settings`` — called by the auth bootstrap and
   *  the preferences panel after a successful PATCH. Setting either
   *  id to ``null`` clears the default. */
  setDefault: (providerId: string | null, modelId: string | null) => void;
  /** Snap the active selection back to the user's default. Called
   *  when the chat route lands on ``/chat`` (no conversation id yet)
   *  so a fresh chat always starts on the preferred model regardless
   *  of what the previous chat happened to be using. Falls back to
   *  the first available model if no default is configured or the
   *  configured default is no longer in the available list. */
  applyDefault: () => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      available: [],
      selectedProviderId: null,
      selectedModelId: null,
      defaultProviderId: null,
      defaultModelId: null,

      setAvailable: (available) => {
        set({ available });
        const {
          selectedProviderId,
          selectedModelId,
          defaultProviderId,
          defaultModelId,
        } = get();
        // If the previously-selected model was removed, prefer the
        // user's default; only fall back to the first available
        // model if the default is also gone.
        const stillValid = available.some(
          (m) =>
            m.provider_id === selectedProviderId &&
            m.model_id === selectedModelId
        );
        if (stillValid) return;
        const defaultEntry = available.find(
          (m) =>
            m.provider_id === defaultProviderId &&
            m.model_id === defaultModelId
        );
        if (defaultEntry) {
          set({
            selectedProviderId: defaultEntry.provider_id,
            selectedModelId: defaultEntry.model_id,
          });
        } else if (available.length > 0) {
          set({
            selectedProviderId: available[0].provider_id,
            selectedModelId: available[0].model_id,
          });
        } else {
          set({ selectedProviderId: null, selectedModelId: null });
        }
      },
      setSelection: (selectedProviderId, selectedModelId) =>
        set({ selectedProviderId, selectedModelId }),
      setDefault: (defaultProviderId, defaultModelId) =>
        set({ defaultProviderId, defaultModelId }),
      applyDefault: () => {
        const {
          available,
          defaultProviderId,
          defaultModelId,
          selectedProviderId,
          selectedModelId,
        } = get();
        // Resolve the default against the currently-loaded list. If
        // the user's preferred model isn't installed any more, fall
        // back to the first available so a "new chat" still has a
        // working selection rather than going blank.
        const target =
          available.find(
            (m) =>
              m.provider_id === defaultProviderId &&
              m.model_id === defaultModelId
          ) ??
          available[0] ??
          null;
        if (!target) return;
        if (
          target.provider_id === selectedProviderId &&
          target.model_id === selectedModelId
        ) {
          return;
        }
        set({
          selectedProviderId: target.provider_id,
          selectedModelId: target.model_id,
        });
      },
    }),
    {
      name: "promptly.model-selection",
      // Persist the active selection so refreshes don't blank the
      // picker before ``available`` arrives. Defaults are server-side
      // (mirrored into ``user.settings``) so they don't need to live
      // here; the auth bootstrap pushes them in via ``setDefault``.
      partialize: (state) => ({
        selectedProviderId: state.selectedProviderId,
        selectedModelId: state.selectedModelId,
      }),
    }
  )
);

/**
 * Subscribe to the currently-selected `AvailableModel`, recomputed any
 * time `available` or the selected ids change.
 *
 * History: this used to be a `selected()` method on the store, called
 * via `useModelStore((s) => s.selected)()`. That pattern subscribes to
 * the function *reference* (which is stable) instead of the state it
 * reads — so when `setAvailable` populated the model list after a page
 * refresh, components didn't re-render and the UI stayed stuck on
 * "No model selected" until something unrelated forced a render.
 *
 * Doing the lookup inside the selector makes Zustand subscribe to the
 * fields the lookup depends on, so the component re-renders the moment
 * either the list or the selection changes.
 */
export function useSelectedModel(): AvailableModel | null {
  return useModelStore(
    (s) =>
      s.available.find(
        (m) =>
          m.provider_id === s.selectedProviderId &&
          m.model_id === s.selectedModelId
      ) ?? null
  );
}

/** Resolve the user's configured default model against the currently
 *  loaded ``available`` list. Returns ``null`` when no default is set
 *  or when the configured default is not installed. Components use
 *  this to render "Default model" copy in the preferences picker
 *  without needing a second store-derivation pattern. */
export function useDefaultModel(): AvailableModel | null {
  return useModelStore(
    (s) =>
      s.available.find(
        (m) =>
          m.provider_id === s.defaultProviderId &&
          m.model_id === s.defaultModelId
      ) ?? null
  );
}
