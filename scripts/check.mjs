#!/usr/bin/env node
// Promptly's pre-release check: every test there is, one command, one table.
//
//   scripts/check.ps1                 (Windows)      scripts/check.sh   (bash)
//   node scripts/check.mjs            (either)
//
//   --quick                    everything but the browser suite (about 11 minutes)
//   --only backend,frontend    run just these steps
//   --skip android             run everything but these
//   --workers 6                backend test processes (default: half the CPUs, 2-8)
//   --tests "tests/test_mail.py -k sync"   backend: only these (passed to pytest)
//   --list                     show the steps and stop
//   --gate                     run nothing: say whether the last check covers this
//                              exact code (exit 0) or not (exit 3). scripts/release asks.
//
// Steps: static (compose file, one Alembic head, script syntax), backend
// (pytest in the backend image, on throwaway databases of its own), frontend
// (tsc + vitest), android (unit tests), and e2e (about 45 minutes: the
// browser suite against a private copy of Promptly built from this checkout;
// set E2E_BASE_URL to test a stack that's already running instead).
//
// It prints one table at the end, exits non-zero if anything failed, keeps
// each step's full output under .check/<time>/, and writes .check/last.json:
// what passed, on which code. scripts/release reads that file and won't cut a
// version unless static, backend, frontend and e2e all passed on exactly
// this code. They needn't be one run: steps run separately on the same code
// add up (--quick while you work, --only e2e before the release). A run
// narrowed with --tests, or pointed at another stack with E2E_BASE_URL, is
// shown but never counts towards a release.
//
// Safe from a worktree: nothing here builds or restarts the main stack (the
// browser suite's private copy has containers, a port and data of its own). The
// backend step only borrows the running stack's Postgres and Redis (the
// `promptly` Docker network), under database names of its own, and drops
// them afterwards.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const STEPS = ["static", "backend", "frontend", "android", "e2e"];
const DEFAULT = STEPS;
// --quick: the day-to-day run, without the slow step.
const QUICK = ["static", "backend", "frontend", "android"];
// What a release needs to have seen pass. Android is reported when it
// didn't run, not required: not every machine has the SDK.
const REQUIRED = ["static", "backend", "frontend", "e2e"];

function args() {
  const a = process.argv.slice(2);
  const out = { only: null, skip: [], with: [], workers: 0, list: false, gate: false, quick: false, tests: "" };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^-+/, "").toLowerCase();
    const v = () => (a[++i] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (k === "only") out.only = v();
    else if (k === "skip") out.skip = v();
    else if (k === "with") out.with = v();
    else if (k === "workers") out.workers = Number(a[++i]) || 0;
    else if (k === "tests") out.tests = a[++i] ?? "";
    else if (k === "list") out.list = true;
    else if (k === "gate") out.gate = true;
    else if (k === "quick") out.quick = true;
    else if (k === "h" || k === "help") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 35).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(0);
    } else {
      console.error(`Unknown option: ${a[i]} (see --help)`);
      process.exit(2);
    }
  }
  for (const s of [...(out.only ?? []), ...out.skip, ...out.with]) {
    if (!STEPS.includes(s)) {
      console.error(`Unknown step: ${s}. Steps: ${STEPS.join(", ")}`);
      process.exit(2);
    }
  }
  return out;
}

/** A command's stdout, or null when it fails or isn't there. */
function read(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: opts.cwd ?? ROOT, encoding: "utf8", shell: opts.shell ?? false, windowsHide: true });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
}

const OPT = args();
const chosen = (OPT.only ?? [...(OPT.quick ? QUICK : DEFAULT), ...OPT.with]).filter((s, i, all) => all.indexOf(s) === i && !OPT.skip.includes(s));
if (OPT.list) {
  console.log(`Steps: ${STEPS.join(", ")}\nBy default: all of them. --quick: ${QUICK.join(", ")}\nA release needs: ${REQUIRED.join(", ")}`);
  process.exit(0);
}

if (OPT.gate) process.exit(gate());

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const OUT = path.join(ROOT, ".check", stamp);
fs.mkdirSync(OUT, { recursive: true });

/** Run a command, all its output to a log file (and the last lines kept for
 *  the table's note). Never throws. */
