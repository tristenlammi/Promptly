import { apiClient } from "@/api/client";

export interface SubscriptionSummary {
  id: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
  /** The device's own switch: off, nothing is pushed to it. */
  enabled: boolean;
  /** A phone or tablet (they start on; computers start off). */
  mobile: boolean;
  /** SHA-256 of the push endpoint, so a page can find its own row. */
  endpoint_hash: string;
}

export interface NotificationPreferences {
  enabled: boolean;
  export_ready: boolean;
  import_done: boolean;
  shared_message: boolean;
  task_complete: boolean;
  mention: boolean;
  assignment: boolean;
  invite: boolean;
  item_reminder: boolean;
  room_message: boolean;
  calendar: boolean;
  passwords: boolean;
  mail: boolean;
  /** Forms: new answers to my forms (counts only), and a form closing. */
  form_response: boolean;
  /** Calls ringing you and missed calls (DM calls). */
  call: boolean;
  /** "Don't ring me during quiet hours": calls then become missed calls, told when quiet hours end (off: calls always ring). */
  call_quiet_hold?: boolean;
  notes: boolean;
  /** Porch: which kinds, and how, are chosen in Porch → Settings. */
  porch?: boolean;
  /** Talk: things you asked to have sent to your phone ("send that to my phone"). */
  talk_followup?: boolean;
  /** P Maps: someone is sharing the trip they're driving with you. */
  maps?: boolean;
  /** Quiet hours, "HH:MM" in your own time zone (one setting for all of Promptly). */
  quiet_enabled: boolean;
  quiet_start: string;
  quiet_end: string;
  /** A different pair for Friday and Saturday nights. */
  quiet_weekend: boolean;
  quiet_weekend_start: string | null;
  quiet_weekend_end: string | null;
  /** Categories set to "Daily summary" instead of instant. */
  summary_categories: string[];
  /** Read-only: which categories can be set to "Daily summary". */
  summary_capable: string[];
  /** Read-only: when the summary goes (the Today summary time). */
  summary_time: string;
  /** Read-only: the time zone quiet hours use. */
  timezone: string;
  /** Read-only: quiet hours are on right now. */
  quiet_now: boolean;
}

/** The on/off switches (the master switch and one per category). */
export type NotificationSwitch =
  | "enabled"
  | "export_ready"
  | "import_done"
  | "shared_message"
  | "task_complete"
  | "mention"
  | "assignment"
  | "invite"
  | "item_reminder"
  | "room_message"
  | "calendar"
  | "passwords"
  | "mail"
  | "form_response"
  | "call"
  | "call_quiet_hold"
  | "notes"
  | "porch"
  // Talk
  | "talk_followup"
  // P Maps
  | "maps";

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
  /** Turn one device's notifications on or off. */
  async setSubscriptionEnabled(
    id: string,
    enabled: boolean
  ): Promise<SubscriptionSummary> {
    const { data } = await apiClient.patch<SubscriptionSummary>(
      `/notifications/subscriptions/${id}`,
      { enabled }
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
  /** What the test push reached: accepted by the push service, failed,
   *  or dropped because the browser had unsubscribed. */
  async sendTest(): Promise<{ sent: number; failed: number; removed: number }> {
    const { data } = await apiClient.post<{ sent: number; failed?: number; removed?: number }>(
      "/notifications/test"
    );
    return { sent: data.sent, failed: data.failed ?? 0, removed: data.removed ?? 0 };
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
