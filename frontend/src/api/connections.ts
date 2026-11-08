import { apiClient } from "@/api/client";

/*
 * Connections between things across apps (``/api/connections``):
 * "Mentioned in" (recorded from docs, room messages, chat messages and
 * journal entries) and two-way "Linked". Everything comes back as the
 * viewer sees it — entries they can't open are simply not there.
 */

export type ThingKind =
  | "file"
  | "folder"
  | "photo"
  | "album"
  | "task"
  | "recipe"
  | "trip"
  | "contact"
  | "txn"
  | "journal"
  | "event"
  | "person"
  | "user"
  | "witem"
  | "room_msg"
  | "chat_msg"
  | "porch_post";

/** A thing, named the way a mention or link stores it. Things inside an app
 *  file are ``<file id>:<id inside it>`` (see :func:`subRef`). */
export interface ThingRef {
  kind: ThingKind;
  id: string;
}

export interface Thing extends ThingRef {
  label: string;
  title: string;
  subtitle: string;
  href: string | null;
  thumb?: string | null;
  emoji?: string | null;
  image_url?: string | null;
}

export interface LinkedThing extends Thing {
  link_id: string;
  at: string;
  can_remove: boolean;
}

export interface MentionedIn extends Thing {
  at: string;
}

export interface Connections {
  mentioned_in: MentionedIn[];
  linked: LinkedThing[];
}

/** ``task`` + tasks file + task id → the stored id. */
export function subRef(fileId: string, id: string): string {
  return `${fileId}:${id}`;
}

/** The in-app path a mention points at (``/link/<kind>/<id>``). */
export function linkPath(ref: ThingRef): string {
  return `/link/${ref.kind}/${ref.id}`;
}

/** The Markdown a mention is written as in a message or journal entry. */
export function mentionMarkdown(thing: Pick<Thing, "kind" | "id" | "title">): string {
  const title = (thing.title || "Untitled").replace(/[[\]\n]/g, " ").trim() || "Untitled";
  return `@[${title}](${linkPath(thing)})`;
}

const LINK_PATH_RE = /^\/link\/([a-z_]+)\/([A-Za-z0-9:_-]+)$/;

/** Parse ``/link/<kind>/<id>`` back out (null when it isn't one). */
export function parseLinkPath(href: string | null | undefined): ThingRef | null {
  if (!href) return null;
  const m = LINK_PATH_RE.exec(href);
  return m ? { kind: m[1] as ThingKind, id: m[2] } : null;
}

export const connectionsApi = {
  async get(ref: ThingRef): Promise<Connections> {
    const { data } = await apiClient.get<Connections>("/connections", { params: ref });
    return data;
  },
  async link(a: ThingRef, b: ThingRef): Promise<LinkedThing> {
    const { data } = await apiClient.post<LinkedThing>("/connections", { a, b });
    return data;
  },
  async unlink(linkId: string): Promise<void> {
    await apiClient.delete(`/connections/${linkId}`);
  },
  async search(q: string, limit = 6): Promise<Thing[]> {
    const { data } = await apiClient.get<{ results: Thing[] }>("/connections/search", { params: { q, limit } });
    return data.results;
  },
  async resolve(ref: ThingRef): Promise<Thing> {
    const { data } = await apiClient.get<Thing>("/connections/resolve", { params: ref });
    return data;
  },
};
