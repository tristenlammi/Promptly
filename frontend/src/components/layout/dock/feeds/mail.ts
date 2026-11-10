import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Mail, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { mailApi } from "@/mail/api";
import { toast } from "@/store/toastStore";

import type { DockCardData, DockFeed } from "../types";

/**
 * Mail, only once a mailbox is connected: a mailbox that needs attention, a
 * message that didn't send (with Try again), and the first fetch of a new
 * mailbox. Shares the Mail app's overview cache; asks once, then once a
 * minute only while there is a mailbox.
 */
function useCards(): DockCardData[] {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["mail-overview"],
    queryFn: mailApi.overview,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (q) => (q.state.data?.accounts?.length ? 60_000 : false),
  });
  const accounts = data?.accounts ?? [];
  if (!data || accounts.length === 0) return [];

  const open = () => navigate("/mail");
  const cards: DockCardData[] = [];

  const broken = accounts.filter((a) => a.status === "error");
  if (broken.length > 0) {
    cards.push({
      id: "mail:attention",
      priority: 70,
      icon: AlertTriangle,
      tone: "warn",
      title: broken.length === 1 ? "Mailbox needs attention" : `${broken.length} mailboxes need attention`,
      detail: broken.length === 1 ? broken[0].email : "Open Mail to sort them out",
      onOpen: open,
    });
  }

  const failed = data.failed ?? [];
  if (failed.length > 0) {
    const first = failed[0];
    cards.push({
      id: "mail:failed",
      priority: 72,
      icon: AlertTriangle,
      tone: "warn",
      title: failed.length === 1 ? "A message didn't send" : `${failed.length} messages didn't send`,
      detail: failed.length === 1 ? first.subject || "No subject" : "Open Mail to try again",
      onOpen: open,
      actions:
        failed.length === 1
          ? [
              {
                id: "retry",
                label: "Try again",
                icon: RotateCcw,
                onClick: () => {
                  void mailApi
                    .retrySend(first.id)
                    .then(() => {
                      toast.info("Sending again…");
                      return qc.invalidateQueries({ queryKey: ["mail-overview"] });
                    })
                    .catch(() => toast.error("Couldn't send it. Open Mail to check."));
                },
              },
            ]
          : undefined,
    });
  }

  const fetching = accounts.filter((a) => a.status === "syncing" && !a.last_sync_at);
  if (fetching.length > 0) {
    cards.push({
      id: "mail:fetching",
      priority: 35,
      icon: Mail,
      title: "Fetching your mail",
      detail: fetching.length === 1 ? fetching[0].email : `${fetching.length} mailboxes`,
      onOpen: open,
    });
  }
  return cards;
}

export const mailFeed: DockFeed = { id: "mail", useCards };
