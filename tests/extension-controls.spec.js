import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const extension = new URL("../chrome-extension/", import.meta.url);
test.setTimeout(15000);

async function popup(page, values = {}, { host = false, bar = false, options = false } = {}) {
  await page.route("**/extension-ui/**", async route => {
    const name = new URL(route.request().url()).pathname.replace("/extension-ui/", "");
    if (!/^[a-z0-9/.-]+$/i.test(name) || name.includes("..")) return route.abort();
    const contentType = name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "image/png";
    let body = await readFile(new URL(name, extension));
    if (host && name === "controls.html") body = body.toString().replace('<script type="module" src="offscreen.js"></script>', "");
    await route.fulfill({ contentType, body });
  });
  await page.addInitScript(values => {
    let state = { status: "recording", sourceMode: "tab", elapsedMs: 12000, recordingId: "fixture", barVisible: false,
      microphoneAvailable: true, microphoneMuted: false, sourceAudioAvailable: true, sourceAudioMuted: false,
      settings: { source: "tab", microphone: true, systemAudio: true }, ...values };
    const listeners = [], storageListeners = [];
    const savedPreferences = () => JSON.parse(localStorage.getItem("fixtureRecorderPreferences") || "null") || values.recorderPreferences || {};
    window.__setRecorderPreferences = preferences => {
      const oldValue = savedPreferences();
      localStorage.setItem("fixtureRecorderPreferences", JSON.stringify(preferences));
      for (const listener of storageListeners) listener({ recorderPreferences: { oldValue, newValue: preferences } }, "local");
    };
    window.__extensionMessages = [];
    window.__setExtensionState = patch => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener({ type: "STATE_CHANGED", state }, { id: "a".repeat(32) }, () => {});
    };
    window.recorderCapture = { regionPreview: () => values.regionPreview || null, selectSource: options => {
      window.__pickerGesture = { active: navigator.userActivation.isActive, options };
      state = { ...state, sourceReady: true };
      return Promise.resolve({ state });
    } };
    window.chrome = {
      runtime: {
        id: "a".repeat(32), getURL: path => `${location.origin}/extension-ui/${path}`,
        onMessage: { addListener: listener => listeners.push(listener) },
        sendMessage: async message => {
          window.__extensionMessages.push(message);
          if (message.type === "INIT_POPUP") {
            // The worker publishes state while initializing the popup, before returning its session.
            window.__setExtensionState({});
          } else if (document.documentElement.dataset.surface === "popup" && message.popupSession !== "fixture-session") {
            return { ok: false, error: "Öffne das Menü erneut über den roten Aufnahmepunkt." };
          }
          if (message.type === "SET_AUDIO_STATE") {
            if (typeof message.microphoneEnabled === "boolean") state.microphoneMuted = !message.microphoneEnabled;
            if (typeof message.sourceAudioEnabled === "boolean") state.sourceAudioMuted = !message.sourceAudioEnabled;
          }
          if (message.type === "SET_MICROPHONE_DEVICE") state.microphoneDeviceId = message.deviceId;
          if (message.type === "STOP_RECORDING" && values.stopResult) window.__setExtensionState(values.stopResult);
          if (message.type === "CONFIRM_CAPTURE_REGION") window.__setExtensionState({ status: "recording", choosingRegion: false, controlsHidden: true });
          if (message.type === "CANCEL_CAPTURE_REGION") window.__setExtensionState({ status: "idle", choosingRegion: false, controlsHidden: true });
          if (message.type === "GET_AUDIO_DEVICES") return { ok: true, devices: [{ deviceId: "default", label: "Standardmikrofon" }, { deviceId: "usb", label: "USB-Mikrofon" }], cameras: [{ deviceId: "camera-usb", label: "USB-Kamera" }], microphoneDeviceId: state.microphoneDeviceId || "" };
          return { ok: true, popupSafe: true, popupSession: "fixture-session", barSafe: true, state, recordings: values.recordings || [] };
        },
      },
      storage: { onChanged: { addListener: listener => storageListeners.push(listener), removeListener: listener => { const index = storageListeners.indexOf(listener); if (index >= 0) storageListeners.splice(index, 1); } }, local: {
        get: async () => ({ captureSettings: JSON.parse(localStorage.getItem("fixtureCaptureSettings") || 'null') || { source: "tab", microphone: true, systemAudio: true }, soundDefaultsVersion: 1, recorderPreferences: savedPreferences() }),
        set: async data => { if (data.captureSettings) localStorage.setItem("fixtureCaptureSettings", JSON.stringify(data.captureSettings)); if (data.recorderPreferences) window.__setRecorderPreferences(data.recorderPreferences); },
      } },
      tabs: { getCurrent: async () => ({ id: 5 }) }, commands: { getAll: async () => values.commandShortcuts || [] },
    };
  }, values);
  await page.goto(`/extension-ui/${options ? "options" : bar ? "floatingbar" : host ? "controls" : "popup"}.html`);
  if (options) await expect(page.locator("#saveButton")).toBeEnabled();
  else await expect(page.locator(bar ? "#barStatus" : "#statusText")).toHaveText(/Aufnahme|Bereit/);
}

