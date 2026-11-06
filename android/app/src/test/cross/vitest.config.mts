// Runs the TypeScript side of the cross-device test, from frontend/ so its node_modules
// resolve. Started by CrossDeviceTest.kt; no imports, since this file sits outside frontend.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  root: path.resolve(here, "../../../../../frontend"),
  test: {
    dir: here,
    include: ["cross.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 180_000,
  },
};
