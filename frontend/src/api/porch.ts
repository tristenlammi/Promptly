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
  /** Admins only: things reported in this group, waiting in its Reports tab. */
  open_reports?: number;
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

export type ActivityKind = "comment" | "reply" | "mention" | "reaction" | "removed";

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
  /** Null only for ``removed`` when there's nothing left to open. */
  post: PostRef | null;
  text: string | null;
  emoji: string[] | null;
  target: "post" | "comment" | "story";
  comment_id: string | null;
  unseen: boolean;
  /** ``removed``: an admin took your comment down (``all``), or your post
   *  out of Everyone (``everyone``) or one of your groups (``group``, named
   *  in ``group``), and why. ``post`` is then null when nothing is left to
   *  open. ``group`` on a comment: the group whose admin removed it. */
  removed?: { scope: "all" | "everyone" | "group"; reason: string; group?: string | null } | null;
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
  /** Groups you run with something reported, waiting in their Reports tab. */
  reports: { group: GroupLabel; count: number }[];
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
  /** The groups you run that it's in, and whether it's pinned there (WP-P3.1). */
  pin_groups?: (GroupLabel & { pinned: boolean })[];
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
  /** The story maker's own starting choice (stories remember theirs apart from posts). */
  last_story_groups?: "all" | string[] | null;
}

export interface Bootstrap {
  me: PorchUser & { is_admin: boolean };
  profile: MyProfile;
  /** Everyone first, then yours by name. */
  groups: PorchGroup[];
  invites: PorchGroup[];
  everyone: { id: string; name: string; emoji: string; member_count: number };
  limits: { max_media: number; video_max_seconds: number; video_max_mb: number; story_video_max_seconds: number };
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
  /** Someone else's: "Notify me when they post" is on. */
  alert?: boolean;
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
  | { type: "activity" }
  /** Someone's stories changed (a new one, or one deleted). */
  | { type: "story"; user_id: string }
  /** Someone saw one of your stories. */
  | { type: "story_view"; story_id: string };

// ---- stories (WP-P2.1, P2.2)

/** The six text-story backgrounds (``stories.BACKGROUNDS``). */
export const STORY_BACKGROUNDS = ["sunset", "ocean", "forest", "berry", "night", "sand"] as const;
export type StoryBackground = (typeof STORY_BACKGROUNDS)[number];
export type StoryTextStyle = "classic" | "bold" | "box";

/** A sticker on a story: where its middle sits (shares of the 9:16 frame), its size and turn. */
interface OverlayBase {
  x: number;
  y: number;
  scale: number;
  rotate: number;
  style: StoryTextStyle;
}
export type StoryOverlay =
  | (OverlayBase & { type: "text"; text: string })
  | (OverlayBase & { type: "mention"; user: PorchUser })
  | (OverlayBase & { type: "place"; place: PostPlace });

/** A sticker as sent: a mention names the person by id. */
export type StoryOverlayIn =
  | (OverlayBase & { type: "text"; text: string })
  | (OverlayBase & { type: "mention"; user_id: string })
  | (OverlayBase & { type: "place"; place: PostPlace });

export interface StoryMedia {
  kind: "image" | "video";
  thumb: string | null;
  preview: string | null;
  poster: string | null;
  video: string | null;
  state: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
}

export interface PorchStory {
  id: string;
  author: PorchUser | null;
  kind: "photo" | "video" | "text";
  created_at: string;
  expires_at: string;
  /** Past its 24 hours (only ever yours, or in a highlight). */
  expired: boolean;
  /** Its groups that are also yours. */
  groups: GroupLabel[];
  media: StoryMedia | null;
  text: string;
  background: StoryBackground | null;
  overlays: StoryOverlay[];
  alt_text: string;
  mine: boolean;
  /** You've seen it (your own always count as seen). */
  seen: boolean;
  /** Yours only: how many people saw it. */
  view_count?: number;
  file_id?: string | null;
}

/** One circle in the stories row. */
export interface StoryRing {
  user: PorchUser;
  count: number;
  unseen: number;
  latest_at: string;
  /** Every story of theirs you see is in this one group of yours: its emoji goes on the ring. */
  ring_group: GroupLabel | null;
  thumb: { image: string | null; background: StoryBackground | null; kind: PorchStory["kind"] };
  /** Your own circle: everyone who's seen your live stories. */
  views?: number;
}

export interface StoriesRow {
  me: StoryRing | null;
  people: StoryRing[];
}

export interface NewStory {
  kind: PorchStory["kind"];
  groups: "all" | string[];
  file_id?: string;
  /** Its 9:16 crop for this story only. */
  edit?: Pick<EditOps, "crop"> | null;
  text?: string;
  background?: StoryBackground;
  overlays?: StoryOverlayIn[];
  alt_text?: string;
}

export interface StoryViewer {
  user: PorchUser;
  seen_at: string;
}

/** A highlight (WP-P2.4): stories kept on a profile, each only for the people in its groups. */
export interface Highlight {
  id: string;
  name: string;
  cover: { story_id: string; image: string | null; background: StoryBackground | null; kind: PorchStory["kind"] } | null;
  count: number;
  /** Only the stories you may see (yours: all of them). */
  stories: PorchStory[];
  mine: boolean;
}

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