test("reopening the popup after a recording loads backups with the initialized session", async ({ page }) => {
  await popup(page, { status: "idle", recordingId: "finished" });
  await expect(page.locator("body")).toHaveCSS("visibility", "visible");
  const requests = await page.evaluate(() => window.__extensionMessages.filter(message => message.type === "GET_RECORDINGS"));
  expect(requests.map(request => request.popupSession)).toEqual(["fixture-session"]);
  await expect(page.locator("#message")).toBeHidden();
});

test("window and screen area controls are visible before advanced settings", async ({ page }) => {
  await popup(page, { status: "idle", recordingId: null });
  for (const source of ["window", "screen", "tab"]) {
    await page.locator(`input[name="source"][value="${source}"]`).check();
    await expect(page.locator("#regionCaptureSetting")).toBeVisible();
    await expect(page.locator("#regionCapture")).toBeEnabled();
  }
  await page.locator("#regionCapture").check();
  await expect(page.locator("#startButton")).toHaveText("Ausschnitt auswählen");
  await page.locator('input[name="source"][value="camera"]').check();
  await expect(page.locator("#regionCaptureSetting")).toBeHidden();
});

test("the desktop preview sends source-pixel coordinates and removes its image on confirmation", async ({ page }) => {
  const dataUrl = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="olive"/></svg>');
  await popup(page, { status: "preparing", sourceMode: "window", hostOnly: true, choosingRegion: true,
    regionPreview: { dataUrl, width: 800, height: 600 } }, { host: true });
  await expect(page.locator("#confirmCaptureRegion")).toBeDisabled();
  const preview = await page.locator("#captureRegionStage").boundingBox();
  await page.mouse.move(preview.x + preview.width * .75, preview.y + preview.height * .75);
  await page.mouse.down();
  await page.mouse.move(preview.x + preview.width * .25, preview.y + preview.height * .25);
  await page.mouse.up();
  await expect(page.locator("#captureRegionOutline")).toBeVisible();
  await expect(page.locator("#captureRegionX")).toHaveValue("200");
  await expect(page.locator("#captureRegionY")).toHaveValue("150");
  await expect(page.locator("#captureRegionWidth")).toHaveValue("400");
  await expect(page.locator("#captureRegionHeight")).toHaveValue("300");
  await page.locator("#captureRegionWidth").fill("601");
  await expect(page.locator("#confirmCaptureRegion")).toBeDisabled();
  await page.locator("#captureRegionWidth").fill("400");
  await page.locator("#confirmCaptureRegion").click();
  const confirmed = await page.evaluate(() => window.__extensionMessages.find(message => message.type === "CONFIRM_CAPTURE_REGION"));
  expect(confirmed.region).toEqual({ x: 200, y: 150, width: 400, height: 300, viewportWidth: 800, viewportHeight: 600 });
  await expect(page.locator("#captureRegionPanel")).toBeHidden();
  expect(await page.locator("#captureRegionImage").getAttribute("src")).toBeNull();
});

