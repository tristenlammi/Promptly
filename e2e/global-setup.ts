import crypto from "node:crypto";
import fs from "node:fs";

import {
  AUTH_DIR,
  BASE_URL,
  RUN_FILE,
  type RunInfo,
  seed,
  startMockModel,
  storageStateFile,
} from "./lib/stack";

export default async function globalSetup(): Promise<void> {
  const health = await fetch(`${BASE_URL}/api/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`Promptly isn't answering at ${BASE_URL} — start the stack (docker compose up -d) first.`);
  }

  startMockModel();

  // A fresh throwaway password per run, kept only in the gitignored .auth/.
  const password = `E2e-${crypto.randomBytes(12).toString("base64url")}!9`;
  const result = seed("setup", { E2E_PASSWORD: password });
  const run: RunInfo = { ...result, password };

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(RUN_FILE, JSON.stringify(run, null, 2));

  // Signed-in browser state per user: just the refresh cookie the app
  // trades for an access token on load (the access token lives in memory).
  const host = new URL(BASE_URL).hostname;
  for (const [name, user] of Object.entries(run.users)) {
    fs.writeFileSync(
      storageStateFile(name as keyof RunInfo["users"]),
      JSON.stringify({
        cookies: [
          {
            name: "promptly_refresh",
            value: user.refresh_token,
            domain: host,
            path: "/api/auth",
            expires: Math.floor(Date.now() / 1000) + 2 * 24 * 3600,
            httpOnly: true,
            secure: true,
            sameSite: "Strict",
          },
        ],
        origins: [],
      }),
    );
  }
}
