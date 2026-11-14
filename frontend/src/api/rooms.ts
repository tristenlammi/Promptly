import { API_BASE_URL, apiClient } from "@/api/client";
import type { CallServerEvent, DmCall } from "@/api/dmCalls";
import type { VoiceChannelSettings, VoiceMember, VoiceServerEvent, VoiceWhere } from "@/api/voiceChannels";

/**
 * Rooms — spaces of text rooms + direct messages (docs/rooms-plan.md).
 * Everything lives under ``/api/rooms``. The live feed is a separate
 * fetch-based SSE stream (``useRoomsEvents``).
 */

export type NotifyLevel = "all" | "mentions" | "none";
export type SpaceRole = "owner" | "admin" | "member";
export type RoomKind = "text" | "dm" | "group" | "voice";
export type MessageKind = "user" | "promptly" | "system";

export interface RoomUser {
  id: string;
  username: string;
  avatar_url: string | null;
  color: string | null;
}

export interface RoomPreview {
  author_id: string | null;
  body: string;
  kind: MessageKind;
}

export interface Room {
  id: string;
  space_id: string | null;
  kind: RoomKind;
  name: string;
  topic: string | null;
  position: number;
  last_seq: number;
  last_message_at: string | null;
  last_read_seq: number;
  unread: number;
  mentions: number;
  /** Your override for this room (null = inherit the space / "all"). */
  notify: NotifyLevel | null;
  /** Quiet until then, whatever the level ("mute for a while"). */
  muted_until?: string | null;
  /** Conversations: how far each other person has got (Delivered / Seen).
   *  Absent in space rooms, and when the server has receipts off. */
  receipts?: Record<string, { read: number; delivered: number }>;
  /** DMs: the member ids (you included). */
  members?: string[];
  preview?: RoomPreview | null;
  /** 1:1 conversations: you blocked the other person. */
  blocked?: boolean;
  /** 1:1 conversations: false when a block (either way) closed it. */
  can_send?: boolean;
  /** Voice channels (kind "voice"): their settings (Calls). */
  voice?: VoiceChannelSettings;
}

export interface Space {
  id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  role: SpaceRole;
  notify: NotifyLevel;
  /** The whole space is quiet until then. */
  muted_until?: string | null;
  member_ids: string[];
  rooms: Room[];
  /** Optional: per-member roles, if the server sends them. */
  member_roles?: Record<string, SpaceRole>;
  /** The space's own emoji, written ``:name:`` in messages and reactions. */
  emojis?: SpaceEmoji[];
}

export interface SpaceEmoji {
  id: string;
  name: string;
  url: string;
  animated: boolean;
  created_by: string | null;
}

export type GifProvider = "giphy" | "klipy";

/** A GIF from the GIF library, as a message carries it (``meta.gif``). A
 *  reference: the picture is loaded from the library, never copied here. */
export interface LibraryGif {
  provider: GifProvider;
  id: string;
  url: string;
  preview_url?: string | null;
  page_url?: string | null;
  width?: number | null;
  height?: number | null;
  title?: string | null;
}

/** What the page needs to search the GIF library (null: search is off). */
export interface GifSearchConfig {
  provider: GifProvider;
  key: string;
  rating: "family" | "teen" | "all";
}

/** One of your saved GIFs: your own file, or a library GIF. */
export type SavedGif =
  | { id: string; source: "own"; url: string; filename: string; mime: string; size: number; width: number | null; height: number | null }
  | { id: string; source: "provider"; gif: LibraryGif; width: number | null; height: number | null };

/** A link's preview card (``meta.preview``). */
export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  site: string;
  image: boolean;
  image_url?: string;
  w?: number;
  h?: number;
}

const GIF_HOSTS: Record<GifProvider, string> = { giphy: "giphy.com", klipy: "klipy.com" };

/** True when ``url`` is an https address on that library's own hosts. The
 *  server checks the same before a message is stored. */
export function isLibraryUrl(provider: string, url: unknown): url is string {
  const base = GIF_HOSTS[provider as GifProvider];
  if (!base || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === base || u.hostname.endsWith(`.${base}`));
  } catch {
    return false;
  }
}

