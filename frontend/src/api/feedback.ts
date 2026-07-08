import { apiClient } from "./client";

export interface FeedbackResult {
  delivered: boolean;
  /** ``smtp_not_configured`` | ``send_failed`` when delivered is false. */
  reason?: string | null;
  /** Address to compose to in the mailto: fallback. */
  fallback_to?: string | null;
}

export const feedbackApi = {
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
