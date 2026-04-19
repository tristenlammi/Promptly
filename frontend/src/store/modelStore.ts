import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AvailableModel } from "@/api/types";

interface ModelState {
  available: AvailableModel[];
  selectedProviderId: string | null;
  selectedModelId: string | null;

  setAvailable: (models: AvailableModel[]) => void;
  setSelection: (providerId: string | null, modelId: string | null) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      available: [],
      selectedProviderId: null,
      selectedModelId: null,

      setAvailable: (available) => {
        set({ available });
        const { selectedProviderId, selectedModelId } = get();
        // If the previously-selected model was removed, auto-pick the first.
        const stillValid = available.some(
          (m) =>
            m.provider_id === selectedProviderId && m.model_id === selectedModelId
        );
        if (!stillValid && available.length > 0) {
          set({
            selectedProviderId: available[0].provider_id,
            selectedModelId: available[0].model_id,
          });
        } else if (available.length === 0) {
          set({ selectedProviderId: null, selectedModelId: null });
        }
      },
      setSelection: (selectedProviderId, selectedModelId) =>
        set({ selectedProviderId, selectedModelId }),
    }),
    {
      name: "promptly.model-selection",
      // Only persist the selection, not the list (which we always refetch).
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
