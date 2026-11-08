import { apiClient } from "@/api/client";

/**
 * Porch: photos and news shared through groups, between the people on this
 * Promptly (docs/porch-plan.md, docs/porch-build.md). Everything lives under
 * ``/api/porch``; when Porch isn't on for someone, all of it is a 404. The
 * live feed is a separate fetch-based SSE stream (``usePorchEvents``) that
 * carries ids only — the app refetches through these checked endpoints.
 */

export const PORCH_EVENTS_PATH = "/porch/events";
export const PORCH_OFF_DETAIL = "Porch isn't turned on for you";

export interface PorchUser {
  id: string;
  username: string;
  /** Their display name, else their username. */
  name: string;
  avatar_url: string | null;
  color: string | null;
}

export type GroupKind = "everyone" | "custom";
export type Visibility = "public" | "private";
export type GroupRole = "owner" | "admin" | "member";
/** How much of a group you see: everything, your invite's outline, or a public group's outline. */
export type GroupView = "member" | "invited" | "outline";

/** A post's group, as you see it (only ever one of yours). */
export interface GroupLabel {
  id: string;
  name: string;
  emoji: string;
  kind: GroupKind;
  visibility: Visibility;
}

export interface PorchGroup {
  id: string;
  kind: GroupKind;
  name: string;
  emoji: string;
  about: string;
  visibility: Visibility;
  cover_url: string | null;
  member_count: number;
  admins: PorchUser[];
  view: GroupView;
  members_can_invite: boolean;
  is_admin: boolean;
  is_owner: boolean;
  can_invite: boolean;
  created_at: string | null;
  /** Members only. */
  in_feed?: boolean;
  notify?: "all" | "none";
  role?: GroupRole;
  /** A pending invite. */
  invited_by?: PorchUser | null;
  invited_at?: string | null;
}

export interface PorchMedia {
  id: string;
  position: number;
  kind: "image" | "video";
  alt_text: string;
  edited: boolean;
  thumb: string | null;
  preview: string | null;
  poster: string | null;
  video: string | null;
  full: string | null;
  /** The media worker's progress on its renditions ("ready" when done). */
  state: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  /** Your own posts only. */
  file_id?: string;
}

export type PostKind = "photo" | "video" | "text" | "poll" | "life_event";
export type LifeEventType = "new_baby" | "new_job" | "moved_house" | "engaged" | "graduated" | "other";

