import type { EditOps } from "@/api/photos";

/** Ready-made looks built from the editor's own brightness, contrast and
 *  saturation (Porch's "Filters", WP-P1.4), so the server draws them exactly
 *  as the preview does. A warm look waits for a warmth adjustment. */
export interface FilterPreset {
  id: string;
  label: string;
  brightness: number;
  contrast: number;
  saturation: number;
}

export const FILTER_PRESETS: FilterPreset[] = [
  { id: "normal", label: "Normal", brightness: 0, contrast: 0, saturation: 0 },
  { id: "vivid", label: "Vivid", brightness: 0.05, contrast: 0.15, saturation: 0.45 },
  { id: "mono", label: "Mono", brightness: 0, contrast: 0.1, saturation: -1 },
  { id: "fade", label: "Fade", brightness: 0.08, contrast: -0.25, saturation: -0.3 },
  { id: "bright", label: "Bright", brightness: 0.2, contrast: 0.05, saturation: 0.05 },
  { id: "moody", label: "Moody", brightness: -0.12, contrast: 0.25, saturation: -0.2 },
  { id: "soft", label: "Soft", brightness: 0.05, contrast: -0.15, saturation: -0.1 },
];

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** The preset these adjustments are, if any. */
export function presetOf(ops: Pick<EditOps, "brightness" | "contrast" | "saturation">): FilterPreset | null {
  return FILTER_PRESETS.find((p) => near(p.brightness, ops.brightness) && near(p.contrast, ops.contrast) && near(p.saturation, ops.saturation)) ?? null;
}

/** The CSS filter that previews these adjustments (the server uses PIL's enhancers, the same maths). */
export function cssFilter(ops: Pick<EditOps, "brightness" | "contrast" | "saturation">): string {
  return `brightness(${1 + ops.brightness}) contrast(${1 + ops.contrast}) saturate(${1 + ops.saturation})`;
}
