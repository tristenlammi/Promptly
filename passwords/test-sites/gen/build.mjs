// Regenerates fixtures/ and manifest.json. Run: node gen/build.mjs
// Each category module calls fx() with a definition; `pages` are extra documents a
// fixture needs (iframe contents under _frames/, next pages of a real navigation
// flow under _steps/). Those are not fixtures of their own and have no manifest entry.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, chromeDecoys, registry } from './kit.mjs';

import './signin.mjs';
import './stepped.mjs';
import './modal.mjs';
import './shadow.mjs';
import './iframe.mjs';
import './framework.mjs';
import './otp.mjs';
import './account.mjs';
import './honeypot.mjs';
import './language.mjs';
import './late.mjs';
import './payment.mjs';
import './negative.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'fixtures');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const emit = (rel, html) => {
  const file = join(out, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
};

const manifest = [];
for (const d of registry) {
  const decoys = d.noDecoys ? [] : chromeDecoys(d);
  emit(`${d.id}.html`, assemble(d));
  for (const page of d.pages || []) {
    emit(page.path, page.raw ?? assemble({ brand: d.brand, theme: d.theme, header: d.header, footer: d.footer, lang: d.lang, dir: d.dir, ...page }));
  }

  const steps = d.steps.map((s) => {
    const honeypots = [...(s.honeypots || []), ...(s.noChromeDecoys ? [] : decoys)];
    const step = { kind: s.kind };
    if (s.wait) step.wait = s.wait;
    step.expected = (s.expected || []).map((e) => ({ selector: e.selector, role: e.role, frame: e.frame ?? null }));
    if (honeypots.length) step.honeypots = [...new Set(honeypots)];
    if (s.advance) step.advance = s.advance;
    return step;
  });

  const entry = {
    id: d.id,
    category: d.category,
    description: d.description,
    path: `/fixtures/${d.id}.html`,
  };
  if (d.host) entry.host = d.host;
  entry.negative = !!d.negative;
  entry.steps = steps;
  if (!d.negative) {
    const state = {};
    for (const s of steps) {
      for (const e of s.expected) {
        const key = e.role === 'otp-digit' ? 'otp' : e.role;
        state[key] = key;
      }
    }
    entry.state = state;
  }
  manifest.push(entry);
}

writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.length} fixtures`);