function run(name, cmd, argv, opts = {}) {
  const log = path.join(OUT, `${name}.log`);
  const fd = fs.openSync(log, "a");
  fs.writeSync(fd, `$ ${cmd} ${argv.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")}\n`);
  const started = Date.now();
  // Git Bash can't write to a file handle opened for appending (it exits 1
  // and says nothing), so its output comes back through a pipe instead.
  const r = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: opts.pipe ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
    shell: opts.shell ?? false,
    timeout: opts.timeout ?? 0,
    windowsHide: true,
    maxBuffer: 1 << 28,
  });
  if (opts.pipe) fs.writeSync(fd, `${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (r.error || r.status !== 0) fs.writeSync(fd, `
[check] ${cmd} ended with ${r.error ? r.error.message : `exit ${r.status}${r.signal ? `, signal ${r.signal}` : ""}`}
`);
  fs.closeSync(fd);
  const code = r.error ? (r.error.code === "ENOENT" ? 127 : 1) : (r.status ?? 1);
  return { code, missing: r.error?.code === "ENOENT", timedOut: r.error?.code === "ETIMEDOUT", seconds: Math.round((Date.now() - started) / 1000), log };
}

const has = (cmd) => read(WIN ? "where" : "which", [cmd]) !== null;
const npx = WIN ? "npx.cmd" : "npx";

/** JUnit XML totals without an XML library: every <testsuite ...> tag. */
function junitTotals(file) {
  if (!fs.existsSync(file)) return null;
  const xml = fs.readFileSync(file, "utf8");
  const t = { tests: 0, failed: 0, skipped: 0, names: [] };
  for (const m of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const n = (k) => Number((m[1].match(new RegExp(`\\b${k}="(\\d+)"`)) ?? [])[1] ?? 0);
    t.tests += n("tests");
    t.failed += n("failures") + n("errors");
    t.skipped += n("skipped");
  }
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (m[2] && /<(failure|error)\b/.test(m[2])) {
      const cls = (m[1].match(/\bclassname="([^"]*)"/) ?? [])[1] ?? "";
      const name = (m[1].match(/\bname="([^"]*)"/) ?? [])[1] ?? "";
      t.names.push(`${cls}::${name}`);
    }
  }
  return t;
}

const results = [];
/** `counts.partial`: why this result doesn't stand for the whole step (a
 *  narrowed run, someone else's stack). Shown, never counted by the gate. */
function record(step, status, counts, note, seconds, log) {
  results.push({ step, status, ...counts, note, seconds, at: new Date().toISOString(), log: log ? path.relative(ROOT, log) : undefined });
  const mark = status === "pass" ? "ok  " : status === "skip" ? "skip" : "FAIL";
  console.log(`  ${mark}  ${step}${note ? `: ${note}` : ""}`);
}

// A worktree has no node_modules of its own. Borrow the main checkout's for
// the length of the run (a junction on Windows, a symlink elsewhere).
const borrowed = [];
function mainCheckout() {
  const list = read("git", ["worktree", "list", "--porcelain"]);
  const first = list?.split("\n").find((l) => l.startsWith("worktree "));
  return first ? path.resolve(first.slice(9)) : null;
}
function borrow(rel) {
  const mine = path.join(ROOT, rel);
  if (fs.existsSync(mine)) return true;
  const main = mainCheckout();
  const theirs = main && main !== ROOT ? path.join(main, rel) : null;
  if (!theirs || !fs.existsSync(theirs)) return false;
  fs.symlinkSync(theirs, mine, WIN ? "junction" : "dir");
  borrowed.push(mine);
  return true;
}
function giveBack() {
  for (const p of borrowed.splice(0)) {
    try {
      // A junction/symlink: remove the link, never what it points at.
      if (fs.lstatSync(p).isSymbolicLink() || WIN) fs.rmdirSync(p);
      else fs.unlinkSync(p);
    } catch {
      try { fs.unlinkSync(p); } catch { /* leave it */ }
    }
  }
}
process.on("exit", giveBack);
process.on("SIGINT", () => { giveBack(); process.exit(130); });

// ------------------------------------------------------------------ static
function stepStatic() {
  const started = Date.now();
  const problems = [];
  let ran = 0;
  const log = path.join(OUT, "static.log");

  // Shell scripts parse.
  const sh = ["update.sh", "install.sh", ...fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => f.endsWith(".sh")).map((f) => `scripts/${f}`)];
  const bash = gitBash(); // on Windows: Git's, never WSL's
  if (bash) {
    for (const f of sh) {
      ran++;
      if (run("static", bash, ["-n", f], { pipe: true }).code !== 0) problems.push(`${f} doesn't parse`);
    }
  } else fs.appendFileSync(log, "bash not found: shell scripts not checked\n");

  // PowerShell scripts parse.
  const ps = ["update.ps1", "install.ps1", ...fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => f.endsWith(".ps1")).map((f) => `scripts/${f}`)];
  const pwsh = has("pwsh") ? "pwsh" : has("powershell") ? "powershell" : null;
  if (pwsh) {
    const script = `$bad = 0; foreach ($f in @(${ps.map((f) => `'${f}'`).join(",")})) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f), [ref]$null, [ref]$e); if ($e.Count) { Write-Output "$f : $($e[0].Message)"; $bad++ } }; exit $bad`;
    ran += ps.length;
    if (run("static", pwsh, ["-NoProfile", "-NonInteractive", "-Command", script]).code !== 0) problems.push("a PowerShell script doesn't parse (see the log)");
  } else fs.appendFileSync(log, "PowerShell not found: .ps1 scripts not checked\n");

  // The compose file loads.
  if (has("docker")) {
    ran++;
    if (run("static", "docker", ["compose", "-f", "docker-compose.yml", "config", "-q"]).code !== 0) problems.push("docker-compose.yml doesn't load");
  } else fs.appendFileSync(log, "docker not found: compose file not checked\n");

  // One Alembic head, every revision id short enough for alembic_version
  // (varchar(32): a longer one crash-loops the backend on boot).
  const dir = path.join(ROOT, "backend", "alembic", "versions");
  const revs = new Map();
  const downs = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".py"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const rev = (src.match(/^revision(?:\s*:\s*[^=]+)?\s*=\s*["']([^"']+)["']/m) ?? [])[1];
    if (!rev) continue;
    revs.set(rev, f);
    const down = (src.match(/^down_revision(?:\s*:\s*[^=]+)?\s*=\s*(.+)$/m) ?? [])[1] ?? "";
    for (const m of down.matchAll(/["']([^"']+)["']/g)) downs.add(m[1]);
  }
  ran++;
  const heads = [...revs.keys()].filter((r) => !downs.has(r));
  if (heads.length !== 1) problems.push(`${heads.length} Alembic heads (${heads.join(", ")}): there must be one`);
  const long = [...revs.keys()].filter((r) => r.length > 32);
  if (long.length) problems.push(`Alembic revision id over 32 characters: ${long.join(", ")}`);
  fs.appendFileSync(log, `alembic: ${revs.size} revisions, head(s): ${heads.join(", ")}\n`);

  record("static", problems.length ? "fail" : "pass", { tests: ran, failed: problems.length, skipped: 0 }, problems.join("; ") || `${ran} checks`, Math.round((Date.now() - started) / 1000), log);
}

