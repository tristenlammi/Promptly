/**
 * Email integration API (Phase 12 — E.2).
 *
 * Used by the account Email panel, the inbox page, and chat tools.
 */
import { apiClient } from "./client";

export interface EmailFeatureStatus {
  enabled: boolean;
  oauth_configured: boolean;
}

export interface EmailAccount {
  id: string;
  provider: "google" | "microsoft";
  email_address: string;
  enabled: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
  needs_full_resync: boolean;
  created_at: string;
}

export interface EmailContact {
  id: string;
  email_address: string;
  display_name: string | null;
  is_vip: boolean;
  message_count: number;
  last_seen_at: string | null;
}

export interface OAuthStartResponse {
  auth_url: string;
  state: string;
}

export interface EmailMessageBrief {
  id: string;
  thread_id: string | null;
  subject: string | null;
  from_address: string | null;
  from_name: string | null;
  date: string | null;
  snippet: string | null;
  read: boolean;
  archived: boolean;
  has_attachments: boolean;
  ai_category: string | null;
  ai_priority: number | null;
  ai_summary: string | null;
  needs_reply: boolean | null;
  due_at: string | null;
}

export interface EmailMessageDetail extends EmailMessageBrief {
  body_text: string | null;
  body_html: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  attachment_file_ids: string[];
}

export interface CategoryCounts {
  action_required: number;
  fyi: number;
  newsletter: number;
  promotional: number;
  social: number;
  spam: number;
  uncategorised: number;
}

export interface CalendarEvent {
  id: string;
  provider_event_id: string;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  location: string | null;
  description: string | null;
  attendees: { email: string; name: string | null; self?: boolean }[];
  meet_link: string | null;
  status: string | null;
}

export const emailApi = {
  // ---- Feature status (any auth'd user) ----
  async featureStatus(): Promise<EmailFeatureStatus> {
    const { data } = await apiClient.get<EmailFeatureStatus>("/email/feature-status");
    return data;
  },

  // ---- OAuth ----
  async startGoogleOAuth(): Promise<OAuthStartResponse> {
    const { data } = await apiClient.get<OAuthStartResponse>(
      "/email/oauth/google/start"
    );
    return data;
  },

  // ---- Accounts ----
  async listAccounts(): Promise<EmailAccount[]> {
    const { data } = await apiClient.get<EmailAccount[]>("/email/accounts");
    return data;
  },
  async disconnectAccount(accountId: string): Promise<void> {
    await apiClient.delete(`/email/accounts/${accountId}`);
  },
  async syncNow(accountId: string): Promise<void> {
    await apiClient.post(`/email/accounts/${accountId}/sync-now`);
  },

  // ---- Messages ----
  async listMessages(params: {
    category?: string;
    read?: boolean;
    archived?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<EmailMessageBrief[]> {
    const { data } = await apiClient.get<EmailMessageBrief[]>("/email/messages", {
      params,
    });
    return data;
  },
  async getMessage(messageId: string): Promise<EmailMessageDetail> {
    const { data } = await apiClient.get<EmailMessageDetail>(
      `/email/messages/${messageId}`
    );
    return data;
  },
  async messageCounts(): Promise<CategoryCounts> {
    const { data } = await apiClient.get<CategoryCounts>("/email/messages/counts");
    return data;
  },

  // ---- Message actions ----
  async messageAction(
    messageId: string,
    action: "read" | "unread" | "archive" | "unarchive"
  ): Promise<void> {
    await apiClient.patch(`/email/messages/${messageId}/action`, { action });
  },

  // ---- Calendar ----
  async listCalendarEvents(days = 7): Promise<CalendarEvent[]> {
    const { data } = await apiClient.get<CalendarEvent[]>("/email/calendar/events", {
      params: { days },
    });
    return data;
  },
  async createCalendarEvent(event: {
    title: string;
    start_at: string;
    end_at: string;
    all_day?: boolean;
    location?: string;
    description?: string;
  }): Promise<CalendarEvent> {
    const { data } = await apiClient.post<CalendarEvent>("/email/calendar/events", event);
    return data;
  },

  // ---- Draft / send / AI assist ----
  async draftReply(messageId: string, instruction?: string): Promise<{ draft: string }> {
    const { data } = await apiClient.post<{ draft: string }>(
      `/email/messages/${messageId}/draft-reply`,
      { instruction: instruction ?? null }
    );
    return data;
  },
  async sendReply(messageId: string, body: string): Promise<{ status: string; to: string }> {
    const { data } = await apiClient.post<{ status: string; to: string }>(
      `/email/messages/${messageId}/send-reply`,
      { body, send_confirmed: true }
    );
    return data;
  },
  async aiAssist(messageId: string, instruction: string): Promise<{ response: string }> {
    const { data } = await apiClient.post<{ response: string }>(
      `/email/messages/${messageId}/ai-assist`,
      { instruction }
    );
    return data;
  },

  // ---- Contacts ----
  async listContacts(q?: string): Promise<EmailContact[]> {
    const { data } = await apiClient.get<EmailContact[]>("/email/contacts", {
      params: q ? { q } : undefined,
    });
    return data;
  },
  async setVip(contactId: string, is_vip: boolean): Promise<EmailContact> {
    const { data } = await apiClient.patch<EmailContact>(
      `/email/contacts/${contactId}/vip`,
      { is_vip }
    );
    return data;
  },
};
