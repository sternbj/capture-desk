import { ExtensionStore, finalizeWebm, isFinishedVideo, normalizeOptions, safeFilename, screenshotSaveDestination } from "./capture-core.js";
import { normalizePreferences } from "./preferences.js";
import { writeRecordingToFolder } from "./recording-folder.js";
import { APP_ORIGIN } from "./app-config.js";
import { translateText } from "./i18n.js";

const EXTENSION_ORIGIN = chrome.runtime.getURL("");
const CHUNK_SIZE = 524288;
const CONTROL_CAPTURE_OPERATIONS = new Set(["SELECT_SOURCE", "PREPARE", "PREVIEW_REGION", "SET_CAPTURE_REGION", "BEGIN", "PAUSE", "RESUME", "STOP", "GET_STATE", "SET_AUDIO_STATE", "GET_AUDIO_DEVICES", "SET_MICROPHONE_DEVICE", "SET_AUTO_STOP", "CAPTURE_DISPLAY_IMAGE"]);
let state = { status: "idle", elapsedMs: 0, startedAt: 0, targetTabId: null, controlsHidden: false };
let controlsWindowId, controlsTabId, controlsHostMode, creatingControls, creatingOffscreen, openingMenu, operation = false, focusPause = false, queuedPopupStart = false, selectingRegion = false;
let handoffs = {};
let barWindowId, barTabId, creatingBar, openingBar, finishingCapture;
const completedRecordings = new Set();
const folderWrites = new Map();
const terminalStates = ["idle", "error"];
const popupSessions = new Map(), readyControls = new Set();
const POPUP_URL = chrome.runtime.getURL("popup.html");
const BAR_URL = chrome.runtime.getURL("floatingbar.html");
const ready = chrome.storage.session.get(["captureState", "controlsWindowId", "controlsTabId", "controlsHostMode", "barWindowId", "barTabId", "handoffs", "popupSessions", "readyControlsTabId"]).then(values => {
  state = values.captureState || state;
  controlsWindowId = values.controlsWindowId;
  controlsTabId = values.controlsTabId;
  controlsHostMode = values.controlsHostMode;
  handoffs = values.handoffs || {};
  barWindowId = values.barWindowId;
  barTabId = values.barTabId;
  if (state.lastFinishedRecordingId) completedRecordings.add(state.lastFinishedRecordingId);
  for (const [token, session] of values.popupSessions || []) popupSessions.set(token, session);
  if (Number.isInteger(values.readyControlsTabId)) readyControls.add(values.readyControlsTabId);
});
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function internal(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(EXTENSION_ORIGIN);
}
function mediaState(value = {}) {
  // Media frames report capture progress, never choose the browser target or
  // grant visibility to a menu/host owned by the worker.
  const fields = ["status", "elapsedMs", "startedAt", "sourceMode", "settings", "name", "recordingId", "error", "warning", "notice", "sourceReady", "sourceTitle", "microphoneAvailable", "microphoneMuted", "sourceAudioAvailable", "sourceAudioMuted", "microphoneDeviceId"];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}