// ----------------------------------------------------------------- backend
/** A throwaway mail server (GreenMail) for the tests that send, receive and
 *  sync real mail: its own name on the stack's network, a certificate made
 *  for this run, two made-up people. Returns its host name, or null when the
 *  image isn't here and can't be pulled (those tests then skip and say so). */
function mailServer(name) {
  const image = "greenmail/standalone:2.1.8";
  if (read("docker", ["image", "inspect", image, "--format", "{{.Id}}"]) === null && run("backend", "docker", ["pull", "-q", image]).code !== 0) return null;
  const host = `${name}-mail`;
  const dir = path.join(OUT, "mail");
  fs.mkdirSync(dir, { recursive: true });
  const made = run("backend", "docker", [
    "run", "--rm", "-v", `${dir}:/m`, "--entrypoint", "sh", "promptly-backend:local", "-c",
    `openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj "/CN=${host}" -addext "subjectAltName=DNS:${host}" -keyout /m/key.pem -out /m/cert.pem 2>/dev/null` +
      " && openssl pkcs12 -export -inkey /m/key.pem -in /m/cert.pem -out /m/gm.p12 -passout pass:changeit && chmod 644 /m/gm.p12 /m/cert.pem",
  ]);
  if (made.code !== 0) return null;
  const up = run("backend", "docker", [
    "run", "-d", "--name", host, "--network", "promptly", "-v", `${dir}:/certs:ro`,
    "-e", "GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=alice:testpass@mailtest.example,bob:testpass@mailtest.example -Dgreenmail.users.login=email -Dgreenmail.tls.keystore.file=/certs/gm.p12 -Dgreenmail.tls.keystore.password=changeit",
    image,
  ]);
  if (up.code !== 0) return null;
  // Ready when its own API answers.
  const probe = `for i in $(seq 60); do python -c "import urllib.request; urllib.request.urlopen('http://${host}:8080/api/service/readiness', timeout=2)" 2>/dev/null && exit 0; sleep 1; done; exit 1`;
  const ready = run("backend", "docker", ["run", "--rm", "--network", "promptly", "--entrypoint", "sh", "promptly-backend:local", "-c", probe]);
  if (ready.code !== 0) {
    spawnSync("docker", ["rm", "-f", host], { stdio: "ignore", windowsHide: true });
    return null;
  }
  return host;
}

