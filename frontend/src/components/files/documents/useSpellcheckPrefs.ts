import { useCallback, useMemo } from "react";

import { authApi } from "@/api/auth";
import type { UserPreferencesUpdate, UserSettings } from "@/api/types";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { isSupportedLang, defaultSpellLang } from "./spellDictionaries";

/**
 * User-scoped spell-check preferences, backed by ``user.settings`` (persisted
 * server-side via ``PATCH /auth/me/preferences``) so a user's choices follow
 * their account across devices — not just one browser's localStorage.
 *
 * Writes are optimistic: we patch the cached user immediately (so the toolbar
 * flips without waiting on the round-trip) then reconcile with the server's
 * response, rolling back on failure.
 */
type SpellPrefKey =
  | "spellcheck_enabled"
  | "spellcheck_autocorrect"
  | "spellcheck_lang"
  | "spellcheck_words";

// Stable identity for the "no personal words yet" case. Returning a fresh
// ``[]`` each render would change the array identity every render, and since
// consumers put ``personalWords`` in effect deps that dispatch editor
// transactions, a new ``[]`` triggers a render→dispatch→render loop that
// freezes the note editor. One shared empty array avoids that.
const EMPTY_WORDS: string[] = [];

export function useSpellcheckPrefs() {
  const settings = useAuthStore((s) => s.user?.settings);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);

  const enabled = (settings?.spellcheck_enabled as boolean | undefined) ?? true;
  const autocorrect =
    (settings?.spellcheck_autocorrect as boolean | undefined) ?? false;
  const rawLang = settings?.spellcheck_lang as string | undefined;
  const lang = isSupportedLang(rawLang) ? rawLang : defaultSpellLang();
  const rawWords = settings?.spellcheck_words;
  // Memoised so identity is stable across renders (see EMPTY_WORDS). Keyed on
  // the actual stored array — it only changes when the user edits their
  // dictionary, which is exactly when consumers should re-run.
  const personalWords = useMemo<string[]>(
    () => (Array.isArray(rawWords) ? (rawWords as string[]) : EMPTY_WORDS),
    [rawWords]
  );

  const persist = useCallback(
    (patch: Pick<UserPreferencesUpdate, SpellPrefKey>) => {
      const keys = Object.keys(patch) as SpellPrefKey[];
      const previous: Record<string, unknown> = {};
      for (const k of keys) previous[k] = settings?.[k];
      patchSettings(patch);
      void authApi
        .updatePreferences(patch)
        .then((fresh) => setUser(fresh))
        .catch((err) => {
          patchSettings(previous as Partial<UserSettings>);
          toast.error(
            err instanceof Error
              ? err.message
              : "Couldn't save your spell-check preference."
          );
        });
    },
    [settings, patchSettings, setUser]
  );

  const setEnabled = useCallback(
    (v: boolean) => persist({ spellcheck_enabled: v }),
    [persist]
  );
  const setAutocorrect = useCallback(
    (v: boolean) => persist({ spellcheck_autocorrect: v }),
    [persist]
  );
  const setLang = useCallback(
    (code: string) => persist({ spellcheck_lang: code }),
    [persist]
  );
  const addPersonalWord = useCallback(
    (word: string) => {
      const lw = word.trim().toLowerCase();
      if (!lw || personalWords.includes(lw)) return;
      persist({ spellcheck_words: [...personalWords, lw] });
    },
    [personalWords, persist]
  );

  return {
    enabled,
    autocorrect,
    lang,
    personalWords,
    setEnabled,
    setAutocorrect,
    setLang,
    addPersonalWord,
  };
}
