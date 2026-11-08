// Unit tests for the vault's core (crypto, sync, importers, autofill), small
// shared libraries (src/lib) and the voice engine's audio pipeline (rtc). They
// run in Node with no browser and no Promptly stack: `npx vitest run`.
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["src/passwords/**/*.test.ts", "src/lib/**/*.test.ts", "src/rtc/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