function popupSender(sender) { return sender.url === POPUP_URL && (sender.frameId ?? 0) === 0; }
function barSender(sender) { return sender.url === BAR_URL && (sender.frameId ?? 0) === 0; }
function validateBar(message, sender) {
  if (!barSender(sender) || !Number.isInteger(barTabId) || message.barTabId !== barTabId ||
      (sender.tab && sender.tab.id !== barTabId)) throw new Error("Invalid control bar instance");
}
function liveBarSafe() {
  return ["tab", "window", "camera"].includes(state.sourceMode);
}
function barMayShow() {
  return state.status === "paused" || (state.status === "recording" && liveBarSafe());
}
async function closeFloatingBar() {
  const id = barWindowId;
  barWindowId = barTabId = undefined;
  await chrome.storage.session.remove(["barWindowId", "barTabId"]);
  await publish({ barVisible: false, barPinned: false });
  if (id !== undefined) await chrome.windows.remove(id).catch(() => {});
}
async function hideFloatingBar({ destroy = false } = {}) {
  await publish({ barVisible: false });
  if (barWindowId === undefined) return;
  let window;
  try { window = await chrome.windows.get(barWindowId); }
  catch { await closeFloatingBar(); return; }
  if (destroy && window.state === "minimized" && !state.barPinned) { await closeFloatingBar(); return; }
  let timer, response;
  try {
    response = await Promise.race([
      chrome.runtime.sendMessage({ target: "floatingbar", type: "HIDE_FOR_CAPTURE", barTabId }),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Die Steuerleiste konnte nicht ausgeblendet werden. Die Aufnahme bleibt pausiert.")), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
  if (!response?.ok) throw new Error("Die Steuerleiste hat das Ausblenden nicht bestätigt. Die Aufnahme bleibt pausiert.");
  await publish({ barPinned: false });
  // A minimized window can be restored through the OS while capture is live.
  // Destroy the full-screen bar instead, then create it again after a pause.
  if (destroy) await closeFloatingBar();
  else await chrome.windows.update(barWindowId, { state: "minimized" });
}
function showFloatingBar({ requested = false } = {}) {
  if (!creatingBar) creatingBar = showFloatingBarNow({ requested }).finally(() => { creatingBar = null; });
  return creatingBar;
}
function requestFloatingBar({ legacy = false } = {}) {
  if (openingBar) return openingBar;
  if (operation || queuedPopupStart || openingMenu) throw new Error("Die Aufnahme wird gerade vorbereitet.");
  // Reserve before syncState/PAUSE can yield. A full-screen resume must wait
  // for an earlier UI request even when it has not created its window yet.
  openingBar = (async () => {
    await syncState();
    if (legacy) await showControls();
    else await showFloatingBar({ requested: true });
    return { state };
  })().finally(() => { openingBar = null; });
  return openingBar;
}
async function showFloatingBarNow({ requested }) {
  if (state.controlBarEnabled === false && !requested) return;
  if (state.status === "recording" && !liveBarSafe()) {
    if (!requested) return;
    await engine("PAUSE");
    await publish({ popupHidden: false });
    await setPopupEnabled(true);
  }
  if (!barMayShow()) return;
  const recordingId = state.recordingId;
  const stillRelevant = () => barMayShow() && state.recordingId === recordingId && state.controlBarEnabled !== false;
  await publish({ controlBarEnabled: true, barVisible: false });
  if (barWindowId !== undefined) {
    try {
      if (state.barPinned) {
        const response = await chrome.runtime.sendMessage({ target: "floatingbar", type: "FOCUS_FLOATING_BAR", barTabId });
        if (response?.ok && stillRelevant()) { await publish({ barVisible: true }); return; }
        await publish({ barPinned: false });
      }
      await chrome.windows.update(barWindowId, { state: "normal", focused: true });
      if (!stillRelevant()) { await closeFloatingBar(); return; }
      await publish({ barVisible: true }); return;
    } catch { barWindowId = barTabId = undefined; }
  }
  const options = { url: BAR_URL, type: "popup", width: 330, height: 110, focused: true };
  try {
    const anchor = await normalWindow();
    if ([anchor?.left, anchor?.top, anchor?.width, anchor?.height].every(Number.isFinite)) {
      options.left = anchor.left + Math.max(12, Math.round((anchor.width - options.width) / 2));
      options.top = anchor.top + Math.max(60, anchor.height - options.height - 24);
    }
  } catch { /* Let Chrome position the separate bar on a visible display. */ }
  let window;
  try { window = await chrome.windows.create(options); }
  catch { delete options.left; delete options.top; window = await chrome.windows.create(options); }
  barWindowId = window.id; barTabId = window.tabs?.[0]?.id;
  if (!Number.isInteger(barTabId)) { await closeFloatingBar(); throw new Error("Die Steuerleiste konnte nicht geöffnet werden."); }
  await chrome.storage.session.set({ barWindowId, barTabId });
  if (!stillRelevant()) { await closeFloatingBar(); return; }
  await publish({ barVisible: true });
}
async function popupDocument(sender) {
  if (!popupSender(sender) || sender.tab) throw new Error("Invalid recorder popup");
  const contexts = await popupContexts();
  const context = sender.documentId ? contexts.find(context => context.documentId === sender.documentId) : contexts.length === 1 ? contexts[0] : null;
  if (!context?.documentId) throw new Error("Invalid recorder popup");
  return context.documentId;
}
async function validatePopup(message, sender) {
  const session = popupSessions.get(message.popupSession);
  if (!session || session.documentId !== await popupDocument(sender))
    throw new Error("Öffne das Menü erneut über den roten Aufnahmepunkt.");
}
async function popupContexts() {
  return chrome.runtime.getContexts({ contextTypes: ["POPUP"], documentUrls: [POPUP_URL] });
}
async function setPopupEnabled(enabled) { await chrome.action.setPopup({ popup: enabled ? "popup.html" : "" }); }
async function normalWindow() {
  if (chrome.windows.getLastFocused) {
    try { return await chrome.windows.getLastFocused({ windowTypes: ["normal"] }); } catch { /* use an existing browser window */ }
  }
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return windows.find(window => window.focused) || windows[0];
}
async function rememberPopupTarget() {
  const window = await normalWindow();
  const tab = window ? (await chrome.tabs.query({ active: true, windowId: window.id }))[0] : null;
  const valid = Number.isInteger(tab?.id) && /^(https?|file):/.test(tab.url || "");
  // An unsupported page must not retain a previous page's capture permission.
  await publish({ normalWindowId: window?.id, targetTabId: valid ? tab.id : null, targetTitle: valid ? tab.title || "Chrome-Tab" : "" });
}
async function initPopup(sender) {
  const documentId = await popupDocument(sender);
  await syncState();
  await rememberPopupTarget();
  if (operation || queuedPopupStart || ["selecting", "preparing", "stopping"].includes(state.status)) return { popupSafe: false, close: true, state };
  if (state.status === "recording" && !["tab", "camera"].includes(state.sourceMode)) await engine("PAUSE");
  const popupSession = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join("");
  popupSessions.set(popupSession, { documentId });
  const activeDocuments = new Set((await popupContexts()).map(context => context.documentId));
  for (const [token, session] of popupSessions) if (!activeDocuments.has(session.documentId) && token !== popupSession) popupSessions.delete(token);
  await chrome.storage.session.set({ popupSessions: [...popupSessions] });
  await publish({ hostOnly: true, popupHidden: false });
  const showSettings = state.popupSettingsRequested === true;
  if (showSettings) await publish({ popupSettingsRequested: false });
  return { state, popupSafe: true, popupSession, appOrigin: APP_ORIGIN, showSettings };
}
async function hidePopupSurfaces() {
  await setPopupEnabled(false);
  await publish({ popupHidden: true });
  if ((await popupContexts()).length) {
    await Promise.race([
      chrome.runtime.sendMessage({ target: "popup", type: "HIDE_FOR_CAPTURE", closeAll: true }).catch(() => {}),
      delay(1500),
    ]);
  }
  const until = Date.now() + 4000;
  while ((await popupContexts()).length) {
    if (Date.now() >= until) throw new Error("Schließe zuerst das Erweiterungsmenü. Die Aufnahme bleibt angehalten.");
    await delay(25);
  }
  popupSessions.clear();
  await chrome.storage.session.set({ popupSessions: [] });
}
function openAnchoredMenu() {
  if (!openingMenu) openingMenu = openAnchoredMenuNow().finally(() => { openingMenu = null; });
  return openingMenu;
}
async function openAnchoredMenuNow() {
  if (operation || queuedPopupStart)
    throw new Error("Die Aufnahme wird gerade vorbereitet. Warte einen Moment.");
  await syncState();
  if (state.choosingRegion) return focusControls();
  if (state.status === "recording" && !["tab", "camera"].includes(state.sourceMode)) await engine("PAUSE");
  if (["selecting", "preparing"].includes(state.status)) return;
  await publish({ popupHidden: false, hostOnly: true });
  await setPopupEnabled(true);
  const window = await normalWindow();
  if (window) await chrome.windows.update(window.id, { focused: true });
  await chrome.action.openPopup(window ? { windowId: window.id } : {});
}
async function publish(patch) {
  state = { ...state, ...patch };
  await chrome.storage.session.set({ captureState: state });
  const saving = ["selecting", "preparing", "stopping"].includes(state.status);
  const saved = state.status === "idle" && state.recordingId && state.lastRecordingResult?.id === state.recordingId;
  const badge = state.status === "recording" ? "REC" : state.status === "paused" ? "Ⅱ" : saving ? "…" : state.status === "error" ? "!" : saved ? "✓" : "";
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color: saved ? "#257a54" : state.status === "paused" ? "#b7791f" : "#cf304a" });
  const title = ["recording", "paused"].includes(state.status) ? "Aufnahme beenden" : state.status === "stopping" ? "Aufnahme wird gespeichert" : saved ? "Aufnahme ansehen" : "";
  await chrome.action.setTitle({ title: title ? `Capture Desk · ${title}` : "Capture Desk" });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state }).catch(() => {});
  return state;
}
function publishMedia(value, patch = {}) {
  // A pause, resume or begin acknowledgement can arrive after Chrome has already
  // stopped sharing. It must not bring the finished recording back to life.
  if (value.recordingId && completedRecordings.has(value.recordingId)) return state;
  const published = publish({ ...mediaState(value), ...patch });
  // publish updates state synchronously. Claim this terminal recording before
  // a delayed acknowledgement has a chance to overwrite that state.
  if (terminalStates.includes(value.status) && value.recordingId)
    return completeRecording(value.recordingId, published);
  return published;
}
async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] });
  return contexts.length > 0;
}
async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (!creatingOffscreen) creatingOffscreen = chrome.offscreen.createDocument({ url: "offscreen.html",
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA", "BLOBS"], justification: "Record selected media in the background and retain local recording chunks." }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}
async function engine(type, extra = {}) {
  const target = state.engineContext === "controls" && CONTROL_CAPTURE_OPERATIONS.has(type) ? "capture-controls" : "offscreen";
  if (target === "offscreen") await ensureOffscreen();
  else if (!Number.isInteger(controlsTabId)) throw new Error("Öffne die Erweiterung über ihr Symbol in der Chrome-Leiste.");
  const response = await chrome.runtime.sendMessage({ target, type, ...(target === "capture-controls" ? { controllerTabId: controlsTabId } : {}), ...extra });
  if (!response?.ok) throw new Error(response?.error || "The capture engine did not respond");
  if (response.state) await publishMedia(response.state);
  return response;
}
async function syncState() {
  // The native chooser belongs to the worker; the hidden media frame is idle
  // until Chrome returns a token. Its idle state must not cancel that request.
  if ((queuedPopupStart || state.screenshotInProgress) && state.status === "selecting") return state;
  if (state.engineContext === "controls") {
    try {
      const previous = { ...state };
      const previousError = state.status === "error" ? state.error : "";
      const result = await engine("GET_STATE");
      const interrupted = ["selecting", "preparing", "recording", "paused", "stopping"].includes(previous.status) &&
        result.state?.status === "idle" && result.state.recordingId !== previous.recordingId;
      if (interrupted) {
        await clearRecordingAnnotations();
        await publish({ status: "error", controlsHidden: false, recordingId: previous.recordingId,
          error: "Das Aufnahmefenster wurde neu geladen. Bereits gespeicherte Teile findest du unter Aufnahmen." });
        await closeFloatingBar();
      }
      else if (previousError && result.state?.status === "idle") await publish({ status: "error", error: previousError, controlsHidden: false });
      if (state.hostOnly && interrupted) { await publish({ popupHidden: false }); await setPopupEnabled(true); }
    } catch {
      let vanished = false;
      if (controlsHostMode === "tab") {
        try { await chrome.tabs.get(controlsTabId); } catch { vanished = true; }
      } else if (controlsWindowId !== undefined) {
        try { await chrome.windows.get(controlsWindowId); } catch { vanished = true; }
      }
      if (vanished) {
        await clearRecordingAnnotations();
        await publish({ status: "error", startedAt: 0, controlsHidden: false, engineContext: null,
          error: "Das Aufnahmefenster wurde geschlossen. Bereits gespeicherte Teile findest du unter Aufnahmen." });
        await closeFloatingBar();
      }
      else await publish({ error: "Die Aufnahmesteuerung antwortet nicht. Die Steuerung bleibt bis zur bestätigten Pause oder Beendigung ausgeblendet." });
      if (vanished && state.hostOnly) { await publish({ popupHidden: false }); await setPopupEnabled(true); }
    }
  } else if (await offscreenExists()) {
    const previousError = state.status === "error" ? state.error : "";
    const result = await engine("GET_STATE");
    if (previousError && result.state?.status === "idle") await publish({ status: "error", error: previousError });
  }
  else if (["preparing", "recording", "paused", "stopping"].includes(state.status))
    await publish({ status: "error", startedAt: 0, controlsHidden: false, error: "Chrome stopped the capture process. Committed recording chunks remain in Library." });
  return state;
}
function focusControls(options = {}) {
  if (!creatingControls) creatingControls = focusControlsNow(options).finally(() => { creatingControls = null; });
  return creatingControls;
}
async function focusControlsNow({ hidden = false } = {}) {
  if (controlsHostMode === "tab" && Number.isInteger(controlsTabId)) {
    const tab = await chrome.tabs.update(controlsTabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  if (controlsWindowId !== undefined) {
    try { await chrome.windows.update(controlsWindowId, hidden ? { state: "minimized" } : { state: "normal", focused: true }); return; }
    catch { controlsWindowId = undefined; controlsTabId = undefined; }
  }
  const bounds = { width: 460, height: 650 };
  try {
    const tab = await chrome.tabs.get(state.targetTabId);
    const anchor = await chrome.windows.get(tab.windowId);
    if ([anchor.left, anchor.top, anchor.width, anchor.height].every(Number.isFinite)) {
      bounds.left = anchor.left + Math.max(16, anchor.width - bounds.width - 16);
      bounds.top = anchor.top + 80;
      bounds.height = Math.min(bounds.height, Math.max(460, anchor.height - 100));
    }
  } catch { /* Chrome chooses a safe default position when no page is available. */ }
  // Chrome forbids bounds together with a minimized initial state.
  const options = { url: chrome.runtime.getURL("controls.html"), type: "popup",
    ...(hidden ? { state: "minimized", focused: false } : { ...bounds, focused: true }) };
  let window;
  try { window = await chrome.windows.create(options); }
  catch {
    // Browser bounds can be outside the current display after a monitor change
    // or in a virtual test display. Let Chrome place the same single window.
    delete options.left; delete options.top;
    window = await chrome.windows.create(options);
  }
  controlsWindowId = window.id; controlsTabId = window.tabs?.[0]?.id;
  await chrome.storage.session.set({ controlsWindowId, controlsTabId });
  // Some macOS Chrome builds ignore the initial minimized state.
  if (hidden) await chrome.windows.update(controlsWindowId, { state: "minimized" });
}
async function ensureCaptureHost({ hidden = false } = {}) {
  await publish({ hostOnly: true, controlsHidden: hidden });
  if (hidden) await ensureCaptureTab();
  else await focusControls();
  const until = Date.now() + 10000;
  while (true) {
    if (readyControls.has(controlsTabId)) {
      try {
        const response = await chrome.runtime.sendMessage({ target: "capture-controls", type: "GET_STATE", controllerTabId: controlsTabId });
        if (response?.ok && response.state) return;
      } catch { /* The media module must finish initializing its frame identity. */ }
    }
    if (Date.now() >= until) throw new Error("Die Aufnahme konnte nicht vorbereitet werden. Öffne das Menü erneut.");
    await delay(25);
  }
}
async function ensureCaptureTab() {
  if (controlsHostMode === "tab" && Number.isInteger(controlsTabId)) {
    try {
      const tab = await chrome.tabs.get(controlsTabId);
      const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
      if (active?.id !== controlsTabId) await publish({ captureReturnTabId: active?.id });
      await chrome.tabs.update(controlsTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch { /* Recreate a closed host. */ }
  }
  // A visible browser window must parent Chrome's chooser. A minimized
  // recorder window can also minimize the native dialog on macOS.
  const oldWindow = controlsWindowId;
  readyControls.delete(controlsTabId);
  controlsWindowId = controlsTabId = undefined;
  await chrome.storage.session.remove(["controlsWindowId", "controlsTabId", "controlsHostMode", "readyControlsTabId"]);
  if (oldWindow !== undefined) await chrome.windows.remove(oldWindow).catch(() => {});
  const anchor = await normalWindow();
  if (!Number.isInteger(anchor?.id)) throw new Error("Öffne zuerst ein Chrome-Fenster und starte die Aufnahme erneut.");
  const active = (await chrome.tabs.query({ active: true, windowId: anchor.id }))[0];
  await publish({ captureReturnTabId: active?.id });
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("controls.html"), windowId: anchor.id, active: true });
  controlsTabId = tab.id;
  controlsHostMode = "tab";
  await chrome.storage.session.set({ controlsTabId, controlsHostMode });
  await chrome.windows.update(anchor.id, { focused: true });
}
async function restoreCaptureTab() {
  if (controlsHostMode !== "tab") return;
  const host = await chrome.tabs.get(controlsTabId).catch(() => null);
  if (!host?.active) return;
  const previous = await chrome.tabs.get(state.captureReturnTabId).catch(() => null);
  const fallback = previous?.id !== controlsTabId && previous?.windowId === host.windowId ? previous
    : (await chrome.tabs.query({ windowId: host.windowId })).find(tab => tab.id !== controlsTabId);
  if (fallback) await chrome.tabs.update(fallback.id, { active: true });
}
async function minimizeCaptureHost() {
  if (controlsWindowId !== undefined) await chrome.windows.update(controlsWindowId, { state: "minimized" }).catch(() => {});
}
async function chooseCaptureSource(options) {
  // Bind the single-use token to the persistent consumer, so closing the
  // toolbar popup cannot cancel the chooser or end the resulting recording.
  const consumer = await chrome.tabs.get(controlsTabId);
  const consumerUrl = chrome.runtime.getURL("controls.html");
  if (consumer.id !== controlsTabId || (consumer.url && consumer.url !== consumerUrl))
    throw new Error("Die Aufnahme konnte nicht vorbereitet werden. Öffne das Menü erneut.");
  const sources = options.regionCapture ? [options.source] : [options.source, ...["tab", "window", "screen"].filter(source => source !== options.source)];
  if (options.systemAudio) sources.push("audio");
  return new Promise((resolve, reject) => {
    // tabs.get omits URL without the broad tabs permission. This worker owns
    // the tab and already knows its exact extension URL.
    chrome.desktopCapture.chooseDesktopMedia(sources, { ...consumer, url: consumerUrl }, (streamId, selected = {}) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve({ streamId, canRequestAudioTrack: selected.canRequestAudioTrack === true });
    });
  });
}
async function startFromPopup(input = {}) {
  if (queuedPopupStart || operation || openingMenu || openingBar) throw new Error("Eine Aufnahme wird bereits vorbereitet.");
  queuedPopupStart = true;
  try {
    if (finishingCapture) await finishingCapture;
    await syncState();
    if (["selecting", "preparing", "recording", "paused", "stopping"].includes(state.status)) throw new Error("Stop the current recording first");
    if (!['tab', 'window', 'screen', 'camera'].includes(input.source)) throw new Error("Wähle zuerst eine Aufnahmequelle aus.");
  } catch (error) { queuedPopupStart = false; throw error; }
  setTimeout(() => {
    (async () => {
      let beginning = false;
      try {
        const options = normalizeOptions(input);
        options.region = null;
        const tabRegion = options.source === "tab" && options.regionCapture;
        if (tabRegion) {
          const tab = await targetTab();
          await hidePopupSurfaces();
          await chrome.tabs.update(tab.id, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
          options.region = await selectPageRegion(tab.id);
          if (!options.region) {
            await publish({ status: 'idle', popupHidden: false, notice: 'Bereichsauswahl abgebrochen.' });
            await setPopupEnabled(true); return;
          }
          await publish({ regionTabId: tab.id });
          await pageCall(tab.id, "watchRegion");
        }
        await closeFloatingBar();
        await chrome.storage.local.set({ captureSettings: options });
        await publish({ status: 'selecting', engineContext: 'controls', captureSetup: false, pendingCaptureOptions: null,
          settings: options, sourceMode: options.source, sourceReady: false, recordingId: null,
          hostOnly: true, controlsHidden: true, popupHidden: true, error: '', notice: '',
          controlBarEnabled: options.controlBar !== false, regionTabId: tabRegion ? state.targetTabId : null, regionInvalid: false, choosingRegion: false });
        await hidePopupSurfaces();
        await ensureCaptureHost({ hidden: true });
        const selected = options.source === 'camera' ? { cameraOnly: true }
          : tabRegion ? { streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: state.regionTabId, consumerTabId: controlsTabId }), tabStream: true, canRequestAudioTrack: options.systemAudio }
          : await chooseCaptureSource(options);
        if (!selected.streamId && !selected.cameraOnly) {
          await restoreCaptureTab();
          await publish({ status: 'idle', sourceReady: false, popupHidden: false,
            notice: 'Auswahl abgebrochen. Du kannst die Aufnahme erneut starten.' });
          await setPopupEnabled(true);
          return;
        }
        await engine('PREPARE', { options, ...selected });
        if (tabRegion) {
          const current = await pageCall(state.regionTabId, "metrics");
          if (current.width !== options.region.viewportWidth || current.height !== options.region.viewportHeight)
            throw new Error("Die Seitengröße wurde geändert. Wähle den Aufnahmebereich erneut.");
        } else if (options.regionCapture) {
          await showRegionSelection();
          return;
        }
        beginning = true;
        await startRecording({}, { anchored: true });
      } catch (error) {
        // BEGIN owns its stop acknowledgment and visibility barriers. An
        // uncertain recorder must keep those barriers until STOP is confirmed.
        if (beginning) await publish({ error: error.message });
        else {
          if (state.engineContext === "controls" && state.status === "preparing") await engine("STOP").catch(() => {});
          await clearRecordingAnnotations();
          await restoreCaptureTab();
          await publish({ status: 'error', captureSetup: false, sourceReady: false, error: error.message, popupHidden: false });
          await setPopupEnabled(true);
        }
      } finally { queuedPopupStart = false; }
    })().catch(error => publish({ error: error.message }));
  }, 0);
  return { accepted: true, state };
}
async function showRegionSelection() {
  await restoreCaptureTab();
  await engine("PREVIEW_REGION");
  if (state.status !== "preparing" || !state.sourceReady) throw new Error("Die Freigabe ist beendet. Wähle die Quelle erneut.");
  await publish({ choosingRegion: true, controlsHidden: false });
  await focusControls();
}
async function showControls() {
  await syncState();
  if (state.status === "recording" && !["tab", "camera"].includes(state.sourceMode)) await engine("PAUSE");
  if (["selecting", "preparing"].includes(state.status) && !["tab", "camera"].includes(state.sourceMode)) throw new Error("Wähle zuerst die Aufnahmequelle aus.");
  await publish({ controlsHidden: false });
  await focusControls();
}
async function hideControls() {
  await publish({ controlsHidden: true });
  await restoreCaptureTab();
  if (controlsWindowId === undefined && controlsHostMode !== "tab") return;
  try {
    if (controlsHostMode === "tab") {
      const tab = await chrome.tabs.get(controlsTabId);
      if (tab.active) throw new Error("Wechsle zuerst zum gewünschten Chrome-Tab und starte die Aufnahme erneut.");
    } else await chrome.windows.get(controlsWindowId);
  }
  catch (error) {
    if (controlsHostMode === "tab") throw error;
    controlsWindowId = undefined; controlsTabId = undefined; return;
  }
  let timer, hidden;
  try {
    hidden = await Promise.race([
      chrome.runtime.sendMessage({ target: "controls", type: "HIDE_FOR_CAPTURE" }),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The controls did not hide. Recording stayed paused.")), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
  if (!hidden?.ok) throw new Error("The controls did not confirm they were hidden. Recording stayed paused.");
  if (controlsHostMode !== "tab") await chrome.windows.update(controlsWindowId, { state: "minimized" });
  await delay(200);
}
async function startRecording(input = {}, { anchored = false } = {}) {
  if (operation || openingMenu) throw new Error("A capture operation is already in progress");
  operation = true;
  let attempted = false;
  try {
    if (finishingCapture) await finishingCapture;
    if (openingBar) await openingBar;
    if (creatingBar) await creatingBar;
    await syncState();
    const prepared = await engine('GET_STATE');
    if (prepared.state?.status !== 'preparing' || prepared.state.sourceReady !== true) throw new Error("Öffne zuerst die Chrome-Freigabe im Aufnahmefenster.");
    const options = normalizeOptions(prepared.state.settings || input);
    if (options.regionCapture && !options.region) throw new Error("Wähle zuerst einen Aufnahmebereich.");
    const sourceMode = ['tab', 'window', 'screen', 'camera'].includes(prepared.state.sourceMode) ? prepared.state.sourceMode : 'screen';
    attempted = true;
    await publish({ ...mediaState(prepared.state), sourceMode, captureSetup: false, folderSaveError: null,
      pendingCaptureOptions: null, engineContext: 'controls', hostOnly: true, choosingRegion: false,
      controlBarEnabled: options.controlBar !== false });
    await hidePopupSurfaces();
    await hideControls();
    await engine('BEGIN');
    if (terminalStates.includes(state.status)) {
      await completeRecording(state.recordingId);
      return { state };
    }
    if (['tab', 'camera'].includes(sourceMode)) { await publish({ popupHidden: false }); await setPopupEnabled(true); }
    await pauseIfControllerFocused();
    await showFloatingBar();
    return { state };
  } catch (error) {
    if (attempted) {
      // Absence of an offscreen helper says nothing about a recorder hosted in
      // the controls frame. An uncertain BEGIN still needs a STOP acknowledgment.
      let safe = state.engineContext !== "controls" && !(await offscreenExists());
      if (!safe) {
        try { const result = await engine("STOP"); safe = ["idle", "error"].includes(result.state?.status); }
        catch { /* Keep the controls hidden if stopping cannot be confirmed. */ }
      }
      await publish(safe ? { status: "error", error: error.message, startedAt: 0, controlsHidden: false } : { error: error.message });
      if (safe && anchored) {
        await minimizeCaptureHost(); await publish({ popupHidden: false }); await setPopupEnabled(true);
      } else if (safe) { await setPopupEnabled(true); await focusControls(); }
    }
    throw error;
  } finally { operation = false; }
}
async function pauseRecording({ anchored = false } = {}) {
  if (operation || queuedPopupStart || openingMenu || openingBar) throw new Error("Finish the current capture operation first");
  operation = true;
  try {
    const result = await engine("PAUSE");
    await publish({ controlsHidden: false });
    if (anchored) { await publish({ popupHidden: false }); await setPopupEnabled(true); }
    else await focusControls();
    await showFloatingBar();
    return { ...result, state };
  } finally { operation = false; }
}
async function stopRecording() {
  if (operation || queuedPopupStart) throw new Error("Finish the current capture operation first");
  operation = true;
  try {
    if (openingBar) await openingBar;
    if (openingMenu) await openingMenu;
    if (creatingBar) await creatingBar;
    const result = await engine("STOP");
    if (result.recording?.id) await completeRecording(result.recording.id);
    else {
      await closeFloatingBar();
      if (state.hostOnly) { await minimizeCaptureHost(); await publish({ popupHidden: false }); await setPopupEnabled(true); }
    }
    return { ...result, state };
  } finally { operation = false; }
}
async function pauseIfControllerFocused() {
  if (["tab", "camera"].includes(state.sourceMode)) return;
  if (controlsHostMode === "tab") {
    const tab = await chrome.tabs.get(controlsTabId).catch(() => null);
    if (tab?.active) { await engine("PAUSE"); await publish({ controlsHidden: false }); }
    return;
  }
  if (controlsWindowId === undefined) return;
  const window = await chrome.windows.get(controlsWindowId).catch(() => null);
  if (window?.focused && window.state !== "minimized") {
    await engine("PAUSE");
    await publish({ controlsHidden: false });
    await focusControls();
  }
}
async function resumeRecording({ anchored = false } = {}) {
  if (operation || queuedPopupStart || openingMenu) throw new Error("A recording operation is still in progress");
  operation = true;
  let attempted = false, reopen = false, failure;
  try {
    // A concurrent pause/show request must finish creating its native window
    // before the full-screen hide/destroy barrier decides there is no bar.
    if (openingBar) await openingBar;
    if (creatingBar) await creatingBar;
    await syncState();
    if (state.status !== "paused") throw new Error("Recording is not paused");
    if (state.regionInvalid) throw new Error("Die Seitengröße wurde geändert. Beende diese Aufnahme und wähle den Bereich erneut.");
    attempted = true;
    if (!liveBarSafe()) await hideFloatingBar({ destroy: true });
    if (!["tab", "camera"].includes(state.sourceMode)) await hidePopupSurfaces();
    if (anchored) {
      await hideControls();
    } else if (!["tab", "camera"].includes(state.sourceMode)) await hideControls();
    await engine("RESUME");
    await pauseIfControllerFocused();
    await showFloatingBar();
    return { state };
  } catch (error) {
    if (!attempted) throw error;
    // Even a missing resume acknowledgment must not reveal controls while a
    // recorder may already be running. Confirm PAUSE, or STOP, before restoring.
    let safe = false;
    try { const result = await engine("PAUSE"); safe = result.state?.status === "paused"; }
    catch {
      try { const result = await engine("STOP"); safe = ["idle", "error"].includes(result.state?.status); }
      catch { /* No acknowledgment: leave the controller hidden. */ }
    }
    await publish({ error: error.message, ...(safe ? { controlsHidden: false } : {}) });
    if (safe && anchored) { await publish({ popupHidden: false }); await setPopupEnabled(true); reopen = true; }
    else if (safe) { await setPopupEnabled(true); await focusControls(); }
    failure = error;
  } finally { operation = false; }
  if (reopen) await openAnchoredMenu().catch(() => {});
  throw failure;
}
async function openEditor(id, tool) {
  const url = new URL(chrome.runtime.getURL("editor.html")); url.searchParams.set("id", id);
  if (tool) url.searchParams.set("tool", tool);
  return normalTab(url.href);
}
async function completeRecording(recordingId, published) {
  if (!recordingId || recordingId !== state.recordingId || !terminalStates.includes(state.status)) return;
  if (completedRecordings.has(recordingId)) return finishingCapture;
  completedRecordings.add(recordingId);
  if (completedRecordings.size > 50) completedRecordings.delete(completedRecordings.values().next().value);
  return finishCaptureUI(recordingId, published);
}
function saveVideoToFolder(recording) {
  if (!isFinishedVideo(recording)) throw new Error("Wähle unter „Aufnahmen in Chrome“ ein vollständig gespeichertes Video.");
  if (folderWrites.has(recording.id)) return folderWrites.get(recording.id);
  const saving = (async () => {
    // Use the same bytes as the normal download, including its WebM duration header.
    const recorded = await ExtensionStore.blob(recording.id).catch(() => { throw new Error("Das Video konnte nicht aus dem Browser-Backup gelesen werden."); });
    const filename = await writeRecordingToFolder(recording, await finalizeWebm(recorded, recording.durationMs));
    if (state.folderSaveError?.recordingId === recording.id) await publish({ folderSaveError: null });
    return { filename };
  })().finally(() => folderWrites.delete(recording.id));
  folderWrites.set(recording.id, saving);
  return saving;
}
function finishCaptureUI(recordingId, published) {
  // Reserve all native-window work before yielding. A new recording waits for
  // the previous editor/cleanup rather than allowing it to surface after BEGIN.
  const previous = finishingCapture;
  const job = (async () => {
    if (previous) await previous;
    if (published) await published;
    await clearRecordingAnnotations();
    if (state.choosingRegion) await restoreCaptureTab();
    await publish({ controlsHidden: Boolean(state.hostOnly), popupHidden: false, choosingRegion: false });
    await closeFloatingBar();
    if (state.hostOnly) { await minimizeCaptureHost(); await setPopupEnabled(true); }
    if (!recordingId) return;
    const recording = await ExtensionStore.get(recordingId);
    if (!recording?.bytes) {
      await publish({ status: "error", error: state.error || "Chrome hat kein Video geliefert. Starte die Aufnahme erneut und warte, bis REC am Recorder-Symbol erscheint." });
      return;
    }
    await publish({ lastRecordingResult: {
      id: recordingId, createdAt: recording.createdAt,
      message: isFinishedVideo(recording) && state.status !== "error"
        ? "Video als Browser-Backup gespeichert." : "Aufnahme unterbrochen. Der gespeicherte Teil liegt unter „Aufnahmen in Chrome“.",
    } });
    if (isFinishedVideo(recording) && state.status !== "error") {
      if (recording.saveDestination === "folder") {
        try {
          const { filename } = await saveVideoToFolder(recording);
          await publish({ lastRecordingResult: { id: recordingId, createdAt: recording.createdAt, message: `Im Aufnahmeordner gespeichert: ${filename}` } });
          return;
        }
        catch (error) {
          await publish({ folderSaveError: { recordingId, message: `Speichern im Ordner fehlgeschlagen. ${error.message} Unter „Aufnahmen in Chrome“ kannst du es erneut versuchen.` } });
        }
      } else if (APP_ORIGIN && recording.kind === "video" && recording.saveDestination !== "local") {
        try { await handoff(recordingId); return; }
        catch {
          await publish({ notice: "Das Video ist als Browser-Backup gespeichert. Öffne es erneut, um es online zu speichern." });
        }
      }
    }
    await openEditor(recordingId).catch(() => {});
  })().then(async () => {
    if (recordingId) await publish({ lastFinishedRecordingId: recordingId });
  }).finally(() => { if (finishingCapture === job) finishingCapture = null; });
  finishingCapture = job;
  return job;
}
async function normalTab(url) {
  let windowId;
  try { const tab = await chrome.tabs.get(state.targetTabId); windowId = tab.windowId; } catch { /* use another browser window */ }
  if (windowId === controlsWindowId) windowId = undefined;
  if (windowId === undefined) {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    windowId = windows.find(window => window.focused)?.id ?? windows[0]?.id;
  }
  if (windowId === undefined) {
    const window = await chrome.windows.create({ url, type: "normal", focused: true });
    return window.tabs[0];
  }
  return chrome.tabs.create({ windowId, url, active: true });
}
async function targetTab() {
  if (!Number.isInteger(state.targetTabId)) throw new Error("Open the extension from the page you want to capture");
  const tab = await chrome.tabs.get(state.targetTabId);
  if (!/^(https?|file):/.test(tab.url || "")) throw new Error("Chrome protects this page. Open a normal website and try again.");
  return tab;
}
async function pageCall(tabId, method, argument = null) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: (method, argument) => globalThis.__sternbergPageCapture[method](argument), args: [method, argument] });
  return result.result;
}
async function selectPageRegion(tabId) {
  const { captureDeskLanguage } = await chrome.storage.local.get("captureDeskLanguage");
  const language = (captureDeskLanguage && captureDeskLanguage !== "auto"
    ? captureDeskLanguage : chrome.i18n?.getUILanguage() || "de").split(/[-_]/)[0];
  const hint = translateText("Bereich mit der Maus aufziehen · Esc zum Abbrechen", ["de", "en", "fr", "es"].includes(language) ? language : "en");
  return pageCall(tabId, "selectRegion", hint);
}
async function captureTabImage(tab) {
  const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (active?.id !== tab.id) throw new Error("The active tab changed. The screenshot was stopped to avoid capturing another page.");
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}
async function recorderPreferences() {
  return normalizePreferences((await chrome.storage.local.get("recorderPreferences")).recorderPreferences);
}
async function recordingAnnotation(message) {
  if (!["recording", "paused"].includes(state.status)) throw new Error("Es läuft keine Aufnahme.");
  if (state.sourceMode === "camera") throw new Error("Tab-Markierungen stehen bei einer Kameraaufnahme nicht zur Verfügung.");
  const recordingId = state.recordingId;
  const stillActive = () => state.recordingId === recordingId && ["recording", "paused"].includes(state.status);
  const window = await normalWindow();
  const tab = (await chrome.tabs.query({ active: true, windowId: window?.id }))[0];
  if (!Number.isInteger(tab?.id) || !/^(https?|file):/.test(tab.url || "")) throw new Error("Öffne zuerst eine normale Webseite für die Tab-Markierungen.");
  if (!stillActive()) throw new Error("Die Aufnahme wurde beendet.");
  await publish({ annotationTabIds: [...new Set([...(state.annotationTabIds || []), tab.id])] });
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["recording-overlay.js"] }); }
  catch { throw new Error("Öffne das Recorder-Menü einmal über das Erweiterungssymbol im gewünschten Tab und wähle dann das Zeichenwerkzeug erneut."); }
  const removeLateOverlay = async () => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__sternbergRecordingOverlay?.destroy() }).catch(() => {});
  if (!stillActive()) { await removeLateOverlay(); throw new Error("Die Aufnahme wurde beendet."); }
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
    func: options => {
      const overlay = globalThis.__sternbergRecordingOverlay;
      if (options.action === "clear") return overlay.clear();
      if (options.action === "undo") return overlay.undo();
      return overlay.configure(options);
    }, args: [{ mode: message.mode || "none", color: message.color || "#ff435b", cursorHighlight: message.cursorHighlight === true, action: message.action }] });
  if (!stillActive()) { await removeLateOverlay(); throw new Error("Die Aufnahme wurde beendet."); }
  await publish({ annotationTabIds: [...new Set([...(state.annotationTabIds || []), tab.id])], annotationState: result.result });
  return { annotation: result.result, state };
}
async function clearRecordingAnnotations() {
  if (Number.isInteger(state.regionTabId)) {
    await pageCall(state.regionTabId, "unwatchRegion").catch(() => {});
    await publish({ regionTabId: null });
  }
  for (const tabId of state.annotationTabIds || [])
    await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__sternbergRecordingOverlay?.destroy() }).catch(() => {});
  if (state.annotationTabIds?.length) await publish({ annotationTabIds: [], annotationState: null });
}
async function downloadRecording(id, preferences) {
  const result = await engine("GET_RECORDING", { id });
  preferences ||= await recorderPreferences();
  const filename = (preferences.downloadDirectory ? preferences.downloadDirectory + "/" : "") + safeFilename(result.recording);
  const downloadId = await chrome.downloads.download({ url: result.objectUrl, filename, saveAs: preferences.askWhereToSave });
  return { downloadId };
}
async function completeScreenshot(result, options, preferences) {
  if (preferences.autoDownload) await downloadRecording(result.recording.id, preferences);
  const skip = !options.extractText && (preferences.skipAnnotation === "always" || (preferences.skipAnnotation === "fullpage" && options.mode === "fullpage"));
  if (skip) {
    if (APP_ORIGIN && options.saveDestination === "cloud") await handoff(result.recording.id);
    else if (!preferences.autoDownload) await downloadRecording(result.recording.id, preferences);
  } else await openEditor(result.recording.id, options.extractText ? "ocr" : undefined);
  return { recording: result.recording, id: result.recording.id };
}
async function desktopScreenshot(options, preferences) {
  await publish({ status: "selecting", engineContext: "controls", hostOnly: true, controlsHidden: true,
    sourceReady: false, recordingId: null, error: "", popupHidden: true, captureSetup: false });
  try {
    await hidePopupSurfaces();
    await ensureCaptureHost({ hidden: true });
    const selected = await chooseCaptureSource({ source: options.mode, systemAudio: false });
    await restoreCaptureTab();
    if (!selected.streamId) {
      await publish({ status: "idle", notice: "Bildschirmauswahl abgebrochen.", sourceReady: false });
      return { cancelled: true };
    }
    const result = await engine("CAPTURE_DISPLAY_IMAGE", { ...selected, preferences, captureMode: options.mode,
      saveDestination: options.saveDestination, name: options.name || preferences.filenamePrefix,
      delaySeconds: Number.isFinite(Number(options.delaySeconds)) ? Math.min(10, Math.max(0, Number(options.delaySeconds))) : preferences.desktopDelaySeconds,
      devicePixelRatio: null });
    await publish({ status: "idle", sourceReady: false, error: "" });
    return completeScreenshot(result, options, preferences);
  } catch (error) {
    await publish({ status: "error", error: error.message, sourceReady: false }); throw error;
  } finally { await restoreCaptureTab(); await publish({ popupHidden: false }); await setPopupEnabled(true); }
}
async function screenshot(options = {}) {
  if (operation || queuedPopupStart) throw new Error("A capture operation is in progress");
  operation = true;
  let tab, prepared = false;
  try {
    await syncState();
    if (["selecting", "recording", "preparing", "stopping"].includes(state.status)) throw new Error("Pause or stop recording before taking a screenshot");
    const preferences = await recorderPreferences();
    options = { ...options, saveDestination: screenshotSaveDestination(options) };
    await publish({ screenshotInProgress: true, error: "" });
    if (["screen", "window"].includes(options.mode)) {
      if (state.status === "paused") throw new Error("Beende zuerst die pausierte Aufnahme, bevor du einen Bildschirm-Screenshot erstellst.");
      return await desktopScreenshot(options, preferences);
    }
    tab = await targetTab();
    // A paused desktop recording keeps its original source and settings. Changing
    // sourceMode here would incorrectly bypass the hide-before-resume barrier.
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const metrics = await pageCall(tab.id, "metrics");
    if (options.mode === "region" && !options.rect) {
      options.rect = await selectPageRegion(tab.id);
      if (!options.rect) return { cancelled: true };
    }
    await ensureOffscreen();
    const request = { name: String(options.name || preferences.filenamePrefix + (tab.title ? " – " + tab.title : "")).slice(0, 120),
      sourceUrl: tab.url, viewportWidth: metrics.width, viewportHeight: metrics.height, devicePixelRatio: metrics.dpr,
      captureMode: options.mode || "visible", preferences, saveDestination: options.saveDestination };
    const delaySeconds = Math.min(10, Math.max(0, Number(options.delaySeconds) || 0));
    if (delaySeconds) await delay(delaySeconds * 1000);
    if (options.mode === "fullpage") {
      await pageCall(tab.id, "prepare"); prepared = true;
      let y = 0, lastY = -1, height = metrics.totalHeight;
      const tiles = [];
      for (let index = 0; index < 100; index++) {
        const position = await pageCall(tab.id, "scroll", y);
        if (position.y === lastY) break;
        lastY = position.y;
        await delay(650); // Chrome permits at most two visible-tab captures/second.
        const current = await pageCall(tab.id, "metrics");
        if (current.width !== metrics.width || current.height !== metrics.height)
          throw new Error("The browser was resized during capture. Please try again.");
        height = Math.max(height, current.totalHeight);
        if (height > 32760 || height * current.width * deviceScaleLimit(current) > 64000000)
          throw new Error("This page is too large for one full-page image. Capture a smaller section.");
        tiles.push({ y: current.y, dataUrl: await captureTabImage(tab) });
        if (current.y + current.height >= height - 1) break;
        y = Math.min(current.y + current.height, height - current.height);
      }
      if (tiles.length === 100) throw new Error("This page is too long for one screenshot");
      request.tiles = tiles; request.totalHeight = height;
    } else {
      await delay(150);
      request.dataUrl = await captureTabImage(tab);
      if (options.rect) {
        if (!["x", "y", "width", "height"].every(key => Number.isFinite(options.rect[key]))) throw new Error("Invalid screenshot selection");
        request.rect = options.rect;
      }
    }
    const result = await engine("SAVE_IMAGE", request);
    return await completeScreenshot(result, options, preferences);
  } finally {
    if (prepared && tab) await pageCall(tab.id, "restore").catch(() => {});
    await publish({ screenshotInProgress: false });
    operation = false;
  }
}
function deviceScaleLimit(metrics) { return Math.max(1, Number(metrics.dpr) || 1) ** 2; }
async function listRecordings() {
  const recordings = await ExtensionStore.list();
  for (const item of recordings) if (item.status === "recording" &&
    !(state.recordingId === item.id && ["recording", "paused", "stopping"].includes(state.status)))
    Object.assign(item, await ExtensionStore.update(item.id, { status: "interrupted" }));
  return recordings;
}
async function handoff(id, { ai } = {}) {
  if (!APP_ORIGIN) throw new Error("Es wurde kein Online-Recorder eingebunden.");
  const recording = await ExtensionStore.get(id);
  if (!recording || recording.bytes < 1) throw new Error("Recording not found");
  if (recording.id === state.recordingId && ["recording", "paused", "stopping"].includes(state.status)) throw new Error("Stop recording before opening it online");
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, "0")).join("");
  const url = new URL(APP_ORIGIN); url.searchParams.set("extensionImport", nonce); url.searchParams.set("extensionId", chrome.runtime.id);
  if (ai === "1" || ai === "transcript") url.searchParams.set("ai", ai);
  const tab = await normalTab("about:blank");
  handoffs[nonce] = { tabId: tab.id, recordingId: id, expiresAt: Date.now() + 600000 };
  await chrome.storage.session.set({ handoffs });
  await chrome.tabs.update(tab.id, { url: url.href });
  return { tabId: tab.id };
}
async function importMessage(message, sender) {
  if (!APP_ORIGIN) throw new Error("Recorder import is unavailable");
  const grant = handoffs[message.nonce];
  let origin;
  try { origin = new URL(sender.url).origin; } catch { /* denied below */ }
  if (sender.id !== chrome.runtime.id || origin !== APP_ORIGIN || !sender.tab || (sender.frameId ?? 0) !== 0 || !grant ||
      sender.tab.id !== grant.tabId || grant.expiresAt < Date.now()) throw new Error("This recording import is not authorized or has expired");
  const recording = await ExtensionStore.get(grant.recordingId);
  if (!recording) throw new Error("Local recording not found");
  if (message.type === "IMPORT_METADATA") return { recording, chunkSize: CHUNK_SIZE };
  if (message.type === "IMPORT_DONE") {
    delete handoffs[message.nonce]; await chrome.storage.session.set({ handoffs }); return {};
  }
  const offset = message.offset, length = message.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= recording.bytes ||
      !Number.isSafeInteger(length) || length < 1 || length > CHUNK_SIZE) throw new Error("Invalid import chunk range");
  const bytes = await ExtensionStore.readRange(recording.id, offset, Math.min(recording.bytes, offset + length));
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return { data: btoa(binary), offset, nextOffset: offset + bytes.length, done: offset + bytes.length >= recording.bytes };
}
async function handle(message, sender) {
  await ready;
  if (message.type === "REGION_VIEWPORT_CHANGED") {
    if (sender.id !== chrome.runtime.id || sender.tab?.id !== state.regionTabId || (sender.frameId ?? 0) !== 0 || !state.settings?.region) return {};
    const region = state.settings.region;
    if (message.width === region.viewportWidth && message.height === region.viewportHeight) return {};
    if (state.status === "recording") await engine("PAUSE");
    if (["paused", "preparing", "selecting"].includes(state.status)) await publish({ regionInvalid: true,
      warning: "Die Seitengröße wurde geändert. Beende diese Aufnahme und wähle den Bereich erneut.", controlsHidden: false });
    return { state };
  }
  if (["IMPORT_METADATA", "IMPORT_CHUNK", "IMPORT_DONE"].includes(message.type)) return importMessage(message, sender);
  if (!internal(sender)) throw new Error("Only recorder extension pages can use this operation");
  const anchored = popupSender(sender);
  const floating = barSender(sender);
  if (anchored && message.type !== "INIT_POPUP") await validatePopup(message, sender);
  if (floating) {
    if (message.type === "INIT_FLOATING_BAR" && creatingBar) await creatingBar;
    validateBar(message, sender);
  }
  switch (message.type) {
    case "INIT_POPUP": return initPopup(sender);
    case "INIT_FLOATING_BAR":
      if (!floating) throw new Error("Invalid control bar sender");
      await syncState(); return { barSafe: Boolean(state.barVisible && barMayShow()), state };
    case "SHOW_FLOATING_BAR":
      return requestFloatingBar();
    case "HIDE_FLOATING_BAR":
      if (creatingBar) await creatingBar;
      await hideFloatingBar(); return { state };
    case "PIN_FLOATING_BAR":
      if (!floating) throw new Error("Invalid control bar sender");
      if (operation || queuedPopupStart || !state.barVisible || !barMayShow()) throw new Error("Die Steuerleiste kann gerade nicht angeheftet werden.");
      await publish({ barPinned: true });
      await chrome.windows.update(barWindowId, { state: "minimized" }); return { state };
    case "UNPIN_FLOATING_BAR":
      if (!floating) throw new Error("Invalid control bar sender");
      await publish({ barPinned: false });
      if (!operation && !queuedPopupStart && state.barVisible && barMayShow())
        await chrome.windows.update(barWindowId, { state: "normal", focused: true });
      return { state };
    case "SET_CONTROL_BAR": {
      if (operation || queuedPopupStart || openingMenu) throw new Error("Die Aufnahme wird gerade vorbereitet.");
      if (typeof message.enabled !== "boolean") throw new Error("Invalid control bar preference");
      operation = true;
      try {
        if (openingBar) await openingBar;
        if (creatingBar) await creatingBar;
        const stored = await chrome.storage.local.get("captureSettings");
        await chrome.storage.local.set({ captureSettings: { ...stored.captureSettings, controlBar: message.enabled } });
        await publish({ controlBarEnabled: message.enabled });
        if (!message.enabled) await closeFloatingBar();
        else await showFloatingBar();
        return { state };
      } finally { operation = false; }
    }
    case "RESIZE_FLOATING_BAR": {
      if (!floating) throw new Error("Invalid control bar sender");
      const width = Math.min(650, Math.max(300, Number(message.width) || 420));
      const height = Math.min(500, Math.max(60, Number(message.height) || 110));
      if (barWindowId !== undefined) await chrome.windows.update(barWindowId, { width, height });
      return {};
    }
    case "OPEN_BAR_SETTINGS":
      if (!floating) throw new Error("Invalid control bar sender");
      if (operation || queuedPopupStart || openingMenu) throw new Error("Die Aufnahme wird gerade vorbereitet.");
      await publish({ popupSettingsRequested: true }); await openAnchoredMenu(); return { state };
    case "CONTROLS_READY": {
      if (sender.url !== chrome.runtime.getURL("controls.html") || (sender.frameId ?? 0) !== 0 || !Number.isInteger(message.controllerTabId) ||
          (sender.tab && sender.tab.id !== message.controllerTabId)) throw new Error("Invalid capture host registration");
      readyControls.add(message.controllerTabId);
      await chrome.storage.session.set({ readyControlsTabId: message.controllerTabId });
      return { state };
    }
    case "CAPTURE_HEARTBEAT":
      if (sender.url !== chrome.runtime.getURL("controls.html") || message.controllerTabId !== controlsTabId ||
          (sender.tab && sender.tab.id !== controlsTabId) || (sender.frameId ?? 0) !== 0) throw new Error("Invalid capture host heartbeat");
      return {};
    case "GET_STATE": return { state: await syncState() };
    case "START_RECORDING": return startFromPopup(message.options);
    case "START_PREPARED_RECORDING":
      if (sender.url !== chrome.runtime.getURL('controls.html') || sender.tab?.id !== controlsTabId || (sender.frameId ?? 0) !== 0)
        throw new Error('Invalid capture controller instance');
      return startRecording({}, { anchored: true });
    case "CONFIRM_CAPTURE_REGION":
    case "CANCEL_CAPTURE_REGION":
      if (sender.url !== chrome.runtime.getURL("controls.html") || sender.tab?.id !== controlsTabId || (sender.frameId ?? 0) !== 0)
        throw new Error("Invalid capture controller instance");
      if (!state.choosingRegion || state.status !== "preparing" || !state.sourceReady)
        throw new Error("Die Freigabe ist beendet. Wähle die Quelle erneut.");
      if (operation || selectingRegion || queuedPopupStart) throw new Error("Die Aufnahme wird bereits vorbereitet.");
      selectingRegion = true;
      try {
        if (message.type === "CANCEL_CAPTURE_REGION") {
          await stopRecording();
          await restoreCaptureTab();
          await publish({ choosingRegion: false, controlsHidden: true, notice: "Bereichsauswahl abgebrochen." });
          return { state };
        }
        await engine("SET_CAPTURE_REGION", { region: message.region });
        return await startRecording({}, { anchored: true });
      } finally {
        selectingRegion = false;
      }
    case "GET_AUDIO_DEVICES":
      if (state.engineContext !== "controls" || !Number.isInteger(controlsTabId)) return { devices: [], cameras: [], microphoneDeviceId: '', cameraDeviceId: '' };
      return engine('GET_AUDIO_DEVICES');
    case "SET_MICROPHONE_DEVICE":
      if (!['recording', 'paused'].includes(state.status)) throw new Error('Es läuft keine Aufnahme.');
      return engine('SET_MICROPHONE_DEVICE', { deviceId: message.deviceId });
    case "SET_AUTO_STOP":
      if (!['recording', 'paused'].includes(state.status)) throw new Error('Es läuft keine Aufnahme.');
      if (!Number.isFinite(Number(message.seconds)) || Number(message.seconds) < 0 || Number(message.seconds) > 21600) throw new Error('Wähle eine Dauer zwischen 0 und 21600 Sekunden.');
      return engine('SET_AUTO_STOP', { seconds: Number(message.seconds) });
    case "SET_RECORDING_ANNOTATION": return recordingAnnotation(message);
    case "PAUSE_RECORDING": return pauseRecording({ anchored: anchored || floating });
    case "RESUME_RECORDING": return resumeRecording({ anchored: anchored || floating });
    case "SET_AUDIO_STATE": {
      if (!["recording", "paused"].includes(state.status)) throw new Error("Es läuft keine Aufnahme.");
      const patch = {};
      if (typeof message.microphoneEnabled === "boolean") patch.microphoneEnabled = message.microphoneEnabled;
      if (typeof message.sourceAudioEnabled === "boolean") patch.sourceAudioEnabled = message.sourceAudioEnabled;
      if (!Object.keys(patch).length) throw new Error("Invalid audio state");
      const result = await engine("SET_AUDIO_STATE", patch); return { ...result, state };
    }
    case "STOP_RECORDING": return stopRecording();
    case "CAPTURE_SCREENSHOT": return screenshot(message.options);
    case "GET_RECORDINGS": return { recordings: await listRecordings() };
    case "GET_RECORDING": return engine("GET_RECORDING", { id: message.id });
    case "DOWNLOAD_RECORDING": return downloadRecording(message.id);
    case "SAVE_RECORDING_TO_FOLDER": return saveVideoToFolder(await ExtensionStore.get(message.id));
    case "DELETE_RECORDING":
      if (state.recordingId === message.id && ["recording", "paused", "stopping"].includes(state.status)) throw new Error("Stop this recording before removing it");
      if (await offscreenExists()) await engine("REVOKE_URL", { id: message.id });
      await ExtensionStore.remove(message.id); return {};
    case "OPEN_RECORDER": return handoff(message.id);
    case "OPEN_AI_ASSISTANT": return handoff(message.id, { ai: message.mode === "transcript" ? "transcript" : "1" });
    case "OPEN_IMAGE_WORKSPACE": return { tab: await normalTab(chrome.runtime.getURL("editor.html?mode=import")) };
    case "OPEN_OPTIONS": return { tab: await normalTab(chrome.runtime.getURL("options.html")) };
    case "OPEN_SHORTCUTS": return { tab: await normalTab("chrome://extensions/shortcuts") };
    case "OPEN_LIBRARY": {
      if (!APP_ORIGIN) throw new Error("Es wurde kein Online-Recorder eingebunden.");
      const tab = await normalTab("about:blank");
      await chrome.tabs.update(tab.id, { url: `${APP_ORIGIN}/?view=recordings` });
      return { tabId: tab.id };
    }
    case "SHOW_CONTROLS":
      if (operation || queuedPopupStart || openingMenu) throw new Error("Die Aufnahme wird gerade vorbereitet. Warte einen Moment.");
      if (["recording", "paused"].includes(state.status) && state.controlBarEnabled !== false) return requestFloatingBar();
      else if (state.hostOnly) await openAnchoredMenu(); else return requestFloatingBar({ legacy: true });
      return { state };
    case "OPEN_EDITOR": return { tab: await openEditor(message.id, message.tool) };
    case "RESIZE_CONTROLS": {
      if (anchored || state.hostOnly) return {};
      const width = Math.min(1000, Math.max(360, Number(message.width) || 460));
      const height = Math.min(1000, Math.max(150, Number(message.height) || 250));
      if (controlsWindowId !== undefined) await chrome.windows.update(controlsWindowId, { width, height });
      return {};
    }
    case "CONTROL_CAPTURE_STATE":
      if (sender.url !== chrome.runtime.getURL("controls.html")) throw new Error("Invalid capture controller sender");
      if (message.controllerTabId !== controlsTabId || (sender.tab && sender.tab.id !== controlsTabId) || (sender.frameId ?? 0) !== 0) throw new Error("Invalid capture controller instance");
      if (state.engineContext !== "controls") return {};
      if (terminalStates.includes(message.state?.status) && message.state.recordingId &&
          message.state.recordingId !== state.recordingId) return {};
      await publishMedia(message.state, terminalStates.includes(message.state?.status) ? { controlsHidden: Boolean(state.hostOnly && !state.captureSetup) } : {});
      if (!message.state.recordingId && state.hostOnly && !state.captureSetup && !operation && terminalStates.includes(message.state.status)) {
        await finishCaptureUI();
      }
      return {};
    case "OFFSCREEN_STATE":
      if (sender.url !== chrome.runtime.getURL("offscreen.html")) throw new Error("Invalid capture state sender");
      if (state.engineContext === "controls") return {};
      if (terminalStates.includes(message.state?.status) && message.state.recordingId &&
          message.state.recordingId !== state.recordingId) return {};
      await publishMedia(message.state, terminalStates.includes(message.state?.status) ? { controlsHidden: false } : {});
      return {};
    case "RECORDING_FINISHED":
      if (![chrome.runtime.getURL("offscreen.html"), chrome.runtime.getURL("controls.html")].includes(sender.url)) throw new Error("Invalid capture sender");
      if (sender.url === chrome.runtime.getURL("controls.html") &&
        (message.controllerTabId !== controlsTabId || (sender.tab && sender.tab.id !== controlsTabId) || (sender.frameId ?? 0) !== 0)) throw new Error("Invalid capture controller instance");
      if ((state.engineContext === "controls") !== (sender.url === chrome.runtime.getURL("controls.html"))) return {};
      const id = message.recording?.id;
      if (!id || id !== state.recordingId || completedRecordings.has(id)) return {};
      // The engine sends the terminal state with the durable recording receipt.
      // Either message may reach the worker first.
      if (message.state?.recordingId === id && terminalStates.includes(message.state.status))
        await publishMedia(message.state);
      await completeRecording(id);
      return {};
    default: throw new Error("Unknown recorder operation");
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return;
  handle(message, sender).then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(tab => {
  (async () => {
    await ready;
    if (operation || queuedPopupStart || openingMenu) throw new Error("Die Aufnahme wird gerade vorbereitet. Warte einen Moment.");
    if (["idle", "error"].includes(state.status) && tab?.id && /^(https?|file):/.test(tab.url || ""))
      await publish({ targetTabId: tab.id, targetTitle: tab.title || "Current tab" });
    if (["recording", "paused"].includes(state.status) && state.sourceMode !== "screen" && state.controlBarEnabled !== false)
      await requestFloatingBar();
    else await openAnchoredMenu();
  })().catch(error => publish({ error: error.message }));
});
chrome.commands.onCommand.addListener((command, tab) => {
  (async () => {
    await ready;
    if (command.startsWith("capture-") || command === "start-recording") {
      const candidate = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      const supported = Number.isInteger(candidate?.id) && /^(https?|file):/.test(candidate.url || "");
      await publish({ targetTabId: supported ? candidate.id : null, targetTitle: supported ? candidate.title || "Chrome-Tab" : "" });
      const settings = (await chrome.storage.local.get("captureSettings")).captureSettings || {};
      if (command === "start-recording") await startFromPopup(normalizeOptions({ ...settings, source: settings.source || "screen" }));
      else await screenshot({ mode: command.slice("capture-".length), saveDestination: screenshotSaveDestination(settings) });
      return;
    }
    if (command === "show-controls") {
      if (operation || queuedPopupStart || openingMenu) throw new Error("Die Aufnahme wird gerade vorbereitet. Warte einen Moment.");
      if (["idle", "error"].includes(state.status)) {
        const candidate = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        if (candidate?.id && /^(https?|file):/.test(candidate.url || ""))
          await publish({ targetTabId: candidate.id, targetTitle: candidate.title || "Current tab" });
      }
      if (["recording", "paused"].includes(state.status) && state.controlBarEnabled !== false)
        await requestFloatingBar();
      else await openAnchoredMenu();
    }
    if (command === "stop-recording" && ["recording", "paused"].includes(state.status)) await stopRecording();
    if (command === "pause-resume") {
      if (state.status === "recording") await pauseRecording({ anchored: Boolean(state.hostOnly) });
      else if (state.status === "paused") await resumeRecording({ anchored: Boolean(state.hostOnly) });
    }
  })().catch(error => publish({ error: error.message }));
});
chrome.windows.onFocusChanged.addListener(id => {
  if (id !== controlsWindowId || state.status !== "recording" || !state.controlsHidden || ["tab", "camera"].includes(state.sourceMode) || focusPause || operation || queuedPopupStart) return;
  focusPause = true;
  engine("PAUSE").then(() => publish({ controlsHidden: false })).catch(error => publish({ error: error.message })).finally(() => { focusPause = false; });
});
async function captureHostClosed() {
  await clearRecordingAnnotations();
  readyControls.delete(controlsTabId);
  controlsWindowId = controlsTabId = controlsHostMode = undefined;
  await chrome.storage.session.remove(["controlsWindowId", "controlsTabId", "controlsHostMode", "readyControlsTabId"]);
  if (state.engineContext === "controls") {
    await closeFloatingBar();
    const interrupted = ["selecting", "preparing", "recording", "paused", "stopping"].includes(state.status);
    await publish({ engineContext: null, controlsHidden: false, startedAt: 0,
      ...(interrupted ? { status: "error", error: "Der Aufnahme-Tab wurde geschlossen. Bereits gespeicherte Teile findest du unter Aufnahmen." } : {}) });
    if (state.hostOnly) { await publish({ popupHidden: false }); await setPopupEnabled(true); }
  }
}
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (controlsHostMode !== "tab" || tabId !== controlsTabId || state.status !== "recording" || ["tab", "camera"].includes(state.sourceMode) || operation || queuedPopupStart) return;
  engine("PAUSE").then(() => publish({ controlsHidden: false })).catch(error => publish({ error: error.message }));
});
chrome.windows.onRemoved.addListener(async id => {
  if (id === barWindowId) {
    barWindowId = barTabId = undefined;
    await chrome.storage.session.remove(["barWindowId", "barTabId"]);
    await publish({ barVisible: false, barPinned: false });
    return;
  }
  if (id !== controlsWindowId) return;
  await captureHostClosed();
});
chrome.tabs.onRemoved.addListener(async id => {
  if (controlsHostMode === "tab" && id === controlsTabId) await captureHostClosed();
  for (const [nonce, grant] of Object.entries(handoffs)) if (grant.tabId === id) delete handoffs[nonce];
  chrome.storage.session.set({ handoffs });
});
let creatingContextMenus;
async function updateContextMenus() {
  if (!chrome.contextMenus) return;
  if (creatingContextMenus) return creatingContextMenus;
  creatingContextMenus = (async () => {
    await chrome.contextMenus.removeAll();
    const preferences = await recorderPreferences();
    if (!preferences.showContextMenu) return;
    for (const [id, title] of [["visible", "Sichtbaren Bereich aufnehmen"], ["fullpage", "Ganze Seite aufnehmen"], ["region", "Bereich auswählen"], ["screen", "Bildschirm oder Fenster aufnehmen"], ["edit", "Bild bearbeiten"], ["record", "Aufnahmemenü öffnen"]])
      chrome.contextMenus.create({ id: "recorder-" + id, title: "Capture Desk · " + title, contexts: ["page", "image", "selection", "video"], documentUrlPatterns: ["http://*/*", "https://*/*", "file:///*"] });
  })().finally(() => { creatingContextMenus = null; });
  return creatingContextMenus;
}
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!String(info.menuItemId).startsWith("recorder-")) return;
  (async () => {
    await ready;
    if (tab?.id) await publish({ targetTabId: tab.id, targetTitle: tab.title || "Chrome-Tab" });
    const action = String(info.menuItemId).slice("recorder-".length);
    if (action === "record") return openAnchoredMenu();
    if (action === "edit") return normalTab(chrome.runtime.getURL("editor.html?mode=import"));
    const settings = (await chrome.storage.local.get("captureSettings")).captureSettings || {};
    return screenshot({ mode: action, saveDestination: screenshotSaveDestination(settings) });
  })().catch(error => publish({ error: error.message }));
});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && (changes.recorderPreferences || changes.captureDeskLanguage)) updateContextMenus().catch(() => {});
});
ready.then(() => updateContextMenus()).catch(() => {});