/** A message's library GIF, if it carries a well-formed one. */
export function gifOf(m: { meta: Record<string, unknown> | null }): (LibraryGif & { has_note: boolean }) | null {
  const g = m.meta?.gif as Record<string, unknown> | undefined;
  if (!g || typeof g !== "object" || typeof g.provider !== "string" || !isLibraryUrl(g.provider, g.url)) return null;
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
  return {
    provider: g.provider as GifProvider,
    id: typeof g.id === "string" ? g.id : "",
    url: g.url,
    preview_url: isLibraryUrl(g.provider, g.preview_url) ? g.preview_url : null,
    page_url: isLibraryUrl(g.provider, g.page_url) ? g.page_url : null,
    width: num(g.width),
    height: num(g.height),
    title: typeof g.title === "string" ? g.title : "",
    has_note: g.has_note === true,
  };
}

/** A message's link preview, if it has one to show. */
export function previewOf(m: { meta: Record<string, unknown> | null }): LinkPreview | null {
  const p = m.meta?.preview as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object" || p.removed === true || typeof p.url !== "string" || typeof p.title !== "string" || !p.title) return null;
  if (!/^https?:/i.test(p.url)) return null;
  return {
    url: p.url,
    title: p.title,
    description: typeof p.description === "string" ? p.description : "",
    site: typeof p.site === "string" ? p.site : "",
    image: p.image === true && typeof p.image_url === "string",
    image_url: typeof p.image_url === "string" ? p.image_url : undefined,
    w: typeof p.w === "number" ? p.w : undefined,
    h: typeof p.h === "number" ? p.h : undefined,
  };
}

export interface Bootstrap {
  me: RoomUser;
  spaces: Space[];
  dms: Room[];
  users: Record<string, RoomUser>;
  /** Calls: voice is on for you. Absent on servers without Calls. */
  voice_available?: boolean;
  /** Calls: who's in each voice channel now (empty channels left out). */
  voice?: Record<string, VoiceMember[]>;
  /** Calls: where you are in voice, if anywhere. */
  voice_me?: VoiceWhere | null;
  /** Calls: the server's caps (null when voice is off for you). */
  voice_limits?: { max_participants: number; max_stream: "720p30" | "1080p30" | "1080p60" } | null;
  /** Calls: live DM calls in your conversations. */
  calls?: DmCall[];
  /** Calls: missed calls you haven't seen (the Calls tab's badge). */
  calls_missed?: number;
  /** GIF search (null: off) and whether links get preview cards. */
  media?: { gif_search: GifSearchConfig | null; link_previews: boolean };
  /** What the admin has on for everyone (absent on an older server: all on). */
  features?: RoomFeatures;
}

export interface RoomFeatures {
  voice_messages: boolean;
  /** How long one voice message may be. */
  voice_max_seconds: number;
  polls: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  thumb_url: string | null;
  /** A GIF or animated WebP: played in the chat. */
  animated?: boolean;
}

export interface Reaction {
  emoji: string;
  user_ids: string[];
}

export interface ReplySnippet {
  id: string;
  /** Optional: lets "tap the quote" jump straight there. */
  seq?: number;
  author_id: string | null;
  body: string;
  deleted: boolean;
}

export interface Message {
  id: string;
  room_id: string;
  seq: number;
  author_id: string | null;
  kind: MessageKind;
  body: string;
  reply_to: ReplySnippet | null;
  mentions: string[];
  reactions: Reaction[];
  attachments: Attachment[];
  pinned: boolean;
  edited_at: string | null;
  deleted: boolean;
  created_at: string;
  meta: Record<string, unknown> | null;
  /** Echo of the sender's ``client_id`` (top level or ``meta.client_id``). */
  client_id?: string | null;
  /** A poll's live count (the poll itself is ``meta.poll``). */
  poll?: PollState;
}

/** A voice message (``meta.voice``): its recording is the one attachment. */
export interface VoiceMeta {
  att: string;
  duration_ms: number;
  /** The waveform: levels 0–1. */
  peaks: number[];
  /** There's a copy every browser can play (``url + "&play=1"``). */
  play: boolean;
  /** Its words: on their way, here, not made on this server, or failed. */
  state: "pending" | "done" | "off" | "failed";
  transcript?: string;
}

export function voiceOf(m: { meta: Record<string, unknown> | null }): VoiceMeta | null {
  const v = m.meta?.voice as Partial<VoiceMeta> | undefined;
  if (!v || typeof v !== "object" || typeof v.att !== "string") return null;
  return {
    att: v.att,
    duration_ms: typeof v.duration_ms === "number" && Number.isFinite(v.duration_ms) ? v.duration_ms : 0,
    peaks: Array.isArray(v.peaks) ? v.peaks.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [],
    play: v.play === true,
    state: v.state === "done" || v.state === "off" || v.state === "failed" ? v.state : "pending",
    transcript: typeof v.transcript === "string" ? v.transcript : undefined,
  };
}