test("a recording setup message fits above Start and the popup footer", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await popup(page, { status: "idle", recordingId: null });
  await page.evaluate(() => window.__setExtensionState({ error: "Die Aufnahme konnte nicht gestartet werden. Bitte wähle eine andere Quelle." }));
  await expect(page.locator("#message")).toBeVisible();
  const start = await page.locator("#startButton").boundingBox();
  const footer = await page.locator("#appFooter").boundingBox();
  expect(start.y + start.height).toBeLessThanOrEqual(footer.y);
  expect(footer.y + footer.height).toBeLessThanOrEqual(600);
});

for (const host of [false, true]) {
  test(`the ${host ? "host" : "popup"} setup can scroll from a long error to Start on a small display`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 290 });
    await popup(page, { status: "idle", recordingId: null, error: "Quelle nicht verfügbar. ".repeat(100) }, { host });
    await page.locator('input[name="source"][value="tab"]').check();
    await page.mouse.move(160, 180);
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => page.evaluate(() => {
      const button = document.getElementById("startButton").getBoundingClientRect();
      return button.top >= 0 && button.bottom <= document.getElementById("appFooter").getBoundingClientRect().top;
    })).toBe(true);
    await page.locator("#startButton").click();
    expect(await page.evaluate(() => window.__extensionMessages.some(message => message.type === "START_RECORDING"))).toBe(true);
    const footer = await page.locator("#appFooter").boundingBox();
    expect(footer.y + footer.height).toBeLessThanOrEqual(290);
  });
}

test("a paused window popup exposes microphone and source audio controls", async ({ page }) => {
  await popup(page, { status: "paused", sourceMode: "window", settings: { source: "window", microphone: true, systemAudio: true } });
  await expect(page.locator("body")).toHaveCSS("visibility", "visible");
  await expect(page.locator("#liveMicrophone")).toBeEnabled();
  await expect(page.locator("#liveSourceAudio")).toBeEnabled();
  await page.locator("#liveMicrophone").uncheck();
  await expect.poll(() => page.evaluate(() => window.__extensionMessages.some(message => message.type === "SET_AUDIO_STATE" && message.microphoneEnabled === false))).toBe(true);
  await page.locator("#liveSourceAudio").uncheck();
  await expect.poll(() => page.evaluate(() => window.__extensionMessages.some(message => message.type === "SET_AUDIO_STATE" && message.sourceAudioEnabled === false))).toBe(true);
  expect(await page.evaluate(() => window.__extensionMessages.some(message => message.type === "PAUSE_RECORDING"))).toBe(false);
});

