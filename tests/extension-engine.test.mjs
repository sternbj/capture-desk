import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { normalizePreferences } from "../chrome-extension/preferences.js";
import { finalizeWebm, isFinishedVideo, screenshotSaveDestination } from "../chrome-extension/capture-core.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const EXT = `chrome-extension://${ID}/`;
async function background(initial = {}, stored = {}) {
  const events = [], session = { captureState: { status: "idle", targetTabId: 1, elapsedMs: 0, ...initial }, controlsWindowId: 2, controlsTabId: 3, readyControlsTabId: 3, ...stored };
  let engineState = { ...session.captureState }, allowHide = true, pauseReply, resumeFailure = false, cancelSelection = false, beginFailure = false, stopReply, helperExists = true, controlsExist = true, controlCreations = 0, controlsCreated;
  let removedWindow, removedTab, activatedTab, focusChanged, actionClicked, shortcutCommand, pickerWait, hostTabExists = true, hostTabActive = false, hostTabWindow = stored.controlsHostMode === "tab" ? 5 : 2, hostTabCreations = 0;
  let settings = {}, selectedSource, pickerRequest, regionSelection = { x: 10, y: 20, width: 160, height: 120, viewportWidth: 800, viewportHeight: 600 }, tabCaptureRequest;
  const mediaRequests = [], navigations = [];
  const folderExports = [];
  let folderError;
  let barExists = Number.isInteger(stored.barWindowId), barCreations = 0, allowBarHide = true, barCreated, barRemoved;
  let popupDocuments = [], holdPopup = false, importFailure = false, activeTab = { id: 1, windowId: 5, url: "https://fixture.test/", title: "Fixture" };
  const media = { id: "video", name: "Fixture", kind: "video", status: "finished", mimeType: "video/webm", bytes: 5, width: 640, height: 360, durationMs: 2000 };
  const chrome = {
    runtime: { id: ID, getURL: path => EXT + path, getContexts: async filter => filter?.contextTypes?.includes("POPUP") ? popupDocuments : helperExists ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [],
      onMessage: { addListener() {} }, sendMessage: async message => {
        events.push(message.type);
        if (message.target === "popup") { events.push("POPUP_HIDE"); if (!holdPopup) popupDocuments = []; return { ok: true }; }
        if (message.target === "controls") return { ok: allowHide };
        if (message.target === "floatingbar") { events.push(message.type === "FOCUS_FLOATING_BAR" ? "BAR_FOCUS" : "BAR_HIDE"); return { ok: message.type === "FOCUS_FLOATING_BAR" || allowBarHide }; }
        if (!["offscreen", "capture-controls"].includes(message.target)) return {};
        mediaRequests.push(message);
        if (message.target === "capture-controls") assert.equal(message.controllerTabId, 3);
        if (message.type === "SELECT_SOURCE") {
          events.push("PICKER");
          if (cancelSelection) { engineState.status = "idle"; return { ok: true, cancelled: true, state: { ...engineState } }; }
          events.push("PREPARE");
          engineState = { ...engineState, status: "preparing", sourceMode: message.options.source, settings: message.options };
        }
        if (message.type === "PREPARE") {
          if (message.options.source === "camera") assert.equal(message.cameraOnly, true);
          else assert.equal(message.streamId, message.tabStream ? "tab-stream" : "desktop-token");
          const sourceMode = selectedSource || message.options.source;
          engineState = { ...engineState, status: "preparing", sourceReady: true, recordingId: null, sourceMode, settings: { ...message.options, source: sourceMode } };
        }
        if (message.type === "SET_CAPTURE_REGION") engineState.settings = { ...engineState.settings, region: message.region };
        if (message.type === "BEGIN") { if (session.controlsHostMode === "tab") assert.equal(hostTabActive, false, "Restore the original browser tab before capture begins"); engineState.status = "recording"; if (beginFailure) return { ok: false, error: "Begin acknowledgment missing" }; }
        if (message.type === "PAUSE") {
          if (pauseReply) await pauseReply;
          engineState.status = "paused";
        }
        if (message.type === "RESUME") {
          engineState.status = "recording";
          if (resumeFailure) return { ok: false, error: "Resume acknowledgment missing" };
        }
        if (message.type === "SET_AUTO_STOP") engineState.settings = { ...engineState.settings, autoStopSeconds: message.seconds };
        if (message.type === "STOP") { if (stopReply) await stopReply; engineState.status = "idle"; }
        if (message.type === "SAVE_IMAGE") return { ok: true, recording: { ...media, id: "image", kind: "image", mimeType: "image/png" } };
        return { ok: true, state: { ...engineState } };
      } },
    storage: { session: { get: async () => session, set: async value => { Object.assign(session, value); events.push("STORE"); }, remove: async keys => { for (const key of keys) delete session[key]; } },
      local: { get: async () => ({ captureSettings: settings }), set: async value => { if (value.captureSettings) settings = value.captureSettings; } } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
      setPopup: async ({ popup }) => { events.push(popup ? "POPUP_ENABLE" : "POPUP_DISABLE"); },
      openPopup: async () => { events.push("OPEN_POPUP"); }, onClicked: { addListener(listener) { actionClicked = listener; } } },
    offscreen: { createDocument: async () => {} },
    windows: { get: async id => { if ((id === 2 && !controlsExist) || (id === 6 && !barExists)) throw new Error("Window missing"); return { id, ...(id === 6 && stored.barMinimized ? { state: "minimized" } : {}) }; }, update: async (id, settings) => { if (id === 2 && !controlsExist) throw new Error("Window missing"); events.push(id === 6 ? settings.state === "minimized" ? "BAR_MINIMIZE" : "BAR_SHOW" : id === 2 ? settings.state === "minimized" ? "MINIMIZE" : "SHOW" : "NORMAL_FOCUS"); },
      create: async options => { if (options.url.endsWith("floatingbar.html")) { events.push("BAR_CREATE"); barCreations++; if (barCreated) await barCreated; barExists = true; return { id: 6, tabs: [{ id: 7 }] }; } events.push(options.state === "minimized" && options.focused === false ? "CONTROL_CREATE_HIDDEN" : "CONTROL_CREATE_VISIBLE"); controlCreations++; if (controlsCreated) await controlsCreated; controlsExist = true; return { id: 2, tabs: [{ id: 3 }] }; },
      remove: async id => { if (id === 2) { controlsExist = false; hostTabExists = false; events.push("LEGACY_CLOSE"); await removedWindow(2); } if (id === 6) { events.push("BAR_CLOSE"); if (barRemoved) await barRemoved; barExists = false; await removedWindow(6); } }, getAll: async () => [{ id: 5, type: "normal" }], getLastFocused: async () => ({ id: 5, type: "normal" }),
      onFocusChanged: { addListener(listener) { focusChanged = listener; } }, onRemoved: { addListener(listener) { removedWindow = listener; } } },
    tabs: { get: async id => {
      if (id === 3) { if (!hostTabExists) throw new Error("Tab missing"); return { id: 3, windowId: hostTabWindow, active: hostTabActive }; }
      return { ...activeTab, active: !hostTabActive };
    },
      query: async filter => filter?.active ? [hostTabActive ? { id: 3, windowId: hostTabWindow, active: true } : { ...activeTab, active: true }] : [{ ...activeTab, active: !hostTabActive }, ...(hostTabExists ? [{ id: 3, windowId: hostTabWindow, active: hostTabActive }] : [])],
      create: async value => {
        if (value.url === EXT + "controls.html") {
          events.push("CONTROL_TAB_CREATE"); hostTabCreations++; hostTabExists = true; hostTabWindow = value.windowId; hostTabActive = value.active === true;
          await api("CONTROLS_READY", { controllerTabId: 3 });
          return { id: 3, windowId: hostTabWindow, active: hostTabActive };
        }
        events.push(value.url === "about:blank" ? "CREATE_BLANK" : value.url.includes("?view=recordings") ? "LIBRARY" : "EDITOR"); return { id: 8 };
      },
      update: async (id, value) => {
        if (value.url) { events.push(value.url.includes("?view=recordings") ? "LIBRARY" : "NAVIGATE_IMPORT"); navigations.push(value.url); if (importFailure) throw new Error("Recorder unavailable"); }
        if (value.active) {
          hostTabActive = id === 3; events.push(hostTabActive ? "TAB_ACTIVATE_HOST" : "TAB_RESTORE");
          activatedTab?.({ tabId: id, windowId: 5 });
        }
        return id === 3 ? { id: 3, windowId: hostTabWindow, active: hostTabActive } : { ...activeTab, active: !hostTabActive };
      },
      captureVisibleTab: async () => "data:image/png;base64,AAAA",
      onActivated: { addListener(listener) { activatedTab = listener; } }, onRemoved: { addListener(listener) { removedTab = listener; } } },
    desktopCapture: { chooseDesktopMedia: (sources, targetTab, callback) => {
      assert.equal(targetTab.id, 3);
      assert.equal(hostTabActive, true, "Chrome needs a visible parent tab for its native chooser");
      assert.equal(targetTab.url, EXT + "controls.html");
      pickerRequest = { sources: [...sources], targetTab };
      events.push("PICKER");
      setTimeout(() => Promise.resolve(pickerWait).then(() => callback(cancelSelection ? "" : "desktop-token", { canRequestAudioTrack: sources.includes("audio") })), 0);
      return 12;
    }, cancelChooseDesktopMedia: () => {} },
    tabCapture: { getMediaStreamId: async request => { events.push("TAB_TOKEN"); tabCaptureRequest = request; return "tab-stream"; } },
    scripting: { executeScript: async params => {
      if (params.files) return [];
      if (params.args?.[0] === "selectRegion") { events.push("SELECT_REGION"); return [{ result: regionSelection }]; }
      return [{ result: { width: 800, height: 600, totalHeight: 600, x: 0, y: 0 } }];
    } },
    commands: { onCommand: { addListener(listener) { shortcutCommand = listener; } } }, downloads: { download: async () => 1 },
  };
  const context = vm.createContext({ chrome, APP_ORIGIN: "https://recorder.example.test", ExtensionStore: { get: async id => ({ ...media, id }),
    blob: async () => new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: media.mimeType }),
    readRange: async (_id, start, end) => new Uint8Array([1, 2, 3, 4, 5].slice(start, end)) },
    finalizeWebm, isFinishedVideo, screenshotSaveDestination, writeRecordingToFolder: async (recording, blob) => {
      if (folderError) throw folderError;
      folderExports.push({ id: recording.id, blob });
      return recording.name + (blob.type.includes("mp4") ? ".mp4" : ".webm");
    },
    normalizeOptions: input => ({ source: "tab", ...input }), normalizePreferences, safeFilename: () => "fixture.webm", translateText: source => source, crypto: webcrypto, URL,
    btoa: value => Buffer.from(value, "binary").toString("base64"), setTimeout, clearTimeout, console });
  const source = (await readFile(new URL("../chrome-extension/background.js", import.meta.url), "utf8"))
    .replace(/^import[^\n]+\n/gm, "") + "\nglobalThis.engineTest={handle,ready,getState:()=>state,settled:()=>!queuedPopupStart&&!operation};";
  vm.runInContext(source, context); await context.engineTest.ready;
  const sender = { id: ID, url: EXT + "controls.html", tab: { id: 3 }, frameId: 0 };
  const api = (type, values = {}, customSender = sender) => context.engineTest.handle({ type, ...values }, customSender);
  const prepare = async (options, actualSource = options.source) => {
    events.push('PICKER');
    if (cancelSelection) {
      engineState = { ...engineState, status: 'idle', sourceReady: false };
      await api('CONTROL_CAPTURE_STATE', { controllerTabId: 3, state: engineState });
      return { cancelled: true, state: context.engineTest.getState() };
    }
    events.push('PREPARE');
    engineState = { ...engineState, status: 'preparing', sourceReady: true, sourceMode: actualSource,
      settings: { ...options, source: actualSource } };
    await api('CONTROL_CAPTURE_STATE', { controllerTabId: 3, state: engineState });
    return api('START_PREPARED_RECORDING');
  };
  const settled = async () => {
    const until = Date.now() + 3000;
    while (!context.engineTest.settled()) {
      if (Date.now() >= until) throw new Error("Start did not settle: " + JSON.stringify(context.engineTest.getState()));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return context.engineTest.getState();
  };
  const start = async options => {
    await api('START_RECORDING', { options });
    const state = await settled();
    if (state.error) throw new Error(state.error);
    return { state, cancelled: state.status === "idle" && !state.sourceReady };
  };
  return { events, session, media, mediaRequests, navigations, api, start, prepare, settled, focusControls: () => { focusChanged(2); activatedTab({ tabId: 3, windowId: 5 }); }, activateHost: () => chrome.tabs.update(3, { active: true }), removeHost: () => { hostTabExists = false; return removedTab(3); }, hostTabActive: () => hostTabActive, hostTabCreations: () => hostTabCreations, holdPicker: value => { pickerWait = value; }, pickerRequest: () => pickerRequest, setSelectionMode: value => { selectedSource = value; }, setRegionSelection: value => { regionSelection = value; }, tabCaptureRequest: () => tabCaptureRequest,
    folderExports, setFolderError: error => { folderError = error; }, clickAction: () => actionClicked(activeTab), stopShortcut: () => shortcutCommand("stop-recording"),
    state: context.engineTest.getState, setHide: value => { allowHide = value; }, setPause: value => { pauseReply = value; }, setResumeFailure: value => { resumeFailure = value; },
    setBeginFailure: value => { beginFailure = value; }, setStop: value => { stopReply = value; }, setHelperExists: value => { helperExists = value; },
    makeControlsMissing: wait => { controlsExist = false; controlsCreated = wait; }, controlCreations: () => controlCreations,
    cancelSelection: (value = true) => { cancelSelection = value; }, resetController: () => { engineState = { status: "idle", elapsedMs: 0, startedAt: 0 }; }, removeControls: () => removedWindow(2),
    popupSender: { id: ID, url: EXT + "popup.html", documentId: "popup-document", frameId: 0 },
    openPopup: () => { popupDocuments = [{ contextType: "POPUP", documentId: "popup-document" }]; },
    holdPopup: () => { holdPopup = true; }, closePopup: () => { popupDocuments = []; }, setActiveTab: tab => { activeTab = tab; },
    barCreations: () => barCreations, savedSettings: () => settings, holdBarCreation: value => { barCreated = value; }, setBarHide: value => { allowBarHide = value; }, removeBar: () => { barExists = false; return removedWindow(6); },
    holdBarRemoval: value => { barRemoved = value; },
    setImportFailure: value => { importFailure = value; },
    barSender: { id: ID, url: EXT + "floatingbar.html", tab: { id: 7 }, frameId: 0 } };
}