function stepBackend() {
  if (!has("docker")) return record("backend", "skip", {}, "docker isn't installed", 0);
  const pg = read("docker", ["ps", "--filter", "name=^Promptly-Postgres$", "--filter", "status=running", "--format", "{{.Names}}"]);
  if (!pg) return record("backend", "skip", {}, "the stack's Postgres (Promptly-Postgres) isn't running: docker compose up -d", 0);
  if (read("docker", ["image", "inspect", "promptly-backend:local", "--format", "{{.Id}}"]) === null) {
    return record("backend", "skip", {}, "no promptly-backend:local image: docker compose build backend", 0);
  }
  // The stack's own database password, passed straight through; never printed.
  const pw = read("docker", ["exec", "Promptly-Postgres", "printenv", "POSTGRES_PASSWORD"]) || "promptly";
  const base = `chk_${stamp.replace("-", "_").toLowerCase()}_${crypto.randomBytes(2).toString("hex")}`;
  const workers = OPT.workers || Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
  const cache = path.join(ROOT, ".check", "pip-cache");
  fs.mkdirSync(cache, { recursive: true });
  const mail = mailServer(base.replace(/_/g, "-"));
  // The image may predate the two test plugins: add them for this run only.
  const inner = [
    "python -c 'import xdist, pytest_timeout' 2>/dev/null || pip install -q --disable-pip-version-check pytest-xdist==3.6.1 pytest-timeout==2.3.1",
    `python -m pytest -n ${workers} --dist loadfile -p no:cacheprovider -q -rs --junitxml=/out/backend-junit.xml ${OPT.tests}`,
  ].join(" && ");
  const r = run("backend", "docker", [
    "run", "--rm", "--network", "promptly",
    "-v", `${path.join(ROOT, "backend")}:/app`,
    "-v", `${path.join(ROOT, "home-box")}:/home-box`,
    // Read by a few tests that check the app against the map scripts and
    // the frontend's own data files; without them those tests skip.
    "-v", `${path.join(ROOT, "maps")}:/maps:ro`,
    "-v", `${path.join(ROOT, "frontend", "src")}:/frontend/src:ro`,
    "-v", `${OUT}:/out`,
    "-v", `${cache}:/root/.cache/pip`,
    "-w", "/app",
    "-e", "PYTHONPATH=/app",
    "-e", "PYTHONDONTWRITEBYTECODE=1",
    "-e", `TEST_DATABASE_URL=postgresql+asyncpg://promptly:${encodeURIComponent(pw)}@postgres:5432/${base}`,
    ...(mail ? ["-e", `MAIL_TEST_HOST=${mail}`, "-e", "SSL_CERT_FILE=/out/mail/cert.pem"] : []),
    "--entrypoint", "sh", "promptly-backend:local", "-c", inner,
  ]);
  if (mail) spawnSync("docker", ["rm", "-f", mail], { stdio: "ignore", windowsHide: true });
  // Drop this run's databases whatever happened.
  const names = read("docker", ["exec", "Promptly-Postgres", "psql", "-U", "promptly", "-d", "postgres", "-Atc", `select datname from pg_database where datname like '${base}%'`]);
  for (const n of (names ?? "").split("\n").filter(Boolean)) {
    spawnSync("docker", ["exec", "Promptly-Postgres", "psql", "-U", "promptly", "-d", "postgres", "-c", `drop database if exists "${n}" with (force)`], { stdio: "ignore", windowsHide: true });
  }
  const t = junitTotals(path.join(OUT, "backend-junit.xml"));
  if (!t) return record("backend", "fail", {}, "pytest didn't finish (no result file): see the log", r.seconds, r.log);
  const bad = t.failed > 0 || r.code !== 0;
  const note = bad ? `${t.failed} failed${t.names.length ? `: ${t.names.slice(0, 3).join(", ")}${t.names.length > 3 ? " …" : ""}` : ` (exit ${r.code})`}` : `${t.tests - t.skipped} passed, ${t.skipped} skipped, ${workers} at a time`;
  const partial = OPT.tests ? "only some tests (--tests)" : undefined;
  record("backend", bad ? "fail" : "pass", { tests: t.tests, failed: t.failed, skipped: t.skipped, partial }, partial ? `${note} [${partial}: doesn't count towards a release]` : note, r.seconds, r.log);
}

