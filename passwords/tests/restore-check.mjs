// Plan 5.6 and 13.3: a restored database dump can still be unlocked. Runs a real backup on the
// isolated stack, restores it into a second database, starts a second backend on that database,
// and then has the real client unlock against it. Only touches the promptly-pw stack.
//   cd frontend && node ../passwords/tests/restore-check.mjs prepare
//   PW_STACK_URL=http://localhost:8093 ... (driven by the test named in REPORT.md)
import { execFileSync, spawnSync } from "node:child_process";

const BACKEND = "PromptlyPw-Backend";
const PG = "PromptlyPw-Postgres";
const DB = "promptly_restore_check";
const NAME = "PromptlyPw-RestoreCheck";

const sh = (args, input) => execFileSync("docker", args, { input, encoding: "latin1", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 30 });

export function backup() {
  const made = sh(["exec", "-i", BACKEND, "python"], `
import asyncio
import app.db_models
from app.backups import service
async def main():
    run = await service.run_backup("manual")
    print("BACKUP", run.status, run.filename)
asyncio.run(main())
`);
  const line = made.split(/\r?\n/).find((l) => l.startsWith("BACKUP "));
  if (!line?.includes(" ok ")) throw new Error(made);
  return line.split(" ")[2];
}

export function restore(file) {
  sh(["exec", PG, "psql", "-U", "promptly", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DB}`]);
  sh(["exec", PG, "psql", "-U", "promptly", "-d", "postgres", "-c", `CREATE DATABASE ${DB}`]);
  const dump = execFileSync("docker", ["exec", BACKEND, "cat", `/app/backups/${file}`], { maxBuffer: 1 << 30 });
  const r = spawnSync("docker", ["exec", "-i", PG, "pg_restore", "-U", "promptly", "-d", DB, "--no-owner"], { input: dump, encoding: "latin1", maxBuffer: 1 << 30 });
  if (r.status !== 0 && !/errors ignored/.test(r.stderr)) throw new Error(r.stderr.slice(0, 2000));
  sh(["exec", BACKEND, "rm", "-f", `/app/backups/${file}`]);
}

/** A second backend, same image and secrets, on the restored database. */
export function start() {
  spawnSync("docker", ["rm", "-f", NAME]);
  const env = sh(["inspect", BACKEND, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]).split(/\r?\n/).filter(Boolean);
  const args = ["run", "-d", "--name", NAME, "--network", "promptly-pw", "-p", "127.0.0.1:8093:8000"];
  for (const e of env) {
    if (/^(PATH|LANG|GPG_KEY|PYTHON|HOME)/.test(e)) continue;
    if (e.startsWith("DATABASE_URL=")) args.push("-e", e.replace(/\/[^/?]+(\?|$)/, `/${DB}$1`));
    else args.push("-e", e);
  }
  args.push("promptly-pw-backend:local", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000");
  sh(args);
}

export function stop() {
  spawnSync("docker", ["rm", "-f", NAME]);
  spawnSync("docker", ["exec", PG, "psql", "-U", "promptly", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DB}`]);
}
