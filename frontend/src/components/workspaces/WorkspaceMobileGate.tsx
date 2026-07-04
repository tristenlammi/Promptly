import { Monitor } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { EmptyState } from "@/components/shared/EmptyState";

/**
 * Friendly gate for /workspaces* on phones. Workspaces are a desktop
 * surface by design — the multi-pane layout, drag-first navigator, and
 * embedded editors don't fit a phone, so rather than rendering a broken
 * squeeze we say so. The nav item is already hidden on mobile
 * (``desktopOnly`` in navItems.ts); this covers direct links/bookmarks.
 */
export function WorkspaceMobileGate() {
  const navigate = useNavigate();
  return (
    <>
      <TopNav title="Workspaces" />
      <div className="flex-1 overflow-y-auto px-4 py-10">
        <EmptyState
          icon={<Monitor className="h-5 w-5" />}
          title="Workspaces are designed for desktop"
          description="The multi-pane project layout — navigator, notes, boards, sheets, and canvases — needs a bigger screen. Your workspaces are all here waiting on desktop; chats inside them still work from the regular chat list on your phone."
          action={
            <Button variant="primary" onClick={() => navigate("/chat")}>
              Back to chat
            </Button>
          }
        />
      </div>
    </>
  );
}
