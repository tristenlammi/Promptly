/**
 * Ambient types for the spell-check stack.
 *
 *  - ``virtual:hunspell/*`` modules are synthesised by the
 *    ``hunspellDictionaries`` Vite plugin (see ``vite.config.ts``): each one
 *    inlines a ``dictionary-*`` package's ``.aff``/``.dic`` data as strings.
 *  - ``nspell`` ships no types, so declare the slice of its API we use.
 */
declare module "virtual:hunspell/*" {
  export const aff: string;
  export const dic: string;
}

declare module "nspell" {
  interface Nspell {
    /** True when ``word`` is spelled correctly for the loaded dictionary. */
    correct(word: string): boolean;
    /** Ranked correction candidates for a misspelled word. */
    suggest(word: string): string[];
    /** Teach the instance a new word (personal dictionary). */
    add(word: string): Nspell;
    /** Mark a word as correct without adding it as a suggestion source. */
    remove(word: string): Nspell;
  }
  function nspell(aff: string | Buffer, dic: string | Buffer): Nspell;
  function nspell(dictionary: {
    aff: string | Buffer;
    dic: string | Buffer;
  }): Nspell;
  export default nspell;
}
