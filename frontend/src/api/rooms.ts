import { apiClient } from "@/api/client";

/**
 * Rooms — spaces of text rooms + direct messages (docs/rooms-plan.md).
 * Everything lives under ``/api/rooms``. The live feed is a separate
 * fetch-based SSE stream (``useRoomsEvents``).
 */

export type NotifyLevel = "all" | "mentions" | "none";
export type SpaceRole = "owner" | "admin" | "member";
export type RoomKind = "text" | "dm" | "group";
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
  ai_context: boolean;
  last_seq: number;
  last_message_at: string | null;
  last_read_seq: number;
  unread: number;
  mentions: number;
  /** Your override for this room (null = inherit the space / "all"). */
  notify: NotifyLevel | null;
  /** DMs: the member ids (you included). */
  members?: string[];
  /** DMs: each member's AI consent. */
  ai_ok?: Record<string, boolean>;
  preview?: RoomPreview | null;
}

export interface Space {
  id: string;
  name: string;
  emoji: string | null;
  color: string | null;
  role: SpaceRole;
  notify: NotifyLevel;
  member_ids: string[];
  rooms: Room[];
  /** Optional: per-member roles, if the server sends them. */
  member_roles?: Record<string, SpaceRole>;
}

export interface Bootstrap {
  me: RoomUser;
  spaces: Space[];
  dms: Room[];
  users: Record<string, RoomUser>;
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
  | { type: "read"; room_id: string; seq: number }
  | { type: "typing"; room_id: string; user_id: string }
  | { type: "promptly_thinking"; room_id: string; on: boolean }
  | { type: "room"; room: Room }
  | { type: "room_delete"; room_id: string }
  | { type: "space"; space_id: string }
  | { type: "space_delete"; space_id: string };

export const ROOMS_EVENTS_PATH = "/rooms/events";

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

  // ---- rooms ----
  async createRoom(spaceId: string, body: { name: string; topic?: string | null }): Promise<Room> {
    const { data } = await apiClient.post<Room>(`/rooms/spaces/${spaceId}/rooms`, body);
    return data;
  },
  async updateRoom(
    id: string,
    body: { name?: string; topic?: string | null; position?: number; ai_context?: boolean },
  ): Promise<Room | null> {
    const { data } = await apiClient.patch<Room | null>(`/rooms/rooms/${id}`, body);
    return data ?? null;
  },
  async deleteRoom(id: string): Promise<void> {
    await apiClient.delete(`/rooms/rooms/${id}`);
  },
  async updateMyRoom(
    id: string,
    body: { notify?: NotifyLevel | null; hidden?: boolean; ai_ok?: boolean },
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
    body: { body: string; reply_to_id?: string | null; attachment_ids?: string[]; client_id?: string },
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
  async addReaction(id: string, emoji: string): Promise<void> {
    await apiClient.put(`/rooms/messages/${id}/reactions`, { emoji });
  },
  async removeReaction(id: string, emoji: string): Promise<void> {
    await apiClient.delete(`/rooms/messages/${id}/reactions`, { params: { emoji } });
  },
  async pins(roomId: string): Promise<Message[]> {
    const { data } = await apiClient.get<Message[]>(`/rooms/rooms/${roomId}/pins`);
    return data;
  },

  // ---- read state / typing / presence ----
  async markRead(roomId: string, seq: number): Promise<void> {
    await apiClient.post(`/rooms/rooms/${roomId}/read`, { seq });
  },
  async typing(roomId: string): Promise<void> {
    await apiClient.post(`/rooms/rooms/${roomId}/typing`);
  },
  async presence(roomId: string | null): Promise<void> {
    await apiClient.post("/rooms/presence", { room_id: roomId });
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
