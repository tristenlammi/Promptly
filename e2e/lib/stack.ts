// Talks to the running docker stack: starts the fake model next to it and
// runs the seed script inside the backend container. Nothing here changes
// the stack's own containers or config.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const E2E_ROOT = path.resolve(here, "..");
export const AUTH_DIR = path.join(E2E_ROOT, ".auth");
export const RUN_FILE = path.join(AUTH_DIR, "run.json");

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8091";
export const BACKEND = process.env.E2E_BACKEND_CONTAINER ?? "Promptly-Backend";
const IMAGE = process.env.E2E_BACKEND_IMAGE ?? "promptly-backend:local";
const NETWORK = process.env.E2E_NETWORK ?? "promptly";
export const MOCK = "promptly-e2e-mock";

export type SeededUser = { id: string; email: string; username: string; refresh_token: string };
export type RunInfo = {
  provider_id: string;
  password: string;
  users: { alice: SeededUser; bob: SeededUser; carol: SeededUser; dana: SeededUser };
};

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function startMockModel(): void {
  try {
    docker(["rm", "-f", MOCK]);
  } catch {
    /* wasn't running */
  }
  docker([
    "run", "-d", "--name", MOCK, "--network", NETWORK,
    "--entrypoint", "python",
    "-v", `${path.join(E2E_ROOT, "mock-llm")}:/mock:ro`,
    IMAGE, "/mock/server.py",
  ]);
  // Ready = the backend can reach it by name, which is the path chat takes.
  const probe = `import urllib.request; urllib.request.urlopen("http://${MOCK}:8000/v1/models", timeout=2)`;
  for (let i = 0; i < 30; i++) {
    try {
      docker(["exec", BACKEND, "python", "-c", probe]);
      return;
    } catch {
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
    }
  }
  throw new Error(`The fake model (${MOCK}) never became reachable from ${BACKEND}.`);
}

export function stopMockModel(): void {
  try {
    docker(["rm", "-f", MOCK]);
  } catch {
    /* already gone */
  }
}

export function seed(action: "setup" | "teardown", env: Record<string, string> = {}): any {
  const script = fs.readFileSync(path.join(E2E_ROOT, "seed", "seed.py"), "utf8");
  const envArgs = Object.entries({ E2E_ACTION: action, ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const out = docker(["exec", "-i", ...envArgs, BACKEND, "python", "-"], script);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("E2E_RESULT "));
  if (!line) throw new Error(`Seed (${action}) printed no result:\n${out}`);
  return JSON.parse(line.slice("E2E_RESULT ".length));
}

export function readRun(): RunInfo {
  return JSON.parse(fs.readFileSync(RUN_FILE, "utf8"));
}

export function storageStateFile(user: keyof RunInfo["users"]): string {
  return path.join(AUTH_DIR, `${user}.json`);
}

/** The last chat request the fake model received (its full JSON body). */
export function lastModelRequest(): any {
  const read = `import urllib.request,sys; sys.stdout.write(urllib.request.urlopen("http://localhost:8000/last-request", timeout=5).read().decode())`;
  return JSON.parse(docker(["exec", MOCK, "python", "-c", read]));
}
