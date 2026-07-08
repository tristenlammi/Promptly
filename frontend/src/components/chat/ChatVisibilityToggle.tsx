import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, Users } from "lucide-react";

import { chatApi } from "@/api/chat";
import type { ConversationDetail } from "@/api/types";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Creator-only toggle for a workspace chat's visibility. "Private" keeps the
 * chat to its creator; "Shared" lets every workspace member read it (sending
 * stays creator-only — the backend send path is owner-only). Flipping it
 * refreshes the workspace tree so the chat appears/disappears for others.
 */
export function ChatVisibilityToggle({
  conversationId,
  visibility,
  compact,
}: {
  conversationId: string;
  visibility: "private" | "workspace";
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const shared = visibility === "workspace";

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const next = shared ? "private" : "workspace";
    try {
      await chatApi.update(conversationId, { visibility: next });
      qc.setQueryData<ConversationDetail>(
        ["conversation", conversationId],
        (old) => (old ? { ...old, visibility: next } : old)
      );
      // The chat now shows / hides for other members in the rail.
      void qc.invalidateQueries({ queryKey: ["workspaces", "tree"] });
      toast.success(
        next === "workspace"
          ? "Shared with the workspace (members can read it)"
          : "Chat is private to you again"
      );
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't change the chat's visibility."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={
        shared
          ? "Shared with the workspace — members can read it (only you can send). Click to make private."
          : "Private to you. Click to share it (read-only) with the workspace."
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition disabled:opacity-60",
        shared
          ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/15"
          : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : shared ? (
        <Users className="h-3.5 w-3.5" />
      ) : (
        <Lock className="h-3.5 w-3.5" />
      )}
      {!compact && (shared ? "Shared" : "Private")}
    </button>
  );
}
