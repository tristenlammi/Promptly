import { readFileSync, writeFileSync } from "node:fs";

import { expect, ready, stamp, test } from "../fixtures";

test.describe("import & export", () => {
  test("a ChatGPT export imports from Account settings, and a retry skips it", async ({ bob: page }, info) => {
    const title = `Imported trip ${stamp}`;
    const chatgpt = [
      {
        title,
        conversation_id: `e2e-${stamp}`,
        current_node: "a2",
        mapping: {
          root: { message: null, parent: null, children: ["u1"] },
          u1: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["Plan a trip"] } }, parent: "root", children: ["a1", "a2"] },
          a1: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Rejected draft"] } }, parent: "u1", children: [] },
          a2: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Kept answer"] } }, parent: "u1", children: [] },
        },
      },
    ];
    const file = info.outputPath("conversations.json");
    writeFileSync(file, JSON.stringify(chatgpt));

    await page.goto("/account/data");
    await ready(page);
    const importOnce = async () => {
      await page.getByRole("button", { name: "Import conversations" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.locator('input[type="file"]').setInputFiles(file);
      await dialog.getByRole("button", { name: "Import", exact: true }).click();
      return dialog;
    };
    let dialog = await importOnce();
    await expect(dialog.getByText("1 conversation imported")).toBeVisible();
    await expect(dialog.getByRole("link", { name: title })).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    // R-309: importing the same file again doesn't duplicate it.
    dialog = await importOnce();
    await expect(dialog.getByText("0 conversations imported")).toBeVisible();
    await expect(dialog.getByText("1 already imported")).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    // R-310: everything comes back out in one re-importable file — with
    // the branch the user kept (R-306).
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export all conversations" }).click();
    const body = JSON.parse(readFileSync(await (await download).path(), "utf-8"));
    expect(body.format).toBe("promptly.conversations");
    const conv = body.conversations.find((c: { conversation: { title: string } }) => c.conversation.title === title);
    expect(conv.messages.map((m: { content: string }) => m.content)).toEqual(["Plan a trip", "Kept answer"]);
  });
});
