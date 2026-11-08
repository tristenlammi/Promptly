import { API_BASE_URL, apiClient, authHeader } from "@/api/client";

export interface MailAccount {
  id: string;
  email: string;
  display_name: string;
  color: string;
  provider: string;
  signature: string;
  notify: boolean;
  status: "syncing" | "ok" | "error";
  status_detail: string;
  last_sync_at: string | null;
  pinned: boolean;
}

export interface MailFolder {
  id: string;
  account_id: string;
  name: string;
  role: string;
  unread: number;
}

export interface AiSearchStatus {
  ready: boolean;
  on: boolean;
  local: boolean;
  provider: string;
  model: string;
  indexed: number;
  total: number;
}

export interface MailLabel {
  id: string;
  name: string;
  color: string;
  unread: number;
  /** Its mailbox folder hasn't been copied here yet. */
  fetching?: boolean;
}

export type RuleKind = "from" | "domain" | "subject";

export interface MailRule {
  id: string;
  label_id: string;
  kind: RuleKind;
  value: string;
}

export interface Person {
  name: string;
  addr: string;
}

export interface ThreadRow {
  account_id: string;
  key: string;
  subject: string;
  snippet: string;
  from: Person;
  at: string;
  count: number;
  unread: number;
  starred: boolean;
  attachments: boolean;
  labels: string[];
  summary: string;
  needs_reply: boolean;
  // Found by what it means rather than the words you typed.
  related?: boolean;
}

export interface MailAttachment {
  part: number;
  name: string;
  mime: string;
  size: number;
}

export type InviteAnswer = "going" | "maybe" | "declined";

export interface MailInvite {
  method: string;
  uid: string;
  title: string;
  start: string;
  end: string | null;
  all_day: boolean;
  zone_sure: boolean;
  location: string;
  organizer: Person | null;
  attendees: (Person & { said: string })[];
  repeats: boolean;
  cancelled: boolean;
  answer: InviteAnswer | null;
  event_url: string | null;
}

export interface KnownPerson {
  name: string;
  photo: string | null;
}

export interface Message {
  id: string;
  message_id: string;
  subject: string;
  from: Person;
  to: Person[];
  cc: Person[];
  at: string;
  text: string;
  html: string;
  attachments: MailAttachment[];
  unsubscribe: string;
  seen: boolean;
  starred: boolean;
  remote_images: boolean;
  /** Its HTML was too big to show safely, so `text` is shown instead. */
  html_clipped?: boolean;
  reply_to: string;
  invite: MailInvite | null;
}

export interface Conversation {
  account_id: string;
  key: string;
  subject: string;
  messages: Message[];
  labels: string[];
  snoozed_until: string | null;
  summary: string;
}

export interface ServerSettings {
  host: string;
  port: number;
  security: "ssl" | "starttls";
}

export type ThreadAction = "read" | "unread" | "star" | "unstar" | "archive" | "trash" | "spam" | "inbox" | "no_reply";

export interface OutgoingFile {
  name: string;
  mime: string;
  data: string;
}

export interface FailedSend {
  id: string;
  subject: string;
  error: string;
}

export interface MailSettings {
  sorting: { provider_id: string; model_id: string } | null;
}

export interface ThreadQuery {
  account?: string;
  role?: string;
  folder?: string;
  label?: string;
  needs_reply?: boolean;
  q?: string;
  before?: string;
}

export interface ThreadRef {
  account_id: string;
  key: string;
}

const refOf = ({ account_id, key }: ThreadRef): ThreadRef => ({ account_id, key });