test("tab capture automatically opens a separate control bar only after recording begins", async () => {
  const run = await background();
  await run.start({ source: "tab" });
  assert.ok(run.events.indexOf("BAR_CREATE") > run.events.indexOf("BEGIN"));
  assert.equal(run.state().barVisible, true); assert.equal(run.barCreations(), 1);
  const initialized = await run.api("INIT_FLOATING_BAR", { barTabId: 7 }, run.barSender);
  assert.equal(initialized.barSafe, true);
  run.events.length = 0; await run.removeBar();
  assert.equal(run.state().status, "recording"); assert.equal(run.state().barVisible, false);
  assert.ok(!run.events.includes("STOP"));
});
test("one toolbar Start opens Chrome selection and begins without showing another setup window", async () => {
  const run = await background(); run.openPopup();
  const popup = await run.api("INIT_POPUP", {}, run.popupSender);
  const result = await run.api("START_RECORDING", { popupSession: popup.popupSession, options: { source: "window", systemAudio: true } }, run.popupSender);
  assert.equal(result.accepted, true);
  await run.settled();
  assert.equal(run.state().status, "recording");
  assert.equal(run.state().captureSetup, false);
  assert.equal(run.pickerRequest().targetTab.id, 3);
  assert.equal(run.pickerRequest().sources[0], "window");
  assert.ok(run.pickerRequest().sources.includes("tab") && run.pickerRequest().sources.includes("screen") && run.pickerRequest().sources.includes("audio"));
  assert.equal(run.events.filter(event => event === "PICKER").length, 1);
  assert.ok(run.events.indexOf("POPUP_HIDE") < run.events.indexOf("PICKER"));
  assert.ok(run.events.indexOf("PICKER") < run.events.indexOf("PREPARE"));
  assert.ok(run.events.indexOf("PREPARE") < run.events.indexOf("BEGIN"));
  assert.ok(!run.events.includes("SHOW") && !run.events.includes("CONTROL_CREATE_VISIBLE"));
});
test("a first recording creates a tab in the existing window and restores the original page", async () => {
  const run = await background();
  run.makeControlsMissing();
  await run.start({ source: "tab", systemAudio: false, controlBar: false });
  assert.equal(run.controlCreations(), 0);
  assert.equal(run.hostTabCreations(), 1);
  assert.equal(run.hostTabActive(), false);
  assert.ok(run.events.includes("CONTROL_TAB_CREATE"));
  assert.ok(!run.events.includes("CONTROL_CREATE_VISIBLE") && !run.events.includes("SHOW"));
  assert.equal(run.pickerRequest().sources.includes("audio"), false);
  assert.equal(run.state().status, "recording");
});
test("canceling Chrome selection preserves options and the next single Start records", async () => {
  const run = await background();
  run.cancelSelection();
  const options = { source: "window", microphone: false, resolution: 720, saveDestination: "local", controlBar: false };
  const cancelled = await run.start(options);
  assert.equal(cancelled.cancelled, true);
  assert.equal(run.state().popupHidden, false);
  assert.equal(run.events.includes("BEGIN"), false);
  assert.equal(run.savedSettings().resolution, 720);
  run.cancelSelection(false);
  await run.start(options);
  assert.equal(run.state().status, "recording");
  assert.equal(run.events.filter(event => event === "PICKER").length, 2);
  assert.equal(run.events.filter(event => event === "BEGIN").length, 1);
  assert.ok(!run.events.includes("SHOW") && !run.events.includes("CONTROL_CREATE_VISIBLE"));
});
test("capture-host focus during source selection never pauses the uninitialized engine", async () => {
  const run = await background();
  let choose;
  run.holdPicker(new Promise(resolve => { choose = resolve; }));
  await run.api("START_RECORDING", { options: { source: "window", controlBar: false } });
  const until = Date.now() + 1000;
  while (!run.events.includes("PICKER")) {
    if (Date.now() >= until) throw new Error("Native source selection did not begin");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(run.state().status, "selecting");
  run.focusControls();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(run.events.includes("PAUSE"), false);
  assert.equal(run.state().error, "");
  choose();
  await run.settled();
  assert.equal(run.state().status, "recording");
});
test("activating the hidden capture tab pauses a live window recording", async () => {
  const run = await background();
  await run.start({ source: "window", controlBar: false });
  assert.equal(run.hostTabActive(), false);
  await run.activateHost();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(run.state().status, "paused");
  assert.ok(run.events.includes("PAUSE"));
});
test("closing the capture tab reports interruption and retains the recording identity", async () => {
  const run = await background({ status: "recording", sourceMode: "window", engineContext: "controls", recordingId: "video", hostOnly: true }, { controlsHostMode: "tab", controlsWindowId: undefined });
  await run.removeHost();
  assert.equal(run.state().status, "error");
  assert.equal(run.state().recordingId, "video");
  assert.equal(run.state().popupHidden, false);
  assert.match(run.state().error, /Tab.*geschlossen/);
});
test("a stale hidden-popup flag cannot make the paused recording menu inaccessible", async () => {
  const run = await background({ status: "paused", sourceMode: "screen", engineContext: "controls", hostOnly: true, popupHidden: true });
  run.openPopup();
  const opened = await run.api("INIT_POPUP", {}, run.popupSender);
  assert.equal(opened.popupSafe, true);
  assert.equal(opened.state.popupHidden, false);
});
test("prepared capture can only begin from the registered persistent controls", async () => {
  const run = await background({ status: "preparing", sourceReady: true, engineContext: "controls", sourceMode: "screen", settings: { source: "tab" } });
  await assert.rejects(run.api("START_PREPARED_RECORDING", {}, { id: ID, url: EXT + "editor.html" }), /capture controller/);
  assert.ok(!run.events.includes("BEGIN"));
});
test("window capture removes an old bar before source selection and creates a fresh excluded bar after BEGIN", async () => {
  const run = await background({}, { barWindowId: 6, barTabId: 7 });
  await run.start({ source: "window" });
  assert.ok(run.events.indexOf("BAR_CLOSE") < run.events.indexOf("PICKER"));
  assert.ok(run.events.indexOf("BAR_CREATE") > run.events.indexOf("BEGIN"));
  assert.equal(run.state().barVisible, true);
});
test("screen capture keeps the bar absent until a requested pause is confirmed", async () => {
  const run = await background();
  await run.start({ source: "screen" });
  assert.equal(run.barCreations(), 0);
  let acknowledge; run.setPause(new Promise(resolve => { acknowledge = resolve; }));
  const showing = run.api("SHOW_FLOATING_BAR");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(run.events.includes("PAUSE")); assert.equal(run.barCreations(), 0);
  acknowledge(); await showing;
  assert.equal(run.state().status, "paused"); assert.equal(run.state().barVisible, true);
});
test("full-screen resume destroys the acknowledged hidden bar before recording can resume", async () => {
  const run = await background({ status: "paused", sourceMode: "screen", engineContext: "controls", hostOnly: true, barVisible: true }, { barWindowId: 6, barTabId: 7 });
  await run.api("RESUME_RECORDING", { barTabId: 7 }, run.barSender);
  const order = ["BAR_HIDE", "BAR_CLOSE", "RESUME"].map(event => run.events.indexOf(event));
  assert.ok(order.every((position, index) => position >= 0 && (!index || position > order[index - 1])));
  assert.equal(run.state().barVisible, false); assert.equal(run.state().status, "recording");
});
test("unconfirmed bar hiding blocks screen resume and a foreign bar cannot control capture", async () => {
  const run = await background({ status: "paused", sourceMode: "screen", engineContext: "controls", hostOnly: true, barVisible: true }, { barWindowId: 6, barTabId: 7 });
  run.setBarHide(false);
  await assert.rejects(run.api("RESUME_RECORDING", { barTabId: 7 }, run.barSender), /hide|ausgeblendet|Steuerleiste/);
  assert.ok(!run.events.includes("RESUME"));
  await assert.rejects(run.api("PAUSE_RECORDING", { barTabId: 8 }, { ...run.barSender, tab: { id: 8 } }), /bar|Steuerleiste/);
});
test("the disabled control-bar preference creates no window and explicit stop closes only the bar", async () => {
  const disabled = await background();
  await disabled.start({ source: "tab", controlBar: false });
  assert.equal(disabled.barCreations(), 0);
  const run = await background();
  await run.start({ source: "tab" });
  await run.api("STOP_RECORDING", { barTabId: 7 }, run.barSender);
  assert.equal(run.state().status, "idle"); assert.equal(run.state().barVisible, false);
  assert.ok(run.events.includes("BAR_CLOSE"));
});
test("a live bar-off preference persists and cannot be reverted by old engine settings", async () => {
  const run = await background();
  await run.start({ source: "tab", controlBar: true });
  await run.api("SET_CONTROL_BAR", { enabled: false });
  assert.equal(run.savedSettings().controlBar, false);
  await run.api("GET_STATE"); await run.api("PAUSE_RECORDING");
  assert.equal(run.state().controlBarEnabled, false); assert.equal(run.state().barVisible, false);
  assert.equal(run.barCreations(), 1);
  await run.api("SET_CONTROL_BAR", { enabled: true });
  assert.equal(run.savedSettings().controlBar, true); assert.equal(run.state().barVisible, true);
});
test("rapid show-bar requests reuse one bar window and old screen opt-in flags cannot reveal it live", async () => {
  const run = await background({ status: "paused", sourceMode: "tab", engineContext: "controls" });
  await Promise.all([run.api("SHOW_FLOATING_BAR"), run.api("SHOW_FLOATING_BAR")]);
  assert.equal(run.barCreations(), 1);
  const screen = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", allowControlBarInVideo: true });
  await screen.api("SHOW_FLOATING_BAR");
  assert.equal(screen.state().status, "paused"); assert.equal(screen.barCreations(), 1);
  assert.ok(screen.events.indexOf("PAUSE") < screen.events.indexOf("BAR_CREATE"));
});
test("screen resume waits for an in-flight native bar creation before destroying it", async () => {
  const run = await background({ status: "paused", sourceMode: "screen", engineContext: "controls", hostOnly: true });
  let finish; run.holdBarCreation(new Promise(resolve => { finish = resolve; }));
  const showing = run.api("SHOW_FLOATING_BAR");
  await new Promise(resolve => setTimeout(resolve, 0));
  const resuming = run.api("RESUME_RECORDING");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(!run.events.includes("RESUME"));
  finish(); await Promise.all([showing, resuming]);
  assert.ok(run.events.indexOf("BAR_CLOSE") < run.events.indexOf("RESUME"));
  assert.equal(run.state().barVisible, false);
});
test("a recording stopped during native bar creation leaves no late visible bar", async () => {
  const run = await background({ status: "paused", sourceMode: "tab", engineContext: "controls", recordingId: "video" });
  let finish; run.holdBarCreation(new Promise(resolve => { finish = resolve; }));
  const showing = run.api("SHOW_FLOATING_BAR");
  await new Promise(resolve => setTimeout(resolve, 0));
  const stopping = run.api("STOP_RECORDING");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(!run.events.includes("STOP"));
  finish(); await Promise.all([showing, stopping]);
  assert.equal(run.state().status, "idle"); assert.equal(run.state().barVisible, false);
  assert.ok(run.events.includes("BAR_CLOSE"));
});
test("a delayed pause reserves its whole transaction against a concurrent full-screen resume", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", hostOnly: true });
  let finish; run.setPause(new Promise(resolve => { finish = resolve; }));
  const pausing = run.api("PAUSE_RECORDING");
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(run.api("RESUME_RECORDING"), /operation.*progress/);
  assert.ok(!run.events.includes("RESUME") && !run.events.includes("BAR_CREATE"));
  finish(); await pausing;
  await run.api("RESUME_RECORDING");
  assert.ok(run.events.indexOf("BAR_CLOSE") < run.events.indexOf("RESUME"));
  assert.equal(run.state().barVisible, false);
});
test("full-screen resume waits for an earlier show request still awaiting PAUSE before any window exists", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", hostOnly: true });
  let finish; run.setPause(new Promise(resolve => { finish = resolve; }));
  const showing = run.api("SHOW_FLOATING_BAR");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(run.events.includes("PAUSE") && !run.events.includes("BAR_CREATE"));
  const resuming = run.api("RESUME_RECORDING");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(!run.events.includes("RESUME"));
  finish(); await Promise.all([showing, resuming]);
  assert.ok(run.events.indexOf("BAR_CREATE") < run.events.indexOf("BAR_CLOSE"));
  assert.ok(run.events.indexOf("BAR_CLOSE") < run.events.indexOf("RESUME"));
  assert.equal(run.state().barVisible, false);
});
test("stop reserves against resume while an earlier show is still waiting for PAUSE", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", hostOnly: true });
  let finish; run.setPause(new Promise(resolve => { finish = resolve; }));
  const showing = run.api("SHOW_FLOATING_BAR");
  await new Promise(resolve => setTimeout(resolve, 0));
  const stopping = run.api("STOP_RECORDING");
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(run.api("RESUME_RECORDING"), /operation.*progress/);
  finish(); await Promise.all([showing, stopping]);
  assert.ok(run.events.indexOf("BAR_CREATE") < run.events.indexOf("STOP"));
  assert.equal(run.state().status, "idle"); assert.equal(run.state().barVisible, false);
});
test("a new capture waits for earlier completion window cleanup and online handoff", async () => {
  const run = await background({ status: "idle", sourceMode: "tab", engineContext: "controls", hostOnly: true, recordingId: "old" }, { barWindowId: 6, barTabId: 7 });
  let finish; run.holdBarRemoval(new Promise(resolve => { finish = resolve; }));
  const completed = run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "old" } });
  await new Promise(resolve => setTimeout(resolve, 0));
  const starting = run.start({ source: "screen" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(!run.events.includes("PICKER"));
  finish(); await Promise.all([completed, starting]);
  assert.ok(run.events.indexOf("NAVIGATE_IMPORT") >= 0);
  assert.ok(run.events.indexOf("NAVIGATE_IMPORT") < run.events.indexOf("PICKER"));
  assert.equal(run.state().status, "recording"); assert.equal(run.state().barVisible, false);
});
test("a completed video automatically opens the authenticated webapp handoff after closing controls", async () => {
  const run = await background({ status: "idle", engineContext: "controls", hostOnly: true, recordingId: "video" }, { barWindowId: 6, barTabId: 7 });
  await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } });
  assert.ok(run.events.indexOf("BAR_CLOSE") < run.events.indexOf("NAVIGATE_IMPORT"));
  assert.ok(run.events.includes("CREATE_BLANK"));
  assert.ok(!run.events.includes("EDITOR"));
  assert.equal(Object.values(run.session.handoffs)[0].recordingId, "video");
  assert.equal(run.media.bytes, 5);
});
test("local destination keeps the finished video in browser backup and opens its download editor", async () => {
  const run = await background({ status: "idle", engineContext: "controls", recordingId: "video", settings: { saveDestination: "cloud" } });
  run.media.saveDestination = "local";
  await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } });
  assert.ok(run.events.includes("EDITOR"));
  assert.ok(!run.events.includes("NAVIGATE_IMPORT"));
  assert.equal(run.media.status, "finished"); assert.equal(run.media.bytes, 5);
});
test("a folder recording writes the actual recorded format once and keeps its browser backup", async () => {
  for (const mimeType of ["video/mp4", "video/webm"]) {
    const run = await background({ status: "idle", engineContext: "controls", recordingId: "video", settings: { saveDestination: "cloud" } });
    Object.assign(run.media, { mimeType, saveDestination: "folder" });
    const finish = () => run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } });
    await Promise.all([finish(), finish()]);
    assert.equal(run.folderExports.length, 1);
    assert.equal(run.folderExports[0].id, "video");
    assert.equal(run.folderExports[0].blob.type, mimeType);
    assert.deepEqual([...new Uint8Array(await run.folderExports[0].blob.arrayBuffer())], [1, 2, 3, 4, 5]);
    assert.equal(run.media.status, "finished");
    assert.ok(!run.events.includes("EDITOR") && !run.events.includes("NAVIGATE_IMPORT"));
  }
});
test("a failed folder write retains the backup, explains recovery and can be retried locally", async () => {
  const run = await background({ status: "idle", engineContext: "controls", recordingId: "video" });
  run.media.saveDestination = "folder";
  run.setFolderError(new Error("Bitte den Aufnahmeordner erneut freigeben."));
  await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } });
  assert.equal(run.media.bytes, 5);
  assert.ok(run.events.includes("EDITOR"));
  assert.equal(run.state().folderSaveError.recordingId, "video");
  assert.match(run.state().folderSaveError.message, /Aufnahmen in Chrome/);
  assert.match(run.state().folderSaveError.message, /freigeben/);
  await assert.rejects(run.api("SAVE_RECORDING_TO_FOLDER", { id: "video" }), /freigeben/);
  run.setFolderError(null);
  const retry = await run.api("SAVE_RECORDING_TO_FOLDER", { id: "video" });
  assert.equal(retry.filename, "Fixture.webm");
  assert.equal(run.folderExports.length, 1);
  assert.equal(run.state().folderSaveError, null);
  assert.ok(!run.events.includes("NAVIGATE_IMPORT"));
});
test("saving to a folder rejects incomplete captures and unrelated media", async () => {
  const run = await background({ status: "idle" });
  for (const changes of [{ status: "interrupted" }, { bytes: 0 }, { error: "write failed" }, { kind: "image" }]) {
    Object.assign(run.media, { kind: "video", bytes: 5, status: "finished", error: "" }, changes);
    await assert.rejects(run.api("SAVE_RECORDING_TO_FOLDER", { id: "video" }), /Video|Aufnahme/);
  }
  assert.equal(run.folderExports.length, 0);
});
test("concurrent retries share one write for a legacy video with only a MIME type", async () => {
  const run = await background({ status: "idle" });
  delete run.media.kind;
  const save = () => run.api("SAVE_RECORDING_TO_FOLDER", { id: "video" });
  const results = await Promise.all([save(), save()]);
  assert.ok(results.every(result => result.filename === "Fixture.webm"));
  assert.equal(run.folderExports.length, 1);
});
test("recorded cloud destination wins over settings changed after that recording", async () => {
  const run = await background({ status: "idle", engineContext: "controls", recordingId: "video", settings: { saveDestination: "local" } });
  run.media.saveDestination = "cloud";
  await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } });
  assert.ok(run.events.includes("NAVIGATE_IMPORT"));
  assert.ok(!run.events.includes("EDITOR"));
});
test("failed automatic handoff retains the local video and opens its backup editor", async () => {
  const run = await background({ status: "idle", engineContext: "controls", recordingId: "video" });
  run.setImportFailure(true);
  await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } });
  assert.equal(run.state().status, "idle");
  assert.equal(run.media.status, "finished");
  assert.equal(run.media.bytes, 5);
  assert.ok(run.events.includes("EDITOR"));
  assert.match(run.state().notice, /Browser-Backup/);
});
test("interrupted, empty, and failed videos are never handed off automatically", async () => {
  for (const changes of [{ status: "interrupted" }, { bytes: 0 }, { error: "write failed" }]) {
    const run = await background({ status: "idle", engineContext: "controls", recordingId: "video" });
    Object.assign(run.media, changes);
    await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } });
    assert.ok(!run.events.includes("NAVIGATE_IMPORT"));
    assert.equal(run.events.includes("EDITOR"), changes.bytes !== 0);
  }
});
test("Chrome can end sharing before the separate stop message arrives and still save exactly once", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", hostOnly: true, recordingId: "video" });
  run.media.saveDestination = "folder";
  const state = { status: "idle", recordingId: "video" };
  await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" }, state });
  await run.api("CONTROL_CAPTURE_STATE", { controllerTabId: 3, state });
  await run.api("CONTROL_CAPTURE_STATE", { controllerTabId: 3, state: { status: "paused", recordingId: "video" } });
  assert.equal(run.state().status, "idle");
  assert.equal(run.folderExports.length, 1);
  assert.match(run.state().lastRecordingResult.message, /Im Aufnahmeordner gespeichert/);
});
test("a terminal capture state is enough to restore the popup and surface the durable backup", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", hostOnly: true, recordingId: "video", popupHidden: true });
  run.media.saveDestination = "local";
  await run.api("CONTROL_CAPTURE_STATE", { controllerTabId: 3, state: { status: "idle", recordingId: "video" } });
  assert.equal(run.state().popupHidden, false);
  assert.match(run.state().lastRecordingResult.message, /Browser-Backup/);
  assert.ok(run.events.includes("EDITOR"));
});
test("a failed capture never auto uploads even if its stored video metadata says finished", async () => {
  const run = await background({ status: "error", engineContext: "controls", recordingId: "video", error: "Capture failed" });
  await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } });
  assert.ok(!run.events.includes("NAVIGATE_IMPORT"));
  assert.ok(run.events.includes("EDITOR"));
});
test("duplicate completion messages open just one automatic upload tab", async () => {
  const run = await background({ status: "idle", engineContext: "controls", recordingId: "video" });
  await Promise.all([run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } }),
    run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } })]);
  assert.equal(run.events.filter(event => event === "NAVIGATE_IMPORT").length, 1);
});
test("a completion cannot open webapp while that video is still recording", async () => {
  const run = await background({ status: "recording", engineContext: "controls", recordingId: "video" });
  await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "video" } });
  assert.ok(!run.events.includes("NAVIGATE_IMPORT"));
  assert.ok(!run.events.includes("EDITOR"));
});
test("My recordings opens the same server library used by the webapp", async () => {
  const run = await background();
  await run.api("OPEN_LIBRARY");
  assert.ok(run.events.includes("LIBRARY"));
  assert.ok(run.events.includes("CREATE_BLANK"));
  assert.ok(run.events.indexOf("CREATE_BLANK") < run.events.indexOf("LIBRARY"));
});
test("late completion and terminal state from an old recording cannot affect a new capture", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", hostOnly: true, recordingId: "new", popupHidden: true, controlsHidden: true });
  await run.api("RECORDING_FINISHED", { controllerTabId: 3, recording: { id: "old" } });
  await run.api("CONTROL_CAPTURE_STATE", { controllerTabId: 3, state: { status: "idle", recordingId: "old" } });
  assert.equal(run.state().status, "recording"); assert.equal(run.state().recordingId, "new");
  assert.equal(run.state().popupHidden, true);
  assert.ok(!run.events.includes("EDITOR") && !run.events.includes("POPUP_ENABLE"));
});
test("a pinned bar parks its native opener and show focuses PiP rather than a blank opener", async () => {
  const run = await background();
  await run.start({ source: "tab" });
  await run.api("PIN_FLOATING_BAR", { barTabId: 7 }, run.barSender);
  assert.equal(run.state().barPinned, true); assert.equal(run.state().barVisible, true);
  assert.ok(run.events.includes("BAR_MINIMIZE"));
  run.events.length = 0; await run.api("SHOW_FLOATING_BAR");
  assert.ok(run.events.includes("BAR_FOCUS")); assert.ok(!run.events.includes("BAR_SHOW"));
  await run.api("HIDE_FLOATING_BAR", { barTabId: 7 }, run.barSender);
  assert.equal(run.state().barPinned, false); assert.equal(run.state().barVisible, false);
  assert.equal(run.state().status, "recording");
});
test("a pinned full-screen bar must acknowledge PiP closure despite a minimized opener", async () => {
  const run = await background({ status: "paused", sourceMode: "screen", engineContext: "controls", hostOnly: true, barVisible: true, barPinned: true }, { barWindowId: 6, barTabId: 7, barMinimized: true });
  run.setBarHide(false);
  await assert.rejects(run.api("RESUME_RECORDING", { barTabId: 7 }, run.barSender), /Steuerleiste/);
  assert.ok(run.events.includes("BAR_HIDE")); assert.ok(!run.events.includes("RESUME"));
});
test("bar settings pause a window capture and open the advanced popup view once", async () => {
  const run = await background({ status: "recording", sourceMode: "window", engineContext: "controls", barVisible: true }, { barWindowId: 6, barTabId: 7 });
  await run.api("OPEN_BAR_SETTINGS", { barTabId: 7 }, run.barSender);
  assert.ok(run.events.indexOf("PAUSE") < run.events.indexOf("OPEN_POPUP"));
  run.openPopup();
  const first = await run.api("INIT_POPUP", {}, run.popupSender);
  assert.equal(first.showSettings, true);
  const second = await run.api("INIT_POPUP", {}, run.popupSender);
  assert.equal(second.showSettings, false);
});

