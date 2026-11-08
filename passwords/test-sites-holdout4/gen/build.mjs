// Writes fixtures/ and manifest.json from the modules in this folder.
//   node gen/build.mjs
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = join(ROOT, 'fixtures');
const MODULES = ['signin', 'multi', 'embedded', 'selfhosted', 'language', 'signup', 'chpw', 'otp', 'payment', 'negative'];

const defs = [];
for (const name of MODULES) defs.push(...(await import(`./${name}.mjs`)).default);

rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });

const manifest = defs.map((d) => {
  const write = (rel, text) => {
    const file = join(FIX, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write(`${d.id}.html`, d.html);
  for (const [rel, text] of Object.entries(d.files || {})) write(rel, text);
  const negative = d.category === 'negative';
  const entry = { id: d.id, category: d.category, description: d.description, path: `/fixtures/${d.id}.html` };
  if (d.host) entry.host = d.host;
  entry.negative = negative;
  entry.steps = d.steps;
  if (!negative) {
    const state = {};
    for (const s of d.steps) for (const e of s.expected) state[e.role] = e.role === 'otp-digit' ? 'otp' : e.role;
    entry.state = state;
  }
  return entry;
});

writeFileSync(join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`${manifest.length} fixtures written`);
