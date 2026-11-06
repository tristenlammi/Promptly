// The vault's own browser suite: Chromium, Firefox and WebKit against the isolated
// stack, with service workers ON (the main suite blocks them).
//   cd e2e && npx playwright test --config passwords.config.ts
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PW_E2E_URL ?? "http://localhost:8092";

export default defineConfig({
  testDir: "./passwords-tests",
  globalSetup: "./passwords-tests/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: "./test-results-passwords",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-passwords" }]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 860 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 860 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 860 } } },
  ],
});
