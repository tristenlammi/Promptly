/**
 * The voice UI's own state: which sheet or menu is open, and view
 * choices (theatre, chat beside the stage). The sheets themselves are
 * drawn once by ``VoiceRoot``, so any button anywhere can open them.
 */
import { create } from "zustand";

import { voice } from "../voice/actions";

export interface PersonMenuTarget {
  userId: string;
  roomId: string;
  /** Where to show it: next to an element, or at a point (right-click). */
  anchor: HTMLElement | null;
  point: { x: number; y: number } | null;
}

interface VoiceUiState {
  settingsOpen: boolean;
  goLiveOpen: boolean;
  personMenu: PersonMenuTarget | null;
  /** Theatre: the stage takes the whole page (chat and lists hidden). */
  theatre: boolean;
  /** The channel's text chat beside the stage (desktop). */
  chatOpen: boolean;
  /** The channel the last join was for ("Try again"). */
  lastJoinRoomId: string | null;
  openSettings: () => void;
  closeSettings: () => void;
  openGoLive: () => void;
  closeGoLive: () => void;
  openPersonMenu: (t: PersonMenuTarget) => void;
  closePersonMenu: () => void;
  setTheatre: (on: boolean) => void;
  setChatOpen: (on: boolean) => void;
}

function readChat(): boolean {
  try {
    // Like Discord: the stage first; chat is a click away (and remembered).
    return window.localStorage.getItem("promptly.voice.chatOpen") === "1";
  } catch {
    return false;
  }
}

export const useVoiceUi = create<VoiceUiState>((set) => ({
  settingsOpen: false,
  goLiveOpen: false,
  personMenu: null,
  theatre: false,
  chatOpen: readChat(),
  lastJoinRoomId: null,
  openSettings: () => set({ settingsOpen: true, personMenu: null }),
  closeSettings: () => set({ settingsOpen: false }),
  openGoLive: () => set({ goLiveOpen: true }),
  closeGoLive: () => set({ goLiveOpen: false }),
  openPersonMenu: (personMenu) => set({ personMenu }),
  closePersonMenu: () => set({ personMenu: null }),
  setTheatre: (theatre) => set({ theatre }),
  setChatOpen: (chatOpen) => {
    try {
      window.localStorage.setItem("promptly.voice.chatOpen", chatOpen ? "1" : "0");
    } catch {
      /* this page only */
    }
    set({ chatOpen });
  },
}));

/** Join a voice channel (or move to it), remembering it for "Try again". */
export function joinVoice(roomId: string): Promise<boolean> {
  useVoiceUi.setState({ lastJoinRoomId: roomId });
  return voice.join(roomId);
}
