import type { StoryBackground, StoryTextStyle } from "@/api/porch";

/** How each text-story background looks (the six of ``stories.BACKGROUNDS``),
 *  and whether words on it are dark. */
export const BACKGROUND_LOOK: Record<StoryBackground, { label: string; css: string; dark: boolean }> = {
  sunset: { label: "Sunset", css: "linear-gradient(160deg, #F59E0B 0%, #EA580C 45%, #BE185D 100%)", dark: false },
  ocean: { label: "Ocean", css: "linear-gradient(160deg, #38BDF8 0%, #2563EB 55%, #1E3A8A 100%)", dark: false },
  forest: { label: "Forest", css: "linear-gradient(160deg, #4ADE80 0%, #16A34A 50%, #14532D 100%)", dark: false },
  berry: { label: "Berry", css: "linear-gradient(160deg, #C084FC 0%, #9333EA 50%, #9D174D 100%)", dark: false },
  night: { label: "Night", css: "linear-gradient(160deg, #334155 0%, #1E293B 50%, #020617 100%)", dark: false },
  sand: { label: "Sand", css: "linear-gradient(160deg, #FDF2DC 0%, #F3D9A8 55%, #E2B877 100%)", dark: true },
};

export const TEXT_STYLE_LABEL: Record<StoryTextStyle, string> = { classic: "Classic", bold: "Bold", box: "Box" };

/** How long a photo or text story stays on screen. */
export const STILL_MS = 6000;

/** "3h", "45m" — how long ago, for the viewer's header. */
export function agoShort(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "Ends in 5h" / "Ended". */
export function endsIn(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s <= 0) return "Ended";
  if (s < 3600) return `Ends in ${Math.max(1, Math.floor(s / 60))}m`;
  return `Ends in ${Math.floor(s / 3600)}h`;
}
