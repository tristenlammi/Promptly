import type { CSSProperties } from "react";

import type { Accent, FormFont } from "@/api/forms";

/**
 * A form's look: ten accent presets (terracotta first) and three fonts.
 * There's no free colour picker, so every form stays readable: each
 * preset's ``light`` colour carries white text at 5:1 or better and reads
 * as text on white and on the form's tinted background at 4.5:1 or better;
 * its ``dark`` colour reads at 6.5:1 or better as text on the dark tinted
 * background and carries near-black text at 7.9:1 or better (checked with
 * the WCAG formula when the presets were picked).
 */
export interface AccentColours {
  label: string;
  light: string;
  dark: string;
}

export const ACCENTS: Record<Accent, AccentColours> = {
  terracotta: { label: "Terracotta", light: "#A84B2A", dark: "#F0A27F" },
  rose: { label: "Rose", light: "#B83A5B", dark: "#F49AB0" },
  plum: { label: "Plum", light: "#8E3B83", dark: "#E39AD8" },
  violet: { label: "Violet", light: "#6D4BC4", dark: "#B9A2F5" },
  indigo: { label: "Indigo", light: "#4450B8", dark: "#A3ADF5" },
  blue: { label: "Blue", light: "#1F68B0", dark: "#8CC0F2" },
  teal: { label: "Teal", light: "#0F7470", dark: "#6FD1C8" },
  green: { label: "Green", light: "#2F7A3B", dark: "#8AD293" },
  olive: { label: "Olive", light: "#6B6B1F", dark: "#C9C973" },
  slate: { label: "Slate", light: "#4A5A6E", dark: "#B3C0D0" },
};

export const ACCENT_KEYS = Object.keys(ACCENTS) as Accent[];

export const FONTS: Record<FormFont, { label: string; stack: string }> = {
  default: { label: "Default", stack: "inherit" },
  serif: { label: "Serif", stack: 'Georgia, Cambria, "Times New Roman", ui-serif, serif' },
  rounded: {
    label: "Rounded",
    stack: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Quicksand", system-ui, sans-serif',
  },
};

export function accentOf(accent: string | null | undefined): AccentColours {
  return ACCENTS[(accent as Accent) in ACCENTS ? (accent as Accent) : "terracotta"];
}

/** The CSS custom properties a themed form surface reads (forms.css). */
export function themeVars(accent: string | null | undefined, font?: string | null): CSSProperties {
  const a = accentOf(accent);
  return {
    "--pf-accent-l": a.light,
    "--pf-accent-d": a.dark,
    "--pf-font": FONTS[(font as FormFont) in FONTS ? (font as FormFont) : "default"].stack,
  } as CSSProperties;
}
