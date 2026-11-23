import { apiClient } from "./client";

/** One thing an admin sets up, with a status the server checked. */
export interface SetupRow {
  id: string;
  title: string;
  /** essential: the assistant needs it. recommended: a family will want it.
   *  outside: only you can do it, on your router. extra: optional apps. */
  group: "essential" | "recommended" | "outside" | "extra";
  /** working = busy by itself, nothing to do. */
  status: "done" | "todo" | "working" | "problem";
  detail: string;
  /** A wizard step ("/setup?step=…") or an admin page. */
  to: string | null;
  action: string | null;
}

export interface SetupOutside {
  origins: string[];
  /** The outside address people use, when one is saved. */
  address: string | null;
  https: boolean;
  /** This machine's home-network address, when the server knows it. */
  lan_address: string | null;
  ports: { udp: number; tcp: number };
  calls: {
    there: boolean;
    running: boolean;
    enabled: boolean;
    inside_ok: boolean;
    /** The last test call from outside: passed, failed, or never run. */
    outside: boolean | null;
  };
  maps: { there: boolean; state: string; step: string | null; ready: boolean };
  voice: { there: boolean };
  push: { ready: boolean };
}

export interface SetupChecklist {
  rows: SetupRow[];
  services: Record<string, boolean>;
  outside: SetupOutside;
  done: number;
  total: number;
  essential_left: number;
  left: number;
  dismissed: boolean;
}

export interface ModelPick {
  provider_id: string;
  model_id: string;
  name: string;
  provider_name: string;
}

export interface ModelRole {
  role: "chat" | "quick" | "voice" | "see" | "draw";
  /** The app-settings pair it saves to: `${field}_provider_id` / `_model_id`. */
  field: "default_chat" | "memory" | "voice" | "vision_relay" | "image_gen";
  label: string;
  what: string;
  /** What happens when nothing is chosen. */
  unset: string;
  only: "chat" | "vision" | "image";
  suggestion: ModelPick | null;
  current: ModelPick | null;
}

export interface ModelSuggestions {
  has_models: boolean;
  /** The built-in Promptly model, when it still exists: the chat job is
   *  then "the model behind Promptly". */
  promptly: { id: string; display_name: string; ready: boolean; is_default: boolean } | null;
  roles: ModelRole[];
}

export interface EmbeddingOption {
  provider_id: string;
  provider_name: string;
  provider_type: string;
  model_id: string;
  dim: number;
}

export const SETUP_QUERY_KEY = ["admin", "setup"] as const;

export const setupApi = {
  async checklist(): Promise<SetupChecklist> {
    const { data } = await apiClient.get<SetupChecklist>("/admin/setup");
    return data;
  },
  /** Put a model behind the built-in Promptly model; by default new chats
   *  then start on Promptly. */
  async setPromptlyModel(provider_id: string, model_id: string, make_default = true): Promise<{
    model_id: string;
    provider_id: string;
    default_chat_provider_id: string | null;
    default_chat_model_id: string | null;
  }> {
    const { data } = await apiClient.put("/admin/setup/promptly-model", { provider_id, model_id, make_default });
    return data;
  },
  /** Reading (embedding) models the connected services offer in one click. */
  async embeddingOptions(): Promise<EmbeddingOption[]> {
    const { data } = await apiClient.get<{ options: EmbeddingOption[] }>("/admin/setup/embedding-options");
    return data.options;
  },
  async modelSuggestions(): Promise<ModelSuggestions> {
    const { data } = await apiClient.get<ModelSuggestions>("/admin/setup/model-suggestions");
    return data;
  },
};
