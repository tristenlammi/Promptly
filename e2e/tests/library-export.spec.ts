import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { BACKEND } from "../lib/stack";

/** Export my library (WP-10.4): prepared on the Import & export page, each
 *  part downloads as a zip of the folder tree. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("the library downloads as a folder tree", async ({ dana: page }, info) => {
  test.setTimeout(180_000);
  const auth = await bearer(page);
  const folder = await page.request.post("/api/files/folders", { headers: { Authorization: auth }, data: { name: `Export ${stamp}`, scope: "mine" } });
  expect(folder.ok(), await folder.text()).toBeTruthy();
  const up = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: { scope: "mine", folder_id: (await folder.json()).id, file: { name: `notes-${stamp}.txt`, mimeType: "text/plain", buffer: Buffer.from("hello") } },
  });
  expect(up.ok(), await up.text()).toBeTruthy();

  await page.goto("/files/import");
  await ready(page);
  const section = page.getByRole("region", { name: "Export my library" });
  await section.getByRole("combobox").selectOption("2");
  // (An export from an earlier run may be showing: wait for the new one.)
  const made = page.waitForResponse((r) => r.url().endsWith("/api/files/exports") && r.request().method() === "POST");
  await section.getByRole("button", { name: /Prepare/ }).click();
  expect((await made).status()).toBe(201);
  const parts = section.getByRole("list", { name: "Export parts" });
  await expect(parts.getByRole("listitem")).toHaveCount(1, { timeout: 60_000 });

  const download = page.waitForEvent("download");
  await parts.getByRole("link", { name: "Download" }).click();
  const file = path.join(info.outputDir, "export.zip");
  await (await download).saveAs(file);
  expect(fs.statSync(file).size).toBeGreaterThan(0);
  execFileSync("docker", ["cp", file, `${BACKEND}:/tmp/e2e-export-${stamp}.zip`]);
  const names = JSON.parse(
    execFileSync("docker", ["exec", BACKEND, "python", "-c",
      `import zipfile,json; print(json.dumps(zipfile.ZipFile("/tmp/e2e-export-${stamp}.zip").namelist()))`]).toString(),
  ) as string[];
  execFileSync("docker", ["exec", BACKEND, "rm", "-f", `/tmp/e2e-export-${stamp}.zip`]);
  expect(names).toContain("Promptly/README.txt");
  expect(names).toContain(`Promptly/My files/Export ${stamp}/notes-${stamp}.txt`);
});
