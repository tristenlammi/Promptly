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
  | "file_upload"
  | "choice_grid"
  | "checkbox_grid"
  | "location";
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
/** A grid's row or column (stable ids, like options: a renamed row keeps its answers). */
export interface GridLine {
  id: string;
  label: string;
}
export interface ChoiceGridConfig {
  rows: GridLine[];
  columns: GridLine[];
  /** Every row needs an answer (``required`` alone means at least one). */
  each_row: boolean;
  shuffle_rows: boolean;
  /** Each column can be picked in one row only ("rank these"). */
  one_per_column: boolean;
}
export interface CheckboxGridConfig {
  rows: GridLine[];
  columns: GridLine[];
  each_row: boolean;
  shuffle_rows: boolean;
}
/** A Location question: what to ask for (suggestions follow it). */
export interface LocationConfig {
  ask: "address" | "town" | "any";
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
  choice_grid: ChoiceGridConfig;
  checkbox_grid: CheckboxGridConfig;
  location: LocationConfig;
  text: Record<string, never>;
  image: ImageConfig;
  section: SectionConfig;
}

/** A quiz question's answer key (WP-F2.3), by kind: choices ``options``
 *  (any of them right; checkboxes: exactly that set), short answers
 *  ``accept``, grids ``rows`` (a column, or columns, per row). Paragraphs
 *  have none: they're marked by hand. */