// ---------------------------------------------------------------- frontend
function stepFrontend() {
  if (!borrow(path.join("frontend", "node_modules"))) return record("frontend", "skip", {}, "frontend/node_modules is missing: cd frontend && npm install", 0);
  const fe = path.join(ROOT, "frontend");
  const tsc = run("frontend", npx, ["tsc", "--noEmit"], { cwd: fe, shell: WIN });
  const json = path.join(OUT, "vitest.json");
  const vit = run("frontend", npx, ["vitest", "run", "--reporter=json", `--outputFile=${json}`], { cwd: fe, shell: WIN });
  let t = { tests: 0, failed: 0, skipped: 0 };
  try {
    const j = JSON.parse(fs.readFileSync(json, "utf8"));
    t = { tests: j.numTotalTests ?? 0, failed: j.numFailedTests ?? 0, skipped: (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0) };
  } catch { /* the exit code decides */ }
  const problems = [];
  if (tsc.code !== 0) problems.push("type errors (tsc)");
  if (vit.code !== 0) problems.push(`${t.failed || "some"} unit tests failed`);
  record("frontend", problems.length ? "fail" : "pass", { tests: t.tests + 1, failed: (tsc.code !== 0 ? 1 : 0) + t.failed, skipped: t.skipped }, problems.join("; ") || `types clean, ${t.tests - t.skipped} unit tests passed`, tsc.seconds + vit.seconds, tsc.log);
}

// ----------------------------------------------------------------- android
function stepAndroid() {
  const dir = path.join(ROOT, "android");
  const props = path.join(dir, "local.properties");
  if (!fs.existsSync(props)) {
    const main = mainCheckout();
    const theirs = main && main !== ROOT ? path.join(main, "android", "local.properties") : null;
    if (theirs && fs.existsSync(theirs)) fs.copyFileSync(theirs, props); // ignored by git
    else if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) return record("android", "skip", {}, "no Android SDK here (android/local.properties or ANDROID_HOME)", 0);
  }
  // One of the unit tests runs the web vault's own code beside the app's.
  borrow(path.join("frontend", "node_modules"));
  const gradle = path.join(dir, WIN ? "gradlew.bat" : "gradlew");
  run("android", gradle, ["--stop"], { cwd: dir, shell: WIN });
  const r = run("android", gradle, [":app:testServerDebugUnitTest", ":suite:testDebugUnitTest", "--console=plain"], { cwd: dir, shell: WIN });
  const t = { tests: 0, failed: 0, skipped: 0, names: [] };
  for (const sub of [["app", "build", "test-results", "testServerDebugUnitTest"], ["suite", "build", "test-results", "testDebugUnitTest"]]) {
    const d = path.join(dir, ...sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".xml"))) {
      const one = junitTotals(path.join(d, f));
      if (one) { t.tests += one.tests; t.failed += one.failed; t.skipped += one.skipped; t.names.push(...one.names); }
    }
  }
  const bad = r.code !== 0 || t.failed > 0;
  record("android", bad ? "fail" : "pass", { tests: t.tests, failed: t.failed, skipped: t.skipped }, bad ? (t.names.slice(0, 3).join(", ") || `gradle exit ${r.code}`) : `${t.tests - t.skipped} passed, ${t.skipped} skipped`, r.seconds, r.log);
}