test("desktop recording selects and consumes its source before hiding controls and beginning", async () => {
  const run = await background();
  await run.start({ source: "screen" });
  const order = ["PICKER", "PREPARE", "TAB_RESTORE", "HIDE_FOR_CAPTURE", "BEGIN"].map(event => run.events.indexOf(event));
  assert.ok(order.every((position, index) => position >= 0 && (!index || position > order[index - 1])));
});
test("no recording can start without an explicit source type", async () => {
  const run = await background();
  await assert.rejects(run.api("START_RECORDING", { options: {} }), /quelle/i);
  assert.ok(!run.events.includes("BEGIN") && !run.events.includes("PICKER"));
});
test("native picker cancellation returns retryable idle without showing a setup window", async () => {
  const run = await background(); run.cancelSelection();
  const result = await run.start({ source: "window" });
  assert.equal(result.cancelled, true); assert.equal(run.state().status, "idle");
  assert.equal(run.state().captureSetup, false); assert.equal(run.state().popupHidden, false);
  assert.ok(!run.events.includes("BEGIN") && !run.events.includes("SHOW") && !run.events.includes("CONTROL_CREATE_VISIBLE"));
});
test("tab mode also requires genuine native source selection", async () => {
  const run = await background();
  await run.start({ source: "tab" });
  assert.ok(run.events.indexOf("PICKER") >= 0 && run.events.indexOf("PICKER") < run.events.indexOf("BEGIN"));
  assert.ok(run.events.indexOf("TAB_RESTORE") < run.events.indexOf("BEGIN"));
});
test("closing the active capture controller clears REC and leaves committed chunks recoverable", async () => {
  const run = await background({ status: "recording", sourceMode: "window", engineContext: "controls", recordingId: "video" });
  await run.removeControls();
  assert.equal(run.state().status, "error"); assert.equal(run.state().controlsHidden, false);
  assert.equal(run.state().recordingId, "video"); assert.match(run.state().error, /Aufnahmen/);
});
test("lost BEGIN acknowledgment cannot reveal desktop controls until the controls engine confirms STOP", async () => {
  const run = await background(); run.setBeginFailure(true); run.setHelperExists(false);
  let acknowledge; run.setStop(new Promise(resolve => { acknowledge = resolve; }));
  const starting = run.start({ source: "window" });
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.ok(run.events.includes("BEGIN") && run.events.includes("STOP"));
  assert.equal(run.state().controlsHidden, true);
  acknowledge(); await assert.rejects(starting, /Begin acknowledgment/);
  assert.equal(run.state().controlsHidden, false); assert.ok(run.events.includes("POPUP_ENABLE"));
});
test("reloading an active capture frame reports interruption and recovers a visible menu", async () => {
  const run = await background({ status: "recording", sourceMode: "window", engineContext: "controls", recordingId: "video", controlsHidden: true });
  run.resetController();
  await run.api("GET_STATE");
  assert.equal(run.state().status, "error"); assert.equal(run.state().controlsHidden, false);
  assert.equal(run.state().recordingId, "video"); assert.match(run.state().error, /neu geladen/);
});
test("rapid toolbar requests create only one persistent controls window", async () => {
  const run = await background(); let finishCreating;
  run.makeControlsMissing(new Promise(resolve => { finishCreating = resolve; }));
  const first = run.api("SHOW_CONTROLS"), second = run.api("SHOW_CONTROLS");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(run.controlCreations(), 1);
  finishCreating(); await Promise.all([first, second]); assert.equal(run.controlCreations(), 1);
});
test("a different controls frame cannot overwrite the registered recorder state", async () => {
  const run = await background({ status: "recording", sourceMode: "window", engineContext: "controls", recordingId: "video" });
  const extra = { controllerTabId: 4, state: { status: "idle", controlsHidden: false } };
  await assert.rejects(run.api("CONTROL_CAPTURE_STATE", extra, { id: ID, url: EXT + "controls.html", tab: { id: 4 } }), /instance/);
  assert.equal(run.state().status, "recording"); assert.equal(run.state().recordingId, "video");
});
test("showing desktop controls waits for the recorder pause acknowledgment", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", recordingId: "video" });
  let acknowledge;
  run.setPause(new Promise(resolve => { acknowledge = resolve; }));
  const operation = run.api("PAUSE_RECORDING");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(run.events.includes("PAUSE")); assert.ok(!run.events.includes("SHOW"));
  acknowledge(); await operation;
  assert.ok(run.events.includes("SHOW"));
});
test("paused desktop screenshot preserves capture identity and resume still hides controls first", async () => {
  const run = await background({ status: "paused", sourceMode: "window", recordingId: "video", name: "Original", settings: { source: "window" } });
  await run.api("CAPTURE_SCREENSHOT", { options: { mode: "visible" } });
  assert.equal(run.state().sourceMode, "window"); assert.equal(run.state().recordingId, "video"); assert.equal(run.state().name, "Original");
  run.events.length = 0;
  await run.api("RESUME_RECORDING");
  assert.ok(run.events.indexOf("HIDE_FOR_CAPTURE") < run.events.indexOf("MINIMIZE"));
  assert.ok(run.events.indexOf("MINIMIZE") < run.events.indexOf("RESUME"));
});
test("desktop resume stays paused if controller hiding is not acknowledged", async () => {
  const run = await background({ status: "paused", sourceMode: "screen", recordingId: "video" }); run.setHide(false);
  await assert.rejects(run.api("RESUME_RECORDING"), /confirm/);
  assert.ok(!run.events.includes("RESUME")); assert.equal(run.state().status, "paused");
});
test("duplicate start and resume commands never stop or relabel an active recorder", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", recordingId: "video" });
  await assert.rejects(run.start({ source: "screen" }), /Stop the current/);
  await assert.rejects(run.api("RESUME_RECORDING"), /not paused/);
  assert.ok(!run.events.includes("STOP")); assert.ok(!run.events.includes("HIDE_FOR_CAPTURE"));
  assert.equal(run.state().status, "recording");
});
test("failed resume acknowledgment requires a confirmed pause before controls restore", async () => {
  const run = await background({ status: "paused", sourceMode: "screen", recordingId: "video" });
  run.setResumeFailure(true);
  let acknowledge; run.setPause(new Promise(resolve => { acknowledge = resolve; }));
  const resumed = run.api("RESUME_RECORDING");
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.ok(run.events.includes("RESUME")); assert.ok(run.events.includes("PAUSE")); assert.ok(!run.events.includes("SHOW"));
  acknowledge(); await assert.rejects(resumed, /Resume acknowledgment/);
  assert.ok(run.events.includes("SHOW")); assert.equal(run.state().status, "paused");
});
test("page scripts cannot issue controller commands and imports are exact-tab, origin and one-use scoped", async () => {
  const run = await background();
  const page = { id: ID, url: "https://recorder.example.test/", tab: { id: 8 }, frameId: 0 };
  await assert.rejects(run.api("START_RECORDING", {}, page), /Only recorder extension pages/);
  await run.api("OPEN_RECORDER", { id: "video" });
  assert.ok(run.events.indexOf("CREATE_BLANK") < run.events.indexOf("NAVIGATE_IMPORT"));
  const nonce = Object.keys(run.session.handoffs)[0]; assert.match(nonce, /^[a-f0-9]{64}$/);
  await assert.rejects(run.api("IMPORT_METADATA", { nonce }, { ...page, tab: { id: 9 } }), /not authorized/);
  await assert.rejects(run.api("IMPORT_METADATA", { nonce }, { ...page, frameId: 1 }), /not authorized/);
  await assert.rejects(run.api("IMPORT_METADATA", { nonce }, { ...page, url: "https://untrusted.test/" }), /not authorized/);
  const result = await run.api("IMPORT_CHUNK", { nonce, offset: 1, length: 3 }, page);
  assert.equal(result.data, "AgME"); assert.equal(result.nextOffset, 4); assert.equal(result.done, false);
  await assert.rejects(run.api("IMPORT_CHUNK", { nonce, offset: 0, length: 524289 }, page), /range/);
  await run.api("IMPORT_DONE", { nonce }, page);
  await assert.rejects(run.api("IMPORT_METADATA", { nonce }, page), /not authorized/);
});

