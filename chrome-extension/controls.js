import { captureAudioState, fillMicrophoneDevices } from "./audio-controls.js";
import { isFinishedVideo, normalizeRegion, screenshotSaveDestination, supportedRecordingFormats } from "./capture-core.js";
import { getRecordingFolder } from "./recording-folder.js";
import { APP_ORIGIN } from "./app-config.js";
import { translateText } from "./i18n.js";
import { initializeTheme, setTheme } from "./theme.js";

const themeReady = initializeTheme({ onChange: ({ preference }) => {
  const select = document.getElementById("uiTheme");
  if (select) select.value = preference;
} }).catch(() => null);

const isPopup = document.documentElement.dataset.surface === "popup";
const view = await fetch(chrome.runtime.getURL("controls-view.html"));
if (!view.ok) throw new Error("Das Aufnahmemenü konnte nicht geladen werden.");
document.body.insertAdjacentHTML("afterbegin", await view.text());
const $ = id => document.getElementById(id);
const form = $("settingsForm");
if (APP_ORIGIN) {
  $("onlineRecorderLink").href = APP_ORIGIN;
  $("onlineRecorderLink").hidden = false;
} else {
  for (const select of [$("saveDestination"), $("screenshotDestination")]) select.querySelector('[value="cloud"]').remove();
}
themeReady.then(theme => { if (theme) $("uiTheme").value = theme.preference; });
$("uiTheme").addEventListener("change", event => {
  event.stopPropagation();
  setTheme($("uiTheme").value).catch(error => message(error.message || "Die Darstellung konnte nicht gespeichert werden.", true));
});
const activeStatuses = ["selecting", "preparing", "recording", "paused", "stopping"];
let current = { status: "idle", elapsedMs: 0 }, busy = false, settingsOpen = false, libraryOpen = false;
let mode = "record", sourceSelected = false, lastRecordingId = "", lastSize = "";
let popupSession = "", popupReady = false, popupHidden = false;
let readonlySettingsRequested = false;
let microphoneWarningOpen = false, preferences = {};
let stopShortcut = "", displayedStateMessage = "";
let recordingFolderName = "";
let hostSetupApplied = false, microphoneDevices = [], cameraDevices = [];
const recordingFormats = supportedRecordingFormats();
const formatLabel = format => format === "webm" ? "WebM" : format.toUpperCase();
let localSettings = { source: "screen", name: "", microphone: true, systemAudio: true, camera: false, controlBar: true, cameraPosition: "bottom-right", resolution: 1080, frameRate: 30, bitrate: 4000000, countdown: 3, screenshotMode: "visible", format: "auto", saveDestination: "cloud", cameraDeviceId: "", microphoneReminder: true, autoStopSeconds: 0, screenshotDelaySeconds: 3, regionCapture: false };
const automaticFormat = new Option(formatLabel(recordingFormats[0] || "auto"), "auto");
automaticFormat.hidden = true;
$("recordingFormat").replaceChildren(automaticFormat, ...recordingFormats.map(format => new Option(formatLabel(format), format)));
const sourceNames = { tab: "Chrome-Tab", window: "Fenster", screen: "Bildschirm", camera: "Kamera" };
const labels = { idle: "Bereit", selecting: "Quelle in Chrome auswählen", preparing: "Aufnahme wird vorbereitet", recording: "Aufnahme läuft", paused: "Aufnahme pausiert", stopping: "Aufnahme wird gespeichert", error: "Aufnahme nicht gestartet" };