test("the compact setup matches the three-control row and its dropdowns pass real capture options", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 430 });
  await popup(page, { status: "idle", recordingId: null });
  const camera = await page.locator("#cameraControl").boundingBox();
  const microphone = await page.locator("#microphoneControl").boundingBox();
  const bar = await page.locator("#controlBarSetting").boundingBox();
  expect(camera.height).toBeLessThanOrEqual(60);
  expect(Math.abs(camera.y - microphone.y)).toBeLessThan(1);
  expect(Math.abs(camera.y - bar.y)).toBeLessThan(1);
  expect(camera.x).toBeLessThan(microphone.x);
  expect(microphone.x).toBeLessThan(bar.x);
  expect(bar.width).toBeGreaterThan(camera.width * 1.7);
  await page.locator("#cameraDeviceButton").click();
  await page.locator("#cameraDevice").selectOption("camera-usb");
  await page.locator("#microphoneDeviceButton").click();
  await page.locator("#microphoneDevice").selectOption("usb");
  await page.locator("#microphoneDeviceButton").click();
  await page.locator("#resolution").selectOption("720");
  await page.locator("#saveDestination").selectOption("local");
  await page.locator("#recordingFormat").selectOption("webm");
  await page.locator("#controlBar").uncheck();
  await page.locator('input[name="source"][value="tab"]').check();
  await expect(page.locator("#startButton")).toHaveText("Aufnahme starten");
  const quick = await page.locator("#quickSettings").boundingBox();
  const start = await page.locator("#startButton").boundingBox();
  expect(quick.y).toBeGreaterThanOrEqual(camera.y + camera.height);
  expect(start.y).toBeGreaterThanOrEqual(quick.y + quick.height);
  expect(start.height).toBeLessThanOrEqual(60);
  const footer = await page.locator("#appFooter").boundingBox();
  expect(start.y + start.height).toBeLessThanOrEqual(footer.y);
  expect(footer.y + footer.height).toBeLessThanOrEqual(430);
  expect(await page.locator(".controller").evaluate(element => element.getBoundingClientRect().width)).toBe(320);
  await page.screenshot({ path: "test-results/compact-menu-popup.png" });
  await page.locator("#actionArea").screenshot({ path: "test-results/compact-menu-controls.png" });
  await page.locator("#startButton").click();
  const started = await page.evaluate(() => window.__extensionMessages.find(message => message.type === "START_RECORDING"));
  expect(started.options).toMatchObject({ microphoneDeviceId: "usb", cameraDeviceId: "camera-usb", resolution: 720, saveDestination: "local", format: "webm", controlBar: false });
});

test("microphone, camera and screen show crossed-out icons only while off in both themes", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 374 });
  await popup(page, { status: "idle", recordingId: null });
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const [name, control] of [["Mikrofon", "#microphoneControl"], ["Kamera", "#cameraControl"]]) {
      const toggle = page.getByRole("switch", { name, exact: true });
      const offIcon = page.locator(control + " .device-icon-off");
      const onIcon = page.locator(control + " .device-toggle img:not(.device-icon-off)");
      await toggle.uncheck();
      await expect(offIcon).toBeVisible();
      await expect.poll(() => offIcon.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
      await expect(onIcon).toBeHidden();
      await toggle.check();
      await expect(onIcon).toBeVisible();
      await expect(offIcon).toBeHidden();
    }
    const screenCard = page.locator(".source-card").filter({ hasText: "Bildschirm" });
    const offScreen = screenCard.locator(".device-icon-off");
    const onScreen = screenCard.locator("img:not(.device-icon-off)");
    await expect(offScreen).toBeVisible();
    await expect.poll(() => offScreen.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await expect(onScreen).toBeHidden();
    await screenCard.getByRole("radio").check();
    await expect(onScreen).toBeVisible();
    await expect(offScreen).toBeHidden();
    await page.getByRole("radio", { name: /Fenster/ }).check();
    await expect(offScreen).toBeVisible();
    await expect(onScreen).toBeHidden();
  }
});

test("Control Bar stays optional across reopen and source audio remains available in More", async ({ page }) => {
  await popup(page, { status: "idle", recordingId: null });
  await expect(page.locator("#microphone")).toBeChecked();
  await expect(page.locator("#controlBar")).toBeChecked();
  await page.locator("#controlBar").uncheck();
  await page.reload();
  await expect(page.locator("#controlBar")).not.toBeChecked();
  await page.locator("#controlBar").check();
  await page.reload();
  await expect(page.locator("#controlBar")).toBeChecked();
  await page.locator("#settingsButton").click();
  await expect(page.locator("#systemAudio")).toBeVisible();
  await expect(page.locator("#systemAudio")).toBeChecked();
});

test("a tab recording keeps its menu visible and can switch microphones", async ({ page }) => {
  await popup(page);
  await expect(page.locator("body")).toHaveCSS("visibility", "visible");
  await page.locator("#liveMicrophoneDevice").selectOption("usb");
  expect(await page.evaluate(() => window.__extensionMessages.some(message => message.type === "SET_MICROPHONE_DEVICE" && message.deviceId === "usb"))).toBe(true);
  expect(await page.evaluate(() => window.__extensionMessages.some(message => message.type === "PAUSE_RECORDING"))).toBe(false);
});