/** What's sent with a voice message: the uploaded recording and what the
 *  page measured (the server reads the audio itself and corrects both). */
export interface VoiceSend {
  attachment_id: string;
  duration_ms: number;
  peaks: number[];
}

/** A poll (``meta.poll``). */
export interface PollMeta {
  question: string;
  options: { id: string; text: string }[];
  multiple: boolean;
  anonymous: boolean;
  closes_at: string | null;
  closed_at: string | null;
}

export interface PollState {
  counts: Record<string, number>;
  /** How many people have voted. */
  voters_total: number;
  closed: boolean;
  /** Who picked each answer (never sent for an anonymous poll). */
  voters?: Record<string, string[]>;
  /** Your own answers, when the server was answering you. */
  mine?: string[];
}

export function pollOf(m: { meta: Record<string, unknown> | null }): PollMeta | null {
  const p = m.meta?.poll as Partial<PollMeta> | undefined;
  if (!p || typeof p !== "object" || typeof p.question !== "string" || !Array.isArray(p.options)) return null;
  const options = p.options.filter((o): o is { id: string; text: string } => !!o && typeof o.id === "string" && typeof o.text === "string");
  if (options.length < 2) return null;
  return {
    question: p.question,
    options,
    multiple: p.multiple === true,
    anonymous: p.anonymous === true,
    closes_at: typeof p.closes_at === "string" ? p.closes_at : null,
    closed_at: typeof p.closed_at === "string" ? p.closed_at : null,
  };
}

export interface PollDraft {
  question: string;
  options: string[];
  multiple: boolean;
  anonymous: boolean;
  closes_at: string | null;
}

/** A place sent from P Maps (a message's ``meta.place``): drawn as a card. */
export interface SharedPlace {
  name: string;
  address?: string | null;
  lat: number;
  lon: number;
}

/** A message's place, if it carries a well-formed one. */
export function placeOf(m: { meta: Record<string, unknown> | null }): (SharedPlace & { has_note: boolean }) | null {
  const p = m.meta?.place as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object" || typeof p.name !== "string" || typeof p.lat !== "number" || typeof p.lon !== "number") return null;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return null;
  return { name: p.name, address: typeof p.address === "string" && p.address ? p.address : null, lat: p.lat, lon: p.lon, has_note: p.has_note === true };
}

export interface MessagePage {
  messages: Message[];
  has_more_before: boolean;
  has_more_after: boolean;
}

export interface SearchHit {
  message: Message;
  room_id: string;
}

export interface SpaceMemberRow {
  user_id: string;
  role: SpaceRole;
}

export type RoomEvent =
  | { type: "message"; message: Message }
  | { type: "message_edit"; message: Message }
  | { type: "message_delete"; room_id: string; id: string }
  | { type: "reaction"; room_id: string; message_id: string; reactions: Reaction[] }
  | { type: "poll"; room_id: string; message_id: string; poll: PollState }
  | { type: "read"; room_id: string; seq: number }
  /** Someone else in a conversation got / read further. */
  | { type: "receipt"; room_id: string; user_id: string; read: number; delivered: number }
  | { type: "typing"; room_id: string; user_id: string }
  | { type: "promptly_thinking"; room_id: string; on: boolean }
  /** ``users``: the names in it, when a call opened it for you (Calls). */
  | { type: "room"; room: Room; users?: Record<string, RoomUser> }
  | { type: "room_delete"; room_id: string }
  | { type: "space"; space_id: string }
  | { type: "space_delete"; space_id: string }
  // Calls: voice channels' live state (handled by rtc/voice).
  | VoiceServerEvent
  // Calls: DM calls ringing, live and ended (handled by rtc/call).
  | CallServerEvent;

export const ROOMS_EVENTS_PATH = "/rooms/events";

/** When a "Remind me" on a message is due. */
export type RemindWhen = "hour" | "evening" | "tomorrow" | "none";
export const REMIND_CHOICES: { when: RemindWhen; label: string }[] = [
  { when: "hour", label: "In an hour" },
  { when: "evening", label: "This evening" },
  { when: "tomorrow", label: "Tomorrow morning" },
  { when: "none", label: "Just add to Tasks" },
];

