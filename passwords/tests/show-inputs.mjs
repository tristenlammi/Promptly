// Prints the inputs of fixtures, to see why one failed. node show-inputs.mjs id [id...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, process.env.PW_SITES ?? "../test-sites", "fixtures");
for (const id of process.argv.slice(2)) {
  const html = fs.readFileSync(path.join(dir, `${id}.html`), "utf8");
  console.log(`--- ${id}`);
  const body = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, (s) => (s.includes("<input") ? s : ""));
  const parts = body.match(/<(h[1-3]|label|legend|button|input|select|textarea|form|footer|\/footer|\/form)\b[^>]*>([^<]{0,50})/g) ?? [];
  for (const p of parts) console.log(p.replace(/\s+/g, " ").slice(0, 170));
}