test("the persistent setup opens the standard chooser directly from a trusted click", async ({ page }) => {
  await popup(page, { status: "idle", hostOnly: true, captureSetup: true, pendingCaptureOptions: { source: "window", microphone: true, systemAudio: true, microphoneDeviceId: "usb" } }, { host: true });
  await expect(page.locator("body")).toHaveCSS("visibility", "visible");
  await expect(page.locator("#startButton")).toBeEnabled();
  await page.locator("#startButton").click();
  await expect.poll(() => page.evaluate(() => window.__extensionMessages.some(message => message.type === "START_PREPARED_RECORDING"))).toBe(true);
  const gesture = await page.evaluate(() => window.__pickerGesture);
  expect(gesture.active).toBe(true);
  expect(gesture.options.source).toBe("window");
  expect(gesture.options.microphoneDeviceId).toBe("usb");
});

test("the popup keeps control-bar and microphone actions reachable with long warnings on a short display", async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 290 });
  await popup(page, { sourceMode: "tab", barVisible: true, warning: "Eine lange Statusmeldung zur Quelle. ".repeat(15) });
  await expect(page.locator("#showControlBarButton")).toBeVisible();
  await page.locator("#showControlBarButton").click();
  await page.locator("#liveMicrophone").uncheck();
  expect(await page.evaluate(() => window.__extensionMessages.some(message => message.type === "SHOW_FLOATING_BAR"))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(460);
});

test("unavailable source audio is secondary information and does not block the microphone or stop action", async ({ page }) => {
  await popup(page, { sourceAudioAvailable: false, warning: "Für diese Quelle stellt Chrome keinen Quellton bereit. Die Mikrofoneinstellung gilt unabhängig davon." });
  await expect(page.locator("#liveSourceAudio")).toBeDisabled();
  await expect(page.locator("#liveSourceAudioHint")).toContainText(/nicht|kein/);
  await expect(page.locator("#activeMessage")).toBeHidden();
  await expect(page.locator("#liveMicrophone")).toBeEnabled();
  await expect(page.locator("#stopButton")).toBeEnabled();
});

test("fullscreen popup remains hidden until the background confirms it is paused", async ({ page }) => {
  await popup(page, { sourceMode: "screen" });
  await expect(page.locator("body")).toHaveCSS("visibility", "hidden");
  await page.evaluate(() => window.__setExtensionState({ status: "paused" }));
  await expect(page.locator("body")).toHaveCSS("visibility", "visible");
  await expect(page.locator("#liveMicrophone")).toBeEnabled();
});

test("screen setup explains how to end Chrome sharing and shows the assigned shortcut", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 430 });
  await popup(page, { status: "idle", recordingId: null, commandShortcuts: [{ name: "stop-recording", shortcut: "⌘⇧8" }] });
  await page.locator('input[name="source"][value="screen"]').check();
  await expect(page.locator("#actionHint")).toContainText("„Freigabe beenden“ in Chrome speichert automatisch");
  await expect(page.locator("#actionHint")).toContainText("⌘⇧8");
  await page.locator('input[name="source"][value="tab"]').check();
  await expect(page.locator("#actionHint")).toBeHidden();
});