export const roomsApi = {
  async bootstrap(): Promise<Bootstrap> {
    const { data } = await apiClient.get<Bootstrap>("/rooms/bootstrap");
    return data;
  },

  // ---- spaces ----
  async createSpace(body: { name: string; emoji?: string | null; color?: string | null }): Promise<Space> {
    const { data } = await apiClient.post<Space>("/rooms/spaces", body);
    return data;
  },
  async updateSpace(id: string, body: { name?: string; emoji?: string | null; color?: string | null }): Promise<void> {
    await apiClient.patch(`/rooms/spaces/${id}`, body);
  },
  async deleteSpace(id: string): Promise<void> {
    await apiClient.delete(`/rooms/spaces/${id}`);
  },
  async addSpaceMembers(id: string, user_ids: string[]): Promise<void> {
    await apiClient.post(`/rooms/spaces/${id}/members`, { user_ids });
  },
  async setSpaceMemberRole(id: string, userId: string, role: SpaceRole): Promise<void> {
    await apiClient.patch(`/rooms/spaces/${id}/members/${userId}`, { role });
  },
  async removeSpaceMember(id: string, userId: string): Promise<void> {
    await apiClient.delete(`/rooms/spaces/${id}/members/${userId}`);
  },
  async setSpaceNotify(id: string, notify: NotifyLevel): Promise<void> {
    await apiClient.patch(`/rooms/spaces/${id}/me`, { notify });
  },
  /** Mute the whole space until then (null: unmute). */
  async setSpaceMute(id: string, muted_until: string | null): Promise<void> {
    await apiClient.patch(`/rooms/spaces/${id}/me`, { muted_until });
  },

  // ---- rooms ----
  async createRoom(spaceId: string, body: { name: string; topic?: string | null; kind?: "text" | "voice" }): Promise<Room> {
    const { data } = await apiClient.post<Room>(`/rooms/spaces/${spaceId}/rooms`, body);
    return data;
  },
  async updateRoom(
    id: string,
    body: { name?: string; topic?: string | null; position?: number },
  ): Promise<Room | null> {
    const { data } = await apiClient.patch<Room | null>(`/rooms/rooms/${id}`, body);
    return data ?? null;
  },
  async deleteRoom(id: string): Promise<void> {
    await apiClient.delete(`/rooms/rooms/${id}`);
  },
  async updateMyRoom(
    id: string,
    body: { notify?: NotifyLevel | null; muted_until?: string | null; hidden?: boolean },
  ): Promise<Room | null> {
    const { data } = await apiClient.patch<Room | null>(`/rooms/rooms/${id}/me`, body);
    return data ?? null;
  },

  // ---- DMs ----
  async openDm(user_ids: string[]): Promise<Room> {
    const { data } = await apiClient.post<Room>("/rooms/dms", { user_ids });
    return data;
  },

  // ---- messages ----
  async messages(
    roomId: string,
    params: { before?: number; after?: number; around?: number; limit?: number } = {},
  ): Promise<MessagePage> {
    const { data } = await apiClient.get<MessagePage>(`/rooms/rooms/${roomId}/messages`, {
      params: { limit: 50, ...params },
    });
    return data;
  },
  async send(
    roomId: string,
    body: {
      body: string;
      reply_to_id?: string | null;
      attachment_ids?: string[];
      client_id?: string;
      place?: SharedPlace | null;
      gif?: LibraryGif | null;
      voice?: VoiceSend | null;
      poll?: PollDraft | null;
    },
  ): Promise<Message> {
    const { data } = await apiClient.post<Message>(`/rooms/rooms/${roomId}/messages`, body);
    return data;
  },
  async editMessage(id: string, body: { body?: string; pinned?: boolean }): Promise<Message | null> {
    const { data } = await apiClient.patch<Message | null>(`/rooms/messages/${id}`, body);
    return data ?? null;
  },
  async deleteMessage(id: string): Promise<void> {
    await apiClient.delete(`/rooms/messages/${id}`);
  },
  /** Undo a delete, for a minute after it: the message comes back as it was. */
  async restoreMessage(id: string): Promise<Message> {
    const { data } = await apiClient.post<Message>(`/rooms/messages/${id}/restore`);
    return data;
  },
  async addReaction(id: string, emoji: string): Promise<void> {
    await apiClient.put(`/rooms/messages/${id}/reactions`, { emoji });
  },
  async removeReaction(id: string, emoji: string): Promise<void> {
    await apiClient.delete(`/rooms/messages/${id}/reactions`, { params: { emoji } });
  },
  /** "Remind me": a task in your own Tasks that links back to the message. */
  async remind(messageId: string, when: RemindWhen): Promise<{ title: string; due: string | null; time: string | null; href: string }> {
    const { data } = await apiClient.post(`/rooms/messages/${messageId}/remind`, { when });
    return data;
  },
  /** Vote, change your vote, or (with none) take it back. */
  async votePoll(messageId: string, options: string[]): Promise<PollState> {
    const { data } = await apiClient.put<{ poll: PollState }>(`/rooms/messages/${messageId}/poll/vote`, { options });
    return data.poll;
  },
  async closePoll(messageId: string): Promise<Message> {
    const { data } = await apiClient.post<Message>(`/rooms/messages/${messageId}/poll/close`);
    return data;
  },
  async pins(roomId: string): Promise<Message[]> {
    const { data } = await apiClient.get<Message[]>(`/rooms/rooms/${roomId}/pins`);
    return data;
  },

  // ---- read state / typing / presence ----
  async markRead(roomId: string, seq: number): Promise<void> {
    await apiClient.post(`/rooms/rooms/${roomId}/read`, { seq });
  },
  /** This device has the conversation's messages up to `seq` ("Delivered"). */
  async markDelivered(roomId: string, seq: number): Promise<void> {
    await apiClient.post(`/rooms/rooms/${roomId}/delivered`, { seq });
  },
  async typing(roomId: string): Promise<void> {
    await apiClient.post(`/rooms/rooms/${roomId}/typing`);
  },
  async presence(roomId: string | null, device: string): Promise<void> {
    await apiClient.post("/rooms/presence", { room_id: roomId, device });
  },
  /** "Not looking any more", in a way that still goes out as the page is
   *  hidden or closed (a phone locking): a plain request can be dropped. */
  presenceGone(device: string, token: string | null): void {
    try {
      void fetch(`${API_BASE_URL}/rooms/presence`, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ room_id: null, device }),
      }).catch(() => undefined);
    } catch {
      /* it lapses by itself in a few seconds */
    }
  },

  // ---- attachments ----
  async upload(roomId: string, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, file.name);
    const { data } = await apiClient.post<Attachment>(`/rooms/rooms/${roomId}/attachments`, form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 0,
      signal,
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(e.loaded / e.total);
      },
    });
    return data;
  },

  // ---- GIFs ----
  async savedGifs(): Promise<SavedGif[]> {
    const { data } = await apiClient.get<SavedGif[]>("/rooms/saved-gifs");
    return data;
  },
  /** Save a GIF someone sent (your own copy), or one from the library. */
  async saveGif(body: { attachment_id: string } | { gif: LibraryGif }): Promise<SavedGif> {
    const { data } = await apiClient.post<SavedGif>("/rooms/saved-gifs", body);
    return data;
  },
  async unsaveGif(id: string): Promise<void> {
    await apiClient.delete(`/rooms/saved-gifs/${id}`);
  },
  /** One of your saved GIFs as an attachment in this room, ready to send. */
  async attachSaved(roomId: string, savedId: string): Promise<Attachment> {
    const { data } = await apiClient.post<Attachment>(`/rooms/rooms/${roomId}/attachments/saved/${savedId}`);
    return data;
  },

  // ---- a space's own emoji ----
  async addEmoji(spaceId: string, name: string, file: File): Promise<SpaceEmoji> {
    const form = new FormData();
    form.append("name", name);
    form.append("file", file, file.name);
    const { data } = await apiClient.post<SpaceEmoji>(`/rooms/spaces/${spaceId}/emojis`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return data;
  },
  async renameEmoji(id: string, name: string): Promise<SpaceEmoji> {
    const { data } = await apiClient.patch<SpaceEmoji>(`/rooms/emojis/${id}`, { name });
    return data;
  },
  async deleteEmoji(id: string): Promise<void> {
    await apiClient.delete(`/rooms/emojis/${id}`);
  },

  // ---- link previews ----
  /** Take the preview card off your own message (it stays off). */
  async removePreview(messageId: string): Promise<Message> {
    const { data } = await apiClient.delete<Message>(`/rooms/messages/${messageId}/preview`);
    return data;
  },

  // ---- search / people ----
  async search(q: string, roomId?: string | null): Promise<SearchHit[]> {
    const { data } = await apiClient.get<SearchHit[]>("/rooms/search", {
      params: roomId ? { q, room_id: roomId } : { q },
    });
    return data;
  },
  async people(q = ""): Promise<RoomUser[]> {
    const { data } = await apiClient.get<RoomUser[]>("/rooms/people", { params: { q } });
    return data;
  },
};
