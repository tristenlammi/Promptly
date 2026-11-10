import { AudioLines } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { DockCardData, DockFeed } from "../types";
import { go, useDockToday } from "../useDockToday";

/** Notes: a recording that's still being written up. */
function useCards(): DockCardData[] {
  const today = useDockToday();
  const navigate = useNavigate();
  const notes = today?.sections.notes;
  const list = notes?.transcribing ?? [];
  if (!notes || list.length === 0) return [];
  const first = list[0];
  return [
    {
      id: "notes:transcribing",
      priority: 30,
      icon: AudioLines,
      title: list.length === 1 ? "Writing up your recording" : `Writing up ${list.length} recordings`,
      detail: list.length === 1 ? first.title || "Untitled note" : "They'll be ready soon",
      onOpen: () => go(navigate, list.length === 1 ? first.url : notes.url, "/notes"),
    },
  ];
}

export const notesFeed: DockFeed = { id: "notes", useCards };