test("AI handoffs preserve the private one-recording import grant and only choose the assistant view", async () => {
  const run = await background();
  const page = { id: ID, url: "https://recorder.example.test/", tab: { id: 8 }, frameId: 0 };
  await assert.rejects(run.api("OPEN_AI_ASSISTANT", { id: "video" }, page), /Only recorder extension pages/);
  for (const [mode, intent] of [["analyze", "1"], ["transcript", "transcript"]]) {
    await run.api("OPEN_AI_ASSISTANT", { id: "edited-copy", mode });
    const url = new URL(run.navigations.at(-1));
    assert.equal(url.origin, "https://recorder.example.test");
    assert.equal(url.searchParams.get("ai"), intent);
    assert.equal(url.searchParams.get("extensionId"), ID);
    const nonce = url.searchParams.get("extensionImport");
    assert.equal(run.session.handoffs[nonce].recordingId, "edited-copy");
    assert.equal(run.session.handoffs[nonce].tabId, 8);
    await assert.rejects(run.api("IMPORT_METADATA", { nonce }, { ...page, tab: { id: 9 } }), /not authorized/);
    await run.api("IMPORT_DONE", { nonce }, page);
  }
  await run.api("OPEN_RECORDER", { id: "video" });
  assert.equal(new URL(run.navigations.at(-1)).searchParams.has("ai"), false);
});

