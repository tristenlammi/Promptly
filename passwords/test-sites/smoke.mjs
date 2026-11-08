// Loads every fixture in Chromium and walks it the way a person would. Needs the
// Playwright install under e2e/. Starts its own server unless SMOKE_NO_SERVER=1.
//   cd e2e && node ../passwords/test-sites/smoke.mjs [id-prefix]
//
// For every step it checks: the page throws nothing, `wait` resolves, every expected
// selector is found and is visible and editable, and honeypots exist. It then types
// test values with real key presses and checks window.__fixture.state() agrees.
// `framework` fixtures additionally get a bare value set with no event, which must
// leave the app state unchanged.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(ROOT, '..', '..', 'e2e', 'package.json'));
const { chromium } = require('@playwright/test');

const VALUES = {
  username: 'fixture.user@example.test',
  email: 'fixture.mail@example.test',
  password: 'Fx-Current-4821',
  'new-password': 'Fx-New-Pass-7713',
  'confirm-password': 'Fx-New-Pass-7713',
  'current-password': 'Fx-Current-4821',
  otp: '123456',
  'card-number': '4111111111111111',
  'card-name': 'Pat Example',
  'card-exp': '12/29',
  'card-exp-month': '12',
  'card-exp-year': '29',
  'card-cvv': '123',
  'first-name': 'Pat',
  'last-name': 'Example',
  'full-name': 'Pat Example',
  address1: '1 Test Street',
  address2: 'Unit 2',
  city: 'Sampleton',
  state: 'NSW',
  postcode: '2000',
  country: 'Australia',
  phone: '0400000000',
  company: 'Example Pty Ltd',
};

