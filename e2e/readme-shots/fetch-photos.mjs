// Free-to-reuse photographs for the Photos screenshots, from Wikimedia
// Commons' public API. Only files Commons marks CC0 or public domain are
// taken. They go, already resized to 1600 px wide, into the gitignored
// e2e/readme-shots/photos/ with SOURCES.txt beside them (file, page,
// licence). The photographs themselves are never committed: only the
// screenshots made from them.
//
//   node readme-shots/fetch-photos.mjs find "wombat" "campsite lake"   # candidates → photos/_find.html
//   node readme-shots/fetch-photos.mjs get                              # download PICKS
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "photos");
const API = "https://commons.wikimedia.org/w/api.php";
const UA = { "User-Agent": "readme-screenshot-photos/1.0 (one-off fetch of CC0 images)" };
const FREE = /^(cc0|cc0 1\.0|public domain|pdm|no restrictions)$/i;
fs.mkdirSync(OUT, { recursive: true });

// title on Commons → [date taken (for the timeline), album]
import { PICKS } from "./photo-picks.mjs";

async function info(params) {
  const url = `${API}?${new URLSearchParams({ action: "query", format: "json", prop: "imageinfo", iiprop: "url|extmetadata|size|mime", iiurlwidth: "1600", ...params })}`;
  let r = await fetch(url, { headers: UA });
  for (let wait = 5; r.status === 429 && wait <= 40; wait *= 2) {
    await new Promise((done) => setTimeout(done, wait * 1000)); // asked to slow down
    r = await fetch(url, { headers: UA });
  }
  if (!r.ok) throw new Error(`commons: ${r.status}`);
  await new Promise((done) => setTimeout(done, 1500));
  return Object.values((await r.json()).query?.pages ?? {});
}

const licence = (page) => page.imageinfo?.[0]?.extmetadata?.LicenseShortName?.value ?? "";

async function find(queries) {
  let html = "<body style='font:12px sans-serif'>";
  for (const q of queries) {
    const pages = await info({ generator: "search", gsrsearch: `${q} haslicense:unrestricted filetype:bitmap filemime:jpeg`, gsrnamespace: "6", gsrlimit: "24" });
    html += `<h3>${q}</h3><div style="display:flex;flex-wrap:wrap;gap:6px">`;
    for (const page of pages.sort((a, b) => a.index - b.index)) {
      const ii = page.imageinfo?.[0];
      if (!ii || ii.width < 1500 || !FREE.test(licence(page))) continue;
      const thumb = ii.thumburl.replace(/\/\d+px-/, "/330px-");
      html += `<figure style="margin:0;width:200px"><img src="${thumb}" style="width:200px;height:140px;object-fit:cover"><figcaption>${page.title.replace(/^File:/, "")}</figcaption></figure>`;
      console.log(`${q}\t${page.title}\t${licence(page)}\t${ii.width}x${ii.height}`);
    }
    html += "</div>";
  }
  fs.writeFileSync(path.join(OUT, "_find.html"), html);
}

async function get() {
  const lines = ["# Photographs used for the README's Photos screenshots.", "# All from Wikimedia Commons, marked CC0 or public domain there. Not committed.", ""];
  const manifest = [];
  const titles = Object.keys(PICKS);
  for (let i = 0; i < titles.length; i += 20) {
    for (const page of await info({ titles: titles.slice(i, i + 20).join("|") })) {
      const ii = page.imageinfo?.[0];
      const lic = licence(page);
      if (!ii || !FREE.test(lic)) {
        console.error(`skipped (licence "${lic}"): ${page.title}`);
        continue;
      }
      const [taken, album] = PICKS[page.title] ?? [];
      const name = `${String(manifest.length + 1).padStart(2, "0")}-${page.title.replace(/^File:/, "").replace(/[^A-Za-z0-9.]+/g, "_").slice(0, 60)}`.replace(/\.(jpe?g|JPE?G)$/, "") + ".jpg";
      const file = path.join(OUT, name);
      if (!fs.existsSync(file)) {
        const r = await fetch(ii.thumburl, { headers: UA });
        if (!r.ok) {
          console.error(`failed ${r.status}: ${page.title}`);
          continue;
        }
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        await new Promise((done) => setTimeout(done, 400));
      }
      manifest.push({ file: name, taken, album, title: page.title });
      lines.push(`${name}\t${ii.descriptionurl}\t${lic}`);
      console.log("got", name);
    }
  }
  fs.writeFileSync(path.join(OUT, "SOURCES.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "find") await find(rest);
else if (mode === "get") await get();
else console.log("find <queries…> | get");
