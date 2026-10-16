// Pure-function checks for the document editor (WP-4.1), run by the
// Playwright runner (the frontend has no unit-test runner of its own).
import { expect, test } from "@playwright/test";
import { Schema } from "../../frontend/node_modules/prosemirror-model/dist/index.js";
import { EditorState } from "../../frontend/node_modules/prosemirror-state/dist/index.js";

import { isFatalCollabError, saveChip } from "../../frontend/src/lib/editorSync";
import {
  afterRangeBlock,
  mapPendingRange,
  rangeText,
  rangeUnchanged,
  type PendingRange,
} from "../../frontend/src/lib/pendingRange";

test.describe("save chip (R-224)", () => {
  const base = { fatal: null, synced: true, status: "connected" as const, unsynced: 0 };

  test("typing while offline never reads as saved", () => {
    const chip = saveChip({ ...base, status: "disconnected", unsynced: 3 });
    expect(chip.kind).toBe("offline");
    expect(chip.label).toBe("Offline · 3 unsynced changes");
  });
  test("saving until the server acknowledges", () => {
    expect(saveChip({ ...base, unsynced: 1 }).label).toBe("Saving…");
    expect(saveChip(base).label).toBe("Saved");
  });
  test("a manual save only counts until the next edit", () => {
    const savedManuallyAt = new Date(1000);
    expect(saveChip({ ...base, status: "disconnected", unsynced: 2, savedManuallyAt, lastLocalEditAt: new Date(500) }).kind).toBe("saved");
    expect(saveChip({ ...base, status: "disconnected", unsynced: 2, savedManuallyAt, lastLocalEditAt: new Date(2000) }).kind).toBe("offline");
  });
  test("nothing is 'saved' before the server's copy arrives", () => {
    expect(saveChip({ ...base, synced: false, status: "connecting" }).kind).toBe("loading");
  });
});

test.describe("collab errors (R-221)", () => {
  test("only 403 / 404 are final", () => {
    expect(isFatalCollabError({ response: { status: 403 } })).toBe(true);
    expect(isFatalCollabError({ response: { status: 404 } })).toBe(true);
    for (const transient of [{ response: { status: 502 } }, { response: { status: 401 } }, new Error("Network Error"), null]) {
      expect(isFatalCollabError(transient)).toBe(false);
    }
  });
});

test.describe("AI rewrite range (R-222)", () => {
  const schema = new Schema({
    nodes: { doc: { content: "block+" }, paragraph: { group: "block", content: "text*" }, text: {} },
  });
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("Intro words here.")]),
    schema.node("paragraph", null, [schema.text("Rewrite this sentence.")]),
  ]);
  // The second paragraph's text: after <doc><p>Intro…</p><p>
  const start = 1 + "Intro words here.".length + 2;
  const range: PendingRange = { from: start, to: start + "Rewrite this sentence.".length, text: "Rewrite this sentence." };

  test("an edit before the range moves it instead of corrupting other text", () => {
    const state = EditorState.create({ doc });
    expect(rangeText(state.doc, range.from, range.to)).toBe(range.text);
    // Someone types at the very start of the document meanwhile.
    const tr = state.tr.insertText("NEW ", 1);
    const mapped = mapPendingRange(range, tr.mapping)!;
    expect(mapped.from).toBe(range.from + 4);
    expect(rangeUnchanged(tr.doc, mapped)).toBe(true);
    // The old absolute range would now cut across both paragraphs.
    expect(rangeText(tr.doc, range.from, range.to)).not.toBe(range.text);
  });

  test("an edit inside the range is caught, and Insert below goes after it", () => {
    const state = EditorState.create({ doc });
    const tr = state.tr.insertText("not ", range.from + "Rewrite ".length);
    const mapped = mapPendingRange(range, tr.mapping)!;
    expect(rangeUnchanged(tr.doc, mapped)).toBe(false);
    expect(afterRangeBlock(tr.doc, mapped)).toBe(tr.doc.content.size);
  });

  test("a deleted range is gone", () => {
    const state = EditorState.create({ doc });
    const tr = state.tr.delete(range.from - 1, range.to + 1);
    expect(mapPendingRange(range, tr.mapping)).toBeNull();
  });
});
