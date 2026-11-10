import { AlertTriangle, CloudUpload } from "lucide-react";
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useUploadStore } from "@/store/uploadStore";

import type { DockCardData, DockFeed } from "../types";

/** Pages that show the full upload list themselves. */
const DRIVE_ROUTE = /^\/(files|workspaces|photos)(\/|$)/;

/** Uploads in flight (from Files, Photos or a workspace): "Uploading 12 of
 *  40" with progress, plus the ones waiting on a choice or that failed. */
function useCards(): DockCardData[] {
  const tasks = useUploadStore((s) => s.tasks);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return useMemo(() => {
    const open = () => {
      useUploadStore.getState().setPanelCollapsed(false);
      if (!DRIVE_ROUTE.test(pathname)) navigate("/files");
    };
    const active = tasks.filter((t) => t.status === "uploading" || t.status === "queued");
    const done = tasks.filter((t) => t.status === "done");
    const conflicts = tasks.filter((t) => t.status === "conflict").length;
    const failed = tasks.filter((t) => t.status === "error").length;
    const cards: DockCardData[] = [];

    if (active.length > 0) {
      const total = active.length + done.length;
      const bytes = [...active, ...done].reduce((n, t) => n + t.size, 0);
      const sent = active.reduce((n, t) => n + t.uploaded, 0) + done.reduce((n, t) => n + t.size, 0);
      const progress = bytes > 0 ? Math.min(1, sent / bytes) : 0;
      const pct = Math.floor(progress * 100);
      cards.push({
        id: "uploads",
        priority: 80,
        icon: CloudUpload,
        tone: "accent",
        title: total === 1 ? "Uploading 1 file" : `Uploading ${Math.min(done.length + 1, total)} of ${total}`,
        detail: total === 1 ? `${active[0].name} · ${pct}%` : `${pct}% done`,
        progress,
        onOpen: open,
      });
    }
    if (conflicts > 0) {
      cards.push({
        id: "uploads:conflict",
        priority: 82,
        icon: AlertTriangle,
        tone: "warn",
        title: conflicts === 1 ? "1 upload needs your choice" : `${conflicts} uploads need your choice`,
        detail: "A file with that name is already there",
        onOpen: open,
      });
    }
    if (failed > 0 && active.length === 0) {
      cards.push({
        id: "uploads:failed",
        priority: 78,
        icon: AlertTriangle,
        tone: "warn",
        title: failed === 1 ? "1 upload didn't finish" : `${failed} uploads didn't finish`,
        detail: "Open the list to try again",
        onOpen: open,
      });
    }
    return cards;
  }, [tasks, pathname, navigate]);
}

export const uploadsFeed: DockFeed = { id: "uploads", useCards };
