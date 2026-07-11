import { apiClient } from "./client";

/** A file produced by a code run, persisted to the user's Drive. */
export interface CodeRunOutputFile {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export interface CodeRunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
  outputs: CodeRunOutputFile[];
}

export const codeApi = {
  /**
   * Execute code in the server-side sandbox and return stdout / stderr /
   * produced files. Phase 1: Python only. Pass `conversationId` to share
   * that chat's sandbox session (so the run sees files the model created or
   * the user uploaded there).
   */
  async run(
    code: string,
    opts?: { language?: string; conversationId?: string | null }
  ): Promise<CodeRunResult> {
    const { data } = await apiClient.post<CodeRunResult>("/code/run", {
      code,
      language: opts?.language ?? "python",
      conversation_id: opts?.conversationId ?? null,
    });
    return data;
  },
};
