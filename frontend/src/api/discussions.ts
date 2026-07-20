/**
 * Workspace discussions API client.
 *
 * A ``kind="discussion"`` workspace item is the channel; it holds threads
 * (topics), each a chronological list of messages. Reading needs any
 * workspace membership, posting needs write access (editor+), and a
 * thread/message can be removed by its author or a workspace admin.
 *
 * Lives in its own module rather than ``workspaces.ts`` — discussions have
 * their own nested resource tree (item → thread → message) and that file is
 * already carrying the whole rest of the workspace surface.
 */

import { apiClient } from "./client";

/** One topic inside a discussion item. Ordered most-recently-active first
 *  by the list endpoint. */
export interface DiscussionThread {
  id: string;
  item_id: string;
  title: string;
  /** null once the author's account is gone (history survives). */
  created_by: string | null;
  created_by_name: string;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
}

/** One post in a thread, oldest first. */
export interface DiscussionMessage {
  id: string;
  thread_id: string;
  body: string;
  author_user_id: string | null;
  author_name: string;
  edited_at: string | null;
  created_at: string;
}

export const discussionsApi = {
  async listThreads(
    workspaceId: string,
    itemId: string
  ): Promise<DiscussionThread[]> {
    const { data } = await apiClient.get<DiscussionThread[]>(
      `/workspaces/${workspaceId}/discussions/${itemId}/threads`
    );
    return data;
  },

  /** ``body`` is an optional opening post so "new thread" is one round-trip. */
  async createThread(
    workspaceId: string,
    itemId: string,
    payload: { title: string; body?: string }
  ): Promise<DiscussionThread> {
    const { data } = await apiClient.post<DiscussionThread>(
      `/workspaces/${workspaceId}/discussions/${itemId}/threads`,
      payload
    );
    return data;
  },

  async deleteThread(workspaceId: string, threadId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${workspaceId}/threads/${threadId}`);
  },

  async listMessages(
    workspaceId: string,
    threadId: string
  ): Promise<DiscussionMessage[]> {
    const { data } = await apiClient.get<DiscussionMessage[]>(
      `/workspaces/${workspaceId}/threads/${threadId}/messages`
    );
    return data;
  },

  async postMessage(
    workspaceId: string,
    threadId: string,
    body: string
  ): Promise<DiscussionMessage> {
    const { data } = await apiClient.post<DiscussionMessage>(
      `/workspaces/${workspaceId}/threads/${threadId}/messages`,
      { body }
    );
    return data;
  },

  async deleteMessage(workspaceId: string, messageId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${workspaceId}/messages/${messageId}`);
  },
};
