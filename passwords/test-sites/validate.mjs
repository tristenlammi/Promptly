// Static check of manifest.json against the fixture files. Run: node validate.mjs
// Exits non-zero and lists every problem. Does not need the server or a browser.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const ROLES = new Set(['username', 'email', 'password', 'new-password', 'confirm-password', 'current-password', 'otp', 'otp-digit', 'card-number', 'card-name', 'card-exp', 'card-exp-month', 'card-exp-year', 'card-cvv', 'first-name', 'last-name', 'full-name', 'address1', 'address2', 'city', 'state', 'postcode', 'country', 'phone', 'company']);
const KINDS = new Set(['signin', 'email-first', 'password-next', 'signup', 'change-password', 'otp', 'card', 'identity', 'search', 'newsletter', 'none']);
const HOSTS = new Set(['localhost', 'a.localhost', 'b.localhost', 'other.localhost', '127.0.0.1']);
const MINIMUMS = { signin: 15, 'email-first': 6, 'multi-step': 10, modal: 6, shadow: 8, iframe: 8, framework: 12, otp: 10, signup: 6, 'change-password': 6, honeypot: 5, language: 12, late: 6, card: 6, identity: 4, negative: 20, selfhosted: 9 };
const BANNED = /\b(google|gmail|microsoft|outlook|office ?365|azure|okta|paypal|amazon|apple|icloud|facebook|instagram|twitter|linkedin|github|stripe|shopify|netflix|spotify|yahoo|dropbox|slack|adobe|ebay|visa|mastercard|amex|bitwarden|1password|lastpass)\b/i;

const errors = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);
const localPath = (p) => join(ROOT, ...p.split('/').filter(Boolean));

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const seen = new Set();
const counts = {};

function checkHtml(id, rel) {
  const html = readFileSync(rel, 'utf8');
  const external = [...html.matchAll(/(?:src|href)\s*=\s*["']?(https?:)?\/\/([^"'\s>/]+)/gi)].map((m) => m[2]);
  for (const host of external) {
    const name = host.split(':')[0];
    if (!/(^|\.)localhost$/.test(name)) err(id, `external reference to ${host} in ${rel}`);
  }
  if (/@import|url\(\s*["']?https?:/i.test(html)) err(id, `external stylesheet or url() in ${rel}`);
  const m = html.match(BANNED);
  if (m) err(id, `real company name "${m[0]}" in ${rel}`);
}

for (const f of manifest) {
  const id = f.id || '(no id)';
  if (seen.has(id)) err(id, 'duplicate id');
  seen.add(id);
  counts[f.category] = (counts[f.category] || 0) + 1;

  if (!id.startsWith(f.category)) err(id, `id is not prefixed by category ${f.category}`);
  if (!f.description) err(id, 'missing description');
  if (f.path !== `/fixtures/${id}.html`) err(id, `unexpected path ${f.path}`);
  if (f.host && !HOSTS.has(f.host)) err(id, `unknown host ${f.host}`);
  if (typeof f.negative !== 'boolean') err(id, 'negative must be boolean');
  if (!existsSync(localPath(f.path))) {
    err(id, `path does not exist: ${f.path}`);
    continue;
  }
  const html = readFileSync(localPath(f.path), 'utf8');
  if (!html.includes('__fixture')) err(id, 'page does not define window.__fixture');
  if (!/<!doctype html>/i.test(html)) err(id, 'page is missing a doctype');
  checkHtml(id, localPath(f.path));

  if (!Array.isArray(f.steps) || f.steps.length === 0) {
    err(id, 'no steps');
    continue;
  }
  if (f.steps.length > 3) err(id, 'more than 3 steps');
  f.steps.forEach((s, i) => {
    const at = `${id} step ${i + 1}`;
    if (!KINDS.has(s.kind)) err(at, `unknown kind ${s.kind}`);
    if (!Array.isArray(s.expected)) err(at, 'expected must be an array');
    for (const e of s.expected || []) {
      if (!ROLES.has(e.role)) err(at, `unknown role ${e.role}`);
      if (!(typeof e.selector === 'string' || (Array.isArray(e.selector) && e.selector.length >= 2))) err(at, `bad selector ${JSON.stringify(e.selector)}`);
      if (!(e.frame === null || (Array.isArray(e.frame) && e.frame.length))) err(at, `bad frame ${JSON.stringify(e.frame)}`);
      if (e.role === 'current-password' && s.kind !== 'change-password') err(at, 'current-password outside a change-password step');
    }
    if (s.advance) {
      if (!s.advance.click && !s.advance.goto) err(at, 'advance needs click or goto');
      if (s.advance.goto && !existsSync(localPath(s.advance.goto))) err(at, `advance.goto missing: ${s.advance.goto}`);
      if (s.advance.goto) checkHtml(at, localPath(s.advance.goto));
      if (i === f.steps.length - 1) err(at, 'last step has an advance');
    } else if (i < f.steps.length - 1) {
      err(at, 'non-final step has no advance');
    }
  });

  if (f.negative) {
    if (f.steps.some((s) => (s.expected || []).length)) err(id, 'negative fixture lists expected fields');
    if (!['search', 'newsletter', 'none'].includes(f.steps[0].kind)) err(id, `negative kind must be search, newsletter or none, got ${f.steps[0].kind}`);
  } else {
    const roles = f.steps.flatMap((s) => (s.expected || []).map((e) => e.role));
    if (!roles.length) err(id, 'positive fixture expects nothing');
    if (!f.state) err(id, 'positive fixture has no state map');
    for (const role of roles) {
      const key = role === 'otp-digit' ? 'otp' : role;
      if (!f.state || !(key in f.state)) err(id, `state map is missing ${key}`);
    }
  }
}

for (const [category, min] of Object.entries(MINIMUMS)) {
  if ((counts[category] || 0) < min) err('coverage', `${category} has ${counts[category] || 0}, needs ${min}`);
}
for (const category of Object.keys(counts)) {
  if (!(category in MINIMUMS)) err('coverage', `unexpected category ${category}`);
}

const onDisk = readdirSync(join(ROOT, 'fixtures')).filter((n) => n.endsWith('.html'));
for (const name of onDisk) {
  if (!seen.has(name.replace(/\.html$/, ''))) err(name, 'fixture file has no manifest entry');
}
for (const sub of ['_frames', '_steps']) {
  const dir = join(ROOT, 'fixtures', sub);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    checkHtml(`${sub}/${name}`, file);
    if (name.endsWith('.html') && !readFileSync(file, 'utf8').includes('__fixture')) err(`${sub}/${name}`, 'page does not define window.__fixture');
  }
}
for (const lib of ['react.production.min.js', 'react-dom.production.min.js', 'vue.global.prod.js', 'README.md']) {
  if (!existsSync(join(ROOT, 'lib', lib))) err('lib', `missing ${lib}`);
}

const positive = manifest.filter((f) => !f.negative).length;
const negative = manifest.length - positive;
for (const category of Object.keys(MINIMUMS)) console.log(`${category.padEnd(16)} ${counts[category] || 0}`);
console.log(`total ${manifest.length} (${positive} positive, ${negative} negative)`);
if (positive < 110) err('coverage', `only ${positive} positive fixtures`);
if (negative < 20) err('coverage', `only ${negative} negative fixtures`);

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log('manifest OK');
