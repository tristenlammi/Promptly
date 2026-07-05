import { apiClient } from "@/api/client";

export interface SubscriptionSummary {
  id: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface NotificationPreferences {
  enabled: boolean;
  study_graded: boolean;
  export_ready: boolean;
  import_done: boolean;
  shared_message: boolean;
  task_complete: boolean;
  mention: boolean;
  assignment: boolean;
  invite: boolean;
}

export interface NotificationRow {
  id: string;
  category: string;
  title: string;
  body: string;
  url: string | null;
  workspace_id: string | null;
  actor: {
    username: string;
    avatar_url?: string | null;
    avatar_color?: string | null;
  } | null;
  read_at: string | null;
  created_at: string;
}

export interface InboxResponse {
  items: NotificationRow[];
  unread_count: number;
}

export interface SubscribePayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  user_agent?: string | null;
  label?: string | null;
}

export const notificationsApi = {
  async getPublicKey(): Promise<string | null> {
    try {
      const { data } = await apiClient.get<{ public_key: string }>(
        "/notifications/public-key"
      );
      return data.public_key;
    } catch (e) {
      // 503 == server not configured; treat as "feature unavailable"
      // instead of bubbling an error modal to the user.
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 503) return null;
      throw e;
    }
  },
  async listSubscriptions(): Promise<SubscriptionSummary[]> {
    const { data } = await apiClient.get<SubscriptionSummary[]>(
      "/notifications/subscriptions"
    );
    return data;
  },
  async subscribe(payload: SubscribePayload): Promise<SubscriptionSummary> {
    const { data } = await apiClient.post<SubscriptionSummary>(
      "/notifications/subscriptions",
      payload
    );
    return data;
  },
  async renameSubscription(
    id: string,
    label: string | null
  ): Promise<SubscriptionSummary> {
    const { data } = await apiClient.patch<SubscriptionSummary>(
      `/notifications/subscriptions/${id}`,
      { label }
    );
    return data;
  },
  async deleteSubscription(id: string): Promise<void> {
    await apiClient.delete(`/notifications/subscriptions/${id}`);
  },
  async unsubscribeAll(): Promise<void> {
    await apiClient.delete("/notifications/subscriptions");
  },
  async getPreferences(): Promise<NotificationPreferences> {
    const { data } = await apiClient.get<NotificationPreferences>(
      "/notifications/preferences"
    );
    return data;
  },
  async updatePreferences(
    patch: Partial<NotificationPreferences>
  ): Promise<NotificationPreferences> {
    const { data } = await apiClient.patch<NotificationPreferences>(
      "/notifications/preferences",
      patch
    );
    return data;
  },
  async sendTest(): Promise<number> {
    const { data } = await apiClient.post<{ sent: number }>(
      "/notifications/test"
    );
    return data.sent;
  },
  // ---- Inbox (durable notification list) ----
  async inbox(limit = 30): Promise<InboxResponse> {
    const { data } = await apiClient.get<InboxResponse>(
      "/notifications/inbox",
      { params: { limit } }
    );
    return data;
  },
  async markRead(id: string): Promise<InboxResponse> {
    const { data } = await apiClient.post<InboxResponse>(
      `/notifications/inbox/${id}/read`
    );
    return data;
  },
  async markAllRead(): Promise<InboxResponse> {
    const { data } = await apiClient.post<InboxResponse>(
      "/notifications/inbox/read-all"
    );
    return data;
  },
};
