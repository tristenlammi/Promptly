import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

/**
 * Bundle Hunspell spell-check dictionaries (``dictionary-*`` packages) as
 * code-split virtual modules.
 *
 * The ``dictionary-*`` v4 packages are Node-only (their ``index.js`` reads
 * the ``.aff``/``.dic`` files via ``node:fs``) and lock down subpath access
 * with an ``exports`` map, so we can neither import them at runtime in the
 * browser nor ``?raw``-import their data files directly. Instead this plugin
 * reads each dictionary's ``.aff``/``.dic`` off disk at build time and emits
 * them as a tiny ES module (``export const aff``/``dic``). Because the
 * consumer imports them dynamically (``import("virtual:hunspell/…")``),
 * Rollup gives each language its own async chunk — so the ~0.5–4 MB of
 * dictionary text only loads when a user actually turns spell-check on for
 * that language, and never touches the main bundle. All data is inlined, so
 * there's no runtime ``fetch`` (keeps us clean under the strict CSP).
 */
function hunspellDictionaries(): Plugin {
  const PREFIX = "virtual:hunspell/";
  const RESOLVED = "\0" + PREFIX;
  const require = createRequire(path.resolve(__dirname, "package.json"));
  return {
    name: "promptly-hunspell-dictionaries",
    resolveId(id) {
      return id.startsWith(PREFIX) ? "\0" + id : null;
    },
    load(id) {
      if (!id.startsWith(RESOLVED)) return null;
      const pkg = id.slice(RESOLVED.length); // e.g. "dictionary-en"
      const dir = path.dirname(require.resolve(pkg)); // …/dictionary-en
      const aff = fs.readFileSync(path.join(dir, "index.aff"), "utf8");
      const dic = fs.readFileSync(path.join(dir, "index.dic"), "utf8");
      return `export const aff = ${JSON.stringify(aff)};\nexport const dic = ${JSON.stringify(dic)};`;
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    hunspellDictionaries(),
    VitePWA({
      // We need a handwritten service worker for the Web Push hooks
      // (``push`` + ``notificationclick`` events) — Workbox's
      // generateSW mode doesn't expose those, so we switch to
      // ``injectManifest`` and provide ``src/sw.ts`` ourselves. The
      // precache manifest is still injected automatically so the
      // offline-shell behaviour is preserved.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: "auto",

      // The ``public/`` PNGs are produced by ``scripts/generate-pwa-icons.mjs``
      // (wired as the ``prebuild`` npm script) so they're always present
      // in ``dist/`` when this manifest is written.
      includeAssets: [
        "favicon.png",
        "apple-touch-icon.png",
        "promptly-icon.svg",
      ],

      manifest: {
        name: "Promptly",
        short_name: "Promptly",
        description:
          "Self-hosted multi-user AI chat with study mode, file attachments, and web search.",
        // ``id`` lets Chrome treat this as a single installable app
        // even if start_url ever changes.
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        // Portrait-only. Chat UX doesn't benefit from landscape on a
        // phone (message column goes too wide, input bar loses vertical
        // breathing room) and the flip between orientations is jarring
        // mid-conversation. ``portrait-primary`` would pin to a single
        // rotation; we use the plain ``portrait`` family so tablets can
        // still flip 180° without unmounting. Installed PWAs on Android
        // honour this immediately; iOS respects it on home-screen
        // installs. Regular (non-installed) browser tabs are a runtime
        // lock via ``screen.orientation.lock('portrait')`` — see
        // ``App.tsx``.
        orientation: "portrait",
        background_color: "#FAF9F7",
        theme_color: "#D97757",
        lang: "en",
        dir: "ltr",
        categories: ["productivity", "utilities"],
        icons: [
          {
            src: "/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },

      // ``injectManifest`` mode: the plugin bakes the precache
      // manifest into ``src/sw.ts`` and leaves the runtime behaviour
      // (caching strategies, navigate fallback, push handling) to
      // our code. The patterns below just govern what ends up in the
      // precache list the SW consumes via ``self.__WB_MANIFEST``.
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // Keep Excalidraw out of the SW precache: the lazy editor chunk
        // (~4.5 MB) and its self-hosted fonts/locales are only needed when
        // a canvas is opened (which requires the network for collab
        // anyway), so precaching them would bloat first install and negate
        // the lazy-load. They're fetched on demand instead.
        globIgnores: [
          "**/excalidraw-assets/**",
          "**/excalidraw-*.js",
          // Spell-check dictionaries: large (up to ~5.5 MB for pt) and only
          // loaded when the user turns spell-check on for a language. Keep them
          // out of the precache so first install stays lean (same rationale as
          // Excalidraw). The emitted chunks are named after the virtual module's
          // last segment — ``virtual:hunspell/dictionary-en`` → ``dictionary-en-*.js``
          // — so the ignore must match ``dictionary-*``, not ``hunspell-*``.
          "**/dictionary-*.js",
        ],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },

      devOptions: {
        // Lets us validate the manifest + SW from `npm run dev` without
        // shipping a SW to production-only environments.
        enabled: false,
        type: "module",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Bumped from Vite's default 500 KB so the chart / editor chunks
    // below don't trip the warning. They're intentionally large; the
    // point of the chunking is so non-users of those features never
    // download them.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Hand-rolled chunk groups. We split by feature surface so
        // admin-only pages (charts) stay out of the regular user's
        // main chunk.
        //
        // The function form is preferred over the object form because
        // it lets us match by substring across both flat and nested
        // dependency paths (Vite hands us absolute module IDs).
        manualChunks(id: string): string | undefined {
          // Hunspell dictionary virtual modules (see hunspellDictionaries).
          // Name each after the virtual module's last segment
          // (``virtual:hunspell/dictionary-en`` → ``dictionary-en-*.js``) so the
          // SW precache can glob-exclude them via ``**/dictionary-*.js`` — they're
          // 0.5–5.5 MB and only fetched on demand when a user turns spell-check
          // on. Checked BEFORE the node_modules guard since virtual ids aren't
          // under node_modules.
          if (id.includes("virtual:hunspell/")) {
            return id.split("/").pop();
          }
          if (!id.includes("node_modules")) return undefined;
          // The whiteboard editor is large and only loaded on the
          // (lazily mounted) workspace canvas — keep it out of the main
          // chunk. ``roughjs`` is its hand-drawn renderer.
          if (id.includes("@excalidraw") || id.includes("roughjs")) {
            return "excalidraw";
          }
          // Fortune-sheet (spreadsheet page) is large and lazy-loaded. Must
          // come BEFORE the react rule below, whose ``react/`` substring
          // match would otherwise pull ``@fortune-sheet/react`` into the
          // eager react vendor chunk.
          if (id.includes("@fortune-sheet")) {
            return "fortunesheet";
          }
          // React Flow (node-graph editor) is lazy-loaded on the Tasks flow
          // view only. Must come BEFORE the react rule below — its
          // ``@xyflow/react`` path contains the ``react/`` substring that
          // would otherwise pull this ~300 kB dep into the eager react vendor
          // chunk. d3 is left unassigned (see charts rule) so Vite can hoist
          // the low-level modules React Flow and recharts share into a common
          // async chunk instead of creating a reactflow↔charts cycle.
          if (id.includes("@xyflow")) {
            return "reactflow";
          }
          if (id.includes("@tiptap") || id.includes("prosemirror")) {
            return "tiptap";
          }
          if (
            id.includes("react-markdown") ||
            id.includes("rehype") ||
            id.includes("remark") ||
            id.includes("micromark") ||
            id.includes("mdast") ||
            id.includes("hast") ||
            id.includes("unified") ||
            id.includes("unist")
          ) {
            return "markdown";
          }
          if (
            id.includes("highlight.js") ||
            id.includes("rehype-highlight")
          ) {
            return "highlight";
          }
          // recharts only. d3-* is deliberately left unassigned so Vite
          // auto-hoists the modules shared with React Flow (d3-color,
          // d3-interpolate, …) into a common async chunk — assigning them
          // here would create a reactflow↔charts circular chunk.
          if (id.includes("recharts")) {
            return "charts";
          }
          if (id.includes("lucide-react")) return "icons";
          if (
            id.includes("@tanstack/react-query") ||
            id.includes("zustand")
          ) {
            return "state";
          }
          if (
            id.includes("react-router") ||
            id.includes("react-dom") ||
            id.includes("react/") ||
            id.includes("/react@") ||
            id.includes("scheduler")
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 80,
    strictPort: true,
    // Vite HMR needs the websocket URL to resolve through the reverse proxy.
    hmr: {
      clientPort: 80,
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 80,
  },
});
