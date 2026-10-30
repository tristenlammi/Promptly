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

/**
 * Expose React's UMD builds as virtual modules so the React artifact preview
 * can inject a runtime into its sandboxed iframe.
 *
 * The iframe is ``sandbox="allow-scripts"`` with no ``allow-same-origin``, so
 * it can't fetch anything from us — the runtime has to be inlined into the
 * document. A CDN is not an option either: the app ships a strict CSP that
 * blocks external hosts, and a self-hosted install has to work with no
 * internet at all.
 *
 * A plain ``import "react/umd/react.production.min.js?raw"`` fails: React 18's
 * ``exports`` map doesn't publish ``./umd/*``, so the bare specifier is
 * unresolvable. Reading the file off disk at build time sidesteps that,
 * exactly as ``hunspellDictionaries`` above does for the dictionary data.
 */
function reactUmdRuntime(): Plugin {
  const PREFIX = "virtual:react-umd/";
  const RESOLVED = "\0" + PREFIX;
  const require = createRequire(path.resolve(__dirname, "package.json"));
  const FILES: Record<string, [string, string]> = {
    react: ["react", "umd/react.production.min.js"],
    "react-dom": ["react-dom", "umd/react-dom.production.min.js"],
  };
  return {
    name: "promptly-react-umd-runtime",
    resolveId(id) {
      return id.startsWith(PREFIX) ? "\0" + id : null;
    },
    load(id) {
      if (!id.startsWith(RESOLVED)) return null;
      const key = id.slice(RESOLVED.length);
      const entry = FILES[key];
      if (!entry) return null;
      const [pkg, rel] = entry;
      // ``require.resolve`` respects the exports map for the package root,
      // which resolves fine — it's only the ``./umd/*` subpath that isn't
      // published. Take the directory and read the file directly.
      const dir = path.dirname(require.resolve(pkg));
      const code = fs.readFileSync(path.join(dir, rel), "utf8");
      return `export default ${JSON.stringify(code)};`;
    },
  };
}

// Single source of truth for the in-app version indicator. Read from
// package.json at build time and injected via ``define`` below as the
// ``__APP_VERSION__`` global (see ``src/vite-env.d.ts``). The repo-root
// ``VERSION`` file mirrors this value; ``scripts/release.*`` keeps the two
// in lockstep when cutting a release.
const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
) as { version: string };

/**
 * Emits ``/version.json`` next to the bundle. Open tabs poll it and offer a
 * reload when it no longer matches the version they were built as — after
 * an update they otherwise kept running the old code against the new API
 * (R-247). Not precached by the service worker (json isn't in its glob)
 * and served no-store by nginx.
 */
/**
 * pdf.js's data files (WP-6.5): Adobe CMaps (CJK and other non-embedded
 * encodings), the standard 14 fonts (form fields drawn with Helvetica and
 * friends), its image-decoder wasm and ICC profiles. Served at ``/pdfjs/…``
 * — copied into the build, read from node_modules in dev. Only fetched when
 * a PDF needs them, so they stay out of the service-worker precache.
 */
function pdfjsAssets(): Plugin {
  const root = path.resolve(__dirname, "node_modules/pdfjs-dist");
  const dirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
  return {
    name: "promptly-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url || "").split("?")[0]).replace(/^\/+/, "");
        const [dir] = rel.split("/");
        const file = path.resolve(root, rel);
        if (!dirs.includes(dir) || !file.startsWith(root + path.sep) || !fs.existsSync(file)) return next();
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        const base = path.join(root, dir);
        if (!fs.existsSync(base)) continue;
        for (const name of fs.readdirSync(base)) {
          const file = path.join(base, name);
          if (!fs.statSync(file).isFile()) continue;
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: fs.readFileSync(file) });
        }
      }
    },
  };
}