export interface QuizKey {
  options?: string[];
  accept?: string[];
  rows?: Record<string, string | string[]>;
}
export interface ItemQuiz {
  /** 0–100; a grid's are per row right. */
  points: number;
  key: QuizKey | null;
  feedback_right: string;
  feedback_wrong: string;
  /** Made by AI: shown as "check it" until the owner touches it. */
  suggested?: boolean;
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
  /** Points and the answer key in a quiz (never sent to the answer page). */
  quiz?: ItemQuiz | null;
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

/** A quiz's settings (null: not a quiz). */
export interface QuizSettings {
  /** Straight after sending, or later when you press Release scores. */
  release: "now" | "later";
  show_score: boolean;
  show_right_wrong: boolean;
  /** Turns "Let people change their answer" off while it's on. */
  show_answers: boolean;
  show_points: boolean;
  /** What "change their answer" was before (put back when this goes off). */
  edit_before?: boolean;
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
  quiz: QuizSettings | null;
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
  /** A quiz's key changed: this many answers are being marked again. */
  remarking?: number;
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

/** Who sent an answer: an account, an email they typed (not checked),
 *  someone with the link, or an account that has since been removed. */
export interface Respondent {
  kind: "account" | "email" | "link" | "gone";
  name: string;
}

export interface SummaryOption {
  id: string;
  label: string;
  count: number;
  /** Places on the option (null: no limit) and how many are taken. */
  limit: number | null;
  taken: number | null;
}

export interface SummaryQuestion {
  id: string;
  title: string;
  kind: QuestionKind;
  deleted: boolean;
  /** How many answers have something for this question. */
  answered: number;
  options?: SummaryOption[];
  /** "Other" answers (null when the question has no "Other"). */
  other?: number | null;
  bins?: { value: number; count: number }[];
  average?: number | null;
  min_label?: string;
  max_label?: string;
  groups?: { value: string; count: number }[];
  more_groups?: number;
  latest?: { number: number; text: string; submitted_at: string | null }[];
  /** File questions: the newest files sent (WP-F1.6). */
  files?: (AnswerFile & { number: number })[];
  /** Grids (WP-F2.1): how many picked each column, per row. */
  rows?: { id: string; label: string; answered: number; counts: Record<string, number> }[];
  columns?: GridLine[];
  /** Location questions (WP-F2.2): the newest places, and how many have a spot. */
  places?: AnswerPlace[];
  with_spot?: number;
}

/** A Location answer: its words, and its spot when a suggestion was picked. */
export interface AnswerPlace {
  number: number;
  text: string;
  lat?: number;
  lon?: number;
  question_id?: string;
}

/** A file someone sent with an answer: signed links that work for a few
 *  hours (``url`` always downloads; ``thumb`` is a picture's tile once
 *  it's made). ``missing``: deleted since. ``outside``: from someone
 *  with the link, not an account. */
export interface AnswerFile {
  id: string;
  name: string;
  size?: number;
  mime?: string;
  image?: boolean;
  thumb?: string | null;
  url?: string;
  missing?: boolean;
  outside: boolean;
}

export type NotifyMode = "each" | "daily" | "off";

export interface NotifySettings {
  mode: NotifyMode;
  email_daily: boolean;
  /** This server can send email. */
  can_email: boolean;
}

/** What can be wrong with the linked sheet (WP-F1.5). */
export type SheetProblem = "waiting" | "full" | "tab_deleted" | "trashed" | "deleted";

/** The Sheet card: the linked sheet and how up to date it is. */
export interface LinkedSheet {
  file_id: string | null;
  title: string | null;
  tab_name: string;
  synced_at: string | null;
  /** Answers not written into it yet. */
  pending: number;
  problem: SheetProblem | null;
  message: string | null;
  /** You can open the sheet itself. */
  can_open: boolean;
}

/** The Summary's Scores strip (a quiz): counts only, never names. */
export interface QuizStats {
  max: number;
  marked: number;
  average: number | null;
  median: number | null;
  top: number | null;
  histogram: { label: string; from: number; to: number; count: number }[];
  pending: number;
  released: number;
  unreleased: number;
  release: "now" | "later";
  questions: { id: string; title: string; right_pct: number; answered: number }[];
  most_missed: { id: string; title: string; right_pct: number; answered: number }[];
}

/** One answer's marks. ``points`` null: a paragraph still to mark. */
export interface AnswerMarks {
  score: number;
  max: number;
  pending: number;
  released: boolean;
  items: Record<string, { points: number | null; max: number; right: boolean | null; by: "auto" | "owner"; rows?: Record<string, boolean> }>;
}

export interface ScoreRow {
  number: number;
  who: Respondent;
  score: number;
  max: number;
  pending: number;
  released: boolean;
  submitted_at: string | null;
}

export interface ResponsesSummary {
  total: number;
  first_number: number | null;
  latest_number: number | null;
  new_count: number;
  can_delete: boolean;
  accepting: boolean;
  notify: NotifySettings;
  questions: SummaryQuestion[];
  /** ``null``: no sheet linked. */
  sheet: LinkedSheet | null;
  can_link_sheet: boolean;
  /** A quiz (WP-F2.3/4): the Scores strip; null when it isn't one. */
  quiz?: QuizStats | null;
  /** You can mark answers and release scores (edit access). */
  can_mark?: boolean;
}

export interface QuestionAnswers {
  question: { id: string; title: string; kind: QuestionKind; deleted: boolean };
  items: { number: number; submitted_at: string | null; who: Respondent; text: string; files?: AnswerFile[] }[];
  next_before: number | null;
}

export interface OneResponse {
  number: number;
  position: number;
  total: number;
  prev: number | null;
  next: number | null;
  who: Respondent;
  source: "server" | "link";
  submitted_at: string | null;
  edited_at: string | null;
  answers: {
    id: string;
    title: string;
    kind: QuestionKind;
    deleted: boolean;
    answered: boolean;
    text: string;
    files?: AnswerFile[];
  }[];
  /** A quiz: this answer's marks. */
  quiz?: AnswerMarks | null;
}

/** "Summarise" on a text question (AI): themes with counts and quotes. */
export interface AnswerSummary {
  question_id: string;
  answers: number;
  themes: { title: string; count: number; summary: string; quotes: { number: number; text: string }[] }[];
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
  /** The answer link (``/f/<token>``): made the first time; ``reset`` replaces it (the old one stops working). */
  async makeLink(fileId: string, reset = false): Promise<FormView> {
    const { data } = await apiClient.post<FormView>(`/forms/${fileId}/link`, { reset });
    return data;
  },
  /** Turn the answer link off. */
  async turnOffLink(fileId: string): Promise<FormView> {
    const { data } = await apiClient.delete<FormView>(`/forms/${fileId}/link`);
    return data;
  },
  /** Send the form to people on this server (a notification that opens it). */
  async send(fileId: string, userIds: string[]): Promise<{ sent: number }> {
    const { data } = await apiClient.post<{ sent: number }>(`/forms/${fileId}/send`, { user_ids: userIds });
    return data;
  },
  /** The Responses tab: every question's counts, and how many are new to you. */
  async summary(fileId: string): Promise<ResponsesSummary> {
    const { data } = await apiClient.get<ResponsesSummary>(`/forms/${fileId}/summary`);
    return data;
  },
  /** Every answer to one question, newest first; ``before`` pages back, ``q`` searches text. */
  async questionAnswers(fileId: string, question: string, opts: { before?: number | null; q?: string } = {}): Promise<QuestionAnswers> {
    const { data } = await apiClient.get<QuestionAnswers>(`/forms/${fileId}/responses`, {
      params: { question, before: opts.before ?? undefined, q: opts.q || undefined },
    });
    return data;
  },
  /** A quiz's Scores view: every marked answer, best first. */
  async scores(fileId: string): Promise<ScoreRow[]> {
    const { data } = await apiClient.get<{ scores: ScoreRow[] }>(`/forms/${fileId}/scores`);
    return data.scores;
  },
  /** Mark a paragraph (or change an automatic mark); null: automatic again. */
  async mark(fileId: string, number: number, marks: Record<string, number | null>): Promise<AnswerMarks> {
    const { data } = await apiClient.put(`/forms/${fileId}/responses/${number}/marks`, { marks });
    return data.marks as AnswerMarks;
  },
  /** "Release scores": every answer with nothing left to mark (or these). */
  async release(fileId: string, numbers?: number[]): Promise<{ released: number; still_to_mark: number }> {
    const { data } = await apiClient.post(`/forms/${fileId}/release`, numbers ? { numbers } : {});
    return data;
  },
  /** Every picked place (with a spot), for "Show on a map". */
  async places(fileId: string, question?: string): Promise<{ places: AnswerPlace[]; capped: boolean }> {
    const { data } = await apiClient.get(`/forms/${fileId}/places`, { params: question ? { question } : undefined });
    return data;
  },
  async response(fileId: string, number: number): Promise<OneResponse> {
    const { data } = await apiClient.get<OneResponse>(`/forms/${fileId}/responses/${number}`);
    return data;
  },
  async summarise(fileId: string, questionId: string, model: { provider_id: string; model_id: string }): Promise<AnswerSummary> {
    const { data } = await apiClient.post(`/forms/${fileId}/ai/summary`, { question_id: questionId, ...model }, { timeout: 240_000 });
    return data;
  },
  /** "Add an RSVP form" on a Calendar event (the one it has, or a new one). */
  async fromEvent(eventId: string): Promise<{ file: { id: string }; made: boolean }> {
    const { data } = await apiClient.post(`/forms/from-event`, { event_id: eventId });
    return data;
  },
  /** Save to Files: a copy of a file someone sent, into your own Drive. */
  async saveUpload(fileId: string, uploadId: string): Promise<{ file: { id: string; filename: string; folder_id: string | null } }> {
    const { data } = await apiClient.post(`/forms/${fileId}/uploads/${uploadId}/save`);
    return data;
  },
  async deleteResponse(fileId: string, number: number): Promise<{ deleted: number; response_count: number }> {
    const { data } = await apiClient.delete(`/forms/${fileId}/responses/${number}`);
    return data;
  },
  async deleteAllResponses(fileId: string): Promise<{ deleted: number; response_count: number }> {
    const { data } = await apiClient.delete(`/forms/${fileId}/responses`);
    return data;
  },
  /** Download every answer as CSV or Excel (formula-safe). */
  async exportResponses(fileId: string, format: "csv" | "xlsx"): Promise<{ blob: Blob; filename: string }> {
    const res = await apiClient.get<Blob>(`/forms/${fileId}/export`, { params: { format }, responseType: "blob", timeout: 120_000 });
    const dispo = String(res.headers?.["content-disposition"] ?? "");
    const utf8 = dispo.match(/filename\*=UTF-8''([^;]+)/i);
    let filename = `Responses.${format}`;
    if (utf8) {
      try {
        filename = decodeURIComponent(utf8[1].trim());
      } catch {
        /* keep the fallback */
      }
    }
    return { blob: res.data, filename };
  },
  /** Link a sheet: a new spreadsheet (``name``) or a "Form responses" tab in one you have (``file_id``). */
  async linkSheet(fileId: string, body: { mode: "new"; name?: string } | { mode: "existing"; file_id: string }): Promise<LinkedSheet | null> {
    const { data } = await apiClient.post<{ sheet: LinkedSheet | null }>(`/forms/${fileId}/sheet`, body, { timeout: 120_000 });
    return data.sheet;
  },
  /** Bring the linked sheet up to date now. */
  async syncSheet(fileId: string): Promise<LinkedSheet | null> {
    const { data } = await apiClient.post<{ sheet: LinkedSheet | null }>(`/forms/${fileId}/sheet/sync`, undefined, { timeout: 120_000 });
    return data.sheet;
  },
  /** Stop updating the sheet (it's kept). */
  async unlinkSheet(fileId: string): Promise<void> {
    await apiClient.delete(`/forms/${fileId}/sheet`);
  },
  async setNotify(fileId: string, changes: { mode?: NotifyMode; email_daily?: boolean }): Promise<NotifySettings> {
    const { data } = await apiClient.put<NotifySettings>(`/forms/${fileId}/notify`, changes);
    return data;
  },
  /** You looked at the answers: "new" counts from now. */
  async markSeen(fileId: string): Promise<void> {
    await apiClient.post(`/forms/${fileId}/seen`);
  },
  /** A new form in your Forms folder: blank, a built-in template, or one you saved. */
  async create(payload: { template?: string; template_id?: string; title?: string } = {}): Promise<FileItem> {
    const { data } = await apiClient.post<{ file: FileItem }>(`/forms`, payload);
    return data.file;
  },
};