test("ending a paused screen recording opens local recordings and displays the saving result", async ({ page }) => {
  const result = { id: "fixture", message: "Im Aufnahmeordner gespeichert: Besprechung.webm" };
  await page.setViewportSize({ width: 320, height: 440 });
  await popup(page, {
    status: "paused", sourceMode: "screen", popupHidden: false, warning: "Frühere Warnung",
    stopResult: { status: "idle", lastRecordingResult: result },
    recordings: [{ id: "fixture", name: "Besprechung", kind: "video", status: "finished", bytes: 5000 },
      { id: "previous", name: "Ältere Aufnahme", kind: "video", status: "interrupted", bytes: 1200 }],
  });
  await page.getByRole("button", { name: "Beenden und speichern" }).click();
  await expect(page.getByRole("heading", { name: "Browser-Aufnahmen" })).toBeVisible();
  await expect(page.locator("#libraryRecordingResult")).toHaveText(result.message);
  await expect(page.locator(".recording-card").filter({ hasText: "Ältere Aufnahme" })).toContainText("Unterbrochen");
  await page.getByRole("button", { name: "Zurück zur Aufnahme" }).click();
  await expect(page.locator("#lastRecordingMessage")).toHaveText(result.message);
  await expect(page.getByRole("button", { name: "Letzte Aufnahme öffnen" })).toBeVisible();
  await page.getByRole("button", { name: "Letzte Aufnahme öffnen" }).click();
  await expect.poll(() => page.evaluate(() => window.__extensionMessages.some(message => message.type === "OPEN_EDITOR" && message.id === "fixture"))).toBe(true);
  await page.getByRole("button", { name: "Aufnahmen in Chrome öffnen" }).click();
  await expect(page.getByRole("heading", { name: "Browser-Aufnahmen" })).toBeVisible();
  expect(await page.evaluate(() => window.__extensionMessages.some(message => message.type === "OPEN_LIBRARY"))).toBe(false);
});

test("a folder error keeps the direct link to the recorded video visible", async ({ page }) => {
  const message = "Speichern im Ordner fehlgeschlagen.";
  await popup(page, { status: "idle", recordingId: "fixture",
    lastRecordingResult: { id: "fixture", message: "Video als Browser-Backup gespeichert." },
    folderSaveError: { recordingId: "fixture", message } });
  await expect(page.locator("#message")).toHaveText(message);
  await expect(page.locator("#lastRecordingMessage")).toBeHidden();
  await expect(page.getByRole("button", { name: "Letzte Aufnahme öffnen" })).toBeVisible();
});

test("the glass bar starts as a small pill and expands to device and source audio controls", async ({ page }) => {
  await page.setViewportSize({ width: 330, height: 400 });
  await popup(page, { barVisible: true, microphoneAvailable: false, settings: { microphone: false, source: "tab" } }, { bar: true });
  await expect(page.locator("body")).toHaveCSS("visibility", "visible");
  const pill = await page.locator(".transport").boundingBox();
  expect(pill.width).toBeLessThanOrEqual(330);
  expect(pill.height).toBeLessThanOrEqual(60);
  await expect(page.locator("#barStopButton")).toBeVisible();
  await expect(page.locator("#barMicrophoneButton")).toBeEnabled();
  await expect(page.locator("#barDetails")).toBeHidden();
  await page.screenshot({ path: "test-results/glass-bar-compact.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/glass-bar-compact-dark.png" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator("#barDetailsButton").click();
  await expect(page.locator("#barMicrophoneDevice")).toBeVisible();
  await page.setViewportSize({ width: 330, height: 480 });
  await page.screenshot({ path: "test-results/glass-bar-expanded.png" });
  await page.locator("#barMicrophoneDevice").selectOption("usb");
  expect(await page.evaluate(() => window.__extensionMessages.some(message => message.type === "SET_MICROPHONE_DEVICE" && message.deviceId === "usb"))).toBe(true);
  await expect(page.locator("#barSourceAudioButton")).toBeVisible();
  await page.locator("#barDetailsButton").click();
  await expect(page.locator("#barDetails")).toBeHidden();
  await expect(page.locator("#barStopButton")).toBeVisible();
});

test("all screenshot shortcuts send capture options and fit the smaller popup", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 430 });
  await popup(page, { status: "idle", recordingId: null });
  await page.locator("#screenshotTab").click();
  await expect(page.locator("#screenshotButton")).toBeHidden();
  const body = await page.locator("#screenshotPanel").boundingBox();
  const footer = await page.locator("#appFooter").boundingBox();
  expect(body.y + body.height).toBeLessThanOrEqual(footer.y);
  expect(footer.y + footer.height).toBeLessThanOrEqual(430);
  await page.locator("#screenshotDestination").selectOption("local");
  const buttons = [
    ['[data-capture="visible"]', { mode: "visible" }],
    ['[data-capture="fullpage"]', { mode: "fullpage" }],
    ['[data-capture="region"]', { mode: "region" }],
    ['#delayedScreenshotButton', { mode: "visible", delaySeconds: 3 }],
    ['#displayScreenshotButton', { mode: "screen" }],
    ['#extractTextButton', { mode: "visible", extractText: true }],
  ];
  let count = 0;
  for (const [selector, options] of buttons) {
    await page.locator(selector).click();
    await expect.poll(() => page.evaluate(() => window.__extensionMessages.filter(message => message.type === "CAPTURE_SCREENSHOT").length)).toBe(++count);
    const message = await page.evaluate(() => window.__extensionMessages.filter(message => message.type === "CAPTURE_SCREENSHOT").at(-1));
    expect(message.options).toMatchObject({ ...options, saveDestination: "local" });
    await expect(page.locator(selector)).toBeEnabled();
  }
  await page.locator("#importImageButton").click();
  await expect.poll(() => page.evaluate(() => window.__extensionMessages.some(message => message.type === "OPEN_IMAGE_WORKSPACE"))).toBe(true);
  await page.screenshot({ path: "test-results/compact-screenshot-popup.png" });
});

