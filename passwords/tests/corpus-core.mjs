// The autofill corpus runner, independent of the browser driver. Plan 13.4: at least
// 100 fixtures, target at least 95%, no false fills on negatives, results per browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SITES = path.resolve(here, process.env.PW_SITES ?? "../test-sites");

/** Throwaway values. They're typed into local fixture pages only. */
export const VALUES = {
  username: "ana.fixture@example.com",
  email: "ana.fixture@example.com",
  password: "Fixture-Passw0rd!",
  "current-password": "Fixture-Passw0rd!",
  "new-password": "Fixture-New-Passw0rd!",
  "confirm-password": "Fixture-New-Passw0rd!",
  otp: "482913",
  "card-number": "4111111111111111",
  "card-name": "Ana Fixture",
  "card-exp": "12/30",
  "card-exp-month": "12",
  "card-exp-year": "2030",
  "card-cvv": "123",
  "first-name": "Ana",
  "last-name": "Fixture",
  "full-name": "Ana Fixture",
  address1: "1 Test Street",
  address2: "Unit 2",
  city: "Testville",
  state: "NSW",
  postcode: "2000",
  country: "Australia",
  phone: "0400000000",
  company: "Fixture Pty Ltd",
};

const normalise = (s) => String(s ?? "").replace(/[\s/-]/g, "");

export async function runCorpus(driver, { filter, port = 8101, log = console.log } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SITES, "manifest.json"), "utf8"));
  const list = (Array.isArray(manifest) ? manifest : manifest.fixtures).filter((f) => !filter || f.id.includes(filter) || f.category.includes(filter));
  const results = [];
  for (const f of list) {
    const problems = [];
    let falseFill = false;
    try {
      await driver.goto(`http://${f.host ?? "localhost"}:${port}${f.path}`);
      for (let i = 0; i < f.steps.length; i++) {
        const step = f.steps[i];
        // A step's fields can be spread over frames (hosted payment fields are).
        const byFrame = new Map();
        for (const e of step.expected) {
          const k = JSON.stringify(e.frame ?? null);
          byFrame.set(k, [...(byFrame.get(k) ?? []), e]);
        }
        const target = step.expected[0]?.frame ?? null;
        if (step.wait) await driver.waitFor(step.wait, step.waitFrame ?? (step.expected[0]?.frame && !String(step.wait).includes("frame") ? target : null)).catch(() => driver.waitFor(step.wait, null));
        else if (step.expected[0]) await driver.waitFor(step.expected[0].selector, target).catch(() => undefined);
        await driver.settle();

        const a = await driver.analyze(target, byFrame.get(JSON.stringify(target)) ?? [], step.honeypots ?? []);
        if (f.negative) {
          // Nothing anywhere on this page may offer to fill.
          const anywhere = await driver.analyzeAllFrames();
          const offered = anywhere.filter((x) => x.fillableForms > 0);
          if (offered.length) {
            falseFill = true;
            problems.push(`step ${i + 1}: offered to fill: ${offered.flatMap((x) => x.kinds).join(",")}`);
          }
          continue;
        }
        if (a.kind !== step.kind) problems.push(`step ${i + 1}: kind ${a.kind}, wanted ${step.kind}`);
        for (const m of a.missing) problems.push(`step ${i + 1}: fixture element missing ${JSON.stringify(m)}`);
        for (const r of a.roles) if (r.got !== r.want) problems.push(`step ${i + 1}: ${JSON.stringify(r.selector)} got ${r.got}, wanted ${r.want}`);
        for (const e of a.extras) problems.push(`step ${i + 1}: extra field ${e}`);
        if (a.honeypotHit.length) {
          falseFill = true;
          problems.push(`step ${i + 1}: honeypot chosen ${a.honeypotHit.join(",")}`);
        }

        const roleVals = {};
        for (const e of step.expected) roleVals[e.role === "otp-digit" ? "otp" : e.role] = VALUES[e.role === "otp-digit" ? "otp" : e.role];
        await driver.fill(target, roleVals);
        // The other frames of a spread-out form.
        for (const [k, list] of byFrame) {
          if (k === JSON.stringify(target)) continue;
          const chain = JSON.parse(k);
          const other = await driver.analyze(chain, list, []);
          for (const m of other.missing) problems.push(`step ${i + 1}: fixture element missing ${JSON.stringify(m)}`);
          for (const r of other.roles) if (r.got !== r.want) problems.push(`step ${i + 1}: ${JSON.stringify(r.selector)} got ${r.got}, wanted ${r.want}`);
          await driver.fill(chain, roleVals);
        }
        await driver.settle();

        for (const [role, key] of Object.entries(f.state ?? {})) {
          if (!(role in roleVals)) continue;
          const want = roleVals[role];
          const matches = (got) => {
            const g = normalise(got);
            const w = normalise(want);
            if (g === w) return true;
            if (role === "card-exp-year") return g.endsWith(w.slice(-2));
            // Fewer boxes than digits, or a country chosen from a list by its code.
            if (role === "otp") return g.length >= 4 && w.startsWith(g);
            if (role === "country" || role === "state") return g.length > 0;
            return false;
          };
          // Iframes report state by postMessage, so give it a moment.
          let got;
          for (let t = 0; t < 8; t++) {
            const state = await driver.state(target);
            got = state?.[key];
            if (matches(got)) break;
            await driver.settle();
            await driver.settle();
          }
          if (!matches(got)) problems.push(`step ${i + 1}: the app holds ${role}=${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
        }
        if (step.advance?.click) await driver.click(step.advance.click, step.advance.frame ?? target);
        else if (step.advance?.goto) await driver.goto(`http://${f.host ?? "localhost"}:${port}${step.advance.goto}`);
      }
    } catch (e) {
      problems.push(`error: ${String(e?.message ?? e).split("\n")[0]}`);
    }
    results.push({ id: f.id, category: f.category, negative: !!f.negative, ok: problems.length === 0, falseFill, problems });
  }
  return report(results, log);
}

function report(results, log) {
  const byCat = new Map();
  for (const r of results) {
    const c = byCat.get(r.category) ?? { total: 0, ok: 0 };
    c.total++;
    if (r.ok) c.ok++;
    byCat.set(r.category, c);
  }
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const positive = results.filter((r) => !r.negative);
  const negative = results.filter((r) => r.negative);
  const falseFills = results.filter((r) => r.falseFill);
  log(`\n${"category".padEnd(20)} pass/total`);
  for (const [c, n] of [...byCat].sort()) log(`${c.padEnd(20)} ${n.ok}/${n.total}`);
  log(`\nFixtures: ${ok}/${total} (${((ok / total) * 100).toFixed(1)}%)`);
  log(`Positive: ${positive.filter((r) => r.ok).length}/${positive.length}. Negative: ${negative.filter((r) => r.ok).length}/${negative.length}. False fills: ${falseFills.length}.`);
  for (const r of results.filter((x) => !x.ok)) log(`  FAIL ${r.id}: ${r.problems.slice(0, 4).join("; ")}`);
  return { total, ok, percent: (ok / total) * 100, falseFills: falseFills.length, results };
}
