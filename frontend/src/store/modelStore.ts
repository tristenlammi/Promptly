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
   *  the user has not picked a default — in which case the fallback
   *  chain consults the admin default below, then the first available
   *  model. */
  defaultProviderId: string | null;
  defaultModelId: string | null;
  /** Workspace-wide default chat model picked by the admin under
   *  ``Admin → Models → Defaults``. Mirrored from
   *  ``GET /api/workspace-defaults`` after auth load. Used as the
   *  *second* fallback (after the user's personal default and before
   *  the catalog's first-available model) so a fresh user without a
   *  personal default lands on the admin's preferred starting model
   *  rather than whatever the catalog returns first. ``null`` on
   *  either half = "no admin default — fall through". */
  adminDefaultProviderId: string | null;
  adminDefaultModelId: string | null;
  /** Vision relay model picked by the admin under
   *  ``Admin → Models → Defaults``. Mirrored from the same
   *  workspace-defaults call. The chat composer reads this so it can
   *  soften the "this model can't read images" warning into an
   *  informational chip when an image is queued against a non-vision
   *  model and a relay is configured. Half-null = "no relay — images
   *  on non-vision models really do get dropped". */
  visionRelayProviderId: string | null;
  visionRelayModelId: string | null;
  /** Transient counter bumped whenever some other surface wants the
   *  TopNav model picker to open (e.g. the "Pick another model" button
   *  on a stream-error card). The ``ModelSelector`` watches this and
   *  opens its dropdown on each increment. Not persisted. */
  pickerOpenNonce: number;

  setAvailable: (models: AvailableModel[]) => void;
  setSelection: (providerId: string | null, modelId: string | null) => void;
  /** Mirror of ``user.settings`` — called by the auth bootstrap and
   *  the preferences panel after a successful PATCH. Setting either
   *  id to ``null`` clears the default. */
  setDefault: (providerId: string | null, modelId: string | null) => void;
  /** Mirror of the admin's workspace default — called by the auth
   *  bootstrap (which hits ``GET /api/workspace-defaults`` after
   *  login) and by the admin Defaults card after a successful PATCH
   *  so the picker reflects the change immediately. */
  setAdminDefault: (
    providerId: string | null,
    modelId: string | null,
  ) => void;
  /** Mirror of the admin's vision-relay pick. Called by the auth
   *  bootstrap alongside ``setAdminDefault`` and by the relay card
   *  after a successful PATCH. */
  setVisionRelay: (
    providerId: string | null,
    modelId: string | null,
  ) => void;
  /** Snap the active selection back to the user's default. Called
   *  when the chat route lands on ``/chat`` (no conversation id yet)
   *  so a fresh chat always starts on the preferred model regardless
   *  of what the previous chat happened to be using. Three-step
   *  fallback when the personal default is missing or unavailable:
   *  admin default → first available → blank. */
  applyDefault: () => void;
  /** Ask the TopNav model picker to open. */
  requestPickerOpen: () => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      available: [],
      selectedProviderId: null,
      selectedModelId: null,
      defaultProviderId: null,
      defaultModelId: null,
      adminDefaultProviderId: null,
      adminDefaultModelId: null,
      visionRelayProviderId: null,
      visionRelayModelId: null,
      pickerOpenNonce: 0,

      setAvailable: (available) => {
        set({ available });
        const {
          selectedProviderId,
          selectedModelId,
          defaultProviderId,
          defaultModelId,
          adminDefaultProviderId,
          adminDefaultModelId,
        } = get();
        // If the previously-selected model was removed, walk the
        // fallback chain: personal default → admin default →
        // first available.
        const stillValid = available.some(
          (m) =>
            m.provider_id === selectedProviderId &&
            m.model_id === selectedModelId
        );
        if (stillValid) return;
        const personalEntry = available.find(
          (m) =>
            m.provider_id === defaultProviderId &&
            m.model_id === defaultModelId
        );
        const adminEntry = available.find(
          (m) =>
            m.provider_id === adminDefaultProviderId &&
            m.model_id === adminDefaultModelId,
        );
        const target = personalEntry ?? adminEntry ?? available[0] ?? null;
        if (target) {
          set({
            selectedProviderId: target.provider_id,
            selectedModelId: target.model_id,
          });
        } else {
          set({ selectedProviderId: null, selectedModelId: null });
        }
      },
      setSelection: (selectedProviderId, selectedModelId) =>
        set({ selectedProviderId, selectedModelId }),
      setDefault: (defaultProviderId, defaultModelId) =>
        set({ defaultProviderId, defaultModelId }),
      setAdminDefault: (adminDefaultProviderId, adminDefaultModelId) =>
        set({ adminDefaultProviderId, adminDefaultModelId }),
      setVisionRelay: (visionRelayProviderId, visionRelayModelId) =>
        set({ visionRelayProviderId, visionRelayModelId }),
      applyDefault: () => {
        const {
          available,
          defaultProviderId,
          defaultModelId,
          adminDefaultProviderId,
          adminDefaultModelId,
          selectedProviderId,
          selectedModelId,
        } = get();
        // Three-step fallback chain. Each step is gated on the model
        // actually existing in the currently-loaded catalog so a
        // stale id (e.g. provider deleted since the bootstrap) doesn't
        // produce a blank picker.
        const personalEntry = available.find(
          (m) =>
            m.provider_id === defaultProviderId &&
            m.model_id === defaultModelId,
        );
        const adminEntry = available.find(
          (m) =>
            m.provider_id === adminDefaultProviderId &&
            m.model_id === adminDefaultModelId,
        );
        const target =
          personalEntry ?? adminEntry ?? available[0] ?? null;
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
      requestPickerOpen: () =>
        set((s) => ({ pickerOpenNonce: s.pickerOpenNonce + 1 })),
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
