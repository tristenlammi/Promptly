import type { CodeCheck } from "@/api/study";

/*
 * Runs a learner's code against a step's checks, in the browser.
 *
 * The code never runs in this page. It is posted to /study-runner.html in a
 * hidden <iframe sandbox="allow-scripts">: a document with no origin (no
 * cookies, no storage, no way to call Promptly as you) and, by its own
 * Content-Security-Policy, no network. Inside it the code runs in a Worker
 * that is stopped after a few seconds, so an endless loop can't hang the
 * lesson. If the runner page can't start (an old proxy config without its
 * policy, a browser that blocks it), nothing runs and we say so.
 */

export interface RunResult {
  /** check id → passed */
  results: Record<string, boolean>;
  /** check id → what the code gave back, as text */
  got: Record<string, string>;
  /** What the code printed. */
  output: string;
  /** Why it stopped, if it did (a mistake in the code, or it took too long). */
  error: string;
  line?: number | null;
  /** The runner itself couldn't start: nothing was run. */
  unavailable?: boolean;
}

const RUNNER = "/study-runner.html";
const START_MS = 6000;
const RUN_MS = 3000;

let seq = 0;

function allFailed(checks: CodeCheck[], error: string, unavailable = false): RunResult {
  return { results: Object.fromEntries(checks.map((c) => [c.id, false])), got: {}, output: "", error, unavailable };
}

/** Run ``code`` then each check. Always resolves; never throws. A fresh sandbox every time. */
export function runCode(code: string, checks: CodeCheck[], timeout = RUN_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(allFailed(checks, "Code can't be run here.", true));
    const id = `r${(seq += 1)}`;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    let settled = false;
    let sent = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(startTimer);
      clearTimeout(runTimer);
      frame.remove();
      resolve(r);
    };
    let runTimer = 0;
    const startTimer = window.setTimeout(
      () => finish(allFailed(checks, "The code runner couldn't start on this server. Your code wasn't run.", true)),
      START_MS,
    );
    function onMessage(ev: MessageEvent) {
      if (ev.source !== frame.contentWindow) return;
      const m = ev.data as { type?: string; id?: string; result?: RunResult } | null;
      if (!m || typeof m !== "object") return;
      if (m.type === "study-runner-ready" && !sent) {
        sent = true;
        clearTimeout(startTimer);
        // The frame has no origin of its own, so "*" is the only target that reaches it.
        frame.contentWindow?.postMessage({ type: "study-run", id, code, checks, timeout }, "*");
        // The runner stops the code itself; this is for a runner that never answers.
        runTimer = window.setTimeout(() => finish(allFailed(checks, "Your code took too long. Is there a loop that never ends?")), timeout + 2500);
      } else if (m.type === "study-result" && m.id === id && m.result) {
        finish(tidy(m.result, checks));
      }
    }
    window.addEventListener("message", onMessage);
    frame.src = RUNNER;
    document.body.appendChild(frame);
  });
}

/** Whatever came back, in the shape we expect (the sandbox ran someone's code: trust nothing in it). */
export function tidy(raw: unknown, checks: CodeCheck[]): RunResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const res = (r.results && typeof r.results === "object" ? r.results : {}) as Record<string, unknown>;
  const got = (r.got && typeof r.got === "object" ? r.got : {}) as Record<string, unknown>;
  return {
    results: Object.fromEntries(checks.map((c) => [c.id, res[c.id] === true])),
    got: Object.fromEntries(checks.filter((c) => typeof got[c.id] === "string").map((c) => [c.id, String(got[c.id]).slice(0, 200)])),
    output: typeof r.output === "string" ? r.output.slice(0, 4000) : "",
    error: typeof r.error === "string" ? r.error.slice(0, 500) : "",
    line: typeof r.line === "number" ? r.line : null,
  };
}

export const passedAll = (r: RunResult | null | undefined, checks: CodeCheck[]) => !!r && checks.every((c) => r.results[c.id] === true);

/** The step's own answer must pass its own checks, or the step proves nothing. */
export async function isSound(solution: string, checks: CodeCheck[]): Promise<boolean | null> {
  const r = await runCode(solution, checks);
  if (r.unavailable) return null;
  return passedAll(r, checks);
}
