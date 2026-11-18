// Names the specs use that have no types of their own here.

// The extension's API, as seen from inside its pages (page.evaluate bodies).
declare const chrome: any;

// Used by the Firefox extension suite; it ships no types.
declare module "selenium-webdriver";
declare module "selenium-webdriver/firefox.js";

// What the frontend's own build defines.
interface ImportMetaEnv { readonly [key: string]: any }
interface ImportMeta { readonly env: ImportMetaEnv }