const norm = (v) => String(v ?? '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

async function frameFor(page, chain) {
  let frame = page.mainFrame();
  for (const sel of chain || []) {
    const handle = await frame.waitForSelector(sel, { state: 'attached', timeout: 8000 });
    const next = await handle.contentFrame();
    if (!next) throw new Error(`no content frame for ${sel}`);
    await next.waitForLoadState('load');
    frame = next;
  }
  return frame;
}

/** Walks a selector or a [host, ..., inner] array across open and closed shadow roots. */
async function resolve(frame, selector, timeout = 8000) {
  const path = Array.isArray(selector) ? selector : [selector];
  const deadline = Date.now() + timeout;
  for (;;) {
    const handle = await frame.evaluateHandle((p) => {
      let root = document;
      for (let i = 0; i < p.length; i++) {
        const el = root.querySelector(p[i]);
        if (!el) return null;
        if (i === p.length - 1) return el;
        root = el.shadowRoot || (window.__closedRoots || {})[p[i]];
        if (!root) return null;
      }
      return null;
    }, path);
    const el = handle.asElement();
    if (el) return el;
    if (Date.now() > deadline) throw new Error(`not found: ${JSON.stringify(selector)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const usable = (el) =>
  el.evaluate((n) => {
    const r = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    const problems = [];
    if (!n.isConnected) problems.push('detached');
    if (r.width <= 1 || r.height <= 1) problems.push('no size');
    if (s.display === 'none' || s.visibility !== 'visible') problems.push(`css ${s.display}/${s.visibility}`);
    if (n.disabled) problems.push('disabled');
    if (r.right < 0 || r.left > innerWidth + 1) problems.push('off-screen');
    return problems.join(', ');
  });

const stateOf = (page) => page.evaluate(() => window.__fixture.state());

async function fillOne(page, frame, e, otpIndex) {
  let el = await resolve(frame, e.selector);
  const tag = await el.evaluate((n) => n.tagName);
  if (tag === 'SELECT') {
    const want = VALUES[e.role];
    const v = await el.evaluate((n, w) => {
      const o = [...n.options].find((x) => x.value && (x.value === w || x.text === w || x.value.endsWith(w))) || [...n.options].filter((x) => x.value).at(-1);
      n.value = o.value;
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new Event('change', { bubbles: true }));
      return o.value;
    }, want);
    return v;
  }
  const value = e.role === 'otp-digit' ? VALUES.otp[otpIndex] : VALUES[e.role];
  await el.click();
  await page.waitForTimeout(30); // a blur handler elsewhere may have just re-rendered this field
  el = await resolve(frame, e.selector);
  await el.focus();
  await el.evaluate((n) => n.select?.()); // a kept value from an earlier step gets replaced, not appended to
  await page.keyboard.type(value, { delay: 2 });
  // Leave the field, so change and blur handlers run. Blur may swap the element.
  await (await resolve(frame, e.selector)).evaluate((n) => n.blur());
  await page.waitForTimeout(10);
  return value;
}

async function paste(frame, selector, text) {
  const el = await resolve(frame, selector);
  await el.evaluate((n, t) => {
    const dt = new DataTransfer();
    dt.setData('text', t);
    n.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

async function checkFixture(browser, f, ports) {
  const problems = [];
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    // 127.0.0.1 is the box-on-the-LAN case (the selfhosted fixtures), and still this machine.
    if (u.protocol.startsWith('http') && !/(^|\.)localhost$/.test(u.hostname) && u.hostname !== '127.0.0.1') problems.push(`external request: ${r.url()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });

  const host = f.host || 'localhost';
  const base = `http://${host}:${ports[0]}`;
  const expectedState = {};
  try {
    await page.goto(base + f.path, { waitUntil: 'load' });
    for (let i = 0; i < f.steps.length; i++) {
      const s = f.steps[i];
      const at = `step ${i + 1}`;
      if (s.wait) await page.waitForSelector(s.wait, { state: 'attached', timeout: 8000 });

      for (const hp of s.honeypots || []) {
        const n = await page.locator(hp).count();
        if (n === 0) problems.push(`${at}: honeypot ${hp} not found`);
      }

      const resolved = [];
      for (const e of s.expected) {
        const frame = await frameFor(page, e.frame);
        const el = await resolve(frame, e.selector);
        const bad = await usable(el);
        if (bad) problems.push(`${at}: ${JSON.stringify(e.selector)} unusable: ${bad}`);
        resolved.push({ e, frame });
      }

      const honeypotBefore = [];
      for (const hp of s.honeypots || []) {
        const v = await page.locator(hp).first().evaluate((n) => n.value).catch(() => null);
        honeypotBefore.push([hp, v]);
      }

      if (f.category === 'framework') {
        for (const { e, frame } of resolved) {
          const el = await resolve(frame, e.selector);
          const key = e.role;
          const before = (await stateOf(page))[key];
          await el.evaluate((n) => { n.value = 'bare-set-no-event'; });
          const after = (await stateOf(page))[key];
          if (after !== before) problems.push(`${at}: ${key} accepted a bare value set`);
          await el.evaluate((n, v) => { n.value = v; }, before ?? '');
        }
      }

      const isDigit = s.expected.some((e) => e.role === 'otp-digit');
      let digit = 0;
      for (const { e, frame } of resolved) {
        const v = await fillOne(page, frame, e, digit);
        if (e.role === 'otp-digit') {
          digit++;
          expectedState.otp = (expectedState.otp || '') + v;
        } else {
          expectedState[e.role] = v;
        }
      }
      await page.waitForTimeout(60);

      // Paste-only boxes ignore typing: if the digits did not take, offer a paste.
      if (isDigit) {
        const st = await stateOf(page);
        if (norm(st.otp) !== norm(expectedState.otp)) {
          const first = resolved.find((x) => x.e.role === 'otp-digit');
          await paste(first.frame, first.e.selector, expectedState.otp);
          await page.waitForTimeout(30);
        }
      }

      if (!f.negative) {
        const st = await stateOf(page);
        for (const [key, want] of Object.entries(expectedState)) {
          if (norm(st[key]) !== norm(want)) problems.push(`${at}: state.${key} is ${JSON.stringify(st[key])}, typed ${JSON.stringify(want)}`);
        }
      }

      for (const [hp, before] of honeypotBefore) {
        const v = await page.locator(hp).first().evaluate((n) => n.value).catch(() => null);
        if (v !== before) problems.push(`${at}: honeypot ${hp} changed by typing`);
      }

      if (s.advance?.click) {
        const frame = await frameFor(page, s.advance.frame);
        await frame.click(s.advance.click, { timeout: 5000 });
      } else if (s.advance?.goto) {
        await page.goto(base + s.advance.goto, { waitUntil: 'load' });
      }
    }
  } catch (err) {
    problems.push(`threw: ${err.message.split('\n')[0]}`);
  }
  await context.close();
  return problems;
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const prefix = process.argv[2] || '';
const server = process.env.SMOKE_NO_SERVER ? null : await start();
const ports = server ? server.ports : (process.env.PW_SITES_PORTS || '8101,8102').split(',').map(Number);
const browser = await chromium.launch();
const todo = manifest.filter((f) => f.id.startsWith(prefix));
let failed = 0;
let next = 0;
async function worker() {
  while (next < todo.length) {
    const f = todo[next++];
    const problems = await checkFixture(browser, f, ports);
    if (problems.length) {
      failed++;
      console.log(`FAIL ${f.id}`);
      for (const p of problems) console.log(`     ${p}`);
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
await browser.close();
await server?.close();
console.log(`${todo.length - failed}/${todo.length} fixtures clean`);
process.exit(failed ? 1 : 0);
