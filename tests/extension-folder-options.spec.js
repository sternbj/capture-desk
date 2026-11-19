import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const extension = new URL("../chrome-extension/", import.meta.url);
async function openOptions(page) {
  await page.route("**/folder-options/**", async route => {
    const name = new URL(route.request().url()).pathname.slice("/folder-options/".length);
    const type = { js: "text/javascript", html: "text/html", css: "text/css", png: "image/png" }[name.split(".").pop()];
    if (!type || !/^[a-z\d./-]+$/i.test(name) || name.includes("..")) return route.abort();
    await route.fulfill({ contentType: type, body: await readFile(new URL(name, extension)) });
  });
  await page.addInitScript(() => {
    window.chrome = { storage: { local: {
      get: async () => JSON.parse(localStorage.getItem("settings") || '{"captureSettings":{"saveDestination":"local","microphone":false}}'),
      set: async update => {
        if (window.failSettingsWrite) throw new Error("Speichern fehlgeschlagen.");
        const current = await chrome.storage.local.get();
        localStorage.setItem("settings", JSON.stringify({ ...current, ...update }));
      },
    } } };
    window.folderToPick = "Meeting-Videos";
    window.showDirectoryPicker = async () => {
      if (!navigator.userActivation.isActive) throw new Error("Missing user activation");
      if (!window.folderToPick) throw new DOMException("Abgebrochen", "AbortError");
      const storage = await navigator.storage.getDirectory();
      return storage.getDirectoryHandle(window.folderToPick, { create: true });
    };
  });
  await page.goto("/folder-options/options.html");
  await expect(page.locator("#saveButton")).toBeEnabled();
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== "chromium", "The Chrome extension persists File System Access handles.");
});

test("the extension switches all four interface languages and persists the choice", async ({ page }) => {
  await openOptions(page);
  const picker = page.locator("#uiLanguage");
  for (const [language, heading] of [["en", "Settings"], ["fr", "Paramètres"], ["es", "Configuración"], ["de", "Einstellungen"]]) {
    await picker.selectOption(language);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(page.locator("h1")).toHaveText(heading);
  }
  await picker.selectOption("fr");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.locator("h1")).toHaveText("Paramètres");
});

test("a video folder can be selected, changed and removed without changing screenshot or microphone settings", async ({ page }) => {
  await openOptions(page);
  const capture = () => page.evaluate(async () => (await chrome.storage.local.get()).captureSettings);
  await page.getByRole("button", { name: "Ordner auswählen", exact: true }).click();
  await expect(page.locator("#recordingFolderName")).toHaveText("Meeting-Videos");
  await expect.poll(capture).toEqual({ saveDestination: "folder", screenshotDestination: "local", microphone: false });
  await page.reload();
  await expect(page.locator("#recordingFolderName")).toHaveText("Meeting-Videos");
  await page.evaluate(() => { window.folderToPick = "OneDrive-Unterordner"; });
  await page.getByRole("button", { name: "Ordner ändern" }).click();
  await expect(page.locator("#recordingFolderName")).toHaveText("OneDrive-Unterordner");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.locator("#saveStatus")).toHaveText("Gespeichert.");
  expect(await capture()).toMatchObject({ saveDestination: "folder", screenshotDestination: "local", microphone: false });
  await page.getByRole("button", { name: "Ordnerauswahl aufheben" }).click();
  await expect(page.locator("#recordingFolderName")).toHaveText("Kein Ordner ausgewählt.");
  expect(await capture()).toMatchObject({ saveDestination: "local", screenshotDestination: "local", microphone: false });
  await page.reload();
  await expect(page.locator("#removeRecordingFolder")).toBeHidden();
});

test("cancelling the folder chooser preserves the folder and resetting preserves a later cloud destination", async ({ page }) => {
  await openOptions(page);
  await page.locator("#chooseRecordingFolder").click();
  await expect(page.locator("#recordingFolderStatus")).toContainText("gespeichert");
  await page.evaluate(() => { window.folderToPick = ""; });
  await page.locator("#chooseRecordingFolder").click();
  await expect(page.locator("#recordingFolderName")).toHaveText("Meeting-Videos");
  await expect(page.locator("#recordingFolderStatus")).toBeEmpty();
  await page.evaluate(async () => {
    const { captureSettings } = await chrome.storage.local.get();
    await chrome.storage.local.set({ captureSettings: { ...captureSettings, saveDestination: "cloud" } });
  });
  await page.locator("#resetButton").click();
  await expect(page.locator("#saveStatus")).toHaveText("Gespeichert.");
  await page.reload();
  await expect(page.locator("#chooseRecordingFolder")).toHaveText("Ordner auswählen");
  expect(await page.evaluate(async () => (await chrome.storage.local.get()).captureSettings.saveDestination)).toBe("cloud");
});

test("a storage failure leaves the selected folder visible and reports that video saving was not activated", async ({ page }) => {
  await openOptions(page);
  await page.evaluate(() => { window.failSettingsWrite = true; });
  await page.locator("#chooseRecordingFolder").click();
  await expect(page.locator("#recordingFolderStatus")).toContainText("nicht aktiviert");
  await expect(page.locator("#recordingFolderName")).toHaveText("Meeting-Videos");
  expect(await page.evaluate(async () => (await chrome.storage.local.get()).captureSettings.saveDestination)).toBe("local");
});

test("reopening the settings can reauthorize the saved folder directly from a click", async ({ page }) => {
  await openOptions(page);
  await page.locator("#chooseRecordingFolder").click();
  await expect(page.locator("#recordingFolderStatus")).toContainText("gespeichert");
  await expect(page.locator("#grantRecordingFolder")).toBeHidden();
  await page.addInitScript(() => {
    if (!localStorage.getItem("settings")) return;
    FileSystemHandle.prototype.queryPermission = async () => "prompt";
    FileSystemHandle.prototype.requestPermission = undefined;
    window.nativeGrant = async function ({ mode }) {
      window.grantRequest = { mode, name: this.name, active: navigator.userActivation.isActive };
      return "granted";
    };
  });
  await page.reload();
  const grant = page.getByRole("button", { name: "Schreibzugriff erlauben" });
  await expect(page.locator("#recordingFolderName")).toHaveText("Meeting-Videos");
  await expect(page.getByRole("button", { name: "Ordner ändern" })).toBeVisible();
  await grant.click();
  await expect(page.locator("#recordingFolderStatus")).toContainText("Ordner ändern");
  await page.evaluate(() => {
    window.showDirectoryPicker = () => { throw new Error("Directory picker reopened"); };
    FileSystemHandle.prototype.requestPermission = window.nativeGrant;
  });
  await grant.click();
  await expect(grant).toBeHidden();
  await expect(page.locator("#recordingFolderStatus")).toHaveText("Schreibzugriff erlaubt.");
  expect(await page.evaluate(() => window.grantRequest)).toEqual({ mode: "readwrite", name: "Meeting-Videos", active: true });
});
