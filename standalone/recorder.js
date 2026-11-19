(() => {
  const $ = id => document.getElementById(id);
  const stores = window.captureDeskRecordingStore;
  const locales = window.captureDeskLocales;
  const supportsCrop = typeof HTMLCanvasElement.prototype.captureStream === "function";
  const supportsScreen = typeof navigator.mediaDevices?.getDisplayMedia === "function" && typeof MediaRecorder === "function";
  let locale, display, crop, drag, session, pip, timer, resultUrl, latest;
  let phase = "ready", statusKey = "ready", tone = "ready";
  const date = value => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
  const t = key => (locales[locale] || locales.en)[key] || locales.en[key] || key;
  const tracks = stream => stream?.getTracks() || [];
  const displayTrack = () => display?.getVideoTracks()[0];
  const sourceLive = () => displayTrack()?.readyState === "live";
  const locked = () => ["choosing", "starting", "recording", "paused", "saving"].includes(phase);
  const recording = () => phase === "recording" || phase === "paused";
  const stopTracks = stream => { for (const track of tracks(stream)) track.stop(); };

  function render() {
    const live = sourceLive(), active = recording(), busy = locked();
    $("status").textContent = t(statusKey);
    $("status").dataset.tone = tone;
    $("source").disabled = busy || !supportsScreen;
    $("start").disabled = busy || !live;
    $("pause").hidden = !active;
    $("pause").textContent = t(phase === "paused" ? "resume" : "pause");
    $("stop").hidden = !active;
    $("popout").hidden = !active || Boolean(pip) || !canPopOut();
    $("mic").disabled = busy || !navigator.mediaDevices?.getUserMedia;
    $("displayAudio").disabled = busy;
    $("fullArea").disabled = busy;
    $("cropArea").disabled = busy || !live || !supportsCrop;
    $("fullArea").setAttribute("aria-pressed", String(!crop));
    $("cropArea").setAttribute("aria-pressed", String(Boolean(crop)));
    $("cropHint").hidden = $("coordinates").hidden = !crop || busy;
    $("cropOverlay").hidden = !crop || !live || busy;
    $("cropHint").textContent = t("cropHelp");
    const offered = display?.getAudioTracks().some(track => track.readyState === "live");
    $("audioHint").textContent = t(live && $("displayAudio").checked ? (offered ? "audioAvailable" : "audioUnavailable") : "audioHelp");
    $("floatHint").hidden = Boolean(window.documentPictureInPicture?.requestWindow);
    $("pause").closest(".transport").dataset.floating = String(active && !pip);
    $("showBackups").disabled = busy;
    if (pip) {
      pip.document.documentElement.lang = locale;
      pip.document.getElementById("pipPause").textContent = t(phase === "paused" ? "resume" : "pause");
      pip.document.getElementById("pipStop").textContent = t("stop");
    }
    paintCrop();
  }
  function status(key, kind = "ready") {
    statusKey = key;
    tone = kind;
    render();
  }
  function changeLocale(value) {
    locale = Object.hasOwn(locales, value) ? value : "en";
    $("locale").value = locale;
    document.documentElement.lang = locale;
    document.querySelectorAll("[data-copy]").forEach(element => { element.textContent = t(element.dataset.copy); });
    $("timer").setAttribute("aria-label", t("timer"));
    try { localStorage.setItem("capture-desk.language", locale); } catch {}
    render();
  }

  function clearSource() {
    const previous = display;
    display = null;
    stopTracks(previous);
    $("preview").srcObject = null;
    $("preview").hidden = true;
    $("empty").hidden = false;
    $("viewport").style.removeProperty("aspect-ratio");
    crop = null;
    drag = null;
  }
  function sourceEnded(source) {
    if (display !== source) return;
    if (recording()) stop();
    else if (phase !== "saving" && phase !== "starting") {
      clearSource();
      phase = "ready";
      status("stopped", "error");
    }
  }
  function updatePreviewAspectRatio() {
    const { videoWidth, videoHeight } = $("preview");
    if (sourceLive() && videoWidth && videoHeight) $("viewport").style.aspectRatio = videoWidth + " / " + videoHeight;
  }
  async function chooseSource() {
    if (!supportsScreen || locked()) return;
    phase = "choosing";
    clearSource();
    status("choosing");
    let source;
    try {
      source = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: $("displayAudio").checked, selfBrowserSurface: "exclude", surfaceSwitching: "exclude",
      });
      display = source;
      const track = displayTrack();
      if (!track || track.readyState !== "live") throw new Error("No shared video track");
      track.addEventListener("ended", () => sourceEnded(source), { once: true });
      const preview = $("preview");
      preview.srcObject = source;
      $("empty").hidden = true;
      preview.hidden = false;
      const ended = new Promise((_, reject) => track.addEventListener("ended", () => reject(new Error("Source ended")), { once: true }));
      await Promise.race([preview.play(), ended]);
      if (!sourceLive() || !preview.videoWidth || !preview.videoHeight) throw new Error("Source preview is not ready");
      updatePreviewAspectRatio();
      phase = "selected";
      status("selected");
    } catch {
      clearSource();
      phase = "ready";
      status(source ? "failedSource" : "denied", "error");
    }
  }

  const cap = (value, lowest, highest) => Math.max(lowest, Math.min(highest, value));
  function setCrop(value) {
    crop = value;
    if (crop) for (const key of ["left", "top", "width", "height"]) $(key).value = Math.round(crop[key] * 100);
    render();
  }
  function paintCrop() {
    const selection = $("cropSelection");
    selection.hidden = !crop;
    if (!crop) return;
    for (const key of ["left", "top", "width", "height"]) selection.style[key] = 100 * crop[key] + "%";
  }
  function point(event) {
    const bounds = $("cropOverlay").getBoundingClientRect();
    return {
      x: cap((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: cap((event.clientY - bounds.top) / bounds.height, 0, 1),
    };
  }
  function beginCrop(event) {
    if (!crop || event.button !== 0) return;
    drag = { ...point(event), pointer: event.pointerId, previous: crop };
    $("cropOverlay").setPointerCapture(event.pointerId);
  }
  function drawCrop(event) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const { x, y } = point(event);
    const left = Math.min(x, drag.x), top = Math.min(y, drag.y);
    const width = Math.abs(x - drag.x), height = Math.abs(y - drag.y);
    if (width >= 0.01 && height >= 0.01) setCrop({ left, top, width, height });
  }
  function finishCrop(event) {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (event.type === "pointercancel") setCrop(drag.previous);
    else drawCrop(event);
    drag = null;
  }
  function coordinates() {
    const value = id => Math.round(Number($(id).value)) / 100;
    const left = cap(value("left"), 0, .99), top = cap(value("top"), 0, .99);
    setCrop({ left, top, width: cap(value("width"), .01, 1 - left), height: cap(value("height"), .01, 1 - top) });
  }
  function createCropTrack(rect) {
    if (!rect) return { track: displayTrack(), dispose() {} };
    const video = $("preview"), canvas = document.createElement("canvas");
    const drawWidth = video.videoWidth * rect.width, drawHeight = video.videoHeight * rect.height;
    canvas.width = Math.max(2, Math.floor(drawWidth / 2) * 2);
    canvas.height = Math.max(2, Math.floor(drawHeight / 2) * 2);
    const context = canvas.getContext("2d", { alpha: false });
    let callback, fallback;
    const draw = () => {
      if (video.readyState < 2) return;
      context.drawImage(video, rect.left * video.videoWidth, rect.top * video.videoHeight, rect.width * video.videoWidth,
        rect.height * video.videoHeight, 0, 0, canvas.width, canvas.height);
    };
    draw();
    if (video.requestVideoFrameCallback) {
      const frame = () => {
        draw();
        callback = video.requestVideoFrameCallback(frame);
      };
      callback = video.requestVideoFrameCallback(frame);
    } else fallback = setInterval(draw, 1000 / 30);
    const track = canvas.captureStream(30).getVideoTracks()[0];
    return {
      track,
      dispose() {
        track.stop();
        if (callback !== undefined) video.cancelVideoFrameCallback?.(callback);
        clearInterval(fallback);
      },
    };
  }
  function makeRecorder(input) {
    // Firefox waits for audio that will never arrive if the requested codecs
    // include Opus but the source contains only video.
    const includeAudio = input.getAudioTracks().length > 0;
    const webm = [`video/webm;codecs=vp8${includeAudio ? ",opus" : ""}`, "video/webm"];
    const mp4 = [`video/mp4;codecs=avc1.42e01e${includeAudio ? ",mp4a.40.2" : ""}`, "video/mp4"];
    const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
    const preferred = isSafari ? [...mp4, ...webm] : [...webm, ...mp4];
    const mimeType = preferred.find(type => MediaRecorder.isTypeSupported(type));
    return mimeType ? new MediaRecorder(input, { mimeType }) : new MediaRecorder(input);
  }
  async function start() {
    if (!sourceLive() || locked()) return;
    phase = "starting";
    status("starting");
    let microphone, audio, video;
    const wantMicrophone = $("mic").checked;
    const sharedAudio = $("displayAudio").checked ? display.getAudioTracks().filter(track => track.readyState === "live") : [];
    const mixRequired = sharedAudio.length + Number(wantMicrophone) > 1;
    try {
      if (mixRequired) {
        audio = new (window.AudioContext || window.webkitAudioContext)();
        audio.resume().catch(() => {});
      }
      if (wantMicrophone) {
        try { microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
        catch { throw new Error("micDenied"); }
      }
      if (!sourceLive()) throw new Error("stopped");
      const inputs = [...sharedAudio, ...(microphone?.getAudioTracks() || [])];
      let audioTracks = inputs;
      if (audio && inputs.length > 1) {
        const destination = audio.createMediaStreamDestination();
        for (const track of inputs) audio.createMediaStreamSource(new MediaStream([track])).connect(destination);
        audioTracks = destination.stream.getAudioTracks();
      }
      video = createCropTrack(crop);
      const recorder = makeRecorder(new MediaStream([video.track, ...audioTracks]));
      const createdAt = Date.now();
      const backup = { id: crypto.randomUUID(), createdAt, filename: t("file") + "-" + new Date(createdAt).toISOString().slice(0, 19).replaceAll(":", "-"),
        mimeType: "", bytes: 0, count: 0, durationMs: 0, complete: false };
      const job = { recorder, video, microphone, audio, backup, started: 0, paused: 0, pauseStarted: 0,
        canSave: true, writes: Promise.resolve(), unsaved: [], mimeType: "", finished: false };
      job.writes = stores.save(backup).catch(() => { job.canSave = false; });
      recorder.addEventListener("dataavailable", event => {
        if (!event.data.size) return;
        const blob = event.data, durationMs = elapsed(job);
        job.mimeType ||= (recorder.mimeType || blob.type).split(";")[0];
        job.writes = job.writes.then(async () => {
          if (!job.canSave) { job.unsaved.push(blob); return; }
          try { job.backup = await stores.append(job.backup, blob, durationMs); }
          catch { job.canSave = false; job.unsaved.push(blob); }
        });
      });
      recorder.addEventListener("stop", () => finish(job), { once: true });
      recorder.addEventListener("error", () => stop());
      recorder.start(1000);
      job.started = performance.now();
      session = job;
      phase = "recording";
      timer = setInterval(updateTimer, 200);
      updateTimer();
      status("recording", "recording");
    } catch (error) {
      video?.dispose();
      stopTracks(microphone);
      await audio?.close().catch(() => {});
      const live = sourceLive();
      if (!live) clearSource();
      phase = live ? "selected" : "ready";
      status(["stopped", "micDenied"].includes(error.message) ? error.message : "startError", "error");
    }
  }
  function elapsed(job) {
    return Math.max(0, (job.endedAt || (job.pauseStarted || performance.now())) - job.started - job.paused);
  }
  function updateTimer() {
    if (!session) return;
    const seconds = Math.floor(elapsed(session) / 1000);
    const time = [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
    $("timer").textContent = time;
    if (pip) pip.document.getElementById("pipTimer").textContent = time;
  }
  function pause() {
    const job = session;
    if (!job) return;
    const recorder = job.recorder;
    if (recorder.state === "recording") {
      recorder.pause();
      job.pauseStarted = performance.now();
      phase = "paused";
      status("paused");
    } else if (recorder.state === "paused") {
      recorder.resume();
      job.paused += performance.now() - job.pauseStarted;
      job.pauseStarted = 0;
      phase = "recording";
      status("recording", "recording");
    }
  }
  function stop() {
    const job = session;
    if (!job || job.finished || !recording()) return;
    job.endedAt = job.pauseStarted || performance.now();
    phase = "saving";
    status("saving");
    if (job.recorder.state !== "inactive") {
      try { job.recorder.stop(); }
      catch { finish(job); }
    }
    if (!job.finished) job.stopTimeout = setTimeout(() => finish(job), 5000);
  }
  async function finish(job) {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.stopTimeout);
    job.endedAt ||= job.pauseStarted || performance.now();
    phase = "saving";
    status("saving");
    clearInterval(timer);
    updateTimer();
    pip?.close();
    job.video.dispose();
    stopTracks(job.microphone);
    job.audio?.close().catch(() => {});
    clearSource();
    try {
      await job.writes;
      const durationMs = elapsed(job);
      const backup = job.backup.bytes > 0 ? [await stores.read(job.backup)] : [];
      const mimeType = job.mimeType || job.backup.mimeType || job.unsaved[0]?.type;
      const blob = new Blob([...backup, ...job.unsaved], { type: mimeType });
      if (!blob.size) {
        status("noVideo", "error");
        return;
      }
      if (job.canSave) {
        try { await stores.save({ ...job.backup, durationMs, complete: true }); }
        catch { job.canSave = false; }
      }
      await showResult(blob, job.backup.filename, durationMs);
      status(job.canSave ? "saved" : "savedWithoutBackup");
    } catch {
      status("saveError", "error");
    } finally {
      session = null;
      phase = "ready";
      render();
    }
  }
  async function showResult(blob, baseName, durationMs) {
    const video = await stores.finalizeWebm(blob, durationMs);
    const filename = baseName + (blob.type.includes("mp4") ? ".mp4" : ".webm");
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(video);
    $("aiButton").disabled = true;
    $("download").href = resultUrl;
    $("download").download = filename;
    $("result").hidden = false;
    $("recording").src = resultUrl;
    $("recording").load();
    latest = { blob: video, filename, durationMs };
    document.dispatchEvent(new CustomEvent("capture-desk:recording-ready", { detail: latest }));
  }
  async function showBackups() {
    const dialog = $("backupDialog");
    if (!dialog.open) dialog.showModal();
    const list = $("backupList");
    list.replaceChildren();
    $("backupsStatus").textContent = "";
    try {
      const backups = await stores.list();
      if (!backups.length) $("backupsStatus").textContent = t("noBackups");
      for (const item of backups) {
        const row = document.createElement("li");
        const label = document.createElement("span"), open = document.createElement("button");
        label.textContent = date(item.createdAt) + (item.complete ? "" : " · " + t("interrupted"));
        open.type = "button";
        open.textContent = t("open");
        open.addEventListener("click", async () => {
          open.disabled = true;
          try {
            await showResult(await stores.read(item), item.filename, item.durationMs);
            dialog.close();
            status("recovered");
          } catch { $("backupsStatus").textContent = t("backupLoadFailed"); }
          finally { open.disabled = false; }
        });
        row.append(label, open);
        list.append(row);
      }
    } catch { $("backupsStatus").textContent = t("backupUnavailable"); }
  }

  function canPopOut() {
    const surface = displayTrack()?.getSettings().displaySurface;
    return Boolean(window.documentPictureInPicture?.requestWindow && ["window", "browser"].includes(surface));
  }
  async function openPopout() {
    if (pip || !recording() || !canPopOut()) return;
    try {
      const opened = await window.documentPictureInPicture.requestWindow({ width: 370, height: 104 });
      if (!recording()) { opened.close(); return; }
      pip = opened;
      const doc = pip.document;
      doc.title = "Capture Desk";
      doc.body.className = "recording-pip";
      const css = doc.createElement("link");
      css.rel = "stylesheet";
      css.href = new URL("./style.css", document.baseURI).href;
      doc.head.append(css);
      doc.body.innerHTML = '<div class="transport"><output id="pipTimer"></output><button type="button" id="pipPause"></button><button type="button" id="pipStop" class="danger"></button></div>';
      doc.getElementById("pipPause").onclick = pause;
      doc.getElementById("pipStop").onclick = stop;
      pip.addEventListener("pagehide", () => {
        if (pip === opened) pip = null;
        render();
      }, { once: true });
      render();
      updateTimer();
    } catch { status("pipFailed", "error"); }
  }

  async function openAI(frame = false) {
    try {
      const assistant = await import("../chrome-extension/assist-panel.js");
      if (!frame) { assistant.openAssistant(); return; }
      const video = $("recording");
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      let image;
      if (canvas.width && canvas.height && video.readyState >= 2) {
        canvas.getContext("2d").drawImage(video, 0, 0);
        image = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      }
      assistant.openAssistant({ name: latest?.filename, image });
    } catch { status("aiUnavailable", "error"); }
  }

  $("source").onclick = chooseSource;
  $("start").onclick = start;
  $("pause").onclick = pause;
  $("stop").onclick = stop;
  $("popout").onclick = openPopout;
  $("showBackups").onclick = showBackups;
  $("assistant").onclick = () => openAI();
  $("aiButton").onclick = () => openAI(true);
  $("recording").addEventListener("loadeddata", () => { $("aiButton").disabled = false; });
  $("preview").addEventListener("resize", updatePreviewAspectRatio);
  $("displayAudio").onchange = render;
  $("fullArea").onclick = () => setCrop(null);
  $("cropArea").onclick = () => {
    if (!supportsCrop) { status("unavailableCrop", "error"); return; }
    setCrop(crop || { left: .15, top: .15, width: .7, height: .7 });
  };
  $("cropOverlay").addEventListener("pointerdown", beginCrop);
  $("cropOverlay").addEventListener("pointermove", drawCrop);
  $("cropOverlay").addEventListener("pointerup", finishCrop);
  $("cropOverlay").addEventListener("pointercancel", finishCrop);
  for (const id of ["left", "top", "width", "height"]) $(id).onchange = coordinates;
  $("locale").onchange = event => changeLocale(event.currentTarget.value);
  let preferred;
  try { preferred = localStorage.getItem("capture-desk.language"); } catch {}
  changeLocale(preferred || navigator.language.slice(0, 2));
  if (!supportsScreen) status("unavailable", "error");
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  window.addEventListener("beforeunload", event => {
    if (!session) return;
    event.preventDefault();
    event.returnValue = "";
  });
})();
