import { expect, ready, test } from "../fixtures";

/** Face recognition (PH-2) is off until you turn it on in Photos settings,
 *  and turning it off deletes the faces found. */
test("face recognition is turned on and off in Photos settings", async ({ dana: page }) => {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files/photos");
  await ready(page);
  // (The test users outlive a run: start from off.)
  const auth = { Authorization: (await seen).headers()["authorization"] };
  expect((await page.request.put("/api/photos/settings", { headers: auth, data: { faces: false } })).ok()).toBeTruthy();

  await page.getByRole("button", { name: "Photos settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Photos settings" });
  const faces = dialog.getByRole("checkbox", { name: /Recognise faces/ });
  await expect(faces).toBeEnabled();
  await expect(faces).not.toBeChecked();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/photos/settings") && r.request().method() === "PUT");
  await faces.check();
  expect((await (await saved).json()).faces).toBe(true);
  await expect(dialog).toContainText("faces found so far");

  // Off again: it asks first when faces were found, then deletes them.
  const off = page.waitForResponse((r) => r.url().endsWith("/api/photos/settings") && r.request().method() === "PUT");
  await faces.click();
  const ask = page.getByRole("dialog", { name: "Turn off face recognition?" });
  if (await ask.isVisible().catch(() => false)) await ask.getByRole("button", { name: "Turn off and delete" }).click();
  expect(await (await off).json()).toMatchObject({ faces: false, face_count: 0 });
  await expect(faces).not.toBeChecked();
});
