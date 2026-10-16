import { apiClient } from "@/api/client";
import type { FileItem } from "@/api/files";

/** AI in the editors (WP-5.5). Model calls take a while — generous timeouts. */

export interface AskTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SheetAiResult {
  values: { row: number; value: string | number }[];
  cells: (string | number)[][];
  changed: number;
  title: string | null;
  columns: string[];
  table: (string | number)[][];
}

interface ModelPick {
  provider_id: string | null;
  model_id: string | null;
}

/** A generated deck (Stage 12): each slide's words and where they came from. */
export interface DeckSlide {
  title: string;
  bullets: string[];
  notes: string;
  sources: { file_id: string; name: string }[];
}

export const editorAiApi = {
  /** "Generate a deck from these files" — slides to add, not added yet. */
  async deck(
    fileId: string,
    body: ModelPick & { file_ids: string[]; brief?: string; slides?: number },
  ): Promise<{ slides: DeckSlide[]; truncated: boolean }> {
    const { data } = await apiClient.post(`/files/${fileId}/ai/deck`, body, { timeout: 240_000 });
    return data;
  },

  async ask(
    fileId: string,
    body: ModelPick & { question: string; selection?: string | null; history?: AskTurn[] }
  ): Promise<{ answer: string; truncated: boolean }> {
    const { data } = await apiClient.post(`/files/${fileId}/ai/ask`, body, { timeout: 180_000 });
    return data;
  },

  async sheet(
    fileId: string,
    body: ModelPick & {
      mode: "fill" | "clean" | "build";
      instruction?: string;
      target?: string;
      rows?: { row: number; values: Record<string, string | number> }[];
      cells?: (string | number)[][];
    }
  ): Promise<SheetAiResult> {
    const { data } = await apiClient.post(`/files/${fileId}/ai/sheet`, body, { timeout: 240_000 });
    return data;
  },

  async convert(
    body: ModelPick & { source_file_id: string; to: "sheet" | "document" }
  ): Promise<{ file: FileItem; notes: string[] }> {
    const { data } = await apiClient.post(`/files/office/convert-ai`, body, { timeout: 600_000 });
    return data;
  },
};
