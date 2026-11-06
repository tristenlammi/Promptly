// Loads every fixture once in headless Chromium through server.mjs, walks its steps,
// types test values with key presses and checks window.__fixture.state() agrees.
// Fails on a page error, console error, failed or external request, a missing or hidden
// expected field, a missing honeypot, or a visible form field the manifest does not
// account for (every field on a step must be expected or listed as a honeypot).
// Exits 1 on any failure.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(ROOT, '../../e2e/package.json'));
const { chromium } = require('@playwright/test');

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const BASE = 'http://localhost:8122';

const VALUES = {
  username: 'tester42', email: 'tester@mail.example', password: 'Pw7seekrit', 'new-password': 'New9seekrit', 'confirm-password': 'New9seekrit',
  'current-password': 'Old3seekrit', otp: '123456', 'card-number': '4242424242424242', 'card-name': 'Sam Tester', 'card-exp': '12/29', 'card-cvv': '123',
  'first-name': 'Sam', 'last-name': 'Tester', 'full-name': 'Sam Tester', address1: '1 Test Way', address2: 'Unit 2', city: 'Testville', state: 'TS',
  postcode: '1234', phone: '5550100', company: 'Testco',
};
const strip = (s) => String(s ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();

async function locate(page, { selector, frame }) {
  let scope = page;
  for (const sel of frame || []) scope = scope.frameLocator(sel);
  // Playwright CSS pierces open shadow roots, so a chain becomes a descendant selector.
  const css = Array.isArray(selector) ? selector.join(' ') : selector;
  return scope.locator(css);
}

async function fillField(loc, role, digit) {
  const info = await loc.evaluate((el) => ({ tag: el.tagName, max: el.maxLength, inputmode: el.inputMode, opts: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value).filter(Boolean) : null }));
  if (info.tag === 'SELECT') {
    const v = info.opts[info.opts.length - 1];
    await loc.selectOption(v);
    return v;
  }
  let v = role === 'otp-digit' ? String(digit) : VALUES[role];
  if (info.inputmode === 'numeric' || info.inputmode === 'tel') v = v.replace(/[^0-9]/g, '') || '1234567890';
  if (info.max > 0) v = v.slice(0, info.max);
  await loc.click();
  await loc.pressSequentially(v);
  await loc.blur();
  return v;
}

const SKIP = new Set(['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color']);

// Marks everything the step names, then reports visible text-like fields left unmarked, in every frame.
async function unaccounted(page, step) {
  const named = [...step.expected.map((e) => e), ...step.honeypots.map((hp) => ({ selector: hp, frame: null }))];
  for (const e of named) {
    const loc = await locate(page, e);
    await loc.evaluateAll((els) => els.forEach((el) => { el.__listed = true; })).catch(() => {});
  }
  const out = [];
  for (const f of page.frames()) {
    const left = await f.locator('input,select,textarea').evaluateAll((els, skip) => els
      .filter((el) => !el.__listed && !(el.tagName === 'INPUT' && skip.includes(el.type)))
      .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      .map((el) => el.outerHTML.slice(0, 90)), [...SKIP]).catch(() => []);
    out.push(...left);
  }
  return out;
}

async function run(browser, m) {
  const fails = [];
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fails.push(`page error: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') fails.push(`console error: ${msg.text()}`); });
  page.on('requestfailed', (r) => fails.push(`request failed: ${r.url()}`));
  page.on('request', (r) => { if (!/^(http:\/\/localhost:8122\/|data:|about:)/.test(r.url())) fails.push(`external request: ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 400) fails.push(`HTTP ${r.status()}: ${r.url()}`); });

  await page.goto(BASE + m.path, { waitUntil: 'load' });
  const hasFx = await page.evaluate(() => typeof window.__fixture?.state === 'function');
  if (!hasFx) fails.push('no __fixture.state');

  const want = {};
  for (let i = 0; i < m.steps.length; i++) {
    const s = m.steps[i];
    const at = `step ${i + 1}`;
    if (s.wait) await page.waitForSelector(s.wait, { timeout: 5000, state: 'attached' }).catch(() => fails.push(`${at}: wait ${s.wait} timed out`));
    for (const hp of s.honeypots) if ((await page.locator(hp).count()) === 0) fails.push(`${at}: honeypot ${hp} not found`);
    const before = await Promise.all(s.honeypots.map((hp) => page.locator(hp).first().inputValue().catch(() => null)));
    let digit = 1;
    for (const e of s.expected) {
      const loc = await locate(page, e);
      try {
        await loc.first().waitFor({ state: 'visible', timeout: 5000 });
        if ((await loc.count()) !== 1) fails.push(`${at}: ${JSON.stringify(e.selector)} matches ${await loc.count()} elements`);
        const v = await fillField(loc.first(), e.role, digit);
        const key = e.role === 'otp-digit' ? 'otp' : e.role;
        want[key] = e.role === 'otp-digit' ? (want[key] || '') + v : v;
        if (e.role === 'otp-digit') digit++;
      } catch (err) {
        fails.push(`${at}: ${JSON.stringify(e.selector)} (${e.role}): ${err.message.split('\n')[0]}`);
      }
    }
    for (const left of await unaccounted(page, s)) fails.push(`${at}: field not in manifest: ${left}`);
    const after = await Promise.all(s.honeypots.map((hp) => page.locator(hp).first().inputValue().catch(() => null)));
    s.honeypots.forEach((hp, j) => { if (before[j] !== after[j]) fails.push(`${at}: honeypot ${hp} changed`); });
    if (s.advance) {
      let scope = page;
      for (const sel of s.advance.frame || []) scope = scope.frameLocator(sel);
      await scope.locator(s.advance.click).click({ timeout: 5000 }).catch((err) => fails.push(`${at}: advance: ${err.message.split('\n')[0]}`));
      await page.waitForLoadState('load');
    }
  }

  if (m.negative) {
    const st = await page.evaluate(() => window.__fixture.state());
    if (Object.keys(st).length) fails.push(`negative state not empty: ${JSON.stringify(st)}`);
  } else {
    const st = await page.evaluate(() => window.__fixture.state());
    for (const [k, v] of Object.entries(want)) {
      if (strip(st[k]) !== strip(v)) fails.push(`state.${k}: wanted ${JSON.stringify(v)}, got ${JSON.stringify(st[k])}`);
    }
  }
  await ctx.close();
  return fails;
}

const server = await start();
const browser = await chromium.launch({ headless: true });
let failed = 0;
try {
  for (const m of manifest) {
    const fails = await run(browser, m).catch((e) => [`crash: ${e.message}`]);
    if (fails.length) {
      failed++;
      console.log(`FAIL ${m.id}`);
      for (const x of fails) console.log('   ' + x);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`${manifest.length - failed}/${manifest.length} pages OK`);
process.exit(failed ? 1 : 0);