export const mailApi = {
  async overview() {
    return (await apiClient.get<{ accounts: MailAccount[]; folders: MailFolder[]; labels: MailLabel[]; sorting: boolean; needs_reply: number; failed: FailedSend[] }>("/mail/overview")).data;
  },
  async threads(query: ThreadQuery) {
    return (await apiClient.get<{ threads: ThreadRow[]; next: string | null }>("/mail/threads", { params: query })).data;
  },
  async conversation(accountId: string, key: string) {
    return (await apiClient.get<Conversation>(`/mail/threads/${accountId}/${key}`)).data;
  },
  async act(accountId: string, key: string, action: ThreadAction) {
    await apiClient.post(`/mail/threads/${accountId}/${key}/action`, { action });
  },
  /** Survives the page closing, which an ordinary request doesn't. */
  actAsPageCloses(accountId: string, key: string, action: ThreadAction) {
    void fetch(`${API_BASE_URL}/mail/threads/${accountId}/${key}/action`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ action }),
    }).catch(() => undefined);
  },
  /** One action on several conversations, as one change for the mailbox. */
  async actMany(rows: ThreadRef[], action: ThreadAction) {
    if (rows.length === 1) return mailApi.act(rows[0].account_id, rows[0].key, action);
    await apiClient.post("/mail/threads/action", { threads: rows.map(refOf), action });
  },
  actManyAsPageCloses(rows: ThreadRef[], action: ThreadAction) {
    if (rows.length === 1) return mailApi.actAsPageCloses(rows[0].account_id, rows[0].key, action);
    void fetch(`${API_BASE_URL}/mail/threads/action`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ threads: rows.map(refOf), action }),
    }).catch(() => undefined);
  },
  async labelMany(rows: ThreadRef[], labelId: string) {
    if (rows.length === 1) return mailApi.setThreadLabel(rows[0].account_id, rows[0].key, labelId, true);
    await apiClient.put(`/mail/labels/${labelId}/threads`, { threads: rows.map(refOf) });
  },
  /** Everything unread in a place, including what hasn't loaded on screen. */
  async markAllRead(place: { role?: string; account?: string; labels?: string[] }) {
    return (await apiClient.post<{ marked: number }>("/mail/mark-all-read", place)).data.marked;
  },
  async addLabel(name: string, color: string) {
    return (await apiClient.post<MailLabel>("/mail/labels", { name, color })).data;
  },
  async editLabel(id: string, patch: { name?: string; color?: string }) {
    await apiClient.patch(`/mail/labels/${id}`, patch);
  },
  async removeLabel(id: string) {
    await apiClient.delete(`/mail/labels/${id}`);
  },
  async setThreadLabel(accountId: string, key: string, labelId: string, on: boolean) {
    const url = `/mail/threads/${accountId}/${key}/labels/${labelId}`;
    await (on ? apiClient.put(url) : apiClient.delete(url));
  },
  async rules() {
    return (await apiClient.get<{ rules: MailRule[] }>("/mail/rules")).data.rules;
  },
  async previewRule(kind: RuleKind, value: string) {
    return (await apiClient.post<{ conversations: number }>("/mail/rules/preview", { kind, value })).data;
  },
  async addRule(body: { kind: RuleKind; value: string; label_id: string; apply_existing: boolean; thread?: { account_id: string; key: string } }) {
    return (await apiClient.post<MailRule>("/mail/rules", body)).data;
  },
  async removeRule(id: string) {
    await apiClient.delete(`/mail/rules/${id}`);
  },
  async aiSearch() {
    return (await apiClient.get<AiSearchStatus>("/mail/admin/ai-search")).data;
  },
  async setAiSearch(on: boolean) {
    return (await apiClient.put<AiSearchStatus>("/mail/admin/ai-search", { on })).data;
  },
  async setup(email: string) {
    const { data } = await apiClient.get<{ known: boolean; provider?: string; note?: string; imap?: ServerSettings; smtp?: ServerSettings }>("/mail/setup", { params: { email } });
    return data;
  },
  async addAccount(body: Record<string, unknown>) {
    return (await apiClient.post<MailAccount>("/mail/accounts", body)).data;
  },
  async editAccount(id: string, patch: Partial<Pick<MailAccount, "display_name" | "color" | "signature" | "notify">> & { password?: string }) {
    return (await apiClient.patch<MailAccount>(`/mail/accounts/${id}`, patch)).data;
  },
  async removeAccount(id: string) {
    await apiClient.delete(`/mail/accounts/${id}`);
  },
  async send(body: { account_id: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; html?: string; reply_to_message?: string; forward_of?: string; files?: OutgoingFile[]; file_ids?: string[] }) {
    return (await apiClient.post<{ id: string; undo_seconds: number }>("/mail/send", body)).data;
  },
  async retrySend(id: string) {
    await apiClient.post(`/mail/send/${id}/retry`);
  },
  async dismissSend(id: string) {
    await apiClient.post(`/mail/send/${id}/dismiss`);
  },
  async people(q: string) {
    return (await apiClient.get<{ people: Person[] }>("/mail/people", { params: { q } })).data.people;
  },
  async draft(body: { provider_id: string; model_id: string; account_id: string; thread_key?: string; instruction: string; subject: string }) {
    return (await apiClient.post<{ text: string }>("/mail/draft", body)).data;
  },
  async rsvp(messageId: string, answer: InviteAnswer) {
    return (await apiClient.post<{ answer: InviteAnswer; event_url: string | null; told_organiser: boolean }>(`/mail/messages/${messageId}/rsvp`, { answer })).data;
  },
  async removeCancelled(messageId: string) {
    await apiClient.post(`/mail/messages/${messageId}/remove-cancelled`);
  },
  async eventDraft(accountId: string, key: string, body: { provider_id: string; model_id: string; today: string }) {
    return (await apiClient.post<{ title: string; date: string; time: string; end_time: string; location: string }>(`/mail/threads/${accountId}/${key}/event-draft`, body)).data;
  },
  async addEvent(accountId: string, key: string, body: { title: string; start: string; end?: string; all_day: boolean; location: string }) {
    return (await apiClient.post<{ url: string }>(`/mail/threads/${accountId}/${key}/event`, body)).data;
  },
  async addTask(accountId: string, key: string) {
    return (await apiClient.post<{ title: string }>(`/mail/threads/${accountId}/${key}/task`)).data;
  },
  async addContact(name: string, addr: string) {
    await apiClient.post("/mail/contacts", { name, addr });
  },
  async knownPeople(addrs: string[]) {
    return (await apiClient.post<{ people: Record<string, KnownPerson> }>("/mail/known-people", { addrs })).data.people;
  },
  async attachmentBlob(messageId: string, part: number) {
    return (await apiClient.get<Blob>(`/mail/messages/${messageId}/attachments/${part}`, { responseType: "blob" })).data;
  },
  async attachmentPreview(messageId: string, part: number) {
    return (await apiClient.get<ArrayBuffer>(`/mail/messages/${messageId}/attachments/${part}/preview`, { responseType: "arraybuffer" })).data;
  },
  async saveAttachment(messageId: string, part: number) {
    return (await apiClient.post<{ id: string; filename: string }>(`/mail/messages/${messageId}/attachments/${part}/save`)).data;
  },
  async snooze(accountId: string, key: string, until: Date) {
    await apiClient.put(`/mail/threads/${accountId}/${key}/snooze`, { until: until.toISOString() });
  },
  async unsnooze(accountId: string, key: string) {
    await apiClient.delete(`/mail/threads/${accountId}/${key}/snooze`);
  },
  async settings() {
    return (await apiClient.get<MailSettings>("/mail/settings")).data;
  },
  async setSorting(choice: { provider_id?: string; model_id?: string }) {
    return (await apiClient.put<MailSettings>("/mail/settings", choice)).data;
  },
  async undoSend(id: string) {
    await apiClient.delete(`/mail/send/${id}`);
  },
  async images(urls: string[]) {
    return (await apiClient.post<{ images: Record<string, string> }>("/mail/images", { urls })).data.images;
  },
  // With an account and no thread: only that mailbox.
  async ask(body: { question: string; provider_id: string; model_id: string; account_id?: string; thread_key?: string }) {
    return (await apiClient.post<{ answer: string; read: number; model: string }>("/mail/ask", body)).data;
  },
  async download(messageId: string, part: number, name: string) {
    const { data } = await apiClient.get<Blob>(`/mail/messages/${messageId}/attachments/${part}`, { responseType: "blob" });
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

/** "Sam Taylor" or the part before the @. */
export function personName(p: Person): string {
  return p.name || p.addr.split("@")[0] || "Unknown";
}

/** 9:41 am today, Tue this week, 3 Nov this year, otherwise with the year. */
export function shortWhen(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 6) return at.toLocaleDateString([], { weekday: "short" });
  if (at.getFullYear() === now.getFullYear()) return at.toLocaleDateString([], { day: "numeric", month: "short" });
  return at.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
