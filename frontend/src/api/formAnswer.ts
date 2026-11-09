import type { SearchRowLike } from "@/lib/locationSuggest";

import { apiClient } from "./client";
import type { FormDefinition } from "./forms";

/**
 * The answer side of Forms, ``/api/f/{token}`` (WP-F1.3): what the
 * ``/f/:token`` page loads and sends. No sign-in needed — the client adds
 * the Bearer token when someone is signed in, which is how a server form
 * knows who's answering.
 *
 * Every dead link (unknown, turned off, in the trash) is the same 404
 * ``{code: "gone"}``; refusals carry a ``code`` the page acts on.
 */

export type AnswerPageState = "open" | "closed" | "sign_in";

/** Your own quiz result (WP-F2.3), only what the owner chose to show. */
export interface QuizResultView {
  number?: number;
  released: boolean;
  pending?: number;
  score?: number;
  max?: number;
  items?: {
    id: string;
    title: string;
    waiting: boolean;
    right?: boolean | null;
    points?: number | null;
    max?: number;
    correct?: string;
    feedback?: string;
  }[];
}

export interface MyAnswer {
  number: number;
  answers: Record<string, unknown>;
  /** Files already sent with this answer, by upload id. */
  files?: Record<string, { name: string }>;
  email: string | null;
  submitted_at: string | null;
  edited_at: string | null;
}

export interface AnswerPageOpen {
  state: "open";
  audience: "server" | "link";
  definition: FormDefinition;
  asset_urls: Record<string, string>;
  settings: {
    collect_email: boolean;
    allow_edit: boolean;
    allow_another: boolean;
    one_per_person: boolean;
    show_remaining: boolean;
    confirmation: string;
  };
  /** Places left on limited options, by question and option id. */
  remaining: Record<string, Record<string, number>>;
  start_token: string;
  respondent: { name: string } | null;
  /** Signed in and answered before. */
  answered: boolean;
  /** Your last answer (signed in, with changing answers on). */
  mine: MyAnswer | null;
  closes_at: string | null;
  /** File questions: who may send files here, and what the picker takes per question. */
  uploads: { mode: "all" | "link" | "none"; accept: Record<string, string> };
  /** The event this form is for (an RSVP from Calendar): "Add to my calendar". */
  event: { title: string } | null;
  /** A quiz: when scores come. */
  quiz?: { release: "now" | "later" } | null;
  /** Signed in and answered a quiz: your own result. */
  my_result?: QuizResultView | null;
}

/** A file picked on the answer page, kept until the answer is sent. */
export interface StagedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  image: boolean;
}

export interface AnswerPageClosed {
  state: "closed";
  audience: "server" | "link";
  definition: FormDefinition;
  asset_urls: Record<string, string>;
  closed_message: string;
  /** A quiz: you can still look up your own score. */
  quiz?: boolean;
}

export interface AnswerPageSignIn {
  state: "sign_in";
  audience: "server";
}

export type AnswerPage = AnswerPageOpen | AnswerPageClosed | AnswerPageSignIn;

export interface SubmitBody {
  answers: Record<string, unknown>;
  submit_id: string;
  start_token: string;
  email?: string;
  /** The honeypot: always empty from a person. */
  website?: string;
  /** Changing a link answer: its edit token. */
  edit?: string;
  /** This page's key for the files it picked. */
  draft_key?: string;
}

/** A refusal's body (``detail``). */
export interface Refusal {
  code:
    | "gone"
    | "closed"
    | "sign_in"
    | "invalid"
    | "full"
    | "already_answered"
    | "busy"
    | "too_fast"
    | "start_expired"
    | "bad_start"
    | "too_big"
    | "bad_request"
    | "no_files"
    | "too_many"
    | "bad_type"
    | "no_room"
    | "daily_full"
    | "empty";
  message: string;
  question_id?: string;
  option_id?: string;
  can_edit?: boolean;
}

export function refusalOf(err: unknown): { status: number | null; refusal: Refusal | null } {
  const e = err as { response?: { status?: number; data?: { detail?: unknown } } };
  const status = e?.response?.status ?? null;
  const detail = e?.response?.data?.detail;
  if (detail && typeof detail === "object" && "code" in (detail as object)) return { status, refusal: detail as Refusal };
  return { status, refusal: null };
}

const base = (token: string) => `/f/${encodeURIComponent(token)}`;

export const formAnswerApi = {
  async get(token: string): Promise<AnswerPage> {
    const { data } = await apiClient.get<AnswerPage>(base(token));
    return data;
  },
  async submit(
    token: string,
    body: SubmitBody
  ): Promise<{ number: number; edit_token: string | null; result?: QuizResultView; result_token?: string }> {
    const { data } = await apiClient.post(`${base(token)}/submit`, body, { timeout: 30_000 });
    return data;
  },
  async mine(token: string, edit?: string | null): Promise<MyAnswer & { start_token: string }> {
    const { data } = await apiClient.get(`${base(token)}/mine`, { params: edit ? { edit } : undefined });
    return data;
  },
  async change(
    token: string,
    body: Omit<SubmitBody, "submit_id"> & { submit_id?: string }
  ): Promise<{ number: number; result?: QuizResultView; result_token?: string }> {
    const { data } = await apiClient.put(`${base(token)}/mine`, body, { timeout: 30_000 });
    return data;
  },
  /** Your own quiz marks: by the results link kept on this device, or signed in. */
  async result(token: string, r?: string | null): Promise<QuizResultView> {
    const { data } = await apiClient.get(`${base(token)}/result`, { params: r ? { r } : undefined });
    return data;
  },
  async report(token: string, reason: string): Promise<void> {
    await apiClient.post(`${base(token)}/report`, { reason });
  },
  /** Stage one file for a file question (shown with its progress). */
  async upload(
    token: string,
    questionId: string,
    draftKey: string,
    file: File,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal
  ): Promise<StagedFile> {
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("question_id", questionId);
    form.append("draft_key", draftKey);
    const { data } = await apiClient.post<StagedFile>(`${base(token)}/uploads`, form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 0,
      signal,
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(e.loaded / e.total);
      },
    });
    return data;
  },
  /** Place suggestions for a Location question: this server's own map
   *  search only (never anyone's saved places). ``maps: false`` when Maps
   *  isn't set up — the question is then a plain text box. */
  async places(
    token: string,
    q: string,
    opts: { question?: string; near?: { lat: number; lon: number } | null; signal?: AbortSignal } = {}
  ): Promise<{ results: SearchRowLike[]; maps: boolean }> {
    const params: Record<string, string | number> = { q };
    if (opts.question) params.question = opts.question;
    // Roughly where (a kilometre or so) is enough to rank nearby places first.
    if (opts.near) {
      params.lat = Math.round(opts.near.lat * 100) / 100;
      params.lon = Math.round(opts.near.lon * 100) / 100;
    }
    const { data } = await apiClient.get(`${base(token)}/places`, { params, signal: opts.signal });
    return data;
  },
  /** The linked event as a one-event .ics (title, time and place). */
  async ics(token: string): Promise<Blob> {
    const { data } = await apiClient.get(`${base(token)}/ics`, { responseType: "blob" });
    return data as Blob;
  },
  /** Take back a staged file. */
  async removeUpload(token: string, uploadId: string, draftKey: string): Promise<void> {
    await apiClient.delete(`${base(token)}/uploads/${encodeURIComponent(uploadId)}`, { params: { draft_key: draftKey } });
  },
};
