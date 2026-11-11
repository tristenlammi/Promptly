import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Trash2 } from "lucide-react";

import { feedbackApi, type FeedbackItem, type FeedbackList } from "@/api/feedback";
import { Button } from "@/components/shared/Button";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRows } from "@/components/shared/Skeleton";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

const KEY = ["admin", "feedback"];

/**
 * Admin → Feedback: what people wrote with the Send feedback button. Who,
 * when and the words; nothing about where they were in the app. Mark one
 * read, or delete it.
 */
export function FeedbackPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<FeedbackList>({
    queryKey: KEY,
    queryFn: () => feedbackApi.list(),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const setRead = useMutation({
    mutationFn: (v: { id: string; read: boolean }) => feedbackApi.setRead(v.id, v.read),
    onSuccess: refresh,
    onError: (e) => toast.error(apiErrorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => feedbackApi.remove(id),
    onSuccess: refresh,
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  if (isLoading) return <SkeletonRows count={3} label="Loading" />;
  if (error || !data) {
    return (
      <p className="text-sm text-[var(--danger)]">
        {apiErrorMessage(error, "Feedback couldn't be loaded.")}
      </p>
    );
  }
  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={<MessageSquare className="h-5 w-5" />}
        title="No feedback yet"
        description="Messages people send with Send feedback show up here."
      />
    );
  }

  const busy = setRead.isPending || remove.isPending;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--text-muted)]">
        {data.unread === 0 ? "All read." : `${data.unread} unread.`}
      </p>
      <ul className="flex flex-col gap-2" aria-label="Feedback">
        {data.items.map((item: FeedbackItem) => (
          <li
            key={item.id}
            data-read={item.read ? "true" : "false"}
            className={cn(
              "rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3",
              !item.read && "border-l-2 border-l-[var(--accent)]"
            )}
          >
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--text-muted)]">
              <span className={cn("text-sm text-[var(--text)]", !item.read && "font-semibold")}>
                {item.username ?? "Someone who has left"}
              </span>
              <time dateTime={item.created_at}>
                {new Date(item.created_at).toLocaleString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
              {!item.read && <span className="text-[var(--accent-text)]">New</span>}
            </div>
            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-[var(--text)]">
              {item.message}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setRead.mutate({ id: item.id, read: !item.read })}
              >
                {item.read ? "Mark unread" : "Mark read"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Delete this message? This can't be undone.")) {
                    remove.mutate(item.id);
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