test("microphone-off reminder requires a choice and can enable the microphone", async ({ page }) => {
  await popup(page, { status: "idle", recordingId: null });
  await page.locator('input[name="source"][value="tab"]').check();
  await page.locator("#microphone").uncheck();
  await page.locator("#startButton").click();
  await expect(page.locator("#microphoneReminderPanel")).toBeVisible();
  expect(await page.evaluate(() => window.__extensionMessages.some(message => message.type === "START_RECORDING"))).toBe(false);
  await page.locator("#cancelMicrophoneButton").click();
  await expect(page.locator("#startButton")).toBeVisible();
  await page.locator("#startButton").click();
  await page.locator("#enableMicrophoneButton").click();
  const started = await page.evaluate(() => window.__extensionMessages.find(message => message.type === "START_RECORDING"));
  expect(started.options.microphone).toBe(true);
});

test("More preserves countdown, auto-stop and custom-tab settings through reopen", async ({ page }) => {
  await popup(page, { status: "idle", recordingId: null });
  await page.locator('input[name="source"][value="tab"]').check();
  await page.locator("#regionCapture").check();
  await page.locator("#settingsButton").click();
  await page.locator("#microphoneReminder").uncheck();
  await page.locator("#countdown").selectOption("10");
  await page.locator("#autoStopEnabled").check();
  await page.locator("#autoStopMinutes").fill("2.5");
  await page.locator("#autoStopMinutes").press("Tab");
  await page.reload();
  await page.locator('input[name="source"][value="tab"]').check();
  await expect(page.locator("#regionCapture")).toBeChecked();
  await page.locator("#settingsButton").click();
  await expect(page.locator("#microphoneReminder")).not.toBeChecked();
  await expect(page.locator("#countdown")).toHaveValue("10");
  await expect(page.locator("#autoStopEnabled")).toBeChecked();
  await expect(page.locator("#autoStopMinutes")).toHaveValue("2.5");
  await page.locator("#closeSettingsButton").click();
  await page.locator("#startButton").click();
  const started = await page.evaluate(() => window.__extensionMessages.find(message => message.type === "START_RECORDING"));
  expect(started.options).toMatchObject({ countdown: 10, autoStopSeconds: 150, microphoneReminder: false, regionCapture: true });
});

