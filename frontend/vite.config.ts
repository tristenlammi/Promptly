import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
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
        orientation: "any",
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
          if (!id.includes("node_modules")) return undefined;
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
          if (id.includes("recharts") || id.includes("d3-")) {
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
