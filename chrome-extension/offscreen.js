import { ExtensionStore, finalizeWebm, normalizeOptions, normalizeRegion, recordingMimeType } from "./capture-core.js";

const controlsFrame = typeof location !== "undefined" && location.href === chrome.runtime.getURL("controls.html");
const engineTarget = controlsFrame ? "capture-controls" : "offscreen";
const sourceEndedBeforeStart = "Die Bildschirmfreigabe wurde vor dem Aufnahmestart beendet. Starte eine neue Aufnahme.";
let controlsFrameTabId;
if (controlsFrame) chrome.tabs.getCurrent().then(tab => { controlsFrameTabId = tab?.id; });
let state = { status: "idle", elapsedMs: 0, startedAt: 0 };
let source, microphone, camera, sourceVideo, cameraVideo, audioContext, canvas, drawTimer;
let regionPreview, captureRegionDimensions;
let recorder, preparingCapture, stopPromise, signalRecorderStopped, stopTimer, pickerRequest, autoStopTimer;
let writes = Promise.resolve(), storageError;
const urls = new Map();
const notify = () => chrome.runtime.sendMessage({ target: "background", type: controlsFrame ? "CONTROL_CAPTURE_STATE" : "OFFSCREEN_STATE",
  ...(controlsFrame ? { controllerTabId: controlsFrameTabId } : {}), state: publicState() }).catch(() => {});
