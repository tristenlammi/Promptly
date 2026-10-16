// A pure-function check run by the Playwright runner (the frontend has no
// unit-test runner of its own): folders dragged in keep their structure
// (WP-8.2). Browsers can't fake a dropped *folder* in a real drop event, so
// the walker is driven with entry objects shaped like Chrome's.
import { expect, test } from "@playwright/test";

import { treeFromDrop, treeFromPicked } from "../../frontend/src/lib/folderTree";

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, bad: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (es: Entry[]) => void, bad: (e: unknown) => void) => void };
};

const file = (name: string, body = "x"): Entry => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok(new File([body], name)),
});

/** A folder whose reader hands its children over two at a time, then an
 *  empty batch — the way Chrome batches big folders. */
const dir = (name: string, children: Entry[]): Entry => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let at = 0;
    return {
      readEntries: (ok) => {
        const batch = children.slice(at, at + 2);
        at += 2;
        ok(batch);
      },
    };
  },
});

const drop = (entries: Entry[]) =>
  ({
    items: entries.map((e) => ({ kind: "file", webkitGetAsEntry: () => e })),
    files: [],
  }) as unknown as DataTransfer;

test("a dropped folder tree keeps its folders, and its clutter stays behind", async () => {
  const { files, hasFolders } = await treeFromDrop(
    drop([
      dir("Holiday", [
        file("plan.txt"),
        file(".DS_Store"),
        dir("Day 1", [file("a.jpg"), file("b.jpg"), file("c.jpg"), file("._a.jpg")]),
        dir("Empty", []),
      ]),
      file("loose.pdf"),
    ])
  );
  expect(hasFolders).toBe(true);
  expect(files.map((t) => `${t.dir}|${t.file.name}`).sort()).toEqual([
    "Holiday/Day 1|a.jpg",
    "Holiday/Day 1|b.jpg",
    "Holiday/Day 1|c.jpg",
    "Holiday|plan.txt",
    "|loose.pdf",
  ]);
});

test("loose files alone are just files", async () => {
  const { files, hasFolders } = await treeFromDrop(drop([file("one.txt"), file("two.txt")]));
  expect(hasFolders).toBe(false);
  expect(files.map((t) => t.dir)).toEqual(["", ""]);
});

test("a picked folder's paths come from webkitRelativePath", () => {
  const f = new File(["x"], "a.jpg");
  Object.defineProperty(f, "webkitRelativePath", { value: "Holiday/Day 1/a.jpg" });
  expect(treeFromPicked([f])).toEqual([{ file: f, dir: "Holiday/Day 1" }]);
});
