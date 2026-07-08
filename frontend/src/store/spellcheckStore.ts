import { create } from "zustand";
import { persist } from "zustand/middleware";

import { defaultSpellLang } from "@/components/files/documents/spellDictionaries";

interface SpellcheckState {
  /** Master on/off for the custom (nspell) spell-checker in notes. */
  enabled: boolean;
  /** Selected dictionary language code (see ``SPELL_LANGUAGES``). */
  lang: string;
  /** Words the user has "Add to dictionary"-ed, lower-cased. Language-agnostic
   *  and applied on top of every dictionary. */
  personalWords: string[];
  setEnabled: (v: boolean) => void;
  setLang: (code: string) => void;
  addPersonalWord: (word: string) => void;
  removePersonalWord: (word: string) => void;
}

/**
 * Per-user, per-device spell-check preference for the note editor. Persisted
 * to ``localStorage`` alongside the other editor prefs (note width, theme).
 * A cross-device "saved to profile" variant would live in backend user
 * settings — a possible follow-up.
 */
export const useSpellcheckStore = create<SpellcheckState>()(
  persist(
    (set) => ({
      enabled: true,
      lang: defaultSpellLang(),
      personalWords: [],
      setEnabled: (v) => set({ enabled: v }),
      setLang: (code) => set({ lang: code }),
      addPersonalWord: (word) =>
        set((s) => {
          const lw = word.trim().toLowerCase();
          if (!lw || s.personalWords.includes(lw)) return s;
          return { personalWords: [...s.personalWords, lw] };
        }),
      removePersonalWord: (word) =>
        set((s) => {
          const lw = word.trim().toLowerCase();
          return { personalWords: s.personalWords.filter((w) => w !== lw) };
        }),
    }),
    { name: "promptly.spellcheck" }
  )
);
