import { apiClient } from "@/api/client";
import type { EditOps } from "@/api/photos";

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
  /** Your own posts only: the library file and this post's crop / filter. */
  file_id?: string;
  edit?: EditOps | null;
  /** People tagged on it: approved ones; the author also sees who hasn't
   *  answered yet, and you your own request. */
  tags: PhotoTag[];
}

export type TagStatus = "pending" | "approved" | "declined";

/** Someone tagged at a point (shares of the photo as posted). */
export interface PhotoTag {
  id: string;
  user: PorchUser;
  x: number;
  y: number;
  status: TagStatus;
}

/** A tag in a new or changed post. */
export interface TagIn {
  user_id: string;
  x: number;
  y: number;
}

/** The six reactions (the same as Rooms' quick ones). */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;
export const HEART = "❤️";

/** Which emoji were used and yours; who reacted only on your own post or comment. */
export interface Reactions {
  emojis: string[];
  mine: string | null;
  /** Yours only: the latest few people who reacted (not you). */
  people?: PorchUser[];
  /** Yours only: how many people reacted (not you). */
  count?: number;
}

export interface ReactionBy {
  user: PorchUser;
  emoji: string;
  created_at: string | null;
}

export interface PollOption {
  id: string;
  label: string;
  /** null until you can see the results. */
  votes: number | null;
  voters: PorchUser[] | null;
}

export interface Poll {
  options: PollOption[];
  closes_at: string | null;
  closed: boolean;
  my_vote: string | null;
  /** After you vote, when it closes, or on your own poll. */
  show_results: boolean;
  total: number | null;
}

export type PollCloses = "1d" | "3d" | "1w" | "never";

export interface PorchComment {
  id: string;
  post_id: string;
  parent_id: string | null;
  author: PorchUser | null;
  body: string;
  mentions: PorchUser[];
  /** Deleted, kept in place for its replies. */
  deleted: boolean;
  created_at: string | null;
  edited_at: string | null;
  mine: boolean;
  can_edit: boolean;
  can_delete: boolean;
  reactions: Reactions;
  /** Top comments only. */
  replies?: PorchComment[];
}

export interface CommentLine {
  id: string;
  parent_id: string | null;
  author: PorchUser | null;
  body: string;
}

export type ActivityKind = "comment" | "reply" | "mention" | "reaction";

export interface PostRef {
  id: string;
  kind: PostKind;
  thumb: string | null;
  body: string;
  mine: boolean;
}

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: string;
  actors: PorchUser[];
  /** How many more people than ``actors``. */
  others: number;
  post: PostRef;
  text: string | null;
  emoji: string[] | null;
  target: "post" | "comment";
  comment_id: string | null;
  unseen: boolean;
}

export interface TagRequest {
  id: string;
  post: PostRef;
  by: PorchUser | null;
  thumb: string | null;
  created_at: string | null;
}

export interface Activity {
  invites: PorchGroup[];
  tag_requests: TagRequest[];
  items: ActivityItem[];
  seen_at: string | null;
  unseen: number;
}

export interface TagSuggestion {
  file_id: string;
  user: PorchUser;
  /** The middle of their face, as shares of the upright photo (before this post's crop). */
  x: number;
  y: number;
}

export type PostKind = "photo" | "video" | "text" | "poll" | "life_event";

/** A link's preview, as the post keeps it (never an outside image). */
export interface LinkSnapshot {
  url: string;
  title: string;
  description: string;
  site_name: string;
}

export interface PostPlace {
  name: string;
  lat: number | null;
  lon: number | null;
}

/** One photo or video in a new or changed post: a new one by ``file_id``
 *  (yours, in your Photos library), one already in the post by ``id``. */
export interface MediaIn {
  id?: string;
  file_id?: string;
  alt_text?: string;
  /** This post's own crop / filter (``photos/edits`` ops); null: none. */
  edit?: EditOps | null;
  /** Who's tagged on it (asked first); left out: unchanged. */
  tags?: TagIn[];
}

export interface NewPost {
  kind: "photo" | "video" | "text" | "poll" | "life_event";
  body: string;
  groups: "all" | string[];
  media?: MediaIn[];
  place?: PostPlace | null;
  link?: LinkSnapshot | null;
  life_event?: { type: LifeEventType; title: string; date: string } | null;
  from_memory_id?: string | null;
  mentions?: string[];
  poll?: { options: string[]; closes: PollCloses } | null;
}

export type PostPatch = Partial<Pick<NewPost, "body" | "media" | "place" | "link" | "life_event" | "mentions">>;

/** What Photos knows about a photo you're posting. */
export interface ComposeFile {
  file_id: string;
  /** Photos' own description of it, for the alt text. */
  caption: string | null;
  /** The town it was taken in (never the exact spot). */
  place: { name: string; address: string; lat: number; lon: number } | null;
}
export type LifeEventType = "new_baby" | "new_job" | "moved_house" | "engaged" | "graduated" | "other";

