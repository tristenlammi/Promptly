// A pure-function check run by the Playwright runner (the frontend has no
// unit-test runner of its own): the answer page's path walk (logic.ts) must
// give the same path, the same kept answers and the same first "needs an
// answer" as the server's re-walk (backend/app/forms/answering.py). Both
// sides run the cases in backend/tests/data/forms_path_cases.json.
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import type { FormDefinition } from "../../frontend/src/api/forms";
import { answersOnPath, sectionProblems, walkPath, type Answers } from "../../frontend/src/components/forms/logic";
import { sectionsOf } from "../../frontend/src/components/forms/model";

interface Case {
  name: string;
  definition: FormDefinition;
  answers: Answers;
  path: number[];
  kept: string[] | null;
  error: string | null;
}

const cases: Case[] = JSON.parse(
  readFileSync(new URL("../../backend/tests/data/forms_path_cases.json", import.meta.url), "utf-8")
).cases;

for (const c of cases) {
  test(`path parity: ${c.name}`, () => {
    const path = walkPath(c.definition, c.answers);
    expect(path).toEqual(c.path);
    const sections = sectionsOf(c.definition);
    // The first problem in form order along the path (what the server reports).
    let first: string | null = null;
    for (const i of path) {
      const probs = sectionProblems(sections[i], c.answers);
      const id = sections[i].items.map((q) => q.id).find((qid) => probs[qid]);
      if (id) {
        first = id;
        break;
      }
    }
    expect(first).toBe(c.error);
    if (c.kept) expect(Object.keys(answersOnPath(c.definition, c.answers, path)).sort()).toEqual([...c.kept].sort());
  });
}

test("there are parity cases", () => {
  expect(cases.length).toBeGreaterThan(10);
});
