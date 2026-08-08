/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * App version, injected at build time from ``package.json`` by the
 * ``define`` block in ``vite.config.ts``. Drives the sidebar version tag.
 */
declare const __APP_VERSION__: string;
