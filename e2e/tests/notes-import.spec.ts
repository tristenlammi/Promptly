import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, ready, stamp, test } from "../fixtures";
import { BACKEND, E2E_ROOT } from "../lib/stack";
import { card, notesReady, serverNotes } from "../lib/notes";

/** Promptly Notes (N1.6): moving in from Google Keep. A Keep Takeout (made
 *  here in the shape of a real one: a note's JSON and HTML, a picture, a
 *  recording, labels, a checklist, a note in Keep's trash) is imported from
 *  Notes' "Import from Google Keep"; the notes arrive with their colours,
 *  pins, labels, ticks, pictures and recordings; a second import adds
 *  nothing. */

function keepTakeout(tag: string): string {
  const py = `
import io, json, zipfile, base64, subprocess, tempfile, os
from PIL import Image
tag = ${JSON.stringify(tag)}
def jpeg():
    b = io.BytesIO(); Image.new("RGB", (40, 30), (220, 60, 60)).save(b, "JPEG"); return b.getvalue() + tag.encode()
def m4a():
    d = tempfile.mkdtemp(); p = os.path.join(d, "a.m4a")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "aac", p], check=True)
    return open(p, "rb").read()
# Keep ids are the created time: a new one each run (the same Takeout again is skipped).
T = int(__import__("time").time()) * 1000000
def note(**kw):
    base = {"color": "DEFAULT", "isTrashed": False, "isPinned": False, "isArchived": False, "textContent": "", "title": "",
            "createdTimestampUsec": T, "userEditedTimestampUsec": T}
    base.update(kw); return json.dumps(base).encode()
K = "Takeout/Keep/"
shop = json.loads(note(title="Shopping " + tag, color="GREEN", isPinned=True, labels=[{"name": "Home " + tag}],
    listContent=[{"text": "Milk", "isChecked": False}, {"text": "Eggs", "isChecked": True}]))
del shop["textContent"]
members = {
    K + "Gate code " + tag + ".json": note(title="Gate code " + tag, textContent="Gate code 4471", color="YELLOW", createdTimestampUsec=T + 1,
        labels=[{"name": "Home " + tag}]),
    K + "Gate code " + tag + ".html": b"<div class='note YELLOW'><div class='title'>Gate code</div></div>",
    K + "Shopping " + tag + ".json": json.dumps(shop).encode(),
    K + "Holiday " + tag + ".json": note(title="Holiday " + tag, textContent="Beach", color="CERULEAN", createdTimestampUsec=T + 2,
        attachments=[{"filePath": "pic-" + tag + ".jpeg", "mimetype": "image/jpeg"}]),
    K + "pic-" + tag + ".jpg": jpeg(),
    K + "Song " + tag + ".json": note(title="Song " + tag, textContent="la la", color="PURPLE", createdTimestampUsec=T + 3,
        attachments=[{"filePath": "rec-" + tag + ".m4a", "mimetype": "audio/mp4"}]),
    K + "rec-" + tag + ".m4a": m4a(),
    K + "Binned " + tag + ".json": note(title="Binned " + tag, textContent="gone", isTrashed=True, createdTimestampUsec=T + 4),
    K + "Labels.txt": ("Home " + tag + "\\n").encode(),
}
b = io.BytesIO()
with zipfile.ZipFile(b, "w") as z:
    for k, v in members.items(): z.writestr(k, v)
print(base64.b64encode(b.getvalue()).decode())
`;
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py, maxBuffer: 16 * 1024 * 1024 });
  const dir = path.join(E2E_ROOT, "test-results", "keep");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `takeout-keep-${tag}.zip`);
  fs.writeFileSync(file, Buffer.from(out.toString().trim(), "base64"));
  return file;
}

