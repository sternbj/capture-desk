import assert from "node:assert/strict";
import test from "node:test";
import { defaultPreferences, normalizePreferences, safeDownloadDirectory, updateCapturePreferences, updatePreferences } from "../chrome-extension/preferences.js";

test("preferences keep manual download confirmation and private sharing choices unchanged by default", () => {
  assert.deepEqual(normalizePreferences(), defaultPreferences);
  assert.equal(defaultPreferences.autoDownload, false);
  assert.equal(defaultPreferences.askWhereToSave, true);
  assert.equal(defaultPreferences.defaultTab, "last");
  assert.equal(Object.hasOwn(defaultPreferences, "autoShare"), false);
});

test("preference normalization accepts configured capture formats and bounded delay choices", () => {
  const saved = normalizePreferences({ screenshotDelaySeconds: "10", desktopDelaySeconds: "5", screenshotFormat: "webp", skipAnnotation: "fullpage", defaultTab: "screenshot", theme: "dark", timeFormat: 12 });
  assert.equal(saved.screenshotDelaySeconds, 10);
  assert.equal(saved.desktopDelaySeconds, 5);
  assert.equal(saved.screenshotFormat, "webp");
  assert.equal(saved.skipAnnotation, "fullpage");
  assert.equal(saved.defaultTab, "screenshot");
  assert.equal(saved.theme, "dark");
  assert.equal(saved.timeFormat, "12");
  const invalid = normalizePreferences({ screenshotDelaySeconds: 900, desktopDelaySeconds: -3, screenshotFormat: "svg", skipAnnotation: true, autoDownload: "true", askWhereToSave: 0, theme: "unknown" });
  assert.equal(invalid.screenshotDelaySeconds, 3);
  assert.equal(invalid.desktopDelaySeconds, 0);
  assert.equal(invalid.screenshotFormat, "png");
  assert.equal(invalid.skipAnnotation, "never");
  assert.equal(invalid.autoDownload, false);
  assert.equal(invalid.askWhereToSave, true);
  assert.equal(invalid.theme, "system");
});

test("download subfolders reject traversal, absolute locations, empty segments and reserved names", () => {
  for (const invalid of ["../private", "Screenshots/../Secrets", "/tmp/private", "C:\\Users\\Jonathan", "~/.ssh", "//server/share", "Fotos//Kunden", "./Fotos", "Fotos/.", "con", "Fotos/COM1.txt", "x".repeat(161)])
    assert.equal(safeDownloadDirectory(invalid), "", invalid);
  assert.equal(safeDownloadDirectory(" Screenshots/Kunden "), "Screenshots/Kunden");
  assert.equal(safeDownloadDirectory("Screenshots\\Kunden"), "Screenshots/Kunden");
  assert.equal(safeDownloadDirectory("Kunden:2026/Angebote?"), "Kunden-2026/Angebote-");
  assert.equal(normalizePreferences({ downloadDirectory: "../../etc" }).downloadDirectory, "");
});

test("filename prefixes keep German characters while removing path separators and control characters", () => {
  assert.equal(normalizePreferences({ filenamePrefix: "Prüfung / Kunde: A\nB" }).filenamePrefix, "Prüfung - Kunde- A-B");
  assert.equal(normalizePreferences({ filenamePrefix: "..." }).filenamePrefix, "Screenshot");
  assert.equal(normalizePreferences({ filenamePrefix: "CON" }).filenamePrefix, "_CON");
  assert.equal(normalizePreferences({ filenamePrefix: "x".repeat(100) }).filenamePrefix.length, 60);
});

function storage(initial = {}) {
  const values = structuredClone(initial);
  return { values, get: async key => ({ [key]: values[key] }), set: async patch => Object.assign(values, structuredClone(patch)) };
}

test("saving one preference preserves other configured preferences and future stored fields", async () => {
  const store = storage({ recorderPreferences: { theme: "dark", downloadDirectory: "Aufnahmen", screenshotFormat: "jpeg", futurePreference: "retained" }, captureSettings: { source: "window" } });
  const saved = await updatePreferences(store, { askWhereToSave: false });
  assert.equal(saved.askWhereToSave, false);
  assert.equal(saved.theme, "dark");
  assert.equal(saved.screenshotFormat, "jpeg");
  assert.equal(store.values.recorderPreferences.downloadDirectory, "Aufnahmen");
  assert.equal(store.values.recorderPreferences.futurePreference, "retained");
  assert.deepEqual(store.values.captureSettings, { source: "window" });
});

test("saving recording preferences preserves current source, microphone, camera, format and storage choices", async () => {
  const original = { source: "camera", microphone: false, microphoneDeviceId: "usb-mic", cameraDeviceId: "webcam", format: "mp4", saveDestination: "local" };
  const store = storage({ captureSettings: original });
  const saved = await updateCapturePreferences(store, { countdown: 10, autoStopSeconds: 90, microphoneReminder: false });
  assert.deepEqual(saved, { ...original, countdown: 10, autoStopSeconds: 90, microphoneReminder: false });
  assert.equal((await updateCapturePreferences(store, { countdown: 999, autoStopSeconds: Infinity })).autoStopSeconds, 0);
  assert.equal(store.values.captureSettings.countdown, 3);
  assert.equal((await updateCapturePreferences(store, { autoStopSeconds: 99999 })).autoStopSeconds, 21600);
});

test("failed preference writes propagate so the UI cannot report unsaved settings as saved", async () => {
  await assert.rejects(updatePreferences({ get: async () => ({}), set: async () => { throw new Error("Storage unavailable"); } }, { theme: "dark" }), /Storage unavailable/);
});