  // ---- hand-offs (WP-P1.6)
  /** Posts you can see, by words and (photos) by what's in them. */
  async search(q: string, signal?: AbortSignal): Promise<SearchResults> {
    const { data } = await apiClient.get<SearchResults>("/porch/search", { params: { q }, signal });
    return data;
  },
  /** Your 1:1 conversation with the post's author (made if new). */
  async replyPrivately(postId: string): Promise<{ room_id: string; share: string; url: string }> {
    const { data } = await apiClient.post<{ room_id: string; share: string; url: string }>(`/porch/posts/${postId}/reply`);
    return data;
  },
  /** "Make this an event": the post's words and place, and who can see it. */
  async eventPrefill(postId: string): Promise<EventPrefillOut> {
    const { data } = await apiClient.get<EventPrefillOut>(`/porch/posts/${postId}/event`);
    return data;
  },
  /** A post's small card, or 404 when you can't see it. */
  async card(postId: string): Promise<PostCardSummary> {
    const { data } = await apiClient.get<PostCardSummary>(`/porch/posts/${postId}/card`);
    return data;
  },
  /** How many Porch posts these photos of yours are in (Photos' trash warning). */
  async uses(fileIds: string[]): Promise<{ posts: number; photos: number }> {
    const { data } = await apiClient.post<{ posts: number; photos: number }>("/porch/files/uses", { file_ids: fileIds });
    return data;
  },

  // ---- notifications, reports (WP-P1.7)
  async notifications(): Promise<NotificationSettings> {
    const { data } = await apiClient.get<NotificationSettings>("/porch/me/notifications");
    return data;
  },
  async setNotifications(patch: { modes?: Partial<Record<PushKind, PushMode>>; porch?: boolean }): Promise<NotificationSettings> {
    const { data } = await apiClient.patch<NotificationSettings>("/porch/me/notifications", patch);
    return data;
  },
  /** People you're told about when they post. */
  async alerts(): Promise<PorchUser[]> {
    const { data } = await apiClient.get<PorchUser[]>("/porch/alerts");
    return data;
  },
  async setAlert(userId: string, on: boolean): Promise<void> {
    if (on) await apiClient.put(`/porch/alerts/${userId}`);
    else await apiClient.delete(`/porch/alerts/${userId}`);
  },
  /** Report a post or comment to the admins of the groups picked (yours
   *  that it's in; Everyone's admins are the people who run this Promptly). */
  async report(targetType: "post" | "comment" | "story", targetId: string, reason: string, groups: string[]): Promise<{ id: string; groups: GroupLabel[] }> {
    const { data } = await apiClient.post<{ id: string; groups: GroupLabel[] }>("/porch/reports", { target_type: targetType, target_id: targetId, reason, groups });
    return data;
  },
  /** A group's Reports tab (its owner and admins). */
  async groupReports(groupId: string): Promise<ReportItem[]> {
    const { data } = await apiClient.get<ReportItem[]>(`/porch/groups/${groupId}/reports`, { params: { status: "open" } });
    return data;
  },
  async groupHandled(groupId: string): Promise<HandledReport[]> {
    const { data } = await apiClient.get<HandledReport[]>(`/porch/groups/${groupId}/reports`, { params: { status: "handled" } });
    return data;
  },
  async decideGroupReport(groupId: string, reportId: string, action: "remove" | "keep", reason: string): Promise<{ deleted?: boolean; already_gone?: boolean }> {
    const { data } = await apiClient.post<{ deleted?: boolean; already_gone?: boolean }>(`/porch/groups/${groupId}/reports/${reportId}`, { action, reason });
    return data;
  },

