import { apiClient } from "./client";

export interface FeedbackResult {
  delivered: boolean;
  /** ``smtp_not_configured`` | ``send_failed`` when delivered is false. */
  reason?: string | null;
  /** Address to compose to in the mailto: fallback. */
  fallback_to?: string | null;
}

export const feedbackApi = {
  /** The address feedback is delivered to — shown in the form so a user can
   *  email directly instead. */
  async getConfig(): Promise<{ email: string }> {
    const { data } = await apiClient.get<{ email: string }>("/feedback");
    return data;
  },

  /**
   * Submit feedback. The server emails it to the maintainer via the
   * instance's own SMTP. If SMTP isn't configured (or the send fails) it
   * returns ``delivered: false`` with ``fallback_to`` so the caller can
   * open a ``mailto:`` compose instead.
   */
  async submit(message: string, includeEmail: boolean): Promise<FeedbackResult> {
    const { data } = await apiClient.post<FeedbackResult>("/feedback", {
      message,
      include_email: includeEmail,
    });
    return data;
  },
};
