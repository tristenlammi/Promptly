import { createContext, useContext } from "react";

import type { WorkspaceItemNode } from "@/api/workspaces";

/**
 * Opening a workspace-item link (an `@`-mention pill in a note, or a linked
 * shape on a canvas) shows the item in a lightweight PREVIEW modal, with an
 * "Open" button that navigates to it fully. Both surfaces are nested several
 * component layers below the page that owns the modal, so the handler is
 * shared via context rather than threaded through every pane as a prop.
 *
 * ``null`` when there's no provider (e.g. a canvas rendered outside the
 * workspace detail page) — callers fall back to opening the item directly.
 */
export type ItemPreviewFn = (node: WorkspaceItemNode) => void;

export const ItemPreviewContext = createContext<ItemPreviewFn | null>(null);

export function useItemPreview(): ItemPreviewFn | null {
  return useContext(ItemPreviewContext);
}
