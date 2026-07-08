import nspell from "nspell";

/**
 * Spell-check dictionary registry + lazy loader.
 *
 * Each language's Hunspell data is bundled as a code-split virtual module by
 * the ``hunspellDictionaries`` Vite plugin (``virtual:hunspell/dictionary-*``),
 * so a dictionary's ~0.5–4 MB of text is only downloaded the first time a
 * user selects that language. Building the ``nspell`` instance from the raw
 * ``aff``/``dic`` blocks the main thread briefly (one-time, on load) — fine
 * for a note editor; a Web Worker is a possible future optimisation.
 *
 * Language set is limited to dictionaries whose licences are safe to bundle
 * (MIT/BSD, MPL, or LGPL). German + Italian exist upstream but are GPL-only
 * (strong copyleft) so are deliberately excluded from the build.
 */
export interface NspellLike {
  correct(word: string): boolean;
  suggest(word: string): string[];
  add(word: string): unknown;
}

export interface SpellLang {
  /** Our stable key, persisted in the spell-check store. */
  code: string;
  /** Menu label, in the language's own name where natural. */
  label: string;
  /** Short badge shown on the toolbar control. */
  short: string;
  loader: () => Promise<{ aff: string; dic: string }>;
}

export const SPELL_LANGUAGES: SpellLang[] = [
  {
    code: "en",
    label: "English (US)",
    short: "EN",
    loader: () => import("virtual:hunspell/dictionary-en"),
  },
  {
    code: "en-gb",
    label: "English (UK)",
    short: "EN-GB",
    loader: () => import("virtual:hunspell/dictionary-en-gb"),
  },
  {
    code: "es",
    label: "Español",
    short: "ES",
    loader: () => import("virtual:hunspell/dictionary-es"),
  },
  {
    code: "fr",
    label: "Français",
    short: "FR",
    loader: () => import("virtual:hunspell/dictionary-fr"),
  },
  {
    code: "pt",
    label: "Português",
    short: "PT",
    loader: () => import("virtual:hunspell/dictionary-pt"),
  },
];

const cache = new Map<string, Promise<NspellLike>>();

/** Load (and cache) the ``nspell`` instance for a language code. Unknown
 *  codes fall back to English so a stale persisted value can't wedge the
 *  checker. */
export function loadSpell(code: string): Promise<NspellLike> {
  const key = isSupportedLang(code) ? code : "en";
  const existing = cache.get(key);
  if (existing) return existing;
  const lang =
    SPELL_LANGUAGES.find((l) => l.code === key) ?? SPELL_LANGUAGES[0];
  const p = lang.loader().then(({ aff, dic }) => nspell(aff, dic) as NspellLike);
  cache.set(key, p);
  return p;
}

export function isSupportedLang(code: string | null | undefined): code is string {
  return !!code && SPELL_LANGUAGES.some((l) => l.code === code);
}

export function spellLangLabel(code: string): string {
  return SPELL_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export function spellLangShort(code: string): string {
  return SPELL_LANGUAGES.find((l) => l.code === code)?.short ?? code.toUpperCase();
}

/** Best-effort default from the browser locale, constrained to the set we
 *  actually ship. */
export function defaultSpellLang(): string {
  const nav =
    typeof navigator !== "undefined"
      ? navigator.language.toLowerCase()
      : "en";
  if (nav.startsWith("en-gb") || nav.startsWith("en-au")) return "en-gb";
  const two = nav.slice(0, 2);
  return SPELL_LANGUAGES.find((l) => l.code === two)?.code ?? "en";
}
