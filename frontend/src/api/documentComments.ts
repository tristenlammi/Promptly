import { apiClient } from "./client";

/** Comments on documents and notes (WP-4.5, R-227), sheets and whiteboards
 *  (WP-6.1). The routes are under /documents/{fileId} for all of them. */
export interface CommentAuthor {
  user_id: string;
  username: string;
  avatar_url?: string | null;
  avatar_color?: string | null;
}

export interface TextAnchor {
  /** base64 Yjs relative positions into the document's Y.Doc. */
  from: string;
  to: string;
}

/** A sheet cell: the tab's id and the 0-based row / column. */
export interface CellAnchor {
  kind: "cell";
  sheet: string;
  /** The tab's name, for when its id changed. */
  tab?: string;
  r: number;
  c: number;
}

/** Whiteboard shapes, by element id. */
export interface ElementAnchor {
  kind: "element";
  ids: string[];
}

export type CommentAnchor = TextAnchor | CellAnchor | ElementAnchor;

export function isTextAnchor(a: CommentAnchor | null | undefined): a is TextAnchor {
  return !!a && "from" in a && "to" in a;
}

export interface DocComment {
  id: string;
  parent_id: string | null;
  author: CommentAuthor | null;
  body: string;
  quote: string | null;
  anchor: CommentAnchor | null;
  resolved_at: string | null;
  resolved_by: string | null;
  edited_at: string | null;
  created_at: string;
  can_edit: boolean;
  can_delete: boolean;
}

export interface DocCommentList {
  comments: DocComment[];
  can_comment: boolean;
}

export const documentCommentsApi = {
  async list(documentId: string): Promise<DocCommentList> {
    const { data } = await apiClient.get<DocCommentList>(`/documents/${documentId}/comments`);
    return data;
  },
  async people(documentId: string): Promise<CommentAuthor[]> {
    const { data } = await apiClient.get<CommentAuthor[]>(`/documents/${documentId}/comments/people`);
    return data;
  },
  async create(
    documentId: string,
    payload: { body: string; quote?: string | null; anchor?: CommentAnchor | null; parent_id?: string | null }
  ): Promise<DocComment> {
    const { data } = await apiClient.post<DocComment>(`/documents/${documentId}/comments`, payload);
    return data;
  },
  async edit(documentId: string, commentId: string, body: string): Promise<DocComment> {
    const { data } = await apiClient.patch<DocComment>(`/documents/${documentId}/comments/${commentId}`, { body });
    return data;
  },
  async resolve(documentId: string, commentId: string, resolved: boolean): Promise<DocComment> {
    const { data } = await apiClient.post<DocComment>(`/documents/${documentId}/comments/${commentId}/resolve`, {
      resolved,
    });
    return data;
  },
  async remove(documentId: string, commentId: string): Promise<void> {
    await apiClient.delete(`/documents/${documentId}/comments/${commentId}`);
  },
};
