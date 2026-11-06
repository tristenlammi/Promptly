// Static check of manifest.json against fixtures/. No browser. Exits 1 on any problem.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const problems = [];
const bad = (id, msg) => problems.push(`${id}: ${msg}`);

const ROLES = new Set(['username', 'email', 'password', 'new-password', 'confirm-password', 'current-password', 'otp', 'otp-digit',
  'card-number', 'card-name', 'card-exp', 'card-exp-month', 'card-exp-year', 'card-cvv',
  'first-name', 'last-name', 'full-name', 'address1', 'address2', 'city', 'state', 'postcode', 'country', 'phone', 'company']);
const KINDS = new Set(['signin', 'email-first', 'password-next', 'signup', 'change-password', 'otp', 'card', 'identity', 'search', 'newsletter', 'none']);
const WANT = { signin: 10, 'multi-step': 6, otp: 6, signup: 5, 'change-password': 5, modal: 2, shadow: 2, iframe: 3, language: 5, card: 2, identity: 2, negative: 12 };
const REAL_BRANDS = /\b(google|facebook|amazon|microsoft|apple|paypal|netflix|github|stripe|shopify|okta|slack)\b/i;

const isSelector = (s) => typeof s === 'string' ? s.length > 0 : Array.isArray(s) && s.length > 1 && s.every((x) => typeof x === 'string' && x);

const ids = new Set();
const paths = new Set();
const counts = {};
for (const m of manifest) {
  const id = m.id || '(no id)';
  if (ids.has(id)) bad(id, 'duplicate id');
  ids.add(id);
  counts[m.category] = (counts[m.category] || 0) + 1;
  if (m.path !== `/fixtures/${id}.html`) bad(id, `path ${m.path} does not match id`);
  if (paths.has(m.path)) bad(id, 'duplicate path');
  paths.add(m.path);
  if (!m.description) bad(id, 'no description');
  if (typeof m.negative !== 'boolean') bad(id, 'negative must be boolean');
  if (!Array.isArray(m.steps) || !m.steps.length) { bad(id, 'no steps'); continue; }

  const file = join(ROOT, m.path);
  let html = '';
  if (!existsSync(file)) bad(id, 'fixture file missing');
  else html = readFileSync(file, 'utf8');

  const roles = new Set();
  m.steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!KINDS.has(s.kind)) bad(id, `${at}: kind ${s.kind}`);
    if (!Array.isArray(s.expected)) { bad(id, `${at}: expected not an array`); return; }
    if (!Array.isArray(s.honeypots)) bad(id, `${at}: honeypots not an array`);
    for (const e of s.expected) {
      if (!ROLES.has(e.role)) bad(id, `${at}: role ${e.role}`);
      if (!isSelector(e.selector)) bad(id, `${at}: selector ${JSON.stringify(e.selector)}`);
      if (e.frame !== null && !(Array.isArray(e.frame) && e.frame.length && e.frame.every((x) => typeof x === 'string'))) bad(id, `${at}: frame ${JSON.stringify(e.frame)}`);
      roles.add(e.role);
    }
    if (i < m.steps.length - 1 && !s.advance) bad(id, `${at}: no advance before next step`);
    if (s.advance && !s.advance.click && !s.advance.goto) bad(id, `${at}: advance has neither click nor goto`);
    if (s.advance && s.advance.goto && !existsSync(join(ROOT, s.advance.goto))) bad(id, `${at}: goto target missing`);
  });

  if (m.negative) {
    if (m.state) bad(id, 'negative page has a state map');
    if (m.steps.some((s) => s.expected.length)) bad(id, 'negative page has expected fields');
  } else {
    if (!m.state) bad(id, 'no state map');
    else {
      for (const r of roles) {
        const want = r === 'otp-digit' ? 'otp' : r;
        if (m.state[r] !== want) bad(id, `state map for ${r} should be ${want}`);
      }
      for (const r of Object.keys(m.state)) if (!roles.has(r)) bad(id, `state map has unused role ${r}`);
    }
    if (!roles.size) bad(id, 'positive page with nothing expected');
  }

  if (html) {
    if (!html.includes('window.__fixture')) bad(id, 'no window.__fixture');
    if ((m.category === 'signup' || m.category === 'change-password') && /<input[^>]*\bautocomplete=/i.test(html)) bad(id, 'autocomplete attribute on input');
    if (/contenteditable/i.test(html)) bad(id, 'contenteditable');
    if (REAL_BRANDS.test(html)) bad(id, 'real brand name');
  }
}

// No external references anywhere under fixtures/, frames and step pages included.
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(readFileSync(p, 'utf8'))) problems.push(`${e.name}: external URL`);
  }
}
walk(join(ROOT, 'fixtures'));

if (manifest.length !== 60) problems.push(`expected 60 fixtures, found ${manifest.length}`);
for (const [cat, n] of Object.entries(WANT)) if ((counts[cat] || 0) !== n) problems.push(`category ${cat}: want ${n}, found ${counts[cat] || 0}`);

console.log(Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`${manifest.length} fixtures, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