// --------------------------------------------------------------------- e2e
// The browser suite needs a running Promptly. By default that's a private
// copy built from THIS checkout (scripts/stack.sh: its own containers, port
// and throwaway data, with the upload service, calls and a stub map switched
// on so nothing has to be skipped). It's kept between runs, so only the
// first build is slow; `scripts/stack.sh down check` removes it. With
// E2E_BASE_URL set, that stack is tested instead, as it is.
function gitBash() {
  if (!WIN) return has("bash") ? "bash" : null;
  const git = read("where", ["git"])?.split(/\r?\n/)[0];
  const tries = [git ? path.join(path.dirname(path.dirname(git)), "bin", "bash.exe") : null, path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")];
  return tries.find((t) => t && fs.existsSync(t)) ?? null; // never WSL's bash
}

function stepE2e() {
  if (!borrow(path.join("e2e", "node_modules"))) return record("e2e", "skip", {}, "e2e/node_modules is missing: cd e2e && npm install && npx playwright install chromium", 0);
  borrow(path.join("frontend", "node_modules"));
  const json = path.join(OUT, "e2e.json");
  const pw = ["--reporter=line,json", "--retries=1"];
  const env = { PLAYWRIGHT_JSON_OUTPUT_NAME: json };
  let r;
  let where;
  if (process.env.E2E_BASE_URL) {
    where = `${process.env.E2E_BASE_URL} (as it is: not necessarily this checkout's code)`;
    r = run("e2e", npx, ["playwright", "test", ...pw], { cwd: path.join(ROOT, "e2e"), shell: WIN, env });
  } else {
    const bash = gitBash();
    if (!bash) return record("e2e", "skip", {}, "needs bash (Git for Windows) to build the private test stack, or set E2E_BASE_URL", 0);
    const stack = "scripts/stack.sh";
    const up = run("e2e", bash, [stack, "up", "check", "--e2e", "--with", "calls"], { pipe: true });
    if (up.code !== 0) return record("e2e", "fail", {}, "the private test stack didn't come up: see the log", up.seconds, up.log);
    where = "a private stack built from this checkout";
    r = run("e2e", bash, [stack, "e2e", "check", ...pw], { env, pipe: true });
    r.seconds += up.seconds;
  }
  let t = null;
  try {
    const st = JSON.parse(fs.readFileSync(json, "utf8")).stats;
    t = { tests: st.expected + st.unexpected + st.flaky + st.skipped, failed: st.unexpected, skipped: st.skipped, flaky: st.flaky };
  } catch { /* below */ }
  if (!t) return record("e2e", "fail", {}, "the browser suite didn't finish: see the log", r.seconds, r.log);
  const partial = process.env.E2E_BASE_URL ? "a stack that was already running, not this code" : undefined;
  record("e2e", t.failed ? "fail" : "pass", { ...t, partial }, `${t.tests - t.failed - t.skipped} passed, ${t.skipped} skipped${t.flaky ? `, ${t.flaky} passed only on a second try` : ""}${t.failed ? `, ${t.failed} failed` : ""}, on ${where}${partial ? " [doesn't count towards a release]" : ""}`, r.seconds, r.log);
}

// -------------------------------------------------------------------- main
const BEFORE = fingerprint();
console.log(`Promptly check: ${chosen.join(", ")}   (output: ${path.relative(process.cwd(), OUT) || OUT})`);
const todo = { static: stepStatic, backend: stepBackend, frontend: stepFrontend, android: stepAndroid, e2e: stepE2e };
for (const s of chosen) {
  try { todo[s](); } catch (e) { record(s, "fail", {}, `the check itself broke: ${e.message}`, 0); }
}
giveBack();

/** What the release gate compares: the commit, and any uncommitted edits to
 *  tracked files (so "passed, then changed" isn't a pass). */
function fingerprint(root = ROOT) {
  const head = read("git", ["rev-parse", "HEAD"], { cwd: root }) ?? "";
  const diff = spawnSync("git", ["diff", "HEAD", "--", ".", ":(exclude)CHANGELOG.md", ":(exclude)VERSION", ":(exclude)frontend/package.json", ":(exclude).claude"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true }).stdout ?? "";
  return { commit: head, tree: crypto.createHash("sha256").update(diff.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16) };
}

/** The release gate: does the last check cover exactly this code? */
function gate() {
  const file = path.join(ROOT, ".check", "last.json");
  const say = (ok, lines) => {
    console.log(lines.map((l) => `  ${l}`).join("\n"));
    return ok ? 0 : 3;
  };
  if (!fs.existsSync(file)) return say(false, ["No check has been run on this checkout.", "Run scripts/check first."]);
  let last;
  try { last = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return say(false, ["The last check's result can't be read. Run scripts/check again."]); }
  const now = fingerprint();
  if (last.commit !== now.commit || last.tree !== now.tree) {
    return say(false, [`The last check ran on different code (commit ${String(last.commit).slice(0, 8)}${last.tree !== now.tree && last.commit === now.commit ? ", before later edits" : ""}).`, "Run scripts/check again."]);
  }
  if (last.changed_during) return say(false, ["The code changed while the last check was running, so it doesn't say anything about this code.", "Run scripts/check again."]);
  // The newest full result of each step on this code (steps run separately add up).
  const steps = (last.steps ?? []).filter((r) => !r.partial);
  const failedSteps = steps.filter((r) => r.status === "fail").map((r) => `${r.step} (${r.note ?? "failed"})`);
  if (failedSteps.length) return say(false, [`The last check failed: ${failedSteps.join("; ")}`]);
  const missing = REQUIRED.filter((s) => !steps.some((r) => r.step === s && r.status === "pass"));
  if (missing.length) {
    const how = missing.length === 1 && missing[0] === "e2e" ? "Run scripts/check --only e2e (the browser suite, about 45 minutes)." : `Run scripts/check (it needs ${REQUIRED.join(", ")} to pass).`;
    return say(false, [`Not checked on this code: ${missing.join(", ")}.`, how]);
  }
  const lines = [`Checked on this code: ${steps.filter((r) => r.status === "pass").map((r) => `${r.step} ${r.tests ?? ""}`.trim()).join(", ")} passed.`];
  const optional = STEPS.filter((s) => !steps.some((r) => r.step === s && r.status === "pass"));
  if (optional.length) lines.push(`NOT RUN: ${optional.join(", ")}. This release goes out without them.`);
  return say(true, lines);
}

const failed = results.filter((r) => r.status === "fail");
const notRun = STEPS.filter((s) => !results.some((r) => r.step === s && r.status !== "skip"));
const AFTER = fingerprint();
const changedDuring = AFTER.commit !== BEFORE.commit || AFTER.tree !== BEFORE.tree;
const summary = { at: new Date().toISOString(), ...BEFORE, passed: failed.length === 0, steps: results, not_run: notRun, required: REQUIRED, out: path.relative(ROOT, OUT), ...(changedDuring ? { changed_during: true } : {}) };
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
// last.json is what the gate reads: each step's newest full result on this
// exact code. Steps this run didn't touch keep the result an earlier run
// gave them, as long as that run was on the same code. A narrowed run
// (partial) is never written over a full one.
const carried = [];
{
  const file = path.join(ROOT, ".check", "last.json");
  let before = null;
  try { before = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
  const same = before && !before.changed_during && !changedDuring && before.commit === BEFORE.commit && before.tree === BEFORE.tree;
  const full = results.filter((r) => !r.partial && r.status !== "skip");
  const kept = same ? (before.steps ?? []).filter((r) => !r.partial && !full.some((n) => n.step === r.step)) : [];
  carried.push(...kept);
  const merged = { ...summary, steps: [...kept, ...full], passed: [...kept, ...full].every((r) => r.status !== "fail") };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
}

const w = (s, n) => String(s ?? "").padEnd(n);
console.log(`\n${w("step", 10)}${w("result", 8)}${w("tests", 8)}${w("failed", 8)}${w("skipped", 9)}${w("time", 8)}note`);
for (const r of results) {
  const time = r.seconds >= 60 ? `${Math.floor(r.seconds / 60)}m${String(r.seconds % 60).padStart(2, "0")}s` : `${r.seconds}s`;
  console.log(`${w(r.step, 10)}${w(r.status.toUpperCase(), 8)}${w(r.tests ?? "-", 8)}${w(r.failed ?? "-", 8)}${w(r.skipped ?? "-", 9)}${w(time, 8)}${r.note ?? ""}`);
}
if (notRun.length) console.log(`\nNot run: ${notRun.join(", ")}`);
if (carried.length) console.log(`From earlier runs on this same code: ${carried.map((r) => `${r.step} ${r.status === "pass" ? "passed" : r.status === "fail" ? "FAILED" : r.status}`).join(", ")}`);
if (changedDuring) console.log("\nThe code changed while this ran: the result doesn't count towards a release.");
console.log(failed.length ? `\nFAILED: ${failed.map((f) => f.step).join(", ")}. Logs in ${path.relative(process.cwd(), OUT) || OUT}` : `\nAll ${results.filter((r) => r.status === "pass").length} steps that ran passed.`);
process.exit(failed.length ? 1 : 0);
