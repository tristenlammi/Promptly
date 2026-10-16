// Promptly end-to-end safety net (roadmap WP-1.1). Runs against the docker
// stack that's already up — it doesn't build or start Promptly itself.
//
//   cd e2e && npm install && npx playwright install chromium   (once)
//   npm test                                                    (every release)
//
// E2E_BASE_URL (default http://localhost:8091) picks the instance. The
// suite adds two users (e2e_alice, e2e_bob) and a disabled-between-runs
// "E2E Mock" model provider backed by a fake model container; see
// seed/seed.py and mock-llm/server.py.
import { defineConfig, devices } from "@playwright/test";

import { BASE_URL } from "./lib/stack";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One instance, one shared set of rate limits: keep the load polite.
  workers: 2,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    // Workspaces are desktop-only (≤768 px is the phone layout), and the
    // Files folder rail needs ≥1024 px.
    viewport: { width: 1366, height: 860 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 860 } } }],
});
