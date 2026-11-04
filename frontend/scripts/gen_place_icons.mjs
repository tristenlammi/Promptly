// Writes src/maps/placeIcons.ts: the icons you can pick for a saved place, as
// plain SVG (a map marker isn't a React component). Run after changing the list:
//   node scripts/gen_place_icons.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ALIAS = { home: "house" };

const ICONS = [
  ["bookmark", "Saved"], ["star", "Star"], ["heart", "Heart"], ["users", "Family and friends"],
  ["coffee", "Cafe"], ["utensils", "Food"], ["beer", "Pub"], ["shopping-cart", "Shops"],
  ["fuel", "Fuel"], ["car", "Car"], ["wrench", "Mechanic"], ["dumbbell", "Gym"],
  ["graduation-cap", "School"], ["stethoscope", "Doctor"], ["baby", "Kids"], ["dog", "Dog"],
  ["trees", "Park"], ["tent", "Camping"], ["waves", "Beach"], ["plane", "Travel"],
  // Not offered in the picker: Home, Work and lists have their own.
  ["home", "Home"], ["briefcase", "Work"], ["list", "List"],
];

const out = {};
for (const [id] of ICONS) {
  const at = (name) => {
    const dir = "node_modules/lucide-react/dist/esm/icons";
    const text = existsSync(`${dir}/${name}.js`) ? readFileSync(`${dir}/${name}.js`, "utf8") : "";
    // Some names are only aliases of another icon's file.
    const alias = text.match(/from '\.\/([\w-]+)\.js'/);
    return alias && !text.includes("createLucideIcon(") ? at(alias[1]) : text;
  };
  const source = at(ALIAS[id] ?? id);
  const nodes = source.match(/createLucideIcon\("\w+", (\[[\s\S]*\])\);/)?.[1];
  if (!nodes) throw new Error(`No icon data for ${id}`);
  // eslint-disable-next-line no-new-func -- our own dependency's icon data, at dev time
  const parts = new Function(`return ${nodes}`)();
  out[id] = parts
    .map(([tag, { key: _key, ...attrs }]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`)
    .join("");
}

const text = `// Written by scripts/gen_place_icons.mjs (lucide icons, ISC licence).
export const PLACE_ICON_SVG: Record<string, string> = ${JSON.stringify(out, null, 2)};

/** What you can pick from when saving a place. */
export const PLACE_ICONS: { id: string; label: string }[] = ${JSON.stringify(ICONS.slice(0, 20).map(([id, label]) => ({ id, label })), null, 2)};

export const PLACE_COLOURS = ["#D97757", "#D9982B", "#2F9E6E", "#1E9AA8", "#4F7FE0", "#7C5CCB", "#C2557A", "#5B6B7F"];
`;
writeFileSync("src/maps/placeIcons.ts", text);
console.log(Object.keys(out).length, "icons");