test("camera-only capture and general preferences stay reachable", async ({ page }) => {
  await popup(page, { status: "idle", recordingId: null, recorderPreferences: { defaultTab: "screenshot", theme: "dark", screenshotDelaySeconds: 10 } });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#screenshotTab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#screenshotDelayLabel")).toHaveText("10 s");
  await page.locator("#recordTab").click();
  await page.locator('input[name="source"][value="camera"]').check();
  await expect(page.locator("#camera")).toBeChecked();
  await expect(page.locator("#camera")).toBeDisabled();
  await page.locator("#startButton").click();
  const started = await page.evaluate(() => window.__extensionMessages.find(message => message.type === "START_RECORDING"));
  expect(started.options).toMatchObject({ source: "camera", camera: true });
  await page.locator("#optionsButton").click();
  await expect.poll(() => page.evaluate(() => window.__extensionMessages.some(message => message.type === "OPEN_OPTIONS"))).toBe(true);
});

test("compact popup remains narrower than the reference and readable in light and dark themes", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 430 });
  await popup(page, { status: "idle", recordingId: null });
  await page.locator('input[name="source"][value="window"]').check();
  const width = await page.locator(".controller").evaluate(element => element.getBoundingClientRect().width);
  expect(width).toBe(320);
  expect(await page.locator("#libraryFooterButton").evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(10);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.locator(".controller").screenshot({ path: `artifacts/ScreenRecorder-Menu-${theme}.png` });
    await page.locator("#screenshotTab").click();
    const footer = await page.locator("#appFooter").boundingBox();
    const save = await page.locator(".screenshot-save").boundingBox();
    expect(save.y + save.height).toBeLessThanOrEqual(footer.y);
    await page.locator(".controller").screenshot({ path: `artifacts/ScreenRecorder-Screenshots-${theme}.png` });
    await page.locator("#recordTab").click();
  }
});

test("popup theme follows Chrome by default and explicit overrides persist without replacing other preferences", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await popup(page, { status: "idle", recordingId: null, recorderPreferences: { futurePreference: "keep", defaultTab: "record" } });
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#settingsButton").click();
  await page.locator("#uiTheme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light" }); await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fixtureRecorderPreferences")))).toMatchObject({ theme: "light", futurePreference: "keep", defaultTab: "record" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "light");
  await page.locator("#settingsButton").click(); await page.locator("#uiTheme").selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.evaluate(() => window.__setRecorderPreferences({ theme: "dark", futurePreference: "keep" }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#uiTheme")).toHaveValue("dark");
});

test("floating bar respects explicit light and dark choices across live preference and Chrome changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await popup(page, { barVisible: true, recorderPreferences: { theme: "light" } }, { bar: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".timer")).toHaveCSS("color", "rgb(38, 52, 59)");
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => window.__setRecorderPreferences({ theme: "dark" }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".timer")).toHaveCSS("color", "rgb(242, 245, 245)");
  await page.locator("#barDetailsButton").click();
  await expect(page.locator("#barMicrophoneDevice")).toHaveCSS("background-color", "rgba(255, 255, 255, 0.07)");
  await page.evaluate(() => window.__setRecorderPreferences({ theme: "system" }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("options persist theme immediately and apply external theme changes without resetting unsaved fields", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await popup(page, { recorderPreferences: { theme: "system", futurePreference: "retained" } }, { options: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#filenamePrefix").fill("Unsaved prefix");
  await page.locator("#theme").selectOption("light");
  await expect(page.locator("#saveStatus")).toHaveText("Darstellung gespeichert.");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fixtureRecorderPreferences")))).toMatchObject({ theme: "light", futurePreference: "retained" });
  await page.evaluate(() => window.__setRecorderPreferences({ theme: "dark", futurePreference: "retained" }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#theme")).toHaveValue("dark");
  await expect(page.locator("#filenamePrefix")).toHaveValue("Unsaved prefix");
  await page.locator("#saveButton").click();
  await expect(page.locator("#saveStatus")).toHaveText("Gespeichert.");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#filenamePrefix")).toHaveValue("Unsaved prefix");
  await page.locator("#theme").selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