  // ---- stories (WP-P2.1)
  /** The stories row: you, then people with live stories in your ticked groups. */
  async storiesRow(): Promise<StoriesRow> {
    const { data } = await apiClient.get<StoriesRow>("/porch/stories");
    return data;
  },
  /** Someone's live stories you can see, oldest first (``feed``: as the row shows them). */
  async userStories(userId: string, feed: boolean): Promise<{ user: PorchUser; stories: PorchStory[] }> {
    const { data } = await apiClient.get<{ user: PorchUser; stories: PorchStory[] }>(`/porch/stories/u/${userId}`, { params: { feed: feed || undefined } });
    return data;
  },
  async story(id: string): Promise<PorchStory> {
    const { data } = await apiClient.get<PorchStory>(`/porch/stories/${id}`);
    return data;
  },
  async createStory(body: NewStory): Promise<PorchStory> {
    const { data } = await apiClient.post<PorchStory>("/porch/stories", body);
    return data;
  },
  async deleteStory(id: string): Promise<void> {
    await apiClient.delete(`/porch/stories/${id}`);
  },
  async viewStory(id: string): Promise<void> {
    await apiClient.post(`/porch/stories/${id}/view`);
  },
  /** Who saw your story (yours only). */
  async storyViewers(id: string): Promise<{ count: number; viewers: StoryViewer[] }> {
    const { data } = await apiClient.get<{ count: number; viewers: StoryViewer[] }>(`/porch/stories/${id}/viewers`);
    return data;
  },
  /** Reply or react to someone's story: a message in your 1:1 Rooms conversation, with the story attached. */
  async replyStory(id: string, body: { text?: string; emoji?: string }): Promise<{ room_id: string; url: string; message_id: string }> {
    const { data } = await apiClient.post<{ room_id: string; url: string; message_id: string }>(`/porch/stories/${id}/reply`, body);
    return data;
  },
  // ---- pins (WP-P3.1)
  async groupPins(groupId: string): Promise<PorchPost[]> {
    const { data } = await apiClient.get<PorchPost[]>(`/porch/groups/${groupId}/pins`);
    return data;
  },
  async setPin(groupId: string, postId: string, pinned: boolean): Promise<void> {
    if (pinned) await apiClient.put(`/porch/groups/${groupId}/pins/${postId}`);
    else await apiClient.delete(`/porch/groups/${groupId}/pins/${postId}`);
  },

  // ---- highlights (WP-P2.4)
  async myHighlights(): Promise<Highlight[]> {
    const { data } = await apiClient.get<Highlight[]>("/porch/me/highlights");
    return data;
  },
  /** Someone's highlights, each with only the stories you may see. */
  async userHighlights(userId: string): Promise<Highlight[]> {
    const { data } = await apiClient.get<Highlight[]>(`/porch/users/${userId}/highlights`);
    return data;
  },
  async createHighlight(body: { name: string; story_ids: string[]; cover_story_id?: string | null }): Promise<Highlight> {
    const { data } = await apiClient.post<Highlight>("/porch/me/highlights", body);
    return data;
  },
  async updateHighlight(id: string, body: { name?: string; story_ids?: string[]; cover_story_id?: string | null }): Promise<Highlight> {
    const { data } = await apiClient.patch<Highlight>(`/porch/me/highlights/${id}`, body);
    return data;
  },
  async deleteHighlight(id: string): Promise<void> {
    await apiClient.delete(`/porch/me/highlights/${id}`);
  },
  async addToHighlight(id: string, storyId: string): Promise<Highlight> {
    const { data } = await apiClient.post<Highlight>(`/porch/me/highlights/${id}/stories`, { story_id: storyId });
    return data;
  },
  async removeFromHighlight(id: string, storyId: string): Promise<{ deleted: boolean; highlight?: Highlight }> {
    const { data } = await apiClient.delete<{ deleted: boolean; highlight?: Highlight }>(`/porch/me/highlights/${id}/stories/${storyId}`);
    return data;
  },
  /** Every story you've posted, newest first (private to you). */
  async storyArchive(before: string | null): Promise<{ stories: PorchStory[]; next: string | null }> {
    const { data } = await apiClient.get<{ stories: PorchStory[]; next: string | null }>("/porch/stories/archive", { params: { before: before || undefined } });
    return data;
  },
};

// ---- WP-P1.7: push settings

export type PushKind = "post" | "comment" | "reply" | "mention" | "tag" | "invite" | "reaction" | "birthday";
export type PushMode = "on" | "summary" | "off";

export interface NotificationSettings {
  modes: Record<PushKind, PushMode>;
  defaults: Record<PushKind, PushMode>;
  kinds: PushKind[];
  account: {
    /** Account → Notifications: notifications on at all. */
    push_enabled: boolean;
    /** Account → Notifications: Porch's own switch. */
    porch: boolean;
    quiet_enabled: boolean;
    quiet_start: string;
    quiet_end: string;
    summary_time: string;
    timezone: string;
  };
}

// ---- WP-P1.7: Admin → Porch