test("opening the anchored menu registers its current tab without creating a floating controller", async () => {
  const run = await background(); run.openPopup();
  const result = await run.api("INIT_POPUP", {}, run.popupSender);
  assert.equal(result.popupSafe, true); assert.equal(result.appOrigin, "https://recorder.example.test");
  assert.equal(result.state.targetTabId, 1); assert.equal(run.controlCreations(), 0);
  assert.ok(!run.events.includes("SHOW")); assert.match(result.popupSession, /^[a-f0-9]{32}$/);
});
test("opening the menu on a protected page clears a previous screenshot target", async () => {
  const run = await background(); run.openPopup(); run.setActiveTab({ id: 9, windowId: 5, url: "chrome://settings/" });
  const result = await run.api("INIT_POPUP", {}, run.popupSender);
  assert.equal(result.state.targetTabId, null); assert.equal(result.state.targetTitle, "");
  await assert.rejects(run.api("CAPTURE_SCREENSHOT", { popupSession: result.popupSession, options: {} }, run.popupSender), /page you want to capture/);
});
test("desktop popup initialization waits for actual pause and does not focus its capture host", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", hostOnly: true, controlsHidden: true });
  run.openPopup(); let pause; run.setPause(new Promise(resolve => { pause = resolve; }));
  const opening = run.api("INIT_POPUP", {}, run.popupSender);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(run.events.includes("PAUSE")); assert.equal(run.state().status, "recording"); assert.ok(!run.events.includes("SHOW"));
  pause(); const result = await opening; assert.equal(result.state.status, "paused"); assert.equal(result.popupSafe, true);
});
test("the full-screen recording icon opens the stop menu instead of a floating window", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", hostOnly: true, controlBarEnabled: true });
  run.clickAction();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(run.events.includes("PAUSE") && run.events.includes("OPEN_POPUP"));
  assert.ok(!run.events.includes("BAR_CREATE"));
  assert.equal(run.state().status, "paused");
});
test("the stop shortcut stops an ongoing full-screen recording without opening any controls", async () => {
  const run = await background({ status: "recording", sourceMode: "screen", engineContext: "controls", hostOnly: true });
  run.stopShortcut();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(run.events.includes("STOP"));
  assert.ok(!run.events.includes("OPEN_POPUP") && !run.events.includes("BAR_CREATE"));
  assert.equal(run.state().status, "idle");
});
test("desktop resume waits for the native popup context to disappear after its hide acknowledgment", async () => {
  const run = await background({ status: "paused", sourceMode: "screen", engineContext: "controls", hostOnly: true, controlsHidden: true });
  run.openPopup(); const popup = await run.api("INIT_POPUP", {}, run.popupSender); run.holdPopup(); run.events.length = 0;
  const resuming = run.api("RESUME_RECORDING", { popupSession: popup.popupSession }, run.popupSender);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(run.events.includes("POPUP_DISABLE") && run.events.includes("POPUP_HIDE")); assert.ok(!run.events.includes("RESUME"));
  await assert.rejects(run.api("SHOW_CONTROLS"), /gerade vorbereitet/);
  assert.ok(!run.events.includes("OPEN_POPUP"));
  run.closePopup(); await resuming;
  const order = ["POPUP_DISABLE", "POPUP_HIDE", "MINIMIZE", "RESUME"].map(event => run.events.indexOf(event));
  assert.ok(order.every((position, index) => position >= 0 && (!index || position > order[index - 1])));
  assert.equal(run.state().status, "recording"); assert.equal(run.state().popupHidden, true);
});
test("popup sessions remain document-bound across a service worker restart", async () => {
  const first = await background(); first.openPopup();
  const popup = await first.api("INIT_POPUP", {}, first.popupSender);
  const restarted = await background({}, first.session);
  restarted.openPopup();
  await restarted.api("GET_STATE", { popupSession: popup.popupSession }, restarted.popupSender);
  await assert.rejects(restarted.api("GET_STATE", { popupSession: popup.popupSession }, { ...restarted.popupSender, documentId: "foreign-document" }), /popup|Menü erneut/);
});
test("native popup senders without document fields bind to the actual POPUP context only", async () => {
  const run = await background(); run.openPopup();
  const native = { id: ID, url: EXT + "popup.html" };
  const popup = await run.api("INIT_POPUP", {}, native);
  assert.equal(popup.popupSafe, true);
  await run.api("GET_STATE", { popupSession: popup.popupSession }, native);
  await assert.rejects(run.api("INIT_POPUP", {}, { ...native, tab: { id: 9 } }), /Invalid recorder popup/);
  run.closePopup();
  await assert.rejects(run.api("GET_STATE", { popupSession: popup.popupSession }, native), /Invalid recorder popup/);
});
test("accepted popup setup survives popup closure and reserves against duplicate starts", async () => {
  const run = await background(); run.openPopup();
  const popup = await run.api('INIT_POPUP', {}, run.popupSender);
  const request = { popupSession: popup.popupSession, options: { source: 'window' } };
  const results = await Promise.allSettled([run.api('START_RECORDING', request, run.popupSender), run.api('START_RECORDING', request, run.popupSender)]);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.accepted).length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  run.closePopup();
  await run.settled();
  assert.equal(run.state().status, "recording");
  assert.equal(run.events.filter(event => event === 'PICKER').length, 1);
  assert.ok(run.events.indexOf('POPUP_DISABLE') < run.events.indexOf('BEGIN'));
  assert.equal(run.state().controlsHidden, true); assert.equal(run.state().hostOnly, true);
});