function versionManifest(): Plugin {
  return {
    name: "promptly-version-json",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ version: pkg.version }),
      });
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    versionManifest(),
    pdfjsAssets(),
    hunspellDictionaries(),
    reactUmdRuntime(),
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
          // The PromptlySync APK (several MB): only for whoever installs it.
          "**/downloads/**",
          "**/excalidraw-assets/**",
          "**/excalidraw-*.js",
          // The Photos map (~1 MB) and its offline country outlines: only for
          // whoever opens the map.
          "**/maplibre-gl-*.js",
          "**/maplibre-gl-*.css",
          "**/maps/**",
          // Spell-check dictionaries: large (up to ~5.5 MB for pt) and only
          // loaded when the user turns spell-check on for a language. Keep them
          // out of the precache so first install stays lean (same rationale as
          // Excalidraw). The emitted chunks are named after the virtual module's
          // last segment — ``virtual:hunspell/dictionary-en`` → ``dictionary-en-*.js``
          // — so the ignore must match ``dictionary-*``, not ``hunspell-*``.
          "**/dictionary-*.js",
          // Photos (WP-9.2): its own small chunk, fetched when someone opens it.
          "**/PhotosPage-*.js",
          "**/PhotoAlbumsPage-*.js",
          "**/ImportPage-*.js",
          // Word in and out (WP-4.3): mammoth (~1.2 MB), the .docx writer,
          // docx-preview and the zip reader they share — only fetched when
          // someone converts, exports or previews a Word file.
          "**/word-import-*.js",
          "**/word-export-*.js",
          "**/word-preview-*.js",
          "**/jszip-*.js",
          // React artifact preview: ~350 KB, almost all of it React's UMD
          // runtime inlined as text for the sandboxed iframe. Only needed
          // when someone opens a jsx/tsx artifact, so same rationale again.
          "**/ReactPreview-*.js",
          // pdf.js: the library chunk plus its worker asset (~1.4 MB
          // together), fetched only when someone opens a PDF preview.
          // The worker is emitted as a .mjs asset, which the default
          // glob would otherwise sweep into the precache.
          "**/pdfjs-*.js",
          "**/pdf.worker*.mjs",
          // pdf.js data files (CMaps, standard fonts, wasm) — WP-6.5.
          "**/pdfjs/**",
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
  // Workers bundled by Vite (``?worker&url``) are ES modules — the Photos map's
  // MapLibre worker is started with ``type: "module"``.
  worker: { format: "es" },
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
          // Vite's ~1 kB dynamic-import helper. Its module id is the
          // virtual ``\0vite/preload-helper``, which contains no
          // ``node_modules`` — so this MUST sit above the guard below or
          // it never matches. Left unassigned, Rollup buries it in
          // whichever chunk needs it first (excalidraw), which forces the
          // entry to statically import that 4.6 MB chunk just to reach it.
          if (id.includes("vite/preload-helper")) {
            return "vite-preload";
          }
          // Rollup's CommonJS interop helpers (``\0commonjsHelpers.js``) —
          // same story: no ``node_modules`` in the id, so left alone they
          // landed in the tiptap chunk once TipTap v3 brought CJS deps, and
          // react → tiptap → state → react became a cycle that crashed the
          // app on load ("reading 'createContext'"). They have no imports
          // of their own, so they sit with the preload helper.
          if (id.includes("commonjsHelpers")) {
            return "vite-preload";
          }
          if (!id.includes("node_modules")) return undefined;
          // DOMPurify is imported eagerly by the chat markdown renderer AND
          // by Excalidraw. Matching no rule here, it was left unassigned —
          // which lets Rollup place the shared module wherever it likes, and
          // it chose to bury it inside the excalidraw chunk. The entry then
          // had to *statically* import 4.6 MB of whiteboard editor purely to
          // sanitize a message:
          //
          //   import { x as purify, ah as __vitePreload } from "./excalidraw-…"
          //
          // That static edge is also what put excalidraw (and fortunesheet,
          // and reactflow behind it) into index.html's modulepreload list on
          // every page load — ~7.4 MB fetched to open a chat.
          //
          // Pinning it to its own 23 kB chunk keeps the heavy editors
          // genuinely dynamic. There is only one copy in node_modules; this
          // is about *placement*, not deduplication.
          if (id.includes("dompurify")) {
            return "sanitize";
          }
          // The whiteboard editor is large and only loaded on the
          // (lazily mounted) workspace canvas — keep it out of the main
          // chunk. ``roughjs`` is its hand-drawn renderer.
          // Word import / export / preview (WP-4.3) — lazy, and kept out of
          // the precache by name (see globIgnores).
          if (
            /\/(mammoth|@xmldom|lop|underscore|bluebird|dingbat-to-unicode|option)\//.test(id)
          ) {
            return "word-import";
          }
          if (id.includes("/docx-preview/")) return "word-preview";
          if (id.includes("/docx/")) return "word-export";
          if (id.includes("/jszip/") || id.includes("/pako/")) return "jszip";
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
          // pdf.js renders the Drive PDF preview. Lazy-loaded with the
          // preview component, so keep it out of whatever chunk happens
          // to import it first.
          // The full viewer (WP-6.5) reads ``globalThis.pdfjsLib`` when it
          // runs, so it can't share the library's chunk — every module in a
          // chunk runs when the chunk loads, possibly before pdf.js itself.
          if (id.includes("pdfjs-dist/web/")) {
            return "pdfjs-viewer";
          }
          if (id.includes("pdfjs-dist")) {
            return "pdfjs";
          }
          // Libraries the editor shares with code every page loads. Left
          // unassigned, Rollup parked them in the tiptap chunk, and the
          // entry imported all ~230 KB gz of the editor to reach them.
          if (id.includes("/entities/")) return "markdown";
          if (id.includes("/yjs/") || id.includes("/lib0/") || id.includes("/y-protocols/")) {
            return "yjs";
          }
          if (
            id.includes("@tiptap") ||
            id.includes("prosemirror") ||
            id.includes("tiptap-markdown") ||
            id.includes("/markdown-it/") ||
            id.includes("/linkify") ||
            id.includes("/mdurl/") ||
            id.includes("/uc.micro/") ||
            id.includes("/punycode") ||
            id.includes("tippy.js") ||
            id.includes("@popperjs") ||
            // TipTap v3's menus position with Floating UI.
            id.includes("@floating-ui") ||
            id.includes("orderedmap") ||
            id.includes("rope-sequence")
          ) {
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
          // ``clsx`` (behind every ``cn()`` call) and tailwind-merge. Left
          // unassigned, Rollup put clsx inside the *charts* chunk (recharts
          // uses it too), so the entry statically imported all of recharts
          // — 112 KB gz — on every page load just to join class names.
          if (
            id.includes("/clsx/") ||
            id.includes("tailwind-merge") ||
            // Also used by code every page loads; was parked in tiptap.
            id.includes("w3c-keyname")
          ) {
            return "classnames";
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
            // React's own store hook (zustand, react-query and TipTap v3's
            // React bindings all use it) belongs with React.
            id.includes("use-sync-external-store") ||
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
