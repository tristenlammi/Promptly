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

export interface MyAnswer {
  number: number;
  answers: Record<string, unknown>;
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
}

export interface AnswerPageClosed {
  state: "closed";
  audience: "server" | "link";
  definition: FormDefinition;
  asset_urls: Record<string, string>;
  closed_message: string;
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
    | "bad_request";
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
  async submit(token: string, body: SubmitBody): Promise<{ number: number; edit_token: string | null }> {
    const { data } = await apiClient.post(`${base(token)}/submit`, body, { timeout: 30_000 });
    return data;
  },
  async mine(token: string, edit?: string | null): Promise<MyAnswer & { start_token: string }> {
    const { data } = await apiClient.get(`${base(token)}/mine`, { params: edit ? { edit } : undefined });
    return data;
  },
  async change(token: string, body: Omit<SubmitBody, "submit_id"> & { submit_id?: string }): Promise<{ number: number }> {
    const { data } = await apiClient.put(`${base(token)}/mine`, body, { timeout: 30_000 });
    return data;
  },
  async report(token: string, reason: string): Promise<void> {
    await apiClient.post(`${base(token)}/report`, { reason });
  },
};