async function offscreen() {
  const context = vm.createContext({ ExtensionStore: {}, normalizeOptions: value => value, finalizeWebm: value => value,
    chrome: { runtime: { id: ID, onMessage: { addListener() {} }, sendMessage: async () => ({}) } },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, console });
  const source = (await readFile(new URL("../chrome-extension/offscreen.js", import.meta.url), "utf8"))
    .replace(/^import[^\n]+\n/gm, "") + "\nglobalThis.engineTest={freshFrames,pause,sourceCrop,setAutoStop,setVideo:v=>sourceVideo=v,setSource:v=>source=v,setProcessor:c=>globalThis.MediaStreamTrackProcessor=c,setRecorder:r=>recorder=r,setState:s=>state=s,getState:()=>state};";
  vm.runInContext(source, context); return context.engineTest;
}
test("fresh-frame barrier requires three new capture frames before it resolves", async () => {
  const engine = await offscreen(); let callback, resolved = false;
  engine.setVideo({ requestVideoFrameCallback: next => { callback = next; return 1; }, cancelVideoFrameCallback() {} });
  const barrier = engine.freshFrames(3).then(() => { resolved = true; });
  callback(); await Promise.resolve(); assert.equal(resolved, false);
  callback(); await Promise.resolve(); assert.equal(resolved, false);
  callback(); await barrier; assert.equal(resolved, true);
});
test("hidden offscreen frame barrier consumes and closes fresh source frames independently of video compositing", async () => {
  const engine = await offscreen(); let reads = 0, closed = 0, cancelled = false, stopped = false;
  const clone = { stop() { stopped = true; } };
  engine.setSource({ getVideoTracks: () => [{ clone: () => clone }] });
  engine.setProcessor(class {
    constructor(options) {
      assert.equal(options.track, clone);
      this.readable = { getReader: () => ({
        read: async () => { reads++; return { value: { close() { closed++; } }, done: false }; },
        cancel: async () => { cancelled = true; },
      }) };
    }
  });
  await engine.freshFrames(3);
  assert.equal(reads, 3); assert.equal(closed, 3); assert.equal(cancelled, true); assert.equal(stopped, true);
});
test("offscreen pause does not publish paused state until actual MediaRecorder pause event", async () => {
  const engine = await offscreen(); let acknowledge;
  const recorder = { state: "recording", addEventListener: (_type, listener) => { acknowledge = listener; }, pause() { this.state = "paused"; } };
  engine.setRecorder(recorder); engine.setState({ status: "recording", elapsedMs: 0, startedAt: Date.now() });
  const paused = engine.pause(); await Promise.resolve(); assert.equal(engine.getState().status, "recording");
  acknowledge(); await paused; assert.equal(engine.getState().status, "paused");
});

