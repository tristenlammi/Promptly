// Generates the home-screen icons for the standalone Promptly Photos app
// (/photos, public/photos.webmanifest):
//   public/pwa-photos-{192,512,maskable-512}.png + public/apple-touch-icon-photos.png
//
//   cd frontend && node scripts/gen-photos-icons.cjs
//
// Same look as the Item Store app icons (scripts/gen-item-icons.cjs): a
// terracotta tile with a white lucide glyph. Needs Playwright from ../e2e.
const path = require("path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const lucide = require("lucide-react");
const { chromium } = require(path.join(__dirname, "../../e2e/node_modules/playwright"));

const TERRACOTTA = "#D97757";
const GLYPH = "Images";

function glyph(px) {
  return renderToStaticMarkup(React.createElement(lucide[GLYPH], { size: px, color: "#ffffff", strokeWidth: 2 }));
}

// shape: "rounded" (any-purpose, transparent corners), "full" (maskable / apple: full bleed)
function html(size, shape, glyphRatio) {
  const g = Math.round(size * glyphRatio);
  const radius = shape === "rounded" ? Math.round(size * 0.22) : 0;
  return `<!doctype html><html><head><style>
    html,body{margin:0;background:transparent}
    .t{width:${size}px;height:${size}px;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;
       background:linear-gradient(160deg, color-mix(in srgb, ${TERRACOTTA} 82%, white) 0%, ${TERRACOTTA} 55%, color-mix(in srgb, ${TERRACOTTA} 86%, black) 100%);}
    svg{filter:drop-shadow(0 ${Math.round(size * 0.012)}px ${Math.round(size * 0.02)}px rgba(0,0,0,.18))}
  </style></head><body><div class="t">${glyph(g)}</div></body></html>`;
}

(async () => {
  const out = path.join(__dirname, "../public");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const variants = [
    ["pwa-photos-192.png", 192, "rounded", 0.56],
    ["pwa-photos-512.png", 512, "rounded", 0.56],
    ["pwa-photos-maskable-512.png", 512, "full", 0.42],
    ["apple-touch-icon-photos.png", 180, "full", 0.54],
  ];
  for (const [file, size, shape, ratio] of variants) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(html(size, shape, ratio));
    await page.locator(".t").screenshot({ path: path.join(out, file), omitBackground: true });
    console.log("icon:", file);
  }
  await browser.close();
})();
