import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  notificationsApi,
  type InboxResponse,
} from "@/api/notifications";

const INBOX_KEY = ["notifications", "inbox"] as const;

/** The durable notification list + unread badge. 60s poll matches the
 *  invites cadence — push is the real-time channel; this is catch-up. */
export function useInbox() {
  return useQuery<InboxResponse>({
    queryKey: INBOX_KEY,
    queryFn: () => notificationsApi.inbox(),
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: (data) => qc.setQueryData(INBOX_KEY, data),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: (data) => qc.setQueryData(INBOX_KEY, data),
  });
}