export interface PorchPost {
  id: string;
  author: PorchUser | null;
  kind: PostKind;
  body: string;
  place: { name: string; lat: number | null; lon: number | null } | null;
  life_event: { type: LifeEventType; title: string; date: string } | null;
  link: LinkSnapshot | null;
  /** The people it @mentions (each could see it when it was written). */
  mentions: PorchUser[];
  groups: GroupLabel[];
  media: PorchMedia[];
  /** Every photo was since moved to the trash in Photos. */
  photo_removed: boolean;
  created_at: string;
  edited_at: string | null;
  mine: boolean;
  can_edit: boolean;
  can_delete: boolean;
  /** Comments you can see, and the latest two. */
  comment_count: number;
  latest_comments: CommentLine[];
  reactions: Reactions;
  poll: Poll | null;
  /** In your saved posts. */
  saved: boolean;
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
  /** The Activity badge: new since you last looked, plus invites and tag requests waiting. */
  activity_unseen: number;
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
  /** Yours only: "Suggest tags from my faces". */
  face_suggestions?: boolean;
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
  | { type: "invite"; group_id: string }
  | { type: "comment"; post_id: string; comment_id: string }
  | { type: "activity" };

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
  async createPost(body: NewPost): Promise<PorchPost> {
    const { data } = await apiClient.post<PorchPost>("/porch/posts", body);
    return data;
  },
  /** Description and place for your photos, from Photos. */
  async composeFiles(fileIds: string[]): Promise<ComposeFile[]> {
    const { data } = await apiClient.post<{ files: ComposeFile[] }>("/porch/compose/files", { file_ids: fileIds });
    return data.files;
  },
  async updatePost(id: string, patch: PostPatch): Promise<PorchPost> {
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
  async updateProfile(patch: Partial<Pick<MyProfile, "bio" | "birthday" | "show_birthday" | "face_suggestions">> & { welcomed?: boolean }): Promise<MyProfile> {
    const { data } = await apiClient.patch<MyProfile>("/porch/me/profile", patch);
    return data;
  },

  // ---- comments
  async comments(postId: string): Promise<{ comments: PorchComment[]; count: number }> {
    const { data } = await apiClient.get(`/porch/posts/${postId}/comments`);
    return data;
  },
  async addComment(postId: string, body: string, opts: { parentId?: string | null; mentions?: string[] } = {}): Promise<PorchComment> {
    const { data } = await apiClient.post<PorchComment>(`/porch/posts/${postId}/comments`, { body, parent_id: opts.parentId ?? null, mentions: opts.mentions ?? [] });
    return data;
  },
  async editComment(id: string, body: string, mentions: string[] = []): Promise<PorchComment> {
    const { data } = await apiClient.patch<PorchComment>(`/porch/comments/${id}`, { body, mentions });
    return data;
  },
  async deleteComment(id: string): Promise<void> {
    await apiClient.delete(`/porch/comments/${id}`);
  },

  // ---- reactions
  async react(postId: string, emoji: string | null): Promise<Reactions> {
    const { data } = emoji
      ? await apiClient.put<Reactions>(`/porch/posts/${postId}/reactions`, { emoji })
      : await apiClient.delete<Reactions>(`/porch/posts/${postId}/reactions`);
    return data;
  },
  async reactComment(commentId: string, emoji: string | null): Promise<Reactions> {
    const { data } = emoji
      ? await apiClient.put<Reactions>(`/porch/comments/${commentId}/reactions`, { emoji })
      : await apiClient.delete<Reactions>(`/porch/comments/${commentId}/reactions`);
    return data;
  },
  /** Who reacted to your post or comment (yours only). */
  async whoReacted(target: "post" | "comment", id: string): Promise<ReactionBy[]> {
    const { data } = await apiClient.get<ReactionBy[]>(`/porch/${target === "post" ? "posts" : "comments"}/${id}/reactions`);
    return data;
  },

  // ---- polls
  async vote(postId: string, optionId: string | null): Promise<PorchPost> {
    const { data } = optionId
      ? await apiClient.put<PorchPost>(`/porch/posts/${postId}/vote`, { option_id: optionId })
      : await apiClient.delete<PorchPost>(`/porch/posts/${postId}/vote`);
    return data;
  },

  // ---- saved
  async setSaved(postId: string, saved: boolean): Promise<void> {
    if (saved) await apiClient.put(`/porch/posts/${postId}/save`);
    else await apiClient.delete(`/porch/posts/${postId}/save`);
  },
  async saved(before: string | null): Promise<PostPage> {
    const { data } = await apiClient.get<PostPage>("/porch/saved", { params: { before: before || undefined } });
    return data;
  },

  // ---- tags
  async answerTag(tagId: string, yes: boolean): Promise<void> {
    await apiClient.post(`/porch/tags/${tagId}/${yes ? "approve" : "decline"}`);
  },
  async removeTag(tagId: string): Promise<void> {
    await apiClient.delete(`/porch/tags/${tagId}`);
  },
  async tagSuggestions(body: { file_ids: string[]; groups?: "all" | string[]; post_id?: string }): Promise<{ enabled: boolean; suggestions: TagSuggestion[] }> {
    const { data } = await apiClient.post("/porch/compose/tag-suggestions", body);
    return data;
  },

  // ---- activity
  async activity(): Promise<Activity> {
    const { data } = await apiClient.get<Activity>("/porch/activity");
    return data;
  },
  async activitySeen(): Promise<void> {
    await apiClient.post("/porch/activity/seen");
  },
};
