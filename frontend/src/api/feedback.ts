import { apiClient } from "./client";

/** A message someone sent with the Send feedback button. */
export interface FeedbackItem {
  id: string;
  /** Null once the account is gone. */
  user_id: string | null;
  username: string | null;
  message: string;
  created_at: string;
  read: boolean;
}

export interface FeedbackList {
  items: FeedbackItem[];
  unread: number;
}

export const feedbackApi = {
  /** Send a message to this server's admins. It stays on the server. */
  async submit(message: string): Promise<void> {
    await apiClient.post("/feedback", { message });
  },

  // Admin → Feedback
  async list(): Promise<FeedbackList> {
    const { data } = await apiClient.get<FeedbackList>("/admin/feedback");
    return data;
  },

  async setRead(id: string, read: boolean): Promise<FeedbackItem> {
    const { data } = await apiClient.post<FeedbackItem>(
      `/admin/feedback/${id}/read`,
      { read }
    );
    return data;
  },

  async remove(id: string): Promise<void> {
    await apiClient.delete(`/admin/feedback/${id}`);
  },
};
