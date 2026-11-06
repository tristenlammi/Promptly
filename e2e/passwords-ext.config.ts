// The browser extension in Playwright's Chromium, with the real content scripts on
// local test pages against the isolated stack.
//   cd e2e && npx playwright test --config passwords-ext.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./passwords-ext",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: "./test-results-passwords",
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