export interface PorchAdminSettings {
  enabled: boolean;
  /** null: everyone on this Promptly. */
  user_group_ids: string[] | null;
  video_max_seconds: number;
  video_max_mb: number;
  everyone_name: string;
  everyone_emoji: string;
  /** How many people Porch is on for. */
  people: number;
  user_groups: { id: string; name: string; member_count: number }[];
  open_reports: number;
}

export interface ReportTarget {
  type: "post" | "comment" | "story";
  id: string;
  /** Deleted, or no longer in this group: nothing more is shown. */
  gone: boolean;
  author?: PorchUser | null;
  post_id?: string;
  /** A story: its id, and a text story's colour. */
  story_id?: string;
  background?: StoryBackground | null;
  kind?: PostKind | "text";
  created_at?: string;
  body?: string;
  /** A comment's post, a few words of it. */
  post_body?: string;
  /** Where it is: only your own groups are named. */
  groups?: { in_everyone: boolean; named: GroupLabel[] };
  media?: { thumb: string | null; preview: string | null; alt: string; video: boolean }[];
}

export interface ReportItem {
  /** The report to answer (every open report on the same thing in this group goes with it). */
  id: string;
  /** The group it was reported in. */
  group: GroupLabel;
  target: ReportTarget;
  /** The reasons given. Never who gave them. */
  reports: { id: string; reason: string; created_at: string }[];
  first_at: string;
}

export interface HandledReport {
  id: string;
  target_type: "post" | "comment" | "story";
  status: "removed" | "kept";
  note: string;
  handled_at: string | null;
  handled_by: PorchUser | null;
}

export const porchAdminApi = {
  async get(): Promise<PorchAdminSettings> {
    const { data } = await apiClient.get<PorchAdminSettings>("/admin/porch");
    return data;
  },
  async patch(body: Partial<Pick<PorchAdminSettings, "enabled" | "user_group_ids" | "video_max_seconds" | "video_max_mb" | "everyone_name" | "everyone_emoji">>): Promise<PorchAdminSettings> {
    const { data } = await apiClient.patch<PorchAdminSettings>("/admin/porch", body);
    return data;
  },
  async reports(): Promise<ReportItem[]> {
    const { data } = await apiClient.get<ReportItem[]>("/admin/porch/reports", { params: { status: "open" } });
    return data;
  },
  async handled(): Promise<HandledReport[]> {
    const { data } = await apiClient.get<HandledReport[]>("/admin/porch/reports", { params: { status: "handled" } });
    return data;
  },
  async decide(reportId: string, action: "remove" | "keep", reason: string): Promise<{ deleted?: boolean; already_gone?: boolean }> {
    const { data } = await apiClient.post<{ deleted?: boolean; already_gone?: boolean }>(`/admin/porch/reports/${reportId}`, { action, reason });
    return data;
  },
  async removeFromEveryone(postId: string, reason: string): Promise<void> {
    await apiClient.post(`/admin/porch/posts/${postId}/remove-from-everyone`, { reason });
  },
};

export interface SearchResult {
  id: string;
  kind: PostKind;
  title: string;
  /** "Sam · in Family · 3 Nov" */
  subtitle: string;
  author: PorchUser | null;
  thumb: string | null;
  href: string;
  created_at: string | null;
}

export interface SearchResults {
  results: SearchResult[];
  /** False: photos weren't searched by what's in them (the photo service is off). */
  photos_searched: boolean;
}

export interface EventPrefillOut {
  title: string;
  body: string;
  location: string;
  author: PorchUser | null;
  url: string;
  /** Everyone who can see the post (not you): the only people it can invite. */
  guests: PorchUser[];
}

export interface PostCardSummary {
  title: string;
  subtitle: string;
  thumb: string | null;
  href: string;
}

/**
 * Before photos go to the trash: "This photo is in 2 Porch posts. …", or
 * null when they're in none (or Porch isn't on for you, or it can't be told).
 */
export async function porchTrashWarning(fileIds: string[]): Promise<string | null> {
  if (!fileIds.length) return null;
  try {
    const { posts, photos } = await porchApi.uses(fileIds);
    if (!posts) return null;
    const inPosts = posts === 1 ? "1 Porch post" : `${posts} Porch posts`;
    const lead = fileIds.length === 1 ? `This photo is in ${inPosts}.` : photos === 1 ? `One of these is in ${inPosts}.` : `${photos} of these are in ${inPosts}.`;
    return `${lead} Moving ${fileIds.length === 1 ? "it" : "them"} to the trash takes ${fileIds.length === 1 ? "it" : "them"} out of ${posts === 1 ? "that post" : "those posts"} for everyone. Restoring from the trash puts ${fileIds.length === 1 ? "it" : "them"} back.`;
  } catch {
    return null;
  }
}
