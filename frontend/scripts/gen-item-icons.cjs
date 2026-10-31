// Generates the home-screen icons for Item Store apps (each item file can be
// installed as its own app): public/item-icons/<kind>-{192,512,maskable-512,apple-180}.png
//
//   cd frontend && node scripts/gen-item-icons.cjs
//
// Needs Playwright from ../e2e (already installed for the e2e suite). Re-run it
// when an item kind is added or its icon changes (the table below
// mirrors each kind's SPEC: kind, lucide icon and colour).
const fs = require("fs");
const path = require("path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const lucide = require("lucide-react");
const { chromium } = require(path.join(__dirname, "../../e2e/node_modules/playwright"));

// Each app wears its own colour (its SPEC.color, as in the store); a kind
// without its own icon falls back to Promptly terracotta.
const TERRACOTTA = "#D97757";
const KINDS = [
  ["workout", "Dumbbell", "#E2725B"],
  ["health", "HeartPulse", "#D9506A"],
  ["meals", "Salad", "#4E9F5B"],
  ["mealplan", "CalendarDays", "#D9902F"],
  ["habits", "CircleCheckBig", "#7B6CD9"],
  ["budget", "Wallet", "#2F8F83"],
  ["contacts", "Contact", "#3B7DD8"],
  ["trip", "Plane", "#2C9CC8"],
  ["journal", "BookOpen", "#B5835A"],
  ["boardgames", "Dices", "#C2557A"],
  ["flashcards", "Layers", "#5B6DD9"],
  ["example", "ListChecks", "#4F8A8B"],
  ["item", "LayoutGrid", TERRACOTTA], // fallback for a kind without its own
];

function glyph(name, px) {
  const Icon = lucide[name];
  if (!Icon) throw new Error(`no lucide icon ${name}`);
  return renderToStaticMarkup(React.createElement(Icon, { size: px, color: "#ffffff", strokeWidth: 2 }));
}

// shape: "rounded" (any-purpose, transparent corners), "full" (maskable / apple: full bleed)
function html(name, color, size, shape, glyphRatio) {
  const g = Math.round(size * glyphRatio);
  const radius = shape === "rounded" ? Math.round(size * 0.22) : 0;
  return `<!doctype html><html><head><style>
    html,body{margin:0;background:transparent}
    .t{width:${size}px;height:${size}px;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;
       background:linear-gradient(160deg, color-mix(in srgb, ${color} 82%, white) 0%, ${color} 55%, color-mix(in srgb, ${color} 86%, black) 100%);}
    svg{filter:drop-shadow(0 ${Math.round(size * 0.012)}px ${Math.round(size * 0.02)}px rgba(0,0,0,.18))}
  </style></head><body><div class="t">${glyph(name, g)}</div></body></html>`;
}

(async () => {
  const out = path.join(__dirname, "../public/item-icons");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const variants = [
    ["192", 192, "rounded", 0.56],
    ["512", 512, "rounded", 0.56],
    ["maskable-512", 512, "full", 0.42],
    ["apple-180", 180, "full", 0.54],
  ];
  for (const [kind, icon, color] of KINDS) {
    for (const [suffix, size, shape, ratio] of variants) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(html(icon, color, size, shape, ratio));
      await page.locator(".t").screenshot({ path: path.join(out, `${kind}-${suffix}.png`), omitBackground: true });
    }
    console.log("icons:", kind);
  }
  await browser.close();
})();
