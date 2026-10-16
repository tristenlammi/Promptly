import { shallow as shallowEqual } from "zustand/shallow";

import { useModelStore } from "@/store/modelStore";

/**
 * The model the editors' AI uses (Enhance, Ask, Sheets AI, Convert): the one
 * in use in chat, else your default, else the admin's, else the first one
 * you have — a fresh user used to be told to "pick a model first (in a
 * chat)" (R-222).
 */
export function useEditorModel(): { providerId: string | null; modelId: string | null } {
  return useModelStore((s) => {
    if (s.selectedProviderId && s.selectedModelId) {
      return { providerId: s.selectedProviderId, modelId: s.selectedModelId };
    }
    if (s.defaultProviderId && s.defaultModelId) {
      return { providerId: s.defaultProviderId, modelId: s.defaultModelId };
    }
    if (s.adminDefaultProviderId && s.adminDefaultModelId) {
      return { providerId: s.adminDefaultProviderId, modelId: s.adminDefaultModelId };
    }
    const first = s.available.find((m) => !m.supports_image_output);
    return { providerId: first?.provider_id ?? null, modelId: first?.model_id ?? null };
  }, shallowEqual);
}

export const NO_MODEL_MESSAGE = "No AI model is available to you yet — ask an admin to add one.";