export interface PorchPost {
  id: string;
  author: PorchUser | null;
  kind: PostKind;
  body: string;
  place: { name: string; lat: number | null; lon: number | null } | null;
  life_event: { type: LifeEventType; title: string; date: string } | null;
  link: { url: string; title: string; description: string; site_name: string } | null;
  mentions: string[];
  groups: GroupLabel[];
  media: PorchMedia[];
  /** Every photo was since moved to the trash in Photos. */
  photo_removed: boolean;
  created_at: string;
  edited_at: string | null;
  mine: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

export interface MyProfile {
  bio: string;
  birthday: string | null;
  show_birthday: boolean;
  face_suggestions: boolean;
  feed_seen_at: string | null;
  activity_seen_at: string | null;
  welcomed: boolean;
  last_groups: "all" | string[] | null;
}

export interface Bootstrap {
  me: PorchUser & { is_admin: boolean };
  profile: MyProfile;
  /** Everyone first, then yours by name. */
  groups: PorchGroup[];
  invites: PorchGroup[];
  everyone: { id: string; name: string; emoji: string; member_count: number };
  limits: { max_media: number; video_max_seconds: number; video_max_mb: number };
}

export interface PostPage {
  posts: PorchPost[];
  /** The next page's ``before``; null at the end. */
  next: string | null;
  /** The feed only. */
  ticked?: string[];
  feed_seen_at?: string | null;
}

export interface Profile {
  user: PorchUser;
  is_me: boolean;
  bio: string;
  birthday: string | null;
  show_birthday?: boolean;
  /** Groups you're both in (never one you're not in). */
  shared_groups?: GroupLabel[];
  /** What they are to you, from your own Contacts and Photos people. */
  relation?: { name: string; label: string | null } | null;
}

export interface Member extends PorchUser {
  role: GroupRole;
  joined_at: string | null;
}

export interface PendingInvite {
  user: PorchUser;
  invited_by: PorchUser | null;
  invited_at: string | null;
}

export interface Suggested {
  user: PorchUser;
  label: string | null;
  name: string;
}

export type ProfileTab = "all" | "photos" | "posts" | "life_events";

export type PorchEvent =
  | { type: "post"; post_id: string }
  | { type: "post_change"; post_id: string }
  | { type: "group"; group_id: string }
  | { type: "invite"; group_id: string };

export interface NewGroup {
  name: string;
  visibility: Visibility;
  emoji?: string;
  about?: string;
  members_can_invite?: boolean;
  invite?: string[];
}

export interface GroupPatch {
  name?: string;
  visibility?: Visibility;
  emoji?: string;
  about?: string;
  members_can_invite?: boolean;
  cover_file_id?: string | null;
}

export const porchApi = {
  async available(): Promise<boolean> {
    const { data } = await apiClient.get<{ available: boolean }>("/porch/available");
    return data.available;
  },
  async bootstrap(): Promise<Bootstrap> {
    const { data } = await apiClient.get<Bootstrap>("/porch/bootstrap");
    return data;
  },

  // ---- posts
  async feed(before: string | null, photos: boolean): Promise<PostPage> {
    const { data } = await apiClient.get<PostPage>("/porch/feed", { params: { before: before || undefined, photos: photos || undefined } });
    return data;
  },
  async feedSeen(at: string): Promise<void> {
    await apiClient.post("/porch/feed/seen", { at });
  },
  async post(id: string): Promise<PorchPost> {
    const { data } = await apiClient.get<PorchPost>(`/porch/posts/${id}`);
    return data;
  },
  async updatePost(id: string, patch: { body?: string }): Promise<PorchPost> {
    const { data } = await apiClient.patch<PorchPost>(`/porch/posts/${id}`, patch);
    return data;
  },
  async deletePost(id: string): Promise<void> {
    await apiClient.delete(`/porch/posts/${id}`);
  },
  async groupPosts(groupId: string, before: string | null, photos: boolean): Promise<PostPage> {
    const { data } = await apiClient.get<PostPage>(`/porch/groups/${groupId}/posts`, { params: { before: before || undefined, photos: photos || undefined } });
    return data;
  },
  async userPosts(userId: string, before: string | null, tab: ProfileTab): Promise<PostPage> {
    const { data } = await apiClient.get<PostPage>(`/porch/users/${userId}/posts`, { params: { before: before || undefined, tab } });
    return data;
  },

  // ---- groups
  async groups(): Promise<{ groups: PorchGroup[]; invites: PorchGroup[] }> {
    const { data } = await apiClient.get("/porch/groups");
    return data;
  },
  async discover(q = ""): Promise<PorchGroup[]> {
    const { data } = await apiClient.get<PorchGroup[]>("/porch/groups/discover", { params: { q: q || undefined } });
    return data;
  },
  async group(id: string): Promise<PorchGroup> {
    const { data } = await apiClient.get<PorchGroup>(`/porch/groups/${id}`);
    return data;
  },
  async createGroup(body: NewGroup): Promise<PorchGroup & { invited: string[] }> {
    const { data } = await apiClient.post(`/porch/groups`, body);
    return data;
  },
  async updateGroup(id: string, patch: GroupPatch): Promise<PorchGroup> {
    const { data } = await apiClient.patch<PorchGroup>(`/porch/groups/${id}`, patch);
    return data;
  },
  async deleteGroup(id: string): Promise<void> {
    await apiClient.delete(`/porch/groups/${id}`);
  },
  async transfer(id: string, userId: string): Promise<PorchGroup> {
    const { data } = await apiClient.post<PorchGroup>(`/porch/groups/${id}/transfer`, { user_id: userId });
    return data;
  },
  async members(id: string): Promise<Member[]> {
    const { data } = await apiClient.get<Member[]>(`/porch/groups/${id}/members`);
    return data;
  },
  async setRole(id: string, userId: string, role: "admin" | "member"): Promise<void> {
    await apiClient.patch(`/porch/groups/${id}/members/${userId}`, { role });
  },
  /** Remove someone (admins), or leave (yourself). */
  async removeMember(id: string, userId: string): Promise<void> {
    await apiClient.delete(`/porch/groups/${id}/members/${userId}`);
  },
  async setMine(id: string, patch: { in_feed?: boolean; notify?: "all" | "none" }): Promise<{ group_id: string; in_feed: boolean; notify: string }> {
    const { data } = await apiClient.patch(`/porch/groups/${id}/me`, patch);
    return data;
  },
  async invite(id: string, userIds: string[]): Promise<string[]> {
    const { data } = await apiClient.post<{ invited: string[] }>(`/porch/groups/${id}/invites`, { user_ids: userIds });
    return data.invited;
  },
  async pendingInvites(id: string): Promise<PendingInvite[]> {
    const { data } = await apiClient.get<PendingInvite[]>(`/porch/groups/${id}/invites`);
    return data;
  },
  async cancelInvite(id: string, userId: string): Promise<void> {
    await apiClient.delete(`/porch/groups/${id}/invites/${userId}`);
  },
  async accept(id: string): Promise<PorchGroup> {
    const { data } = await apiClient.post<PorchGroup>(`/porch/groups/${id}/accept`);
    return data;
  },
  async decline(id: string): Promise<void> {
    await apiClient.post(`/porch/groups/${id}/decline`);
  },
  async join(id: string): Promise<PorchGroup> {
    const { data } = await apiClient.post<PorchGroup>(`/porch/groups/${id}/join`);
    return data;
  },

  // ---- people and profiles
  async people(q: string, opts: { groups?: string[]; post?: string } = {}): Promise<PorchUser[]> {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    for (const g of opts.groups ?? []) params.append("groups", g);
    if (opts.post) params.set("post", opts.post);
    const { data } = await apiClient.get<PorchUser[]>(`/porch/people?${params.toString()}`);
    return data;
  },
  async suggested(): Promise<Suggested[]> {
    const { data } = await apiClient.get<Suggested[]>("/porch/people/suggested");
    return data;
  },
  async profile(userId: string): Promise<Profile> {
    const { data } = await apiClient.get<Profile>(`/porch/users/${userId}`);
    return data;
  },
  /** Block someone (Promptly-wide, ``/api/people/blocks``). They aren't told. */
  async block(userId: string): Promise<void> {
    await apiClient.put(`/people/blocks/${userId}`);
  },
  async updateProfile(patch: Partial<Pick<MyProfile, "bio" | "birthday" | "show_birthday">> & { welcomed?: boolean }): Promise<MyProfile> {
    const { data } = await apiClient.patch<MyProfile>("/porch/me/profile", patch);
    return data;
  },
};
