/**
 * Render the master Promptly SVG icon into every PNG size the PWA
 * install criteria + iOS home-screen need.
 *
 * Outputs (all into ``frontend/public/`` so Vite copies them into
 * ``dist/`` verbatim and they survive cache-busting):
 *
 *   pwa-192.png            — Chrome / Android (purpose: "any")
 *   pwa-512.png            — Chrome / Android (purpose: "any")
 *   pwa-maskable-512.png   — Chrome / Android (purpose: "maskable",
 *                            with a safe-zone of inset content)
 *   apple-touch-icon.png   — iOS home screen (180x180)
 *   favicon.png            — generic browser favicon (32x32)
 *
 * This runs as the ``prebuild`` npm script so a fresh ``vite build``
 * always picks up the latest icons. Idempotent — re-running just
 * overwrites the PNGs in place.
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const mainSvg = path.join(projectRoot, "public", "promptly-icon.svg");
const filesSvg = path.join(projectRoot, "public", "promptly-files-icon.svg");
const outDir = path.join(projectRoot, "public");

// Brand background — must match the SVG's solid fill so masked icons
// blend in seamlessly with the corner shaves Android applies.
const BRAND_BG = "#D97757";

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function renderAny(size, outName, sourceSvg) {
  const out = path.join(outDir, outName);
  const svg = await readFile(sourceSvg);
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "cover" })
    .png({ compressionLevel: 9 })
    .toFile(out);
  return out;
}

/**
 * Maskable icons need ~10% padding on all sides so the icon survives
 * Android's circular / squircle / teardrop mask without important
 * content getting clipped. We render the SVG into the inner safe-zone
 * and pad the outside with the brand background.
 */
async function renderMaskable(size, outName, sourceSvg) {
  const out = path.join(outDir, outName);
  const inner = Math.round(size * 0.78); // ~11% padding each side
  const pad = Math.round((size - inner) / 2);
  const svg = await readFile(sourceSvg);

  const innerBuffer = await sharp(svg, { density: 384 })
    .resize(inner, inner, { fit: "cover" })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: BRAND_BG,
    },
  })
    .composite([{ input: innerBuffer, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toFile(out);

  return out;
}

// Two app icon sets — the main "Promptly" chat app and the "Promptly
// Files" Drive PWA. Each installs independently on the user's home
// screen, so they need visually distinct tiles. The main mark is a
// serif "P"; the Files mark is a white folder glyph on the same
// brand background so the two feel like siblings.
const ICON_SETS = [
  {
    label: "main",
    sourceSvg: mainSvg,
    targets: [
      { kind: "any", size: 192, name: "pwa-192.png" },
      { kind: "any", size: 512, name: "pwa-512.png" },
      { kind: "any", size: 180, name: "apple-touch-icon.png" },
      { kind: "any", size: 32, name: "favicon.png" },
      { kind: "maskable", size: 512, name: "pwa-maskable-512.png" },
    ],
  },
  {
    label: "files",
    sourceSvg: filesSvg,
    targets: [
      { kind: "any", size: 192, name: "pwa-files-192.png" },
      { kind: "any", size: 512, name: "pwa-files-512.png" },
      { kind: "any", size: 180, name: "apple-touch-icon-files.png" },
      { kind: "maskable", size: 512, name: "pwa-files-maskable-512.png" },
    ],
  },
];

async function main() {
  for (const set of ICON_SETS) {
    if (!(await exists(set.sourceSvg))) {
      console.error(`[pwa-icons] Source SVG missing: ${set.sourceSvg}`);
      process.exit(1);
    }
    console.log(
      `[pwa-icons] generating ${set.label} set from`,
      path.relative(projectRoot, set.sourceSvg)
    );
    for (const t of set.targets) {
      const out =
        t.kind === "maskable"
          ? await renderMaskable(t.size, t.name, set.sourceSvg)
          : await renderAny(t.size, t.name, set.sourceSvg);
      const { size } = await stat(out);
      console.log(
        `[pwa-icons]   ${t.name.padEnd(32)} ${t.size}x${t.size}  (${(
          size / 1024
        ).toFixed(1)} KB)`
      );
    }
  }

  // Write a marker file so we can tell at a glance whether icons were
  // generated for the current build (handy when debugging caching).
  await writeFile(
    path.join(outDir, "pwa-icons.generated"),
    `${new Date().toISOString()}\n`
  );
  console.log("[pwa-icons] done.");
}

main().catch((err) => {
  console.error("[pwa-icons] FAILED:", err);
  process.exit(1);
});
