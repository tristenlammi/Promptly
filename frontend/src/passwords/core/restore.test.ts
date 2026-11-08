// Plan 5.6: a restored dump can be unlocked, and a different SECRET_KEY doesn't matter to the
// vault. A real backup from the isolated stack, restored into a second database, served by a
// second backend with a new SECRET_KEY, unlocked by the real client.
//   PW_STACK_URL=http://localhost:8092 PW_RESTORE=1 npx vitest run src/passwords/core/restore.test.ts
import { execFileSync, spawnSync } from "node:child_process";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ApiError, VaultApi } from "./api";
import { randomBytes, b64u } from "./bytes";
import { newBody } from "./model";
import { MemoryStore } from "./store";
import { BACKEND, BASE_URL, makeUsers } from "./testing/stack";
import { VaultClient } from "./vault";

const PG = "PromptlyPw-Postgres";
const DB = "promptly_restore_check";
const NAME = "PromptlyPw-RestoreCheck";
const PORT = 8093;
const MASTER = "correct horse battery staple 7!";

const docker = (args: string[], input?: string) => execFileSync("docker", args, { input, encoding: "latin1", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 30 });

vi.setConfig({ testTimeout: 300_000 });

function startRestored(): void {
  spawnSync("docker", ["rm", "-f", NAME]);
  const env = docker(["inspect", BACKEND, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]).split(/\r?\n/).filter(Boolean);
  const binds = JSON.parse(docker(["inspect", BACKEND, "--format", "{{json .HostConfig.Binds}}"])) as string[];
  const networks = Object.keys(JSON.parse(docker(["inspect", BACKEND, "--format", "{{json .NetworkSettings.Networks}}"])) as Record<string, unknown>);
  const args = ["run", "-d", "--name", NAME, "--network", networks[0], "-p", `127.0.0.1:${PORT}:8000`];
  for (const b of binds) {
    // Its uploads and backups stay its own: this is only about the database.
    if (b.includes("/app/app") || b.includes("/app/alembic") || b.includes("/app/alembic.ini")) args.push("-v", b);
  }
  for (const e of env) {
    if (/^(PATH|LANG|GPG_KEY|PYTHON)/.test(e)) continue;
    if (e.startsWith("DATABASE_URL=")) args.push("-e", e.replace(/\/[^/?]+(\?|$)/, `/${DB}$1`));
    else if (e.startsWith("SECRET_KEY=")) args.push("-e", `SECRET_KEY=${b64u(randomBytes(48))}`);
    else args.push("-e", e);
  }
  args.push(docker(["inspect", BACKEND, "--format", "{{.Config.Image}}"]).trim());
  docker(args);
}

describe.skipIf(!process.env.PW_STACK_URL || !process.env.PW_RESTORE)("a restored backup", () => {
  afterAll(() => {
    spawnSync("docker", ["rm", "-f", NAME]);
    spawnSync("docker", ["exec", PG, "psql", "-U", "promptly", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DB}`]);
    // Removing a running backend container can take a while on a busy machine.
  }, 60_000);

  it("unlocks and reads back, with a new SECRET_KEY", async () => {
    const [u] = makeUsers("restored");
    const live = new VaultClient(new VaultApi(BASE_URL, () => u.token), new MemoryStore());
    const { secretKey } = await live.setup(MASTER);
    const vid = await live.personalVaultId();
    await live.saveNew(vid, newBody("login", "Survives a restore", { username: "ana", password: "restored-Pw-1!" }));
    await live.sync();

    // A real backup, the server's own way.
    const made = docker(
      ["exec", "-i", BACKEND, "python"],
      `
import asyncio
import app.db_models
from app.backups import service
async def main():
    run = await service.run_backup("manual")
    print("BACKUP", run.status, run.filename)
asyncio.run(main())
`,
    );
    const line = made.split(/\r?\n/).find((l) => l.startsWith("BACKUP "));
    expect(line, made).toContain(" ok ");
    const file = line!.split(" ")[2];

    docker(["exec", PG, "psql", "-U", "promptly", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DB}`]);
    docker(["exec", PG, "psql", "-U", "promptly", "-d", "postgres", "-c", `CREATE DATABASE ${DB}`]);
    const dump = execFileSync("docker", ["exec", BACKEND, "cat", `/app/backups/${file}`], { maxBuffer: 1 << 30 });
    const restored = spawnSync("docker", ["exec", "-i", PG, "pg_restore", "-U", "promptly", "-d", DB, "--no-owner"], { input: dump, encoding: "latin1", maxBuffer: 1 << 30 });
    expect(restored.status, restored.stderr.slice(0, 1000)).toBe(0);
    docker(["exec", BACKEND, "rm", "-f", `/app/backups/${file}`]);

    startRestored();
    const base = `http://localhost:${PORT}`;
    for (let i = 0; ; i++) {
      const up = await fetch(`${base}/api/health`).then((r) => r.status < 500).catch(() => false);
      if (up) break;
      if (i > 90) throw new Error(docker(["logs", "--tail", "30", NAME]));
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Live tokens were signed with the old SECRET_KEY, and don't work here.
    const stale = new VaultApi(base, () => u.token);
    await expect(stale.prelogin()).rejects.toBeInstanceOf(ApiError);
    const minted = docker(
      ["exec", "-i", NAME, "python"],
      `
import asyncio, uuid
import app.db_models
from app.auth.models import User
from app.auth.utils import create_access_token
from app.database import SessionLocal
async def main():
    async with SessionLocal() as db:
        user = await db.get(User, uuid.UUID("${u.id}"))
        print("TOKEN " + create_access_token(user.id, token_version=user.token_version))
asyncio.run(main())
`,
    );
    const token = minted.split(/\r?\n/).find((l) => l.startsWith("TOKEN "))!.slice(6);

    const device = new VaultClient(new VaultApi(base, () => token), new MemoryStore());
    await device.unlock(MASTER, secretKey);
    await device.sync();
    const item = device.allItems().find((i) => i.body.title === "Survives a restore");
    expect(item?.body.password).toBe("restored-Pw-1!");

    // And the wrong password still gets nothing.
    const wrong = new VaultClient(new VaultApi(base, () => token), new MemoryStore());
    await expect(wrong.unlock("not the password at all", secretKey)).rejects.toBeTruthy();
  });
});
