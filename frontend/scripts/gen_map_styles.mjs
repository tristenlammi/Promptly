// Writes the two map styles (light and dark) that the web map and the phone's
// driving screen share. Run after bumping @protomaps/basemaps:
//   node scripts/gen_map_styles.mjs
// Fonts and sprites live beside them in public/map-assets; see its README.txt.
import { writeFileSync } from "node:fs";
import { layers, namedFlavor } from "@protomaps/basemaps";

for (const flavor of ["light", "dark"]) {
  const style = {
    version: 8,
    // __ORIGIN__ and __BASEMAP__ are filled in where the style is loaded: a
    // map needs full URLs, and the map's link is signed per person.
    glyphs: "__ORIGIN__/map-assets/fonts/{fontstack}/{range}.pbf",
    sprite: `__ORIGIN__/map-assets/sprites/${flavor}`,
    sources: {
      protomaps: {
        type: "vector",
        url: "pmtiles://__BASEMAP__",
        attribution: "© OpenStreetMap contributors · Protomaps",
      },
    },
    layers: layers("protomaps", namedFlavor(flavor), { lang: "en" }),
  };
  writeFileSync(`public/map-assets/style-${flavor}.json`, JSON.stringify(style));
  console.log(flavor, style.layers.length, "layers");
}
