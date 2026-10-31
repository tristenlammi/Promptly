// Node runner for golden.ts — see the header there for the command.
import { readFileSync } from "node:fs";

import { checkGolden, checkInvariants } from "./golden.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: node <bundle> <path to test_item_flashcards_golden.json>");
  process.exit(2);
}
const fx = JSON.parse(readFileSync(path, "utf8"));
const errs = [...checkGolden(fx), ...checkInvariants()];
if (errs.length) {
  console.error(`golden: ${errs.length} difference(s)\n  ${errs.join("\n  ")}`);
  process.exit(1);
}
console.log(`golden: ${fx.steps.length}/${fx.steps.length} steps match; invariants hold`);