async function nativeChooser({ active = true, reject } = {}) {
  const calls = [], selected = { getVideoTracks: () => [{ getSettings: () => ({ displaySurface: 'monitor' }) }] };
  const source = await readFile(new URL('../chrome-extension/offscreen.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function captureSourceMode('), source.indexOf('async function playable('));
  let state = { status: 'idle' }, prepared;
  const context = vm.createContext({ controlsFrame: true, controlsFrameTabId: 3, recorder: null,
    normalizeOptions: value => ({ frameRate: 30, systemAudio: true, ...value }),
    state, change: patch => { Object.assign(state, patch); }, stopStreams: () => {},
    publicState: () => ({ ...state }),
    navigator: { userActivation: { isActive: active }, mediaDevices: { getDisplayMedia: options => {
      calls.push(options); return reject ? Promise.reject(reject) : Promise.resolve(selected);
    } } },
    prepare: async value => { prepared = value; return { state: { status: 'preparing' } }; },
    chrome: { runtime: { sendMessage: async () => ({}) } }, setInterval, clearInterval,
  });
  vm.runInContext(functions + '\nglobalThis.chooser={selectSource,captureSourceMode};', context);
  return { ...context.chooser, calls, selected, prepared: () => prepared };
}
test('standard sharing chooser is called immediately from trusted host activation', async () => {
  const engine = await nativeChooser();
  const selection = engine.selectSource({ source: 'tab' });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].video.displaySurface, 'browser');
  assert.equal(engine.calls[0].selfBrowserSurface, 'exclude');
  await selection;
  assert.equal(engine.prepared().stream, engine.selected);
});
test('source requests without a direct user gesture cannot open the standard chooser', async () => {
  const engine = await nativeChooser({ active: false });
  assert.throws(() => engine.selectSource({ source: 'window' }), /Schaltfläche/);
  assert.equal(engine.calls.length, 0);
});
test('the selected track controls source safety even when it differs from requested tab mode', async () => {
  const engine = await nativeChooser();
  for (const [surface, expected] of [['browser', 'tab'], ['window', 'window'], ['monitor', 'screen'], [undefined, 'screen'], ['future', 'screen']]) {
    const stream = { getVideoTracks: () => [{ getSettings: () => ({ displaySurface: surface }) }] };
    assert.equal(engine.captureSourceMode(stream), expected);
  }
});
test('standard chooser cancellation leaves a retryable idle setup', async () => {
  const error = new Error('Permission dismissed'); error.name = 'NotAllowedError';
  const engine = await nativeChooser({ reject: error });
  const result = await engine.selectSource({ source: 'window' });
  assert.equal(result.cancelled, true);
  assert.equal(result.state.status, 'idle');
  assert.equal(result.state.sourceReady, false);
});
test('system-level screen permission denial is actionable rather than treated as cancellation', async () => {
  const error = new Error('Permission denied by system'); error.name = 'NotAllowedError';
  const engine = await nativeChooser({ reject: error });
  await assert.rejects(engine.selectSource({ source: 'window' }), /Systemeinstellungen.*Bildschirmaufnahme/);
});
test('an unreadable selected display reports a useful source permission error', async () => {
  const error = new Error('Could not start video source'); error.name = 'NotReadableError';
  const engine = await nativeChooser({ reject: error });
  await assert.rejects(engine.selectSource({ source: 'window' }), /Quelle.*Bildschirmaufnahme-Berechtigung/);
});
test('a monitor returned for a requested tab is hidden and never gets a live bar', async () => {
  const run = await background();
  run.setSelectionMode('screen');
  await run.start({ source: 'tab' });
  assert.equal(run.state().sourceMode, 'screen');
  assert.ok(run.events.includes('HIDE_FOR_CAPTURE'));
  assert.equal(run.state().barVisible, false);
  assert.equal(run.state().popupHidden, true);
});

