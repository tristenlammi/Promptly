/**
 * Self-host Excalidraw's runtime-fetched assets (fonts + locales).
 *
 * Excalidraw bundles its JS through Vite, but it loads its woff2 fonts
 * (and non-English locale JSON) at runtime from
 * ``window.EXCALIDRAW_ASSET_PATH``, defaulting to a public CDN. Promptly's
 * CSP is ``font-src/connect-src 'self'``, so a CDN fetch would be blocked
 * and the canvas would render with broken fonts. We therefore copy the
 * assets into ``public/excalidraw-assets/`` (Vite copies ``public/`` into
 * ``dist/`` verbatim) and point ``EXCALIDRAW_ASSET_PATH`` at them in
 * ``main.tsx`` so everything is served same-origin.
 *
 * Runs as part of the ``prebuild`` npm script alongside the PWA icons.
 * Idempotent — re-running overwrites in place. Kept out of the SW
 * precache via ``globIgnores`` in ``vite.config.ts`` so the (large, CJK-
 * inclusive) font set is fetched lazily on demand rather than precached.
 */
import { cp, stat, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

const pkgDist = path.join(
  projectRoot,
  "node_modules",
  "@excalidraw",
  "excalidraw",
  "dist",
  "prod"
);
const outDir = path.join(projectRoot, "public", "excalidraw-assets");

// The two subtrees Excalidraw resolves against EXCALIDRAW_ASSET_PATH at
// runtime: ``fonts/<Family>/*.woff2`` and ``locales/*.json``.
const SUBDIRS = ["fonts", "locales"];

// Font families to drop. Xiaolai is a ~13 MB CJK (Chinese) handwriting
// face — 95% of the whole asset payload — and Promptly is English-first.
// Excluding it means CJK glyphs on a board fall back to a system font
// (a same-origin 404, no CSP error), which is an acceptable trade for a
// ~25x smaller asset bundle. Add it back here if CJK support is needed.
const EXCLUDE_FONTS = ["Xiaolai"];

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(pkgDist))) {
    console.error(
      `[excalidraw-assets] package dist missing: ${pkgDist}\n` +
        "  (is @excalidraw/excalidraw installed?)"
    );
    process.exit(1);
  }

  // Wipe + recopy so a version bump never leaves stale hashed font files.
  await rm(outDir, { recursive: true, force: true });

  for (const sub of SUBDIRS) {
    const src = path.join(pkgDist, sub);
    if (!(await exists(src))) {
      console.warn(`[excalidraw-assets] skip missing ${sub}/`);
      continue;
    }
    const dest = path.join(outDir, sub);
    await cp(src, dest, { recursive: true });
    console.log(
      `[excalidraw-assets] copied ${sub}/ -> ` +
        path.relative(projectRoot, dest)
    );
  }

  // Prune excluded font families after the bulk copy.
  for (const family of EXCLUDE_FONTS) {
    const dir = path.join(outDir, "fonts", family);
    if (await exists(dir)) {
      await rm(dir, { recursive: true, force: true });
      console.log(`[excalidraw-assets] pruned fonts/${family}/`);
    }
  }
  console.log("[excalidraw-assets] done.");
}

main().catch((err) => {
  console.error("[excalidraw-assets] FAILED:", err);
  process.exit(1);
});