function change(patch) { state = { ...state, ...patch }; notify(); return state; }
function videoFor(stream) {
  const video = document.createElement("video");
  video.muted = true; video.autoplay = true; video.playsInline = true;
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = "position:fixed;left:-10000px;width:1px;height:1px;opacity:0;pointer-events:none";
  video.srcObject = stream; document.body.append(video);
  return video;
}
async function acquireMedia(constraints, kind = "source", signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let finished = false;
    const settle = (callback, value) => {
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      callback(value);
    };
    const cancel = () => settle(reject, signal.reason);
    const timer = setTimeout(() => settle(reject, new Error("Chrome konnte die Quelle nicht öffnen. Wähle sie erneut aus.")), 20000);
    signal?.addEventListener("abort", cancel, { once: true });
    navigator.mediaDevices.getUserMedia(constraints).then(stream => {
      if (finished) { for (const track of stream.getTracks()) track.stop(); return; }
      settle(resolve, stream);
    }, error => {
      if (finished) return;
      const labels = { microphone: "Mikrofon", camera: "Kamera", source: "Bildschirmfreigabe" };
      if (["NotAllowedError", "PermissionDeniedError"].includes(error.name)) {
        error = new Error(kind === "source"
          ? "Chrome darf die Quelle nicht aufnehmen. Erlaube Chrome in den macOS-Systemeinstellungen unter Datenschutz & Sicherheit bei Bildschirmaufnahme und versuche es erneut."
          : `Der Zugriff auf ${labels[kind]} wurde nicht erlaubt. Erlaube den Zugriff in Chrome und den Systemeinstellungen oder schalte ${labels[kind]} aus.`);
      } else if (error.name === "NotFoundError") error = new Error(`${labels[kind]} wurde nicht gefunden. Prüfe das Gerät oder schalte es aus.`);
      settle(reject, error);
    });
  });
}
function captureSourceMode(stream) {
  const surface = stream?.getVideoTracks()[0]?.getSettings?.().displaySurface;
  return { browser: "tab", window: "window", monitor: "screen" }[surface] || "screen";
}
function selectSource(input = {}) {
  if (!controlsFrame) throw new Error("Die Quelle muss im sichtbaren Aufnahmefenster ausgewählt werden.");
  const options = normalizeOptions(input.options || input);
  if (!['tab', 'window', 'screen'].includes((input.options || input).source)) throw new Error("Wähle zuerst eine Aufnahmequelle aus.");
  if (recorder || ['selecting', 'preparing'].includes(state.status)) throw new Error("Eine Aufnahme wird bereits vorbereitet.");
  if (!navigator.userActivation?.isActive) throw new Error("Öffne die Chrome-Freigabe über die Schaltfläche im Aufnahmefenster.");
  change({ status: 'selecting', sourceMode: options.source, elapsedMs: 0, startedAt: 0, recordingId: null, error: '', warning: '', notice: '', sourceReady: false });
  // Call before any await: Chrome requires this exact foreground click's activation.
  const selection = navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: { tab: 'browser', window: 'window', screen: 'monitor' }[options.source], frameRate: { ideal: options.frameRate } },
    audio: options.systemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
  });
  const heartbeat = setInterval(() => chrome.runtime.sendMessage({ target: 'background', type: 'CAPTURE_HEARTBEAT', controllerTabId: controlsFrameTabId }).catch(() => {}), 15000);
  return selection.then(stream => prepare({ options, stream }), error => {
    stopStreams();
    if (error.name === 'NotAllowedError' && /system|systemseitig|betriebssystem/i.test(error.message)) {
      const denied = new Error('Chrome darf den Bildschirm nicht aufnehmen. Erlaube Chrome in den macOS-Systemeinstellungen unter Datenschutz & Sicherheit bei Bildschirmaufnahme und versuche es erneut.');
      change({ status: 'error', sourceReady: false, error: denied.message }); throw denied;
    }
    if (error.name === 'NotReadableError') {
      const unreadable = new Error('Die gewählte Quelle konnte nicht geöffnet werden. Prüfe die Bildschirmaufnahme-Berechtigung für Chrome und wähle die Quelle erneut.');
      change({ status: 'error', sourceReady: false, error: unreadable.message }); throw unreadable;
    }
    if (['NotAllowedError', 'AbortError'].includes(error.name)) {
      change({ status: 'idle', sourceReady: false, error: '', notice: 'Auswahl abgebrochen. Öffne die Chrome-Freigabe, um es erneut zu versuchen.' });
      return { cancelled: true, state: publicState() };
    }
    change({ status: 'error', sourceReady: false, error: error.message }); throw error;
  }).finally(() => clearInterval(heartbeat));
}
async function playable(video, signal) {
  await waitForSource(() => video.play(), signal);
  if (video.readyState >= 2) return;
  let loaded, failed, timer;
  try {
    await waitForSource(() => new Promise((resolve, reject) => {
      loaded = resolve;
      failed = () => reject(new Error("Chrome konnte die ausgewählte Quelle nicht öffnen."));
      timer = setTimeout(() => reject(new Error("Die ausgewählte Quelle liefert kein Bild.")), 10000);
      video.addEventListener("loadeddata", loaded, { once: true });
      video.addEventListener("error", failed, { once: true });
    }), signal);
  } finally {
    clearTimeout(timer);
    if (loaded) video.removeEventListener("loadeddata", loaded);
    if (failed) video.removeEventListener("error", failed);
  }
}
async function waitForSource(operation, signal) {
  if (!signal) return operation();
  signal.throwIfAborted();
  let cancel;
  try {
    return await Promise.race([
      new Promise((_resolve, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
      }),
      operation(),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
// Fail closed: a hidden controller is not enough if capture still contains old frames.
async function freshFrames(count = 3, signal) {
  // Offscreen documents need not composite a visible <video>. Consume fresh
  // frames directly when Chrome exposes its track processor in this context.
  const sourceTrack = source?.getVideoTracks()[0];
  if (sourceTrack && typeof globalThis.MediaStreamTrackProcessor === "function") {
    const clone = sourceTrack.clone();
    let reader, timer;
    try {
      reader = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 1 }).readable.getReader();
      await waitForSource(() => Promise.race([
        (async () => {
          for (let index = 0; index < count; index++) {
            const { value, done } = await reader.read();
            if (done || !value) throw new Error("The selected capture source ended before recording could start");
            value.close();
          }
        })(),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Capture is not updating. Recording stayed stopped so the controls cannot appear in it.")), 10000); }),
      ]), signal);
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {}); clone.stop();
    }
    return;
  }
  if (!sourceVideo?.requestVideoFrameCallback) throw new Error("This Chrome version cannot verify fresh capture frames");
  const video = sourceVideo;
  let callback, timer;
  try {
    await waitForSource(() => new Promise((resolve, reject) => {
      let remaining = count;
      const next = () => {
        if (--remaining === 0) resolve();
        else callback = video.requestVideoFrameCallback(next);
      };
      timer = setTimeout(() => reject(new Error("Capture is not updating. Recording stayed stopped so the controls cannot appear in it.")), 10000);
      callback = video.requestVideoFrameCallback(next);
    }), signal);
  } finally {
    clearTimeout(timer);
    if (callback !== undefined) video.cancelVideoFrameCallback?.(callback);
  }
}
function elapsed() { return state.elapsedMs + (state.status === "recording" ? Date.now() - state.startedAt : 0); }
function stopStreams(output) {
  clearInterval(autoStopTimer); autoStopTimer = null;
  clearTimeout(drawTimer); drawTimer = null;
  for (const stream of [source, microphone, camera, output]) for (const track of stream?.getTracks() || []) track.stop();
  silentAudioSource?.stop(); silentAudioSource?.disconnect(); silentAudioGain?.disconnect();
  silentAudioSource = silentAudioGain = null;
  sourceRecordingGain?.disconnect();
  sourceRecordingGain = null;
  microphoneNode?.disconnect(); microphoneNode = null; audioDestination = null;
  source = microphone = camera = null;
  for (const video of [sourceVideo, cameraVideo]) { if (video) { video.srcObject = null; video.remove(); } }
  sourceVideo = cameraVideo = null;
  regionPreview = captureRegionDimensions = null;
  audioContext?.close().catch(() => {}); audioContext = null; canvas = null;
  mixedAudio = null;
}
function cancelPreparation(attempt, error) {
  if (preparingCapture !== attempt) return;
  preparingCapture = null;
  attempt.abort(error || new Error("Die Aufnahme wurde vor dem Start abgebrochen."));
  stopStreams();
  change({ status: error ? "error" : "idle", sourceReady: false, error: error?.message || "" });
}
async function prepare(message) {
  if (recorder || state.status === "preparing") throw new Error("A recording is already in progress");
  stopStreams(); storageError = null; stopPromise = null; writes = Promise.resolve();
  const attempt = new AbortController(), { signal } = attempt;
  preparingCapture = attempt;
  const options = normalizeOptions(message.options);
  change({ status: "preparing", sourceMode: options.source, settings: options, name: options.name,
    elapsedMs: 0, startedAt: 0, recordingId: null, error: "", warning: "" });
  try {
    if (options.source === "camera") {
      const cameraHeight = options.resolution === "source" ? 1080 : options.resolution;
      source = await acquireMedia({ audio: false, video: { width: { ideal: Math.round(cameraHeight * 16 / 9) }, height: { ideal: cameraHeight }, aspectRatio: { ideal: 16 / 9 },
        ...(options.cameraDeviceId ? { deviceId: { exact: options.cameraDeviceId } } : {}) } }, "camera", signal);
    } else if (message.streamId && controlsFrame) {
      const desktop = { chromeMediaSource: message.tabStream ? "tab" : "desktop", chromeMediaSourceId: message.streamId };
      if (message.tabStream && options.region) {
        const height = options.resolution === "source" ? options.region.viewportHeight : Math.min(options.region.viewportHeight, options.resolution);
        Object.assign(desktop, { minWidth: Math.round(height * options.region.viewportWidth / options.region.viewportHeight),
          maxWidth: Math.round(height * options.region.viewportWidth / options.region.viewportHeight), minHeight: Math.round(height), maxHeight: Math.round(height) });
      }
      source = await acquireMedia({
        video: { mandatory: desktop },
        audio: options.systemAudio && message.canRequestAudioTrack ? { mandatory: desktop } : false,
      }, "source", signal);
    } else {
      if (!message.stream?.getVideoTracks()[0]) throw new Error("Wähle zuerst eine Quelle im Chrome-Freigabefenster aus.");
      source = message.stream;
    }
    const selected = source, track = selected.getVideoTracks()[0];
    if (!track || track.readyState !== "live") throw new Error(sourceEndedBeforeStart);
    track.addEventListener("ended", () => {
      if (source !== selected) return;
      if (recorder) finish().catch(() => {});
      else cancelPreparation(attempt, new Error(sourceEndedBeforeStart));
    }, { once: true });
    const sourceMode = options.source === "camera" ? "camera" : message.tabStream ? "tab" : captureSourceMode(source);
    // The standard chooser may return any surface. Safety follows the actual
    // selected track, including a conservative screen fallback for unknown types.
    change({ sourceMode, settings: { ...options, source: sourceMode } });
    // Legacy desktop-token constraints otherwise leave captured tabs at
    // Chrome's generic800px camera default. Ask the capture track for its
    // requested detail before creating a recorder; never upscale a small canvas.
    const requestedHeight = options.resolution === "source" ? 4320 : options.resolution;
    const tabHeight = message.tabStream && options.region ? Math.min(options.region.viewportHeight, requestedHeight) : null;
    const requestedWidth = tabHeight ? Math.round(tabHeight * options.region.viewportWidth / options.region.viewportHeight)
      : options.source === "camera" ? Math.round((options.resolution === "source" ? 1080 : requestedHeight) * 16 / 9) : 7680;
    await waitForSource(() => track.applyConstraints({
      width: { ideal: requestedWidth, max: requestedWidth },
      height: { ideal: tabHeight || (options.source === "camera" && options.resolution === "source" ? 1080 : requestedHeight), max: tabHeight || requestedHeight },
      frameRate: { ideal: options.frameRate, max: options.frameRate },
    }).catch(() => {}), signal);
    sourceVideo = videoFor(source); await playable(sourceVideo, signal);
    if (options.region && Math.abs(sourceVideo.videoWidth / sourceVideo.videoHeight - options.region.viewportWidth / options.region.viewportHeight) > .03)
      throw new Error("Chrome hat die Tab-Größe verändert. Wähle den Aufnahmebereich erneut.");
    if (options.microphone) microphone = await acquireMedia({ audio: { echoCancellation: true, noiseSuppression: true, ...(options.microphoneDeviceId ? { deviceId: { exact: options.microphoneDeviceId } } : {}) }, video: false }, "microphone", signal);
    if (options.camera && options.source !== "camera") {
      camera = await acquireMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 360 },
        ...(options.cameraDeviceId ? { deviceId: { exact: options.cameraDeviceId } } : {}) } }, "camera", signal);
      cameraVideo = videoFor(camera); await playable(cameraVideo, signal);
    }
    // Keep one audio output track for the whole recording, even when initially
    // silent, so live microphone changes never replace a MediaRecorder track.
    audioContext = new AudioContext(); await waitForSource(() => audioContext.resume(), signal);
    audioDestination = audioContext.createMediaStreamDestination();
    // An unconnected destination may never emit samples, which can prevent
    // MediaRecorder from producing video when both input sources start off.
    silentAudioSource = audioContext.createConstantSource();
    silentAudioGain = audioContext.createGain(); silentAudioGain.gain.value = 0;
    silentAudioSource.connect(silentAudioGain); silentAudioGain.connect(audioDestination);
    silentAudioSource.start();
    if (source.getAudioTracks().length) {
      const node = audioContext.createMediaStreamSource(new MediaStream(source.getAudioTracks()));
      if (message.tabStream) {
        // tabCapture suppresses the original playback. Keep listening possible
        // and route recording through its own switch so the call stays audible.
        sourceRecordingGain = audioContext.createGain();
        node.connect(audioContext.destination);
        node.connect(sourceRecordingGain);
        sourceRecordingGain.connect(audioDestination);
      } else node.connect(audioDestination);
    }
    if (microphone) {
      microphoneNode = audioContext.createMediaStreamSource(microphone);
      microphoneNode.connect(audioDestination);
    }
    mixedAudio = audioDestination.stream;
    const warning = options.systemAudio && !source.getAudioTracks().length
      ? "Für diese Quelle stellt Chrome keinen Quellton bereit. Die Mikrofoneinstellung gilt unabhängig davon." : "";
    // Do not put MediaStream objects into extension messages or session storage.
    change({ warning, sourceReady: true, sourceTitle: track.label || "" });
    return { state: publicState() };
  } catch (error) { cancelPreparation(attempt, error); throw error; }
}
let mixedAudio, microphoneNode, audioDestination, silentAudioSource, silentAudioGain, sourceRecordingGain;
async function prepareRegionPreview() {
  const attempt = preparingCapture;
  if (!attempt || !state.sourceReady || !state.settings?.regionCapture)
    throw new Error("Wähle zuerst ein Fenster oder einen Bildschirm.");
  await freshFrames(2, attempt.signal);
  const width = sourceVideo.videoWidth, height = sourceVideo.videoHeight;
  if (!width || !height) throw new Error("Die ausgewählte Quelle liefert kein Bild.");
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const preview = document.createElement("canvas");
  preview.width = Math.max(1, Math.round(width * scale));
  preview.height = Math.max(1, Math.round(height * scale));
  preview.getContext("2d").drawImage(sourceVideo, 0, 0, preview.width, preview.height);
  // This one frame stays in the controls page. It is never sent to the
  // worker, stored in browser state or captured by MediaRecorder.
  regionPreview = { dataUrl: preview.toDataURL("image/jpeg", 0.86), width, height };
  return {};
}
function setCaptureRegion(input) {
  const region = normalizeRegion(input);
  if (!preparingCapture || !regionPreview || !region || region.viewportWidth !== regionPreview.width || region.viewportHeight !== regionPreview.height)
    throw new Error("Wähle einen gültigen Ausschnitt in der Vorschau.");
  if (region.viewportWidth !== sourceVideo.videoWidth || region.viewportHeight !== sourceVideo.videoHeight)
    throw new Error("Die Quelle hat ihre Größe geändert. Brich ab und wähle den Ausschnitt erneut.");
  captureRegionDimensions = { width: region.viewportWidth, height: region.viewportHeight };
  change({ settings: { ...state.settings, region } });
  return { state: publicState() };
}
function regionGeometryMatches() {
  return !captureRegionDimensions || (sourceVideo.videoWidth === captureRegionDimensions.width && sourceVideo.videoHeight === captureRegionDimensions.height);
}
function sourceCrop() {
  const region = state.settings?.region;
  if (!region || !sourceVideo) return { x: 0, y: 0, width: sourceVideo?.videoWidth || 0, height: sourceVideo?.videoHeight || 0 };
  const scaleX = sourceVideo.videoWidth / region.viewportWidth, scaleY = sourceVideo.videoHeight / region.viewportHeight;
  return { x: Math.max(0, region.x * scaleX), y: Math.max(0, region.y * scaleY),
    width: Math.min(sourceVideo.videoWidth - region.x * scaleX, region.width * scaleX),
    height: Math.min(sourceVideo.videoHeight - region.y * scaleY, region.height * scaleY) };
}
function renderFrame() {
  if (!canvas || !sourceVideo) return;
  if (!regionGeometryMatches()) {
    change({ notice: "Die Quelle hat ihre Größe geändert. Die Aufnahme wurde beendet." });
    finish().catch(() => {});
    return;
  }
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#000"; context.fillRect(0, 0, canvas.width, canvas.height);
  const crop = sourceCrop();
  context.drawImage(sourceVideo, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  if (cameraVideo?.readyState >= 2) {
    const width = Math.round(canvas.width * 0.22), height = Math.round(width * cameraVideo.videoHeight / cameraVideo.videoWidth);
    const margin = Math.max(12, Math.round(canvas.width * 0.015)), position = state.settings.cameraPosition;
    const x = position.endsWith("right") ? canvas.width - width - margin : margin;
    const y = position.startsWith("bottom") ? canvas.height - height - margin : margin;
    context.save(); context.beginPath(); context.roundRect(x, y, width, height, Math.min(16, height / 8)); context.clip();
    context.drawImage(cameraVideo, x, y, width, height); context.restore();
  }
  drawTimer = setTimeout(renderFrame, 1000 / state.settings.frameRate);
}
async function begin() {
  const attempt = preparingCapture;
  if (state.status !== "preparing" || !sourceVideo || !attempt)
    throw new Error(state.error || "Wähle zuerst eine verfügbare Quelle aus.");
  const { signal } = attempt, track = source.getVideoTracks()[0];
  regionPreview = null;
  let record;
  try {
    const frames = state.sourceMode === "tab" ? 1 : 3;
    await freshFrames(frames, signal);
    if (state.settings.countdown) {
      let timer;
      try {
        await waitForSource(() => new Promise(resolve => { timer = setTimeout(resolve, state.settings.countdown * 1000); }), signal);
      } finally { clearTimeout(timer); }
    }
    await freshFrames(frames, signal);
    if (!regionGeometryMatches()) throw new Error("Die Quelle hat ihre Größe geändert. Wähle den Ausschnitt erneut.");
    const crop = sourceCrop();
    if (!(crop.width >= 2 && crop.height >= 2)) throw new Error("Der gewählte Aufnahmebereich ist nicht mehr verfügbar.");
    const height = state.settings.resolution === "source" ? crop.height : Math.min(crop.height, state.settings.resolution);
    const width = Math.max(2, Math.round(crop.width * height / crop.height / 2) * 2);
    if (width * height > 33554432) throw new Error("Wähle eine niedrigere Aufnahmeauflösung.");
    let videoTrack = track;
    if (state.settings.region || (state.settings.camera && state.sourceMode !== "camera") || height < sourceVideo.videoHeight) {
      canvas = document.createElement("canvas"); canvas.width = width; canvas.height = Math.max(2, Math.round(height / 2) * 2);
      renderFrame(); videoTrack = canvas.captureStream(state.settings.frameRate).getVideoTracks()[0];
    }
    const output = new MediaStream([videoTrack, ...(mixedAudio?.getAudioTracks() || [])]);
    const selectedMimeType = recordingMimeType(state.settings.format);
    const createdRecorder = new MediaRecorder(output, { mimeType: selectedMimeType, videoBitsPerSecond: state.settings.bitrate, audioBitsPerSecond: 128000 });
    const mimeType = createdRecorder.mimeType || selectedMimeType;
    record = await ExtensionStore.begin({ name: state.name, kind: "video", mimeType,
      width: canvas?.width || sourceVideo.videoWidth, height: canvas?.height || sourceVideo.videoHeight,
      durationMs: 0, sourceMode: state.sourceMode, saveDestination: state.settings.saveDestination,
      hasMicrophone: Boolean(microphone), hasDisplayAudio: source.getAudioTracks().length > 0 });
    signal.throwIfAborted();
    if (track.readyState !== "live") throw new Error(sourceEndedBeforeStart);
    let bytesWritten = 0;
    createdRecorder.ondataavailable = event => {
      if (!event.data.size || recorder !== createdRecorder) return;
      writes = writes.then(async () => {
        await ExtensionStore.append(record.id, event.data);
        bytesWritten += event.data.size;
      }).catch(error => {
        storageError ||= error;
        finish().catch(() => {});
      });
    };
    createdRecorder.onerror = event => {
      if (recorder !== createdRecorder) return;
      storageError ||= event.error || new Error("Die Aufnahme wurde unterbrochen.");
      finish().catch(() => {});
    };
    const stopped = new Promise(resolve => {
      signalRecorderStopped = resolve;
      createdRecorder.onstop = resolve;
    });
    createdRecorder.start(1000);
    recorder = createdRecorder;
    preparingCapture = null;
    stopPromise = stopped.then(async () => {
      clearTimeout(stopTimer); stopTimer = null;
      markStopping();
      createdRecorder.ondataavailable = null;
      await writes;
      return complete(record, bytesWritten);
    });
    // Source ending may finish without any caller waiting for a STOP response.
    stopPromise.catch(error => change({ status: "error", error: error.message }));
    change({ status: "recording", recordingId: record.id, startedAt: Date.now(), elapsedMs: 0 });
    autoStopTimer = setInterval(() => {
      if (state.status === "recording" && state.settings.autoStopSeconds > 0 && elapsed() >= state.settings.autoStopSeconds * 1000)
        finish().catch(() => {});
    }, 250);
    return { state: publicState() };
  } catch (error) {
    if (record) await ExtensionStore.update(record.id, { status: "interrupted", error: error.message }).catch(() => {});
    cancelPreparation(attempt, error);
    throw error;
  }
}
function setAutoStop(seconds) {
  requireActiveAudio();
  const autoStopSeconds = normalizeOptions({ autoStopSeconds: seconds }).autoStopSeconds;
  change({ settings: { ...state.settings, autoStopSeconds } });
  return { state: publicState() };
}
function audioTracks(stream) { return (stream?.getAudioTracks?.() || []).filter(track => track.readyState !== "ended"); }
function publicState() {
  const { audioStream, ...value } = state;
  const voice = audioTracks(microphone), display = audioTracks(source);
  return { ...value, microphoneAvailable: voice.length > 0, microphoneMuted: !voice.some(track => track.enabled),
    sourceAudioAvailable: display.length > 0, sourceAudioMuted: !display.some(track => track.enabled) || sourceRecordingGain?.gain.value === 0,
    microphoneDeviceId: voice[0]?.getSettings?.().deviceId || state.settings?.microphoneDeviceId || '' };
}
function requireActiveAudio() {
  if (!['recording', 'paused'].includes(state.status) || !['recording', 'paused'].includes(recorder?.state))
    throw new Error('Es läuft keine Aufnahme.');
}
let microphoneChange, microphoneMuteRevision = 0, sourceMuteRevision = 0;
async function setMicrophoneDevice(deviceId = '') {
  requireActiveAudio();
  if (typeof deviceId !== 'string' || deviceId.length > 256) throw new Error('Ungültiges Mikrofon.');
  if (microphoneChange) throw new Error('Das Mikrofon wird gerade gewechselt.');
  const activeRecorder = recorder, destination = audioDestination, mixer = audioContext;
  const previousTracks = audioTracks(microphone);
  const initiallyEnabled = previousTracks.length ? previousTracks.some(track => track.enabled) : true;
  const muteRevision = microphoneMuteRevision;
  const switching = (async () => {
    const replacement = await acquireMedia({ audio: { echoCancellation: true, noiseSuppression: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false }, 'microphone');
    let node;
    try {
      if (recorder !== activeRecorder || !['recording', 'paused'].includes(state.status) ||
          destination !== audioDestination || !destination) throw new Error('Die Aufnahme wurde beendet.');
      const enabled = microphoneMuteRevision === muteRevision ? initiallyEnabled : state.settings?.microphone === true;
      for (const track of replacement.getAudioTracks()) track.enabled = enabled;
      node = mixer.createMediaStreamSource(replacement); node.connect(destination);
    } catch (error) {
      node?.disconnect(); for (const track of replacement.getTracks()) track.stop(); throw error;
    }
    const old = microphone, oldNode = microphoneNode;
    microphone = replacement; microphoneNode = node;
    oldNode?.disconnect(); for (const track of old?.getTracks() || []) track.stop();
    change({ settings: { ...state.settings, microphone: replacement.getAudioTracks().some(track => track.enabled), microphoneDeviceId: deviceId } });
    return { state: publicState() };
  })();
  microphoneChange = switching;
  try { return await switching; }
  finally { if (microphoneChange === switching) microphoneChange = null; }
}
async function audioDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return { devices: devices.filter(device => device.kind === 'audioinput').map(device => ({
    deviceId: device.deviceId, label: device.label || 'Mikrofon',
  })), cameras: devices.filter(device => device.kind === 'videoinput').map(device => ({
    deviceId: device.deviceId, label: device.label || 'Kamera',
  })), microphoneDeviceId: publicState().microphoneDeviceId,
    cameraDeviceId: camera?.getVideoTracks()[0]?.getSettings?.().deviceId || state.settings?.cameraDeviceId || '' };
}
async function setAudioState(message) {
  requireActiveAudio();
  const requested = ['microphoneEnabled', 'sourceAudioEnabled'].filter(key => Object.hasOwn(message, key));
  if (!requested.length || requested.some(key => typeof message[key] !== 'boolean')) throw new Error('Ungültige Toneinstellung.');
  if (Object.hasOwn(message, 'sourceAudioEnabled') && !audioTracks(source).length)
    throw new Error('Für diese Quelle ist kein Quellton freigegeben.');
  const activeRecorder = recorder;
  const microphoneRevision = Object.hasOwn(message, 'microphoneEnabled') ? ++microphoneMuteRevision : microphoneMuteRevision;
  const sourceRevision = Object.hasOwn(message, 'sourceAudioEnabled') ? ++sourceMuteRevision : sourceMuteRevision;
  const previousMicrophone = state.settings?.microphone;
  if (Object.hasOwn(message, 'microphoneEnabled')) state.settings = { ...state.settings, microphone: message.microphoneEnabled };
  try {
    if (message.microphoneEnabled === true && !audioTracks(microphone).length)
      await setMicrophoneDevice(state.settings?.microphoneDeviceId || '');
  } catch (error) {
    if (recorder === activeRecorder && microphoneMuteRevision === microphoneRevision)
      change({ settings: { ...state.settings, microphone: previousMicrophone } });
    throw error;
  }
  requireActiveAudio();
  if (Object.hasOwn(message, 'microphoneEnabled') && microphoneMuteRevision === microphoneRevision) {
    for (const track of audioTracks(microphone)) track.enabled = message.microphoneEnabled;
    state.settings = { ...state.settings, microphone: message.microphoneEnabled };
  }
  if (Object.hasOwn(message, 'sourceAudioEnabled') && sourceMuteRevision === sourceRevision) {
    if (sourceRecordingGain) sourceRecordingGain.gain.value = Number(message.sourceAudioEnabled);
    else for (const track of audioTracks(source)) track.enabled = message.sourceAudioEnabled;
  }
  change({}); return { state: publicState() };
}
async function mediaEvent(type, operation) {
  const active = recorder;
  let handler, timer;
  const acknowledged = new Promise((resolve, reject) => {
    handler = resolve;
    timer = setTimeout(() => reject(new Error(`The recorder did not ${type}; controls stayed hidden`)), 5000);
    active.addEventListener(type, handler, { once: true });
    operation();
  });
  try { await (stopPromise ? Promise.race([acknowledged, stopPromise]) : acknowledged); }
  finally {
    clearTimeout(timer);
    active.removeEventListener?.(type, handler);
  }
}
async function pause() {
  if (recorder?.state === "paused") return { state: publicState() };
  if (recorder?.state !== "recording") throw new Error("No recording is running");
  const activeRecorder = recorder;
  const total = elapsed();
  await mediaEvent("pause", () => recorder.pause());
  if (recorder === activeRecorder && activeRecorder.state !== "inactive" && state.status === "recording")
    change({ status: "paused", elapsedMs: total, startedAt: 0 });
  return { state: publicState() };
}
async function resume() {
  if (recorder?.state !== "paused") throw new Error("Recording is not paused");
  const activeRecorder = recorder;
  await freshFrames(state.sourceMode === "tab" ? 1 : 3);
  if (recorder !== activeRecorder || state.status !== "paused") return { state: publicState() };
  await mediaEvent("resume", () => recorder.resume());
  if (recorder === activeRecorder && activeRecorder.state !== "inactive" && state.status === "paused")
    change({ status: "recording", startedAt: Date.now() });
  return { state: publicState() };
}
function markStopping() {
  if (state.status !== "stopping") change({ status: "stopping", elapsedMs: elapsed(), startedAt: 0 });
}
async function complete(record, bytesWritten) {
  let saved;
  let error = !bytesWritten ? "Chrome hat keine Videodaten gespeichert. Starte die Aufnahme erneut." : "";
  if (storageError && bytesWritten) error = "Die Aufnahme wurde unterbrochen. Die gespeicherten Teile findest du unter „Aufnahmen in Chrome“.";
  try {
    saved = await ExtensionStore.update(record.id, { durationMs: state.elapsedMs, status: error ? "interrupted" : "finished", error });
    if (!saved) throw new Error("Aufnahme fehlt");
  } catch {
    error = "Die Aufnahme konnte nicht abgeschlossen werden. Bereits gespeicherte Teile findest du unter „Aufnahmen in Chrome“.";
  } finally {
    const output = recorder?.stream;
    recorder = null;
    stopStreams(output);
  }
  change({ status: error ? "error" : "idle", recordingId: record.id, sourceReady: false, error });
  const result = { recording: saved, state: publicState() };
  if (saved) chrome.runtime.sendMessage({ target: "background", type: "RECORDING_FINISHED",
    ...(controlsFrame ? { controllerTabId: controlsFrameTabId } : {}), ...result }).catch(() => {});
  return result;
}
async function finish() {
  clearInterval(autoStopTimer); autoStopTimer = null;
  if (!recorder) {
    if (stopPromise) return stopPromise;
    if (pickerRequest !== undefined) { chrome.desktopCapture.cancelChooseDesktopMedia(pickerRequest); pickerRequest = undefined; }
    if (preparingCapture) cancelPreparation(preparingCapture);
    else if (state.status === "selecting") change({ status: "idle", sourceReady: false });
    return { state: publicState() };
  }
  if (state.status !== "stopping") {
    markStopping();
    stopTimer = setTimeout(() => {
      storageError ||= new Error("Chrome hat die Beendigung der Aufnahme nicht bestätigt.");
      signalRecorderStopped();
    }, 8000);
    if (recorder.state !== "inactive") {
      try { recorder.stop(); }
      catch (error) { storageError ||= error; signalRecorderStopped(); }
    }
  }
  return stopPromise;
}
async function image(message) {
  let blob, width, height;
  if (message.tiles) {
    const first = await createImageBitmap(await (await fetch(message.tiles[0].dataUrl)).blob());
    const scale = first.height / message.viewportHeight;
    const horizontalScale = first.width / message.viewportWidth;
    if (Math.abs(horizontalScale - scale) > Math.max(horizontalScale, scale) * 0.03) {
      first.close();
      throw new Error("The capture size does not match the page viewport. Use a normal Chrome window without device emulation and try again.");
    }
    width = first.width; height = Math.round(message.totalHeight * scale);
    if (width * height > 64000000 || height > 32760) throw new Error("This page is too large for one image. Capture a smaller section.");
    const output = new OffscreenCanvas(width, height), context = output.getContext("2d");
    for (let i = 0; i < message.tiles.length; i++) {
      const tile = i === 0 ? first : await createImageBitmap(await (await fetch(message.tiles[i].dataUrl)).blob());
      const y = Math.round(message.tiles[i].y * scale);
      context.drawImage(tile, 0, y); tile.close();
    }
    blob = await output.convertToBlob({ type: "image/png" });
  } else {
    blob = message.blob || await (await fetch(message.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob); width = bitmap.width; height = bitmap.height;
    if (message.rect) {
      const scale = width / message.viewportWidth;
      const rect = message.rect;
      const x = Math.max(0, Math.round(rect.x * scale)), y = Math.max(0, Math.round(rect.y * scale));
      width = Math.min(width - x, Math.round(rect.width * scale)); height = Math.min(height - y, Math.round(rect.height * scale));
      if (width < 1 || height < 1) throw new Error("Select a valid screenshot section");
      const output = new OffscreenCanvas(width, height); output.getContext("2d").drawImage(bitmap, x, y, width, height, 0, 0, width, height);
      blob = await output.convertToBlob({ type: "image/png" });
    }
    bitmap.close();
  }
  const preferences = message.preferences || {};
  const type = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[preferences.screenshotFormat] || "image/png";
  const scale = preferences.retinaScale && Number(message.devicePixelRatio || globalThis.devicePixelRatio || 1) > 1 ? .5 : 1;
  if (scale !== 1 || preferences.addDateUrl || type !== "image/png") {
    const bitmap = await createImageBitmap(blob);
    width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale));
    const header = preferences.addDateUrl ? 48 : 0;
    const output = new OffscreenCanvas(width, height + header), context = output.getContext("2d");
    context.fillStyle = "#fff"; context.fillRect(0, 0, width, height + header);
    context.drawImage(bitmap, 0, header, width, height); bitmap.close();
    if (header) {
      const now = new Date();
      const locale = { dmy: "de-DE", mdy: "en-US", ymd: "sv-SE" }[preferences.dateFormat] || "de-DE";
      context.fillStyle = "#263142"; context.font = "12px sans-serif";
      context.fillText(now.toLocaleDateString(locale) + " · " + now.toLocaleTimeString(locale, { hour12: preferences.timeFormat === "12" }), 12, 18, width - 24);
      context.fillStyle = "#687386"; context.fillText(String(message.sourceUrl || message.sourceTitle || "Screenshot"), 12, 36, width - 24);
    }
    height += header;
    blob = await output.convertToBlob({ type, quality: .94 });
  }
  const saved = await ExtensionStore.putBlob({ name: message.name || "Screenshot", kind: "image", mimeType: blob.type || type, width, height, durationMs: 0,
    sourceUrl: message.sourceUrl, captureMode: message.captureMode, saveDestination: message.saveDestination || "cloud" }, blob);
  return { recording: saved };
}
async function captureDisplayImage(message) {
  if (recorder || ["preparing", "recording", "paused", "stopping"].includes(state.status)) throw new Error("Beende zuerst die laufende Aufnahme.");
  let selected, video, reader, clone, bitmap;
  try {
    const mandatory = { chromeMediaSource: "desktop", chromeMediaSourceId: message.streamId };
    selected = await acquireMedia({ video: { mandatory }, audio: false });
    const track = selected.getVideoTracks()[0];
    await track.applyConstraints({ width: { ideal: 7680 }, height: { ideal: 4320 } }).catch(() => {});
    if (message.delaySeconds) await new Promise(resolve => setTimeout(resolve, Math.min(10, message.delaySeconds) * 1000));
    if (typeof MediaStreamTrackProcessor === "function") {
      clone = track.clone(); reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();
      let timer;
      try {
        const frame = await Promise.race([reader.read(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Die Quelle liefert kein Bild.")), 10000); })]);
        if (!frame.value) throw new Error("Die Bildschirmfreigabe wurde beendet.");
        try { bitmap = await createImageBitmap(frame.value); } finally { frame.value.close(); }
      } finally { clearTimeout(timer); }
    } else {
      video = videoFor(selected); await playable(video); bitmap = await createImageBitmap(video);
    }
    const output = new OffscreenCanvas(bitmap.width, bitmap.height);
    output.getContext("2d").drawImage(bitmap, 0, 0);
    return image({ ...message, blob: await output.convertToBlob({ type: "image/png" }), viewportWidth: bitmap.width });
  } finally {
    bitmap?.close(); await reader?.cancel().catch(() => {}); clone?.stop();
    for (const track of selected?.getTracks() || []) track.stop();
    if (video) { video.srcObject = null; video.remove(); }
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== engineTarget || sender.id !== chrome.runtime.id) return;
  if (controlsFrame && (!Number.isInteger(controlsFrameTabId) || message.controllerTabId !== controlsFrameTabId)) return;
  (async () => {
    switch (message.type) {
      case "SELECT_SOURCE": return selectSource(message);
      case "PREPARE": return prepare(message);
      case "PREVIEW_REGION": return prepareRegionPreview();
      case "SET_CAPTURE_REGION": return setCaptureRegion(message.region);
      case "BEGIN": return begin();
      case "PAUSE": return pause();
      case "RESUME": return resume();
      case "STOP": return finish();
      case "GET_STATE": return { state: publicState() };
      case "SET_AUDIO_STATE": return setAudioState(message);
      case "GET_AUDIO_DEVICES": return audioDevices();
      case "SET_MICROPHONE_DEVICE": return setMicrophoneDevice(message.deviceId);
      case "SET_AUTO_STOP": return setAutoStop(message.seconds);
      case "SAVE_IMAGE": return image(message);
      case "CAPTURE_DISPLAY_IMAGE": return captureDisplayImage(message);
      case "GET_RECORDING": {
        const item = await ExtensionStore.get(message.id);
        if (!item) throw new Error("Recording not found");
        if (!urls.has(item.id)) urls.set(item.id, URL.createObjectURL(await finalizeWebm(await ExtensionStore.blob(item.id), item.durationMs)));
        return { recording: item, objectUrl: urls.get(item.id) };
      }
      case "REVOKE_URL": if (urls.has(message.id)) { URL.revokeObjectURL(urls.get(message.id)); urls.delete(message.id); } return {};
      default: throw new Error("Unknown capture operation");
    }
  })().then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
if (controlsFrame) {
  globalThis.recorderCapture = Object.freeze({ selectSource, regionPreview: () => regionPreview });
  // A normal close asks Chrome to keep this frame alive while final chunks are
  // committed. Forced closure still leaves already committed IndexedDB chunks.
  addEventListener("beforeunload", event => {
    if (!recorder) return;
    event.preventDefault(); event.returnValue = "";
    finish().catch(() => {});
  });
  addEventListener("pagehide", () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stopStreams(recorder?.stream);
  });
}