test("camera-only recording skips the desktop picker and starts the persistent media engine", async () => {
  const run = await background();
  await run.start({ source: "camera", camera: true, microphone: false, controlBar: false });
  assert.equal(run.state().status, "recording");
  assert.equal(run.state().sourceMode, "camera");
  assert.equal(run.events.includes("PICKER"), false);
  const prepared = run.mediaRequests.find(message => message.type === "PREPARE");
  assert.equal(prepared.cameraOnly, true);
  assert.equal(prepared.options.source, "camera");
});

test("custom tab region uses selected page coordinates and a consumer-bound tab token", async () => {
  const run = await background();
  await run.start({ source: "tab", regionCapture: true, controlBar: false, systemAudio: true });
  assert.equal(run.state().status, "recording");
  assert.equal(run.events.includes("PICKER"), false);
  assert.ok(run.events.indexOf("SELECT_REGION") < run.events.indexOf("TAB_TOKEN"));
  assert.deepEqual({ ...run.tabCaptureRequest() }, { targetTabId: 1, consumerTabId: 3 });
  const prepared = run.mediaRequests.find(message => message.type === "PREPARE");
  assert.equal(prepared.tabStream, true);
  assert.equal(prepared.options.region.width, 160);
  assert.equal(prepared.options.region.height, 120);
});

test("canceling the page region selector starts no picker, token, or recorder", async () => {
  const run = await background();
  run.setRegionSelection(null);
  const result = await run.start({ source: "tab", regionCapture: true });
  assert.equal(result.state.status, "idle");
  assert.match(result.state.notice, /abgebrochen/i);
  for (const event of ["PICKER", "TAB_TOKEN", "PREPARE", "BEGIN"]) assert.equal(run.events.includes(event), false, event);
});

test("window and monitor regions wait for confirmation after the native chooser", async () => {
  for (const source of ["window", "screen"]) {
    const run = await background();
    await run.start({ source, regionCapture: true, controlBar: false, systemAudio: false });
    assert.deepEqual(run.pickerRequest().sources, [source]);
    assert.equal(run.state().choosingRegion, true);
    assert.equal(run.state().status, "preparing");
    assert.ok(run.events.indexOf("TAB_RESTORE") < run.events.indexOf("PREVIEW_REGION"));
    assert.equal(run.events.includes("BEGIN"), false);
    const region = { x: 120, y: 80, width: 320, height: 240, viewportWidth: 800, viewportHeight: 600 };
    await run.api("CONFIRM_CAPTURE_REGION", { region });
    assert.equal(run.state().choosingRegion, false);
    assert.equal(run.state().status, "recording");
    assert.deepEqual(run.state().settings.region, region);
    assert.ok(run.events.indexOf("SET_CAPTURE_REGION") < run.events.indexOf("BEGIN"));
    assert.equal(run.hostTabActive(), false);
  }
});

test("canceling a desktop region releases the selected stream and returns to the original tab", async () => {
  const run = await background();
  await run.start({ source: "screen", regionCapture: true });
  await run.api("CANCEL_CAPTURE_REGION");
  assert.equal(run.state().status, "idle");
  assert.equal(run.state().choosingRegion, false);
  assert.match(run.state().notice, /abgebrochen/i);
  assert.equal(run.hostTabActive(), false);
  assert.equal(run.events.includes("STOP"), true);
  assert.equal(run.events.includes("BEGIN"), false);
  assert.equal(run.events.includes("POPUP_ENABLE"), true);
});

test("recording crop scales selected CSS coordinates to actual captured video pixels", async () => {
  const engine = await offscreen();
  engine.setVideo({ videoWidth: 1920, videoHeight: 1080 });
  engine.setState({ settings: { region: { x: 100, y: 50, width: 200, height: 120, viewportWidth: 1280, viewportHeight: 720 } } });
  assert.deepEqual({ ...engine.sourceCrop() }, { x: 150, y: 75, width: 300, height: 180 });
  engine.setState({ settings: {} });
  assert.deepEqual({ ...engine.sourceCrop() }, { x: 0, y: 0, width: 1920, height: 1080 });
});

test("auto-stop changes cannot mutate a stopped recorder and preserve other active settings", async () => {
  const engine = await offscreen();
  engine.setState({ status: "idle", settings: { source: "camera" } });
  assert.throws(() => engine.setAutoStop(10), /keine Aufnahme/);
  engine.setRecorder({ state: "paused" });
  engine.setState({ status: "paused", settings: { source: "camera", microphone: false } });
  const result = engine.setAutoStop(150);
  assert.equal(result.state.settings.source, "camera");
  assert.equal(result.state.settings.microphone, false);
  assert.equal(result.state.settings.autoStopSeconds, 150);
});

test("live auto-stop API preserves a paused capture and rejects out-of-range updates", async () => {
  const run = await background({ status: "paused", engineContext: "controls", sourceMode: "camera", settings: { source: "camera" } });
  const result = await run.api("SET_AUTO_STOP", { seconds: 150 });
  assert.equal(result.state.status, "paused");
  assert.equal(result.state.settings.autoStopSeconds, 150);
  for (const seconds of [-1, 21601, Infinity, "invalid"]) await assert.rejects(run.api("SET_AUTO_STOP", { seconds }), /Dauer/);
  const idle = await background();
  await assert.rejects(idle.api("SET_AUTO_STOP", { seconds: 150 }), /keine Aufnahme/);
});

test("camera-only sessions reject page drawing rather than injecting unrelated tabs", async () => {
  const run = await background({ status: "recording", engineContext: "controls", sourceMode: "camera" });
  await assert.rejects(run.api("SET_RECORDING_ANNOTATION", { mode: "pen" }), /Kameraaufnahme/);
});

test("a source viewport change pauses custom-region capture and prevents unsafe resume", async () => {
  const run = await background();
  await run.start({ source: "tab", regionCapture: true, controlBar: false });
  const page = { id: ID, url: "https://fixture.test/", tab: { id: 1 }, frameId: 0 };
  await run.api("REGION_VIEWPORT_CHANGED", { width: 900, height: 600 }, { ...page, tab: { id: 9 } });
  assert.equal(run.state().status, "recording");
  await run.api("REGION_VIEWPORT_CHANGED", { width: 800, height: 600 }, page);
  assert.equal(run.state().status, "recording");
  await run.api("REGION_VIEWPORT_CHANGED", { width: 900, height: 600 }, page);
  assert.equal(run.state().status, "paused");
  assert.equal(run.state().regionInvalid, true);
  await assert.rejects(run.api("RESUME_RECORDING"), /Seitengröße/);
  assert.equal(run.events.includes("RESUME"), false);
});
