import { apiClient } from "./client";
import type { FileItem } from "./files";

/**
 * Forms (``/api/forms``): a form is a Files document type whose content —
 * the definition (questions, sections, theme) and settings — lives in its
 * own row. The builder saves the whole definition with a version guard
 * (``data_version``: a save from an older version is a 409 with the newer
 * one, so nothing is overwritten unseen).
 *
 * Mirrors ``backend/app/forms/definition.py``.
 */

export type Accent =
  | "terracotta"
  | "rose"
  | "plum"
  | "violet"
  | "indigo"
  | "blue"
  | "teal"
  | "green"
  | "olive"
  | "slate";

export type FormFont = "default" | "serif" | "rounded";

export interface FormTheme {
  accent: Accent;
  header_asset_id: string | null;
  header_builtin: string | null;
  font: FormFont;
}

export type QuestionKind =
  | "short_text"
  | "paragraph"
  | "multiple_choice"
  | "checkboxes"
  | "dropdown"
  | "linear_scale"
  | "rating"
  | "date"
  | "time"
  | "file_upload";
export type BlockKind = "text" | "image" | "section";
export type ItemKind = QuestionKind | BlockKind;

export interface FormOption {
  id: string;
  label: string;
  /** Branching on: a section id, "submit", or null (carry on). */
  go_to: string | null;
  /** Places on this option (sign-up sheets); null = no limit. */
  limit: number | null;
  image_asset_id: string | null;
}

export interface ShortTextConfig {
  validation: { kind: "any" | "number" | "email" | "url"; min: number | null; max: number | null; integer: boolean };
  min_length: number | null;
  max_length: number | null;
}
export interface ParagraphConfig {
  min_length: number | null;
  max_length: number;
}
export interface MultipleChoiceConfig {
  options: FormOption[];
  other: boolean;
  shuffle: boolean;
  branching: boolean;
}
export interface CheckboxesConfig {
  options: FormOption[];
  other: boolean;
  shuffle: boolean;
  min_selected: number | null;
  max_selected: number | null;
}
export interface DropdownConfig {
  options: FormOption[];
  branching: boolean;
}
export interface LinearScaleConfig {
  min: 0 | 1;
  max: number;
  min_label: string;
  max_label: string;
}
export interface RatingConfig {
  max: number;
  icon: "star" | "heart" | "thumb";
}
export interface DateConfig {
  include_time: boolean;
  include_year: boolean;
}
export interface TimeConfig {
  mode: "time" | "duration";
}
export type UploadGroup = "images" | "pdf" | "documents" | "spreadsheets" | "audio" | "video";
export interface FileUploadConfig {
  kinds: UploadGroup[];
  max_files: number;
  max_size_mb: number;
}
export interface ImageConfig {
  alt: string;
}
export interface SectionConfig {
  /** "continue", "submit" or a section id. */
  after: string;
}

export interface ConfigByKind {
  short_text: ShortTextConfig;
  paragraph: ParagraphConfig;
  multiple_choice: MultipleChoiceConfig;
  checkboxes: CheckboxesConfig;
  dropdown: DropdownConfig;
  linear_scale: LinearScaleConfig;
  rating: RatingConfig;
  date: DateConfig;
  time: TimeConfig;
  file_upload: FileUploadConfig;
  text: Record<string, never>;
  image: ImageConfig;
  section: SectionConfig;
}

export interface FormItem<K extends ItemKind = ItemKind> {
  id: string;
  kind: K;
  title: string;
  description: string;
  image_asset_id: string | null;
  required: boolean;
  config: ConfigByKind[K];
  /** A question with answers that was deleted: kept for its answers. */
  deleted: boolean;
}

export interface FormDefinition {
  version: 1;
  title: string;
  description: string;
  theme: FormTheme;
  /** Where section 1 goes when it ends. */
  after: string;
  items: FormItem[];
}

