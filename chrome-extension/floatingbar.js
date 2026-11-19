import { captureAudioState, fillMicrophoneDevices } from "./audio-controls.js";
import { initializeTheme } from "./theme.js";
import { localizeDocument } from "./i18n.js";

let uiDocument = document, pictureWindow = null, unpinRequested = false, closingPictureForCapture = false;
const themeReady = initializeTheme({ onChange: ({ preference, resolved }) => {
  if (!pictureWindow || pictureWindow.closed) return;
  pictureWindow.document.documentElement.dataset.theme = resolved;
  pictureWindow.document.documentElement.dataset.themePreference = preference;
  pictureWindow.document.documentElement.style.colorScheme = resolved;
} }).catch(() => null);
let pictureClosed = Promise.resolve();
const $ = id => uiDocument.getElementById(id);
let barTabId, ready = false, hiddenForCapture = false, busy = false, expanded = false;
let current = { status: "idle", elapsedMs: 0 }, lastHeight = 0, microphoneDevices = [];
const sourceNames = { tab: "Chrome-Tab", window: "Fenster", screen: "Bildschirm", camera: "Kamera" };

async function api(type, values = {}) {
  const result = await chrome.runtime.sendMessage({ target: "background", type, barTabId, ...values });
  if (!result || result.ok === false) throw new Error(result?.error || "Die Aufnahmesteuerung antwortet nicht.");
  return result;
}
function message(text = "", error = false) {
  $("barMessage").textContent = text;
  $("barMessage").hidden = !text;
  $("barMessage").classList.toggle("error", error);
  resize();
}
function audioState(channel) {
  return captureAudioState(current, channel);
}
function updateTimer() {
  const elapsed = Number(current.elapsedMs || 0) + (current.status === "recording" && current.startedAt ? Math.max(0, Date.now() - current.startedAt) : 0);
  const seconds = Math.floor(elapsed / 1000), hours = Math.floor(seconds / 3600);
  $("barTimer").textContent = hours
    ? `${hours}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function resize() {
  if (!ready) return;
  const surface = pictureWindow && !pictureWindow.closed ? pictureWindow : window;
  const chromeHeight = Math.max(0, surface.outerHeight - surface.innerHeight);
  const height = Math.ceil(uiDocument.querySelector("main").getBoundingClientRect().height + chromeHeight);
  if (height === lastHeight) return;
  lastHeight = height;
  if (pictureWindow && !pictureWindow.closed) {
    try { pictureWindow.resizeTo(330, height); } catch {}
    return;
  }
  api("RESIZE_FLOATING_BAR", { width: 330, height }).catch(() => {});
}
function applyState(state) {
  current = state || current;
  document.body.dataset.status = current.status;
  uiDocument.body.dataset.status = current.status;
  const active = ["recording", "paused"].includes(current.status);
  const safe = current.status === "paused" || (current.status === "recording" && ["tab", "window", "camera"].includes(current.sourceMode));
  const visible = ready && !hiddenForCapture && current.barVisible === true && safe;
  uiDocument.body.style.visibility = visible ? "visible" : "hidden";
  if (pictureWindow) document.body.style.visibility = "hidden";
  $("barStatus").textContent = current.status === "paused" ? "Aufnahme pausiert" : current.status === "recording" ? "Aufnahme läuft" : "Aufnahme wird gespeichert…";
  $("barPauseButton").hidden = current.status !== "recording";
  $("barResumeButton").hidden = current.status !== "paused";
  $("pinBarButton").hidden = !("documentPictureInPicture" in window);
  $("pinBarButton").setAttribute("aria-pressed", String(Boolean(pictureWindow)));
  $("pinBarButton").title = pictureWindow ? "Zur normalen Leiste wechseln" : "Immer im Vordergrund halten";
  $("pinBarButton").setAttribute("aria-label", $("pinBarButton").title);
  $("pinBarButton").disabled = busy || !active;
  for (const id of ["barPauseButton", "barResumeButton", "barStopButton", "barDetailsButton", "openMenuButton"])
    $(id).disabled = busy || !active;
  for (const [id, channel, label] of [["barMicrophoneButton", "microphone", "Mikrofon"], ["barSourceAudioButton", "source", "Quellton"]]) {
    const audio = audioState(channel), button = $(id);
    button.disabled = busy || !active || (channel !== "microphone" && !audio.available);
    button.setAttribute("aria-pressed", String(Boolean(audio.enabled && audio.available)));
    button.title = !audio.available && channel !== "microphone" ? `${label} ist für diese Quelle nicht verfügbar.` : `${label} ${audio.enabled && audio.available ? "ausschalten" : "einschalten"}`;
    button.setAttribute("aria-label", button.title);
  }
  const microphone = audioState("microphone"), sourceAudio = audioState("source");
  $("detailSource").textContent = sourceNames[current.sourceMode] || "Quelle";
  const settings = current.settings || {};
  if (uiDocument.activeElement?.id !== "barAutoStopMinutes") $("barAutoStopMinutes").value = String(Number(settings.autoStopSeconds || 0) / 60);
  $("barAutoStopMinutes").disabled = busy || !active;
  $("barAnnotationTools").disabled = busy || !active || current.sourceMode === "camera";
  $("detailQuality").textContent = `${settings.resolution === "source" ? "Original" : `${settings.resolution || 1080}p`} · ${settings.frameRate || 30} fps`;
  $("detailMicrophone").textContent = !microphone.available ? "Nicht aktiviert" : microphone.enabled ? "An" : "Stumm";
  $("detailAudio").textContent = !sourceAudio.available ? "Nicht verfügbar" : sourceAudio.enabled ? "An" : "Stumm";
  $("barSourceAudioHint").textContent = sourceAudio.available ? sourceAudio.enabled ? "Wird aufgenommen" : "Stumm" : "Chrome stellt für diese Quelle keinen Ton bereit.";
  $("barMicrophoneDevice").disabled = busy || !active;
  const selectedDevice = current.microphoneDeviceId ?? current.settings?.microphoneDeviceId;
  if (typeof selectedDevice === "string" && $("barMicrophoneDevice").value !== selectedDevice)
    fillMicrophoneDevices($("barMicrophoneDevice"), microphoneDevices, selectedDevice);
  $("detailCamera").textContent = settings.camera ? "An" : "Aus";
  $("barHint").textContent = current.sourceMode === "screen"
    ? "Bildschirmaufnahme pausiert. Die Leiste wird vor dem Fortsetzen ausgeblendet."
    : `${sourceNames[current.sourceMode] || "Aufnahme"} · Diese Leiste gehört nicht zum Video.`;
  if (current.error) message(current.error, true);
  updateTimer();
  resize();
}
async function pinBar() {
  if (pictureWindow && !pictureWindow.closed) {
    unpinRequested = true;
    pictureWindow.close();
    await pictureClosed;
    return;
  }
  if (!("documentPictureInPicture" in window)) return;
  // This call must be reached directly from the pin button's user gesture.
  const pip = await window.documentPictureInPicture.requestWindow({ width: 330, height: expanded ? 420 : 68, disallowReturnToOpener: true });
  pictureWindow = pip;
  const main = document.querySelector("main");
  pip.document.documentElement.lang = "de";
  pip.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  pip.document.documentElement.dataset.themePreference = document.documentElement.dataset.themePreference;
  pip.document.documentElement.style.colorScheme = document.documentElement.style.colorScheme;
  pip.document.title = "Capture Desk · Control bar";
  pip.document.body.style.visibility = "hidden";
  const style = pip.document.createElement("link");
  style.rel = "stylesheet"; style.href = chrome.runtime.getURL("floatingbar.css");
  const stylesReady = new Promise(resolve => { style.onload = resolve; style.onerror = resolve; });
  pip.document.head.append(style);
  const base = pip.document.createElement("base"); base.href = chrome.runtime.getURL(""); pip.document.head.append(base);
  const icon = pip.document.createElement("link"); icon.rel = "icon"; icon.href = chrome.runtime.getURL("icons/recorder-32.png"); pip.document.head.append(icon);
  pip.document.body.append(main);
  localizeDocument(pip.document);
  uiDocument = pip.document;
  document.body.style.visibility = "hidden";
  let finishClosed;
  pictureClosed = new Promise(resolve => { finishClosed = resolve; });
  pip.addEventListener("pagehide", () => {
    document.body.append(main);
    uiDocument = document;
    pictureWindow = null;
    document.body.style.visibility = "hidden";
    lastHeight = 0;
    const closedForCapture = closingPictureForCapture;
    closingPictureForCapture = false;
    finishClosed();
    if (closedForCapture) return;
    if (unpinRequested) {
      unpinRequested = false;
      api("UNPIN_FLOATING_BAR").then(result => applyState(result.state || current)).catch(error => message(error.message, true));
    } else {
      hiddenForCapture = true;
      api("HIDE_FLOATING_BAR").catch(() => {});
    }
  }, { once: true });
  try {
    await stylesReady;
    if (pip.closed) return;
    if (hiddenForCapture || current.barVisible !== true || (current.sourceMode === "screen" && current.status !== "paused")) {
      closingPictureForCapture = true;
      pip.close();
      await pictureClosed;
      return;
    }
    const result = await api("PIN_FLOATING_BAR");
    applyState(result.state || current);
  } catch (error) {
    unpinRequested = true;
    pip.close();
    await pictureClosed;
    throw error;
  }
}
async function blankAndClosePicture() {
  hiddenForCapture = true;
  document.body.style.visibility = "hidden";
  uiDocument.body.style.visibility = "hidden";
  const pip = pictureWindow;
  if (pip && !pip.closed) {
    closingPictureForCapture = true;
    await new Promise(resolve => pip.requestAnimationFrame(() => pip.requestAnimationFrame(resolve)));
    pip.close();
    const until = Date.now() + 1500;
    while (!pip.closed) {
      if (Date.now() >= until) throw new Error("Schließe zuerst die angeheftete Steuerleiste.");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    let timer;
    try { await Promise.race([pictureClosed, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Die angeheftete Steuerleiste wurde nicht geschlossen.")), 1500); })]); }
    finally { clearTimeout(timer); }
  }
  if (document.visibilityState === "hidden") return;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function action(fn) {
  if (busy) return;
  busy = true; message(); applyState(current);
  try { const result = await fn(); if (result?.state) applyState(result.state); }
  catch (error) { message(error.message, true); }
  finally {
    busy = false;
    try { const result = await api("GET_STATE"); applyState(result.state || result); }
    catch (error) { message(error.message, true); }
    applyState(current);
  }
}
$("barPauseButton").onclick = () => action(() => api("PAUSE_RECORDING"));
$("barResumeButton").onclick = () => action(() => api("RESUME_RECORDING"));
$("barStopButton").onclick = () => action(() => api("STOP_RECORDING"));
$("barMicrophoneButton").onclick = () => action(() => api("SET_AUDIO_STATE", { microphoneEnabled: !audioState("microphone").enabled }));
$("barSourceAudioButton").onclick = () => action(() => api("SET_AUDIO_STATE", { sourceAudioEnabled: !audioState("source").enabled }));
$("barAutoStopMinutes").onchange = () => action(() => api("SET_AUTO_STOP", { seconds: Math.max(0, Math.min(21600, Math.round(Number($("barAutoStopMinutes").value || 0) * 60))) }));
const annotation = command => action(() => api("SET_RECORDING_ANNOTATION", { mode: $("barDrawingMode").value, color: $("barDrawColor").value,
  cursorHighlight: $("barCursorHighlight").checked, ...command }));
for (const id of ["barDrawingMode", "barDrawColor", "barCursorHighlight"]) $(id).onchange = () => annotation({});
$("barUndoAnnotation").onclick = () => annotation({ action: "undo" });
$("barClearAnnotations").onclick = () => annotation({ action: "clear" });
$("hideBarButton").onclick = () => action(() => api("HIDE_FLOATING_BAR"));
$("pinBarButton").onclick = () => action(pinBar);
$("barDetailsButton").onclick = () => {
  expanded = !expanded;
  $("barDetails").hidden = !expanded;
  $("barDetailsButton").setAttribute("aria-expanded", String(expanded));
  $("barDetailsButton").title = expanded ? "Weniger anzeigen" : "Mehr anzeigen";
  if (expanded) refreshAudioDevices();
  resize();
};
async function refreshAudioDevices() {
  try {
    const result = await api("GET_AUDIO_DEVICES");
    microphoneDevices = result.devices || [];
    fillMicrophoneDevices($("barMicrophoneDevice"), microphoneDevices, current.microphoneDeviceId ?? current.settings?.microphoneDeviceId ?? result.microphoneDeviceId ?? "");
  } catch (error) { message(error.message, true); }
  resize();
}
$("barMicrophoneDevice").addEventListener("focus", refreshAudioDevices);
$("barMicrophoneDevice").onchange = () => {
  const deviceId = $("barMicrophoneDevice").value;
  return action(() => api("SET_MICROPHONE_DEVICE", { deviceId }));
};
$("openMenuButton").onclick = () => action(() => api("OPEN_BAR_SETTINGS"));
chrome.runtime.onMessage.addListener((event, sender, sendResponse) => {
  const fromBackground = sender.id === chrome.runtime.id && (!sender.url || sender.url === chrome.runtime.getURL("background.js"));
  if (!fromBackground) return;
  if (event.target === "floatingbar" && event.type === "HIDE_FOR_CAPTURE" && event.barTabId === barTabId) {
    blankAndClosePicture().then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (event.target === "floatingbar" && event.type === "FOCUS_FLOATING_BAR" && event.barTabId === barTabId) {
    if (pictureWindow && !pictureWindow.closed) { pictureWindow.focus(); sendResponse({ ok: true }); }
    else sendResponse({ ok: false });
    return;
  }
  if (event.type === "STATE_CHANGED" && event.state) {
    if (event.state.barVisible === true && current.barVisible !== true) hiddenForCapture = false;
    applyState(event.state);
  }
});
setInterval(updateTimer, 250);
try {
  await themeReady;
  barTabId = (await chrome.tabs.getCurrent())?.id;
  const result = await api("INIT_FLOATING_BAR");
  if (!result.barSafe) throw new Error("Die Steuerung kann gerade nicht sicher angezeigt werden.");
  ready = true;
  applyState(result.state || result);
} catch (error) { message(error.message, true); }