test.describe("notes: moving in from Google Keep", () => {
  test("a Keep Takeout comes in with colours, pins, labels, lists, pictures and recordings, once", async ({ alice: page }) => {
    test.setTimeout(240_000);
    // Its own tag: notes-across and notes make a "Gate code <stamp>" too.
    const tag = `${stamp}k`;
    const zip = keepTakeout(tag);
    const auth = await notesReady(page);

    const importOnce = async () => {
      await page.goto("/notes");
      await expect(page.getByRole("searchbox", { name: "Search your notes" })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("link", { name: "Import from Google Keep" }).click();
      await expect(page).toHaveURL(/\/files\/import\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      await ready(page);
      await expect(page.getByRole("heading", { name: "Google Keep" })).toBeVisible();
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Choose files" }).click();
      await (await chooser).setFiles(zip);
      const report = page.getByRole("region", { name: "What's in it" });
      await expect(report).toBeVisible({ timeout: 60_000 });
      await expect(report.getByText("notes", { exact: true }).locator("..")).toContainText("4");
      await expect(report.getByText("lists", { exact: true }).locator("..")).toContainText("1");
      await expect(report).toContainText("1 note in Keep's trash is left out");
      await page.getByRole("button", { name: "Import", exact: true }).click();
      const progress = page.getByRole("region", { name: "Import progress" });
      await expect(progress).toContainText("It's in.", { timeout: 120_000 });
      return progress;
    };
    const stat = (region: import("@playwright/test").Locator, label: string) => region.getByText(label, { exact: true }).locator("..");

    const first = await importOnce();
    await expect(stat(first, "new notes")).toContainText("4");
    await expect(stat(first, "couldn't import")).toContainText("0");
    await page.screenshot({ path: "test-results/notes-import-done.png" });

    // Open Notes: the cards, with Keep's colours, the pin and the list.
    await page.getByRole("link", { name: "Open Notes" }).click();
    await expect(page.getByRole("searchbox", { name: "Search your notes" })).toBeVisible({ timeout: 20_000 });
    await expect(card(page, `Shopping ${tag}`)).toBeVisible({ timeout: 20_000 });
    await expect(card(page, `Gate code ${tag}`)).toHaveAttribute("data-color", "sand");
    await expect(card(page, `Shopping ${tag}`)).toHaveAttribute("data-color", "mint");
    await expect(card(page, `Holiday ${tag}`)).toHaveAttribute("data-color", "storm");
    await expect(card(page, `Shopping ${tag}`)).toContainText("Milk");
    await page.screenshot({ path: "test-results/notes-import-grid.png", fullPage: true });

    const mine = (await serverNotes(page, auth)).filter((n) => n.title.endsWith(tag));
    const by = Object.fromEntries(mine.map((n) => [n.title, n]));
    expect(Object.keys(by).sort()).toEqual([`Gate code ${tag}`, `Holiday ${tag}`, `Shopping ${tag}`, `Song ${tag}`]);
    expect(by[`Shopping ${tag}`].pinned).toBe(true);
    expect(by[`Shopping ${tag}`].labels.map((l) => l.name)).toEqual([`Home ${tag}`]);
    const full = async (id: string) => (await (await page.request.get(`/api/notes/${id}`, { headers: { Authorization: auth } })).json()).note;
    const shop = await full(by[`Shopping ${tag}`].id);
    expect(shop.items.map((i: { text: string; checked: boolean }) => [i.text, i.checked])).toEqual([["Milk", false], ["Eggs", true]]);
    expect((await full(by[`Holiday ${tag}`].id)).attachments.map((a: { kind: string }) => a.kind)).toEqual(["image"]);
    expect((await full(by[`Song ${tag}`].id)).attachments.map((a: { kind: string }) => a.kind)).toEqual(["audio"]);

    // The picture shows on its card; the recording plays in the note.
    await expect(card(page, `Holiday ${tag}`).locator("img")).toHaveCount(1);
    await card(page, `Song ${tag}`).click();
    const dlg = page.getByRole("dialog", { name: `Song ${tag}` });
    await expect(dlg.locator("[data-note-audio]")).toHaveCount(1, { timeout: 20_000 });
    await dlg.getByRole("button", { name: "Close", exact: true }).click();

    // Again: nothing new.
    await page.waitForTimeout(1_000);
    const second = await importOnce();
    await expect(stat(second, "new notes")).toContainText("0");
    await expect(stat(second, "already there")).toContainText("4");
    expect((await serverNotes(page, auth)).filter((n) => n.title.endsWith(tag))).toHaveLength(4);
  });
});