export interface FormSettings {
  audience: "server" | "link";
  accepting: boolean;
  close_at: string | null;
  max_responses: number | null;
  one_per_person: boolean;
  allow_edit: boolean;
  collect_email: boolean;
  show_remaining: boolean;
  allow_uploads_from_link: boolean;
  confirmation: string;
  closed_message: string;
  allow_another: boolean;
}

export interface FormRecord {
  id: string;
  file_id: string;
  definition: FormDefinition;
  data_version: number;
  settings: FormSettings;
  state: "open" | "closed" | "trashed";
  response_count: number;
  last_response_at: string | null;
  event_id: string | null;
  sheet_file_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface FormView {
  file: FileItem;
  access: "read" | "edit";
  is_owner: boolean;
  form: FormRecord;
  link: { token: string; url: string; created_at: string | null } | null;
  /** Signed links to the form's pictures, by asset id. */
  asset_urls: Record<string, string>;
  link_answers_allowed: boolean;
  limits: { max_items: number; max_sections: number; max_options: number; max_json_bytes: number; max_asset_bytes: number };
}

export interface SaveResult {
  data_version: number;
  definition: FormDefinition;
  asset_urls: Record<string, string>;
  file: FileItem;
}

/** The 409 body when someone saved since. */
export interface StaleBody {
  code: "stale";
  message: string;
  data_version: number;
  definition: FormDefinition;
}

export interface FormTemplateInfo {
  key: string;
  title: string;
  description: string;
  accent: Accent;
  questions: number;
}

export interface FormCard {
  file_id: string;
  title: string;
  accent: Accent;
  font: FormFont;
  header_builtin: string | null;
  header_url: string | null;
  questions: number;
  response_count: number;
  new_count: number;
  seen: boolean;
  state: "open" | "closed";
  accepting: boolean;
  close_at: string | null;
  audience: "server" | "link";
  modified_at: string | null;
  starred: boolean;
  folder_id: string | null;
  owner: string | null;
}

export const formsApi = {
  async get(fileId: string): Promise<FormView> {
    const { data } = await apiClient.get<FormView>(`/forms/${fileId}`);
    return data;
  },
  async saveDefinition(fileId: string, definition: FormDefinition, dataVersion: number): Promise<SaveResult> {
    const { data } = await apiClient.put<SaveResult>(`/forms/${fileId}/definition`, {
      definition,
      data_version: dataVersion,
    });
    return data;
  },
  async updateSettings(fileId: string, changes: Partial<FormSettings>): Promise<FormView> {
    const { data } = await apiClient.patch<FormView>(`/forms/${fileId}/settings`, changes);
    return data;
  },
  async uploadAsset(fileId: string, file: File): Promise<{ id: string; url: string }> {
    const form = new FormData();
    form.append("file", file);
    const { data } = await apiClient.post<{ id: string; url: string }>(`/forms/${fileId}/assets`, form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 60_000,
    });
    return data;
  },
  /** Copy a picture from your Photos / Files into the form. */
  async assetFromFile(fileId: string, sourceFileId: string): Promise<{ id: string; url: string }> {
    const { data } = await apiClient.post<{ id: string; url: string }>(`/forms/${fileId}/assets/from-file`, {
      file_id: sourceFileId,
    });
    return data;
  },
  async templates(): Promise<{ built_in: FormTemplateInfo[]; mine: { id: string; title: string; modified_at: string | null }[] }> {
    const { data } = await apiClient.get(`/forms/templates`);
    return data;
  },
  async list(scope: "mine" | "shared"): Promise<FormCard[]> {
    const { data } = await apiClient.get<{ forms: FormCard[] }>(`/forms`, { params: { scope } });
    return data.forms;
  },
  /** A new form in your Forms folder: blank, a built-in template, or one you saved. */
  async create(payload: { template?: string; template_id?: string; title?: string } = {}): Promise<FileItem> {
    const { data } = await apiClient.post<{ file: FileItem }>(`/forms`, payload);
    return data.file;
  },
};
