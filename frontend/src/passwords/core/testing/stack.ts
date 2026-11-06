// Integration tests talk to the isolated :8092 stack. Users are throwaway, created
// by a script piped into the backend container, with a random login password that
// nothing else uses. Never runs against anything but the local test stack.
import { execFileSync } from "node:child_process";

export const BASE_URL = process.env.PW_STACK_URL ?? "http://localhost:8092";
export const BACKEND = process.env.PW_BACKEND ?? "PromptlyPw-Backend";
export const stackEnabled = !!process.env.PW_STACK_URL;

if (stackEnabled && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE_URL)) {
  throw new Error("Vault integration tests only run against a local stack");
}

const SCRIPT = `
import asyncio, json, os, secrets, uuid
import app.db_models
from app.auth.models import User
from app.auth.utils import create_access_token, hash_password
from app.database import SessionLocal

async def main():
    out = []
    async with SessionLocal() as db:
        for tag in os.environ["PW_USERS"].split(","):
            suffix = uuid.uuid4().hex[:10]
            password = "It-" + secrets.token_urlsafe(16) + "!9"
            u = User(email=f"pw-it-{tag}-{suffix}@example.com", username=f"pwit{tag}{suffix}", password_hash=hash_password(password), role=os.environ.get("PW_ROLE", "user"))
            db.add(u)
            await db.flush()
            out.append({"tag": tag, "id": str(u.id), "username": u.username, "password": password, "token": create_access_token(u.id, token_version=u.token_version)})
        await db.commit()
    print("PW_RESULT " + json.dumps(out))

asyncio.run(main())
`;

export type TestUser = { tag: string; id: string; username: string; password: string; token: string };

export function makeUsers(...tags: string[]): TestUser[] {
  const out = execFileSync("docker", ["exec", "-i", "-e", `PW_USERS=${tags.join(",")}`, BACKEND, "python", "-"], {
    input: SCRIPT,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith("PW_RESULT "));
  if (!line) throw new Error(`User seed printed no result: ${out}`);
  return JSON.parse(line.slice("PW_RESULT ".length));
}

export function dockerText(args: string[], input?: string): string {
  return execFileSync("docker", args, { input, encoding: "latin1", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 1024 });
}