async function api(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ target: "background", type,
    ...(isPopup && popupSession ? { popupSession } : {}), ...values });
  if (!response || response.ok === false) throw new Error(response?.error || "Die Erweiterung antwortet nicht.");
  return response;
}
function message(text = "", error = false) {
  for (const id of ["message", "activeMessage", "screenshotMessage", "libraryMessage"]) {
    $(id).textContent = text;
    $(id).hidden = !text;
    $(id).classList.toggle("error", error);
  }
  if (isPopup) resize();
}
function renderLastRecording() {
  const result = current.lastRecordingResult;
  const visible = !activeStatuses.includes(current.status) && Boolean(result?.id && result.message);
  const detail = visible ? result.message : "";
  $("lastRecording").hidden = !visible;
  $("lastRecordingMessage").textContent = detail;
  $("openLastRecordingButton").disabled = busy;
  $("libraryRecordingResult").hidden = !visible;
  $("libraryRecordingResult").textContent = detail;
}
function updateStopHint(source) {
  const hint = $("actionHint");
  hint.hidden = source !== "screen" || current.captureSetup === true;
  hint.textContent = "Warte auf REC. „Freigabe beenden“ in Chrome speichert automatisch."
    + (stopShortcut ? ` Du kannst auch mit ${stopShortcut} beenden.` : " Über REC öffnest du das Menü zum Beenden.");
}
let regionPreview, regionDrag;
const regionFields = ["X", "Y", "Width", "Height"].map(part => $(`captureRegion${part}`));
function selectedRegion() {
  if (!regionPreview || regionFields.some(field => !field.checkValidity() || !field.value)) return null;
  const [x, y, width, height] = regionFields.map(field => field.valueAsNumber);
  if (x + width > regionPreview.width || y + height > regionPreview.height) return null;
  return normalizeRegion({ x, y, width, height, viewportWidth: regionPreview.width, viewportHeight: regionPreview.height });
}
function drawRegion() {
  const region = selectedRegion(), outline = $("captureRegionOutline");
  outline.hidden = !region;
  $("confirmCaptureRegion").disabled = busy || !region;
  if (!region) return;
  Object.assign(outline.style, {
    left: `${region.x / region.viewportWidth * 100}%`,
    top: `${region.y / region.viewportHeight * 100}%`,
    width: `${region.width / region.viewportWidth * 100}%`,
    height: `${region.height / region.viewportHeight * 100}%`,
  });
}
function renderRegionSelection(active) {
  const candidate = active ? globalThis.recorderCapture?.regionPreview?.() : null;
  const image = $("captureRegionImage");
  $("captureRegionPanel").hidden = !Boolean(candidate);
  $("cancelCaptureRegion").disabled = busy;
  document.body.dataset.choosingRegion = String(Boolean(candidate));
  if (candidate !== regionPreview) {
    regionPreview = candidate;
    regionDrag = null;
    $("captureRegionError").hidden = true;
    if (candidate) {
      image.src = candidate.dataUrl;
      image.width = candidate.width;
      image.height = candidate.height;
      $("captureRegionStage").style.setProperty("--preview-ratio", candidate.width / candidate.height);
      regionFields.forEach((field, index) => {
        field.max = index % 2 === 0 ? candidate.width : candidate.height;
        field.value = "";
      });
      $("captureRegionTitle").focus();
    } else image.removeAttribute("src");
  }
  drawRegion();
  return Boolean(candidate);
}
function regionPoint(event) {
  const bounds = $("captureRegionStage").getBoundingClientRect();
  return [
    Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * regionPreview.width),
    Math.round(Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) * regionPreview.height),
  ];
}
function updateDraggedRegion(event) {
  if (!regionDrag || event.pointerId !== regionDrag.pointer) return;
  const [x, y] = regionPoint(event);
  const values = [Math.min(regionDrag.x, x), Math.min(regionDrag.y, y), Math.abs(regionDrag.x - x), Math.abs(regionDrag.y - y)];
  regionFields.forEach((field, index) => { field.value = values[index]; });
  drawRegion();
}
const regionStage = $("captureRegionStage");
regionStage.addEventListener("pointerdown", event => {
  if (!regionPreview || busy || event.button !== 0 || regionDrag) return;
  const [x, y] = regionPoint(event);
  regionDrag = { x, y, pointer: event.pointerId };
  regionStage.setPointerCapture(event.pointerId);
  updateDraggedRegion(event);
});
regionStage.addEventListener("pointermove", updateDraggedRegion);
regionStage.addEventListener("pointerup", event => { updateDraggedRegion(event); regionDrag = null; });
regionStage.addEventListener("lostpointercapture", () => { regionDrag = null; });
for (const field of regionFields) field.addEventListener("input", drawRegion);
function submitRegion(type, values) {
  const error = $("captureRegionError");
  error.hidden = true;
  return action(async () => {
    try {
      const result = await api(type, values);
      if (result.state) applyState(result.state);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    }
  });
}
$("confirmCaptureRegion").onclick = () => {
  const region = selectedRegion();
  if (region) return submitRegion("CONFIRM_CAPTURE_REGION", { region });
};
$("cancelCaptureRegion").onclick = () => submitRegion("CANCEL_CAPTURE_REGION");
function readSettings() {
  const value = name => form.elements.namedItem(name)?.value;
  return {
    source: value("source") || "", name: String(value("name") || "").trim(),
    microphone: $("microphone").checked, systemAudio: $("systemAudio").checked, camera: value("source") === "camera" || $("camera").checked,
    microphoneDeviceId: value("microphoneDeviceId") || "",
    cameraDeviceId: value("cameraDeviceId") || "",
    format: value("format") || "auto", saveDestination: value("saveDestination") || (APP_ORIGIN ? "cloud" : "local"),
    screenshotDestination: $("screenshotDestination").value,
    controlBar: $("controlBar").checked,
    cameraPosition: value("cameraPosition"), resolution: value("resolution") === "source" ? "source" : Number(value("resolution")),
    frameRate: Number(value("frameRate")), bitrate: Number(value("bitrate")), countdown: Number(value("countdown")),
    screenshotMode: value("screenshotMode") || "visible",
    microphoneReminder: $("microphoneReminder").checked,
    autoStopSeconds: $("autoStopEnabled").checked ? Math.max(6, Math.min(21600, Math.round(Number($("autoStopMinutes").value || 5) * 60))) : 0,
    screenshotDelaySeconds: Number($("screenshotDelay").value) || 3,
    regionCapture: Boolean(value("source") && value("source") !== "camera" && $("regionCapture").checked),
  };
}
function fillSettings(settings, selectSource = sourceSelected) {
  selectSource ||= settings.regionCapture && ["screen", "window", "tab"].includes(settings.source);
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (key === "source") {
      for (const radio of form.querySelectorAll('input[name="source"]')) radio.checked = selectSource && radio.value === value;
    } else if (key === "screenshotMode") {
      for (const radio of form.querySelectorAll('input[name="screenshotMode"]')) radio.checked = radio.value === value;
    } else if (key === "format") input.value = value === "auto" || recordingFormats.includes(value) ? value : "auto";
    else if (input.type === "checkbox") input.checked = Boolean(value);
    else if (key === "saveDestination" && value === "cloud" && !APP_ORIGIN) input.value = "local";
    else input.value = String(value ?? "");
  }
  $("autoStopEnabled").checked = Number(settings.autoStopSeconds) > 0;
  $("autoStopMinutes").value = Number(settings.autoStopSeconds) > 0 ? String(Number(settings.autoStopSeconds) / 60) : "5";
  $("screenshotDestination").value = APP_ORIGIN ? screenshotSaveDestination(settings) : "local";
  const folderOption = $("saveDestination").querySelector('[value="folder"]');
  folderOption.hidden = !recordingFolderName && settings.saveDestination !== "folder";
  if (recordingFolderName) folderOption.title = recordingFolderName;
  sourceSelected = Boolean(form.elements.namedItem("source")?.value);
  if (!sourceSelected || settings.source === "camera") $("regionCapture").checked = false;
  updateSummary();
}
function updateSummary() {
  const settings = readSettings();
  const microphoneStatus = activeStatuses.includes(current.status) && typeof current.microphoneAvailable === "boolean"
    ? current.microphoneAvailable ? current.microphoneMuted ? "stumm" : "an" : "aus"
    : settings.microphone ? "an" : "aus";
  $("captureSummary").textContent = settings.source
    ? `${sourceNames[settings.source]} · Mikrofon ${microphoneStatus}${settings.camera ? " · Kamera an" : ""}`
    : "Keine Quelle ausgewählt";
  $("sourceHint").textContent = settings.source
    ? settings.source === "camera" ? "Deine Kamera wird als Video aufgenommen."
      : `Wähle im nächsten Schritt ${settings.source === "window" ? "das konkrete Fenster" : settings.source === "tab" ? "den konkreten Tab" : "den konkreten Bildschirm"}.`
    : "Wähle zuerst eine Aufnahmequelle.";
  $("audioHint").textContent = settings.source === "tab"
    ? settings.regionCapture ? "Ton des ausgewählten Tabs" : "Aktiviere im Chrome-Freigabedialog das Teilen von Tab-Audio."
    : settings.source === "screen" ? "Aktiviere im Chrome-Freigabedialog das Teilen von Systemaudio, falls angeboten."
    : "Wenn Chrome ihn für die Quelle anbietet";
  $("qualitySummary").textContent = mode === "screenshot" ? "PNG" : settings.resolution === "source" ? "Original" : `${settings.resolution}p`;
  const format = settings.format === "auto" ? recordingFormats[0] : settings.format;
  document.querySelector(".format-badge").dataset.format = (format || "auto").toUpperCase();
  $("cameraOptions").hidden = !settings.camera;
  $("autoStopField").hidden = !$("autoStopEnabled").checked;
  $("screenshotDelayLabel").textContent = `${settings.screenshotDelaySeconds} s`;
  if (settings.source === "camera") $("camera").checked = true;
  $("camera").disabled = busy || activeStatuses.includes(current.status) || settings.source === "camera";
  $("regionCapture").disabled = busy || activeStatuses.includes(current.status);
  $("controlBarHint").textContent = settings.source === "screen"
    ? "Bei Bildschirmaufnahmen erscheint die Leiste erst nach dem Pausieren."
    : "Pause, Speichern und Einstellungen in einem schwebenden Fenster.";
  $("startButton").disabled = busy || activeStatuses.includes(current.status) || !settings.source;
  $("startButton").querySelector("span").textContent = current.captureSetup ? "Chrome-Freigabe öffnen"
    : settings.regionCapture ? "Ausschnitt auswählen" : "Aufnahme starten";
  updateStopHint(settings.source);
  resize();
}
function resize() {
  if (isPopup) {
    const addedSpace = ["message", "lastRecording", "actionHint", "regionCaptureSetting"].reduce((height, id) => {
      const element = $(id), styles = getComputedStyle(element);
      return height + (element.offsetHeight ? element.offsetHeight + parseFloat(styles.marginTop) + parseFloat(styles.marginBottom) : 0);
    }, 0);
    const height = activeStatuses.includes(current.status) && !readonlySettingsRequested
      ? ["selecting", "preparing", "stopping"].includes(current.status) ? 225 : 440
      : microphoneWarningOpen ? 340 : settingsOpen || libraryOpen ? 500 : mode === "record" ? 374 + addedSpace : 430;
    document.documentElement.style.setProperty("--popup-height", `${height}px`);
    return;
  }
  if (current.hostOnly) return;
  const active = activeStatuses.includes(current.status);
  const desired = active ? (["selecting", "preparing"].includes(current.status) ? 280 : 560) : 704;
  const height = Math.min(desired, Math.max(350, screen.availHeight - 50));
  const size = `460:${height}`;
  if (size === lastSize) return;
  lastSize = size;
  api("RESIZE_CONTROLS", { width: 460, height }).catch(() => { try { window.resizeTo(460, height); } catch {} });
}
function renderLayout() {
  document.body.dataset.mode = mode;
  const active = activeStatuses.includes(current.status);
  const choosingRegion = renderRegionSelection(!isPopup && current.choosingRegion && current.status === "preparing" && !current.controlsHidden);
  $("setupView").hidden = microphoneWarningOpen || (active && !readonlySettingsRequested) || libraryOpen || (!isPopup && Boolean(current.hostOnly) && !current.captureSetup);
  $("microphoneReminderPanel").hidden = !microphoneWarningOpen;
  $("setupBody").hidden = settingsOpen;
  $("settingsPanel").hidden = !settingsOpen;
  $("quickSettings").hidden = settingsOpen;
  $("compactCaptureControls").hidden = settingsOpen || mode !== "record" || active;
  for (const setting of document.querySelectorAll(".recording-setting")) setting.hidden = mode !== "record";
  $("controlBarSetting").hidden = settingsOpen || mode !== "record" || active;
  $("actionArea").hidden = readonlySettingsRequested || settingsOpen || mode === "screenshot";
  $("libraryPanel").hidden = !libraryOpen;
  $("activePanel").hidden = !active || readonlySettingsRequested || choosingRegion;
  $("showControlBarButton").hidden = !["recording", "paused"].includes(current.status);
  $("showControlBarButton").lastChild.textContent = current.barVisible ? "Schwebende Leiste öffnen" : "Schwebende Leiste anzeigen";
  $("liveAudioPanel").hidden = !["recording", "paused"].includes(current.status);
  $("appFooter").hidden = active || microphoneWarningOpen;
  $("modeTabs").hidden = settingsOpen;
  $("recordPanel").hidden = mode !== "record";
  $("screenshotPanel").hidden = mode !== "screenshot";
  $("startButton").hidden = mode !== "record" || active;
  $("screenshotButton").hidden = true;
  $("settingsButton").setAttribute("aria-expanded", String(settingsOpen));
  for (const [id, selected] of [["recordTab", mode === "record"], ["screenshotTab", mode === "screenshot"]]) {
    $(id).setAttribute("aria-selected", String(selected));
    $(id).tabIndex = selected ? 0 : -1;
  }
  resize();
}
function drawer(which) {
  closeDeviceMenus();
  settingsOpen = which === "settings";
  libraryOpen = which === "library";
  renderLayout();
}
function setMode(next) {
  if (busy || activeStatuses.includes(current.status)) return;
  mode = next;
  chrome.storage.local.get("recorderPreferences").then(saved => {
    preferences = { ...preferences, ...saved.recorderPreferences, lastTab: next };
    return chrome.storage.local.set({ recorderPreferences: preferences });
  }).catch(() => {});
  drawer(null);
  message();
  applyState(current);
}
function updateTimer() {
  const elapsed = Number(current.elapsedMs || 0) + (current.status === "recording" && current.startedAt ? Math.max(0, Date.now() - current.startedAt) : 0);
  const seconds = Math.floor(elapsed / 1000), hours = Math.floor(seconds / 3600);
  $("timer").textContent = hours
    ? `${hours}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function applyState(state) {
  current = state || current;
  if (current.captureSetup && !hostSetupApplied) {
    hostSetupApplied = true;
    localSettings = { ...localSettings, ...current.pendingCaptureOptions };
    fillMicrophoneDevices($("microphoneDevice"), microphoneDevices, localSettings.microphoneDeviceId || "");
    fillSettings(localSettings, true);
  } else if (!current.captureSetup) hostSetupApplied = false;
  document.body.dataset.status = current.status;
  // Before BEGIN there is no MediaRecorder yet. After capture hiding is
  // requested, no stale selecting/preparing message may reveal the window.
  const hostPreflight = current.hostOnly && ["selecting", "preparing"].includes(current.status) && !current.controlsHidden;
  const allowSurface = isPopup ? popupReady && !popupHidden : !current.controlsHidden && (!current.hostOnly || hostPreflight || current.captureSetup);
  const safeToShow = allowSurface && (["idle", "paused", "error", "selecting", "preparing"].includes(current.status)
    || (["tab", "camera"].includes(current.sourceMode) && ["recording", "stopping"].includes(current.status))
    || (isPopup && current.status === "stopping" && current.popupHidden === false));
  document.body.classList.toggle("capture-hidden", !safeToShow);
  document.body.style.visibility = safeToShow ? "visible" : "hidden";
  const active = activeStatuses.includes(current.status);
  if (active && !readonlySettingsRequested) { settingsOpen = false; libraryOpen = false; }
  if (!active && readonlySettingsRequested) { readonlySettingsRequested = false; settingsOpen = false; }
  $("statusText").textContent = labels[current.status] || "Verbindung wird hergestellt…";
  $("pauseButton").hidden = current.status !== "recording";
  $("resumeButton").hidden = current.status !== "paused";
  $("stopButton").hidden = !["recording", "paused"].includes(current.status);
  $("timer").hidden = ["selecting", "preparing"].includes(current.status);
  $("recordingIndicator").hidden = current.status !== "recording";
  $("activeHint").textContent = current.status === "selecting" ? "Bestätige die gewünschte Quelle im Chrome-Dialog."
    : current.status === "preparing" ? "Deine Quelle wird geprüft. Gleich geht’s los."
    : current.status === "paused" ? "Die Aufnahme ist pausiert. Mit Fortsetzen geht es weiter."
    : current.status === "stopping" ? "Deine Aufnahme wird lokal gespeichert."
    : "Die Aufnahme läuft. Mikrofon und Quellton kannst du hier ändern.";
  for (const control of form.elements) control.disabled = control.id === "closeSettingsButton" ? busy : active || busy;
  for (const id of ["pauseButton", "resumeButton", "stopButton", "showControlBarButton"]) $(id).disabled = busy || ["selecting", "preparing", "stopping"].includes(current.status);
  for (const id of ["libraryButton", "libraryFooterButton", "recordTab", "screenshotTab"]) $(id).disabled = active || busy;
  $("libraryButton").hidden = !isPopup && Boolean(current.hostOnly);
  if (!isPopup && hostPreflight) $("activeHint").textContent = "Bestätige die Quelle und die angefragten Freigaben in Chrome.";
  const error = current.error || (!active && current.folderSaveError?.message);
  const warning = active && !(current.sourceAudioAvailable === false && /Quellton/.test(current.warning)) ? current.warning : "";
  const stateMessage = error || warning || current.notice || "";
  if (stateMessage) message(stateMessage, Boolean(error));
  else if (displayedStateMessage && [displayedStateMessage, translateText(displayedStateMessage)].includes($("message").textContent)) message();
  displayedStateMessage = stateMessage;
  renderLastRecording();
  if (current.settings && active) fillSettings({ ...localSettings, ...current.settings,
    controlBar: current.controlBarEnabled ?? current.settings.controlBar ?? localSettings.controlBar }, true);
  if (current.recordingId && current.recordingId !== lastRecordingId && current.status === "idle") {
    lastRecordingId = current.recordingId;
    loadLibrary().catch(error => message(error.message, true));
  }
  updateSummary();
  const voice = captureAudioState(current, "microphone"), sourceAudio = captureAudioState(current, "source");
  const live = ["recording", "paused"].includes(current.status);
  $("liveMicrophone").checked = Boolean(voice.available && voice.enabled);
  $("liveMicrophone").disabled = busy || !live;
  $("liveMicrophoneHint").textContent = !voice.available ? "Zum Einschalten Mikrofon freigeben" : voice.enabled ? "Deine Stimme wird aufgenommen" : "Deine Stimme ist stumm";
  $("liveSourceAudio").checked = Boolean(sourceAudio.available && sourceAudio.enabled);
  $("liveSourceAudio").disabled = busy || !live || !sourceAudio.available;
  $("liveSourceAudioHint").textContent = !sourceAudio.available ? "Für diese Quelle ist kein Ton verfügbar. Dein Mikrofon funktioniert unabhängig davon." : sourceAudio.enabled ? "Ton der Quelle wird aufgenommen" : "Ton der Quelle ist stumm";
  $("liveMicrophoneDevice").disabled = busy || !live;
  const selectedDevice = current.microphoneDeviceId ?? current.settings?.microphoneDeviceId;
  if (typeof selectedDevice === "string" && $("liveMicrophoneDevice").value !== selectedDevice)
    fillMicrophoneDevices($("liveMicrophoneDevice"), microphoneDevices, selectedDevice);
  if (current.sourceTitle && active && !/^(?:web-contents-media-stream|screen|window|tab):/i.test(current.sourceTitle))
    $("captureSummary").textContent = `${sourceNames[current.sourceMode] || "Quelle"} · ${current.sourceTitle}`;
  updateTimer();
  renderLayout();
}
async function action(fn) {
  if (busy) return;
  busy = true;
  message();
  applyState(current);
  try { await fn(); }
  catch (error) { message(error.message, true); }
  finally {
    busy = false;
    try { const result = await api("GET_STATE"); applyState(result.state || result); }
    catch (error) { message(error.message, true); }
    applyState(current);
  }
}
function startRecording() {
  if (!isPopup && current.captureSetup) {
    if (busy) return;
    const options = readSettings();
    // getDisplayMedia must run in this foreground frame's trusted click, before
    // storage, messaging or any other await can consume the user activation.
    let selection;
    try { selection = globalThis.recorderCapture.selectSource(options); }
    catch (error) { message(error.message, true); return; }
    return action(async () => {
      const prepared = await selection;
      if (prepared?.state) applyState({ ...current, ...prepared.state });
      if (prepared?.cancelled) return;
      localSettings = options;
      await chrome.storage.local.set({ captureSettings: localSettings });
      const result = await api("START_PREPARED_RECORDING");
      if (result.state) applyState(result.state);
    });
  }
  return action(async () => {
  localSettings = readSettings();
  if (!sourceNames[localSettings.source]) throw new Error("Wähle zuerst eine Aufnahmequelle.");
  await chrome.storage.local.set({ captureSettings: localSettings });
  drawer(null);
  const result = await api("START_RECORDING", { options: localSettings });
  if (result.state) applyState(result.state);
  });
}
$("startButton").onclick = () => {
  const settings = readSettings();
  if (!settings.source || busy) return;
  if (!settings.microphone && settings.microphoneReminder) {
    microphoneWarningOpen = true;
    renderLayout();
    $("enableMicrophoneButton").focus();
    return;
  }
  return startRecording();
};
$("continueMicrophoneButton").onclick = () => { microphoneWarningOpen = false; renderLayout(); return startRecording(); };
$("enableMicrophoneButton").onclick = () => { $("microphone").checked = true; microphoneWarningOpen = false; renderLayout(); return startRecording(); };
$("cancelMicrophoneButton").onclick = () => { microphoneWarningOpen = false; renderLayout(); $("startButton").focus(); };
$("pauseButton").onclick = () => action(async () => { const result = await api("PAUSE_RECORDING"); if (result.state) applyState(result.state); });
$("resumeButton").onclick = () => action(async () => { drawer(null); const result = await api("RESUME_RECORDING"); if (result.state) applyState(result.state); });
$("stopButton").onclick = () => action(async () => { const result = await api("STOP_RECORDING"); if (result.state) applyState(result.state); await loadLibrary(); drawer("library"); });
$("showControlBarButton").onclick = () => action(() => api("SHOW_FLOATING_BAR"));
for (const [id, field] of [["liveMicrophone", "microphoneEnabled"], ["liveSourceAudio", "sourceAudioEnabled"]]) {
  $(id).onchange = () => {
    const enabled = $(id).checked;
    return action(async () => {
      const result = await api("SET_AUDIO_STATE", { [field]: enabled });
      if (result.state) applyState(result.state);
    });
  };
}
$("liveMicrophoneDevice").onchange = () => {
  const deviceId = $("liveMicrophoneDevice").value;
  return action(async () => {
    const result = await api("SET_MICROPHONE_DEVICE", { deviceId });
    if (result.state) applyState(result.state);
  });
};
async function refreshAudioDevices() {
  try {
    const result = await api("GET_AUDIO_DEVICES");
    microphoneDevices = result.devices || [];
    cameraDevices = result.cameras || [];
    fillMicrophoneDevices($("microphoneDevice"), microphoneDevices, $("microphoneDevice").value || localSettings.microphoneDeviceId || "");
    fillMicrophoneDevices($("liveMicrophoneDevice"), microphoneDevices, current.microphoneDeviceId ?? current.settings?.microphoneDeviceId ?? result.microphoneDeviceId ?? "");
    fillMicrophoneDevices($("cameraDevice"), cameraDevices, $("cameraDevice").value || localSettings.cameraDeviceId || result.cameraDeviceId || "");
    $("cameraDevice").options[0].textContent = "Standardkamera";
  } catch { /* The default device remains selectable before permission is granted. */ }
}
for (const id of ["microphoneDevice", "liveMicrophoneDevice", "cameraDevice"]) $(id).addEventListener("focus", refreshAudioDevices);
function closeDeviceMenus(except = "") {
  for (const device of ["camera", "microphone"]) {
    if (device === except) continue;
    $(`${device}DeviceMenu`).hidden = true;
    $(`${device}DeviceButton`).setAttribute("aria-expanded", "false");
  }
}
for (const device of ["camera", "microphone"]) {
  $(`${device}DeviceButton`).onclick = () => {
    const menu = $(`${device}DeviceMenu`), open = menu.hidden;
    closeDeviceMenus();
    menu.hidden = !open;
    $(`${device}DeviceButton`).setAttribute("aria-expanded", String(open));
    if (open) refreshAudioDevices();
  };
}
document.addEventListener("pointerdown", event => {
  if (!$("compactCaptureControls").contains(event.target)) closeDeviceMenus();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (regionPreview) { event.preventDefault(); $("cancelCaptureRegion").click(); return; }
    closeDeviceMenus();
    if (microphoneWarningOpen) { microphoneWarningOpen = false; renderLayout(); $("startButton").focus(); }
  }
  if (microphoneWarningOpen && event.key === "Tab") {
    const buttons = [$("enableMicrophoneButton"), $("continueMicrophoneButton"), $("cancelMicrophoneButton")];
    const index = buttons.indexOf(document.activeElement);
    event.preventDefault();
    buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
  }
});
function captureScreenshot(options = {}) { return action(async () => {
  const settings = readSettings();
  localSettings = { ...settings, source: settings.source || localSettings.source };
  await chrome.storage.local.set({ captureSettings: localSettings });
  message(settings.screenshotMode === "fullpage" ? "Die ganze Webseite wird aufgenommen. Bitte nicht scrollen." : "Screenshot wird erstellt…");
  await api("CAPTURE_SCREENSHOT", { options: { mode: options.mode || settings.screenshotMode, saveDestination: settings.screenshotDestination, ...options } });
  message("Screenshot gespeichert. Der Editor öffnet sich in einem Tab.");
  await loadLibrary();
}); }
$("screenshotButton").onclick = () => captureScreenshot();
for (const button of document.querySelectorAll("[data-capture]")) button.onclick = () => captureScreenshot({ mode: button.dataset.capture });
$("delayedScreenshotButton").onclick = () => captureScreenshot({ mode: "visible", delaySeconds: readSettings().screenshotDelaySeconds });
$("displayScreenshotButton").onclick = () => captureScreenshot({ mode: "screen" });
$("importImageButton").onclick = () => action(() => api("OPEN_IMAGE_WORKSPACE"));
$("extractTextButton").onclick = () => captureScreenshot({ mode: "visible", extractText: true });
$("saveDestination").addEventListener("change", event => {
  if ($("saveDestination").value !== "configure") return;
  event.stopPropagation();
  $("saveDestination").value = !APP_ORIGIN && localSettings.saveDestination === "cloud" ? "local" : localSettings.saveDestination;
  action(() => api("OPEN_OPTIONS"));
});
$("recordTab").onclick = () => setMode("record");
$("screenshotTab").onclick = () => setMode("screenshot");
$("modeTabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  setMode(event.key === "Home" ? "screenshot" : event.key === "End" ? "record" : mode === "record" ? "screenshot" : "record");
  $(mode === "record" ? "recordTab" : "screenshotTab").focus();
});
$("settingsButton").onclick = () => drawer("settings");
$("screenshotSettingsButton").onclick = () => drawer("settings");
for (const button of document.querySelectorAll("[data-open-device-access]")) {
  button.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("devices.html") })
    .catch(error => message(error.message, true));
}
$("optionsButton").onclick = () => action(() => api("OPEN_OPTIONS"));
$("closeSettingsButton").onclick = () => { readonlySettingsRequested = false; drawer(null); };
async function showLibrary() { drawer("library"); await loadLibrary().catch(error => message(error.message, true)); }
$("libraryButton").onclick = showLibrary;
$("libraryFooterButton").onclick = showLibrary;
$("openLastRecordingButton").onclick = () => action(() => api("OPEN_EDITOR", { id: current.lastRecordingResult.id }));
$("closeLibraryButton").onclick = () => drawer(null);
form.addEventListener("submit", event => event.preventDefault());
form.addEventListener("change", async event => {
  const source = form.elements.namedItem("source");
  if (event.target === $("regionCapture") && $("regionCapture").checked && (!source.value || source.value === "camera")) {
    source.value = "screen";
  } else if (event.target.name === "source" && source.value === "camera") {
    $("regionCapture").checked = false;
  }
  if (localSettings.source === "camera" && source.value !== "camera") $("camera").checked = false;
  sourceSelected = Boolean(form.elements.namedItem("source")?.value);
  updateSummary();
  if (!activeStatuses.includes(current.status)) {
    const settings = readSettings();
    localSettings = { ...settings, source: settings.source || localSettings.source };
    try { await chrome.storage.local.set({ captureSettings: localSettings }); }
    catch (error) { message(error.message, true); }
  }
});
function size(bytes) { return bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
async function loadLibrary() {
  const response = await api("GET_RECORDINGS"), recordings = response.recordings || [];
  $("recordingsList").replaceChildren();
  $("libraryEmpty").hidden = Boolean(recordings.length);
  for (const recording of recordings) {
    const card = document.createElement("article"); card.className = "recording-card";
    const title = document.createElement("strong"); title.textContent = recording.name || recording.displayName || "Aufnahme";
    const info = document.createElement("small");
    const date = recording.createdAt ? new Date(recording.createdAt).toLocaleString("de-DE") : "";
    info.textContent = [
      recording.mimeType?.startsWith("image/") || recording.kind === "image" ? "Screenshot" : "Video",
      recording.status === "interrupted" ? "Unterbrochen · Gespeicherter Teil" : "",
      recording.bytes ? size(recording.bytes) : "",
      date,
    ].filter(Boolean).join(" · ");
    const actions = document.createElement("div"); actions.className = "recording-actions";
    const operations = [["Öffnen", () => api("OPEN_EDITOR", { id: recording.id })], ["Download", () => api("DOWNLOAD_RECORDING", { id: recording.id })]];
    if (isFinishedVideo(recording) && (recordingFolderName || recording.saveDestination === "folder")) {
      operations.push(["Im Aufnahmeordner speichern", async () => {
        const { filename } = await api("SAVE_RECORDING_TO_FOLDER", { id: recording.id });
        message(`Im Aufnahmeordner gespeichert: ${filename}`);
      }]);
    }
    if (APP_ORIGIN) operations.push(["Online speichern & teilen", () => api("OPEN_RECORDER", { id: recording.id })]);
    for (const [label, handler] of operations) {
      const button = document.createElement("button"); button.className = "button secondary"; button.type = "button"; button.textContent = label;
      button.onclick = () => action(handler); actions.append(button);
    }
    card.append(title, info, actions); $("recordingsList").append(card);
  }
}
chrome.runtime.onMessage.addListener((event, sender, sendResponse) => {
  const fromBackground = sender.id === chrome.runtime.id && (!sender.url || sender.url === chrome.runtime.getURL("background.js"));
  if (fromBackground && event.type === "HIDE_FOR_CAPTURE" && ((isPopup && event.target === "popup" && (event.closeAll || event.popupSession === popupSession))
    || (!isPopup && event.target === "controls"))) {
    if (isPopup) popupHidden = true;
    const alreadyHidden = document.body.style.visibility === "hidden" && document.body.classList.contains("capture-hidden");
    document.body.classList.add("capture-hidden");
    document.body.style.visibility = "hidden";
    // Minimized hosts do not receive animation frames. Their UI was hidden
    // before the chooser opened; BEGIN separately verifies fresh source frames.
    if (!isPopup && alreadyHidden) { sendResponse({ ok: true }); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      sendResponse({ ok: true });
      if (isPopup) setTimeout(() => window.close(), 0);
    }));
    return true;
  }
  // INIT_POPUP returns the current state and the session used for follow-up requests.
  if (fromBackground && event.type === "STATE_CHANGED" && event.state && (!isPopup || popupReady)) applyState(event.state);
});
setInterval(updateTimer, 250);
try {
  const [saved, folder] = await Promise.all([
    chrome.storage.local.get(["captureSettings", "soundDefaultsVersion", "recorderPreferences"]),
    getRecordingFolder().catch(() => null),
  ]);
  recordingFolderName = folder?.name || "";
  preferences = saved.recorderPreferences || {};
  mode = preferences.defaultTab === "screenshot" ? "screenshot" : preferences.defaultTab === "last" && preferences.lastTab === "screenshot" ? "screenshot" : "record";
  localSettings = { ...localSettings, ...saved.captureSettings };
  if (Number.isFinite(Number(preferences.screenshotDelaySeconds))) localSettings.screenshotDelaySeconds = Number(preferences.screenshotDelaySeconds);
  if (saved.soundDefaultsVersion !== 1) {
    localSettings.microphone = true;
    localSettings.systemAudio = true;
    await chrome.storage.local.set({ captureSettings: localSettings, soundDefaultsVersion: 1 });
  }
  fillSettings(localSettings);
  if (isPopup) {
    const result = await api("INIT_POPUP");
    if (result.close) { window.close(); }
    if (!result.popupSafe || !result.popupSession) throw new Error("Die Aufnahme konnte noch nicht sicher pausiert werden. Öffne das Menü erneut.");
    popupSession = result.popupSession;
    popupReady = true;
    readonlySettingsRequested = Boolean(result.showSettings);
    if (readonlySettingsRequested) settingsOpen = true;
    applyState(result.state || result);
  } else {
    const tab = await chrome.tabs.getCurrent();
    await api("CONTROLS_READY", { controllerTabId: tab?.id });
    const result = await api("GET_STATE"); applyState(result.state || result);
  }
  refreshAudioDevices();
  const commands = await chrome.commands.getAll();
  const pause = commands.find(command => command.name === "pause-resume"), stop = commands.find(command => command.name === "stop-recording");
  stopShortcut = stop?.shortcut || "";
  const shortcuts = [pause?.shortcut ? `Pause: ${pause.shortcut}` : "", stop?.shortcut ? `Beenden: ${stop.shortcut}` : ""].filter(Boolean);
  if (shortcuts.length) $("shortcutKeys").textContent = shortcuts.join(" · ");
  updateStopHint(readSettings().source);
  resize();
} catch (error) {
  message(error.message, true);
  $("statusText").textContent = "Verbindung nicht verfügbar";
  // An anchored popup stays blank when pause safety cannot be confirmed.
  if (!isPopup) applyState(current);
}
