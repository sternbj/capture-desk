import { ExtensionStore, finalizeWebm, recordingMimeType, supportedRecordingFormats, safeFilename } from './capture-core.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const waitFor = (element, event, timeout = 15000) => new Promise((resolve, reject) => {
  const clear = () => { clearTimeout(timer); element.removeEventListener(event, success); element.removeEventListener('error', failure); };
  const success = () => { clear(); resolve(); }, failure = () => { clear(); reject(new Error('Das Video konnte nicht gelesen werden.')); };
  const timer = setTimeout(() => { clear(); reject(new Error('Das Video antwortet nicht. Öffne es erneut.')); }, timeout);
  element.addEventListener(event, success, { once: true }); element.addEventListener('error', failure, { once: true });
});
export function normalizeVideoEdit(input, duration) {
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('Für die Bearbeitung wird eine gültige Videodauer benötigt.');
  const start = clamp(finite(input.start), 0, duration), end = clamp(finite(input.end, duration), 0, duration);
  if (!(end - start >= .1)) throw new Error('Der Ausschnitt muss mindestens 0,1 Sekunden lang sein und vor dem Ende beginnen.');
  const length = end - start;
  const timed = item => ({ ...item, start: clamp(finite(item.start), 0, length), end: clamp(finite(item.end, length), 0, length) });
  const caption = timed({ ...input.caption, text: String(input.caption?.text || '').trim().slice(0, 500), fontSize: clamp(finite(input.caption?.fontSize, 32), 12, 160) });
  if (caption.text && caption.end <= caption.start) throw new Error('Die Endzeit des Textes muss nach seiner Startzeit liegen.');
  const shapes = (input.shapes || []).slice(0, 20).map(shape => timed({
    ...shape, type: ['rectangle', 'arrow', 'redact'].includes(shape.type) ? shape.type : 'rectangle',
    color: /^#[0-9a-f]{6}$/i.test(shape.color || '') ? shape.color : '#ef4444',
    x: clamp(finite(shape.x, 10), 0, 99), y: clamp(finite(shape.y, 10), 0, 99),
    width: clamp(finite(shape.width, 30), 1, 100), height: clamp(finite(shape.height, 20), 1, 100),
  }));
  for (const shape of shapes) if (shape.end <= shape.start) throw new Error('Die Endzeit einer Markierung muss nach ihrer Startzeit liegen.');
  return { start, end, duration: length, caption, shapes, format: ['mp4', 'webm', 'auto'].includes(input.format) ? input.format : 'auto' };
}
export function drawVideoOverlays(context, edit, time) {
  const width = context.canvas.width, height = context.canvas.height;
  for (const shape of edit.shapes) {
    if (time < shape.start || time >= shape.end) continue;
    const x = width * shape.x / 100, y = height * shape.y / 100, w = Math.min(width - x, width * shape.width / 100), h = Math.min(height - y, height * shape.height / 100);
    context.save(); context.strokeStyle = shape.color; context.fillStyle = shape.type === 'redact' ? '#000' : shape.color; context.lineWidth = Math.max(3, width / 250); context.lineCap = 'round'; context.lineJoin = 'round';
    if (shape.type === 'redact') context.fillRect(Math.floor(x), Math.floor(y), Math.ceil(w), Math.ceil(h));
    else if (shape.type === 'rectangle') context.strokeRect(x, y, w, h);
    else {
      const endX = x + w, endY = y + h, angle = Math.atan2(h, w), head = Math.max(14, width / 45);
      context.beginPath(); context.moveTo(x, y); context.lineTo(endX, endY); context.stroke(); context.beginPath(); context.moveTo(endX - head * Math.cos(angle - Math.PI / 6), endY - head * Math.sin(angle - Math.PI / 6)); context.lineTo(endX, endY); context.lineTo(endX - head * Math.cos(angle + Math.PI / 6), endY - head * Math.sin(angle + Math.PI / 6)); context.stroke();
    }
    context.restore();
  }
  if (edit.caption.text && time >= edit.caption.start && time < edit.caption.end) {
    context.save(); const fontSize = edit.caption.fontSize; context.font = `600 ${fontSize}px system-ui,sans-serif`; context.textBaseline = 'top'; context.textAlign = 'center';
    // Wrap editable text to the export width, including explicit line breaks.
    const lines = [];
    for (const paragraph of edit.caption.text.split('\n')) {
      let line = ''; for (const word of paragraph.split(/\s+/)) { const next = line ? line + ' ' + word : word; if (line && context.measureText(next).width > width * .86) { lines.push(line); line = word; } else line = next; } lines.push(line);
    }
    const selected = lines.slice(0, 8), lineHeight = fontSize * 1.3, boxHeight = selected.length * lineHeight + 20, y = Math.max(10, height - boxHeight - height * .04);
    context.fillStyle = 'rgba(0,0,0,.78)'; context.fillRect(width * .05, y, width * .9, boxHeight); context.fillStyle = '#fff'; selected.forEach((line, index) => context.fillText(line, width / 2, y + 10 + index * lineHeight, width * .86)); context.restore();
  }
}

// Real-time local export. Audio is copied from the original media element into
// the recorder through WebAudio, so trimming and overlays preserve its sound.
// The export element is private; the user's preview and original stay intact.
export async function exportVideoEdit({ objectUrl, edit, signal, onProgress = () => {} }) {
  if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('Dieser Browser unterstützt den lokalen Videoexport nicht. Öffne das Video im Screen Recorder.');
  if (signal?.aborted) throw new DOMException('Export abgebrochen', 'AbortError');
  const video = document.createElement('video'); video.playsInline = true; video.preload = 'auto'; video.src = objectUrl;
  video.style.cssText = 'position:fixed;left:-10000px;width:1px;height:1px;pointer-events:none'; document.body.append(video);
  const audio = new AudioContext(), destination = audio.createMediaStreamDestination();
  const silentSource = audio.createConstantSource(), silentGain = audio.createGain(); silentGain.gain.value = 0;
  silentSource.connect(silentGain); silentGain.connect(destination); silentSource.start();
  let stream, recorder, frameHandle, poll, timeout, finished = false, abortHandler;
  const chunks = [];
  const audioStart = audio.resume();
  try {
    if (video.readyState < 2) await waitFor(video, 'loadeddata');
    if (!video.videoWidth || !video.videoHeight || video.videoWidth * video.videoHeight > 33554432) throw new Error('Die Videoauflösung ist für den lokalen Export zu groß. Öffne es im Screen Recorder.');
    if (Math.abs(video.currentTime - edit.start) > .001) { const seeked = waitFor(video, 'seeked'); video.currentTime = edit.start; await seeked; }
    const output = document.createElement('canvas'); output.width = video.videoWidth; output.height = video.videoHeight;
    const context = output.getContext('2d', { alpha: false });
    const source = audio.createMediaElementSource(video); source.connect(destination); await audioStart;
    // Bound the canvas output cadence. Manual requestFrame calls can produce
    // near-identical timestamps when a decoded frame arrives just after play().
    stream = output.captureStream(30); for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    const mimeType = recordingMimeType(edit.format);
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000, audioBitsPerSecond: 128000 });
    const result = new Promise((resolve, reject) => {
      let failure;
      const finish = error => {
        if (finished) return; finished = true; failure = error; video.pause(); clearInterval(poll); clearTimeout(timeout);
        if (frameHandle !== undefined) video.cancelVideoFrameCallback?.(frameHandle);
        if (recorder.state !== 'inactive') recorder.stop(); else error ? reject(error) : resolve();
      };
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => finish(event.error || new Error('Der Videoexport wurde vom Browser beendet.'));
      recorder.onstop = () => failure ? reject(failure) : resolve();
      abortHandler = () => finish(new DOMException('Export abgebrochen', 'AbortError'));
      signal?.addEventListener('abort', abortHandler, { once: true });
      const draw = () => {
        if (finished) return;
        if (video.currentTime >= edit.end || video.ended) { finish(); return; }
        context.drawImage(video, 0, 0, output.width, output.height); drawVideoOverlays(context, edit, Math.max(0, video.currentTime - edit.start));
        onProgress(clamp((video.currentTime - edit.start) / edit.duration, 0, 1));
        frameHandle = video.requestVideoFrameCallback(draw);
      };
      recorder.start(); draw();
      video.play().catch(finish);
      video.addEventListener('ended', () => finish(), { once: true });
      poll = setInterval(() => { if (video.currentTime >= edit.end || video.ended) finish(); }, 30);
      timeout = setTimeout(() => finish(new Error('Der Export wurde unterbrochen. Das Original ist weiterhin verfügbar.')), Math.max(30000, edit.duration * 2000 + 10000));
      if (signal?.aborted) abortHandler();
    });
    await result; onProgress(1);
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
    if (!blob.size) throw new Error('Der Browser hat keine Videodaten erzeugt. Das Original ist weiterhin verfügbar.');
    const durationMs = Math.round(edit.duration * 1000), finalized = await finalizeWebm(blob, durationMs);
    return { blob: finalized, mimeType: finalized.type, width: output.width, height: output.height, durationMs };
  } finally {
    finished = true; clearInterval(poll); clearTimeout(timeout); if (frameHandle !== undefined) video.cancelVideoFrameCallback?.(frameHandle);
    signal?.removeEventListener('abort', abortHandler); video.pause(); video.removeAttribute('src'); video.load(); video.remove();
    for (const track of stream?.getTracks() || []) track.stop(); silentSource.stop(); silentSource.disconnect(); silentGain.disconnect(); await audio.close().catch(() => {});
  }
}

export async function initVideoEditor({ video, recording, objectUrl, onStatus, openCloud, openAI }) {
  const host = document.getElementById('videoResult');
  const stage = document.createElement('div'); stage.className = 'video-stage'; video.replaceWith(stage); stage.append(video);
  const overlay = document.createElement('canvas'); overlay.id = 'videoOverlayCanvas'; overlay.setAttribute('aria-label', 'Vorschau der Video-Markierungen'); stage.append(overlay);
  const controls = document.createElement('div'); controls.className = 'video-edit-controls'; controls.innerHTML = `
    <div class="video-edit-heading"><h2>Video bearbeiten</h2><div class="video-heading-actions"><span>Original bleibt erhalten</span><button id="videoTranscriptButton" class="button secondary" type="button">Transkript &amp; Untertitel</button></div></div>
    <div class="video-trim-row"><label>Start (Sek.) <input id="videoTrimStart" type="number" min="0" step="0.1" value="0"></label><label>Ende (Sek.) <input id="videoTrimEnd" type="number" min="0.1" step="0.1"></label><button id="previewVideoEditButton" class="button secondary" type="button">Ausschnitt abspielen</button><span id="videoClipDuration" class="muted"></span></div>
    <details class="video-edit-details"><summary>Text einblenden</summary><div class="video-caption-fields"><label>Text <textarea id="videoCaptionText" rows="2" maxlength="500" placeholder="Optionaler Text im Video"></textarea></label><div class="video-timing-row"><label>Ab Sek. <input id="videoCaptionStart" type="number" min="0" step="0.1" value="0"></label><label>Bis Sek. <input id="videoCaptionEnd" type="number" min="0" step="0.1"></label><label>Schriftgröße <select id="videoCaptionSize"><option>24</option><option selected>32</option><option>48</option><option>64</option></select></label></div></div></details>
    <details class="video-edit-details"><summary>Markierungen und Schwärzung</summary><div class="video-shape-fields"><label>Markierung <select id="videoShapeType"><option value="none">Keine neue Markierung</option value="rectangle">Rahmen</option><option value="arrow">Pfeil</option><option value="redact">Schwärzen</option></select></label><label>Farbe <input id="videoShapeColor" type="color" value="#ef4444"></label><div class="video-timing-row"><label>Ab Sek. <input id="videoShapeStart" type="number" min="0" step="0.1" value="0"></label><label>Bis Sek. <input id="videoShapeEnd" type="number" min="0" step="0.1"></label></div><div class="video-timing-row"><label>Links (%) <input id="videoShapeX" type="number" min="0" max="99" value="10"></label><label>Oben (%) <input id="videoShapeY" type="number" min="0" max="99" value="10"></label><label>Breite (%) <input id="videoShapeWidth" type="number" min="1" max="100" value="30"></label><label>Höhe (%) <input id="videoShapeHeight" type="number" min="1" max="100" value="20"></label></div><button id="addVideoShapeButton" class="button secondary" type="button">Markierung hinzufügen</button><div id="videoShapeList" class="video-shape-list"></div></div></details>
    <p class="muted">Text- und Markierungszeiten beziehen sich auf den gewählten Ausschnitt. Der Export läuft lokal in Echtzeit; lasse diesen Tab dabei geöffnet.</p>
    <div class="video-export-row"><label>Format <select id="videoExportFormat"><option value="auto">Automatisch</option></select></label><button id="exportVideoButton" class="button primary" type="button">Bearbeitete Kopie exportieren</button><button id="cancelVideoExportButton" class="button secondary" type="button" hidden>Export abbrechen</button><progress id="videoExportProgress" max="1" value="0" hidden aria-label="Videoexport-Fortschritt"></progress></div>
    <p id="videoEditStatus" class="status" role="status" aria-live="polite">Start und Ende festlegen oder optionale Markierungen hinzufügen.</p>
    <div id="videoExportResult" class="video-export-result" hidden><span>Bearbeitete Kopie ist in deinen Browser-Aufnahmen gespeichert.</span><button id="downloadEditedVideoButton" class="button secondary" type="button">Kopie herunterladen</button><button id="analyzeEditedVideoButton" class="button secondary" type="button">KI für diese Kopie</button><button id="shareEditedVideoButton" class="button primary" type="button">Kopie online speichern &amp; teilen</button></div>`;
  host.append(controls);
  const $ = id => controls.querySelector('#' + id);
  $('shareEditedVideoButton').hidden = !openCloud;
  if (!openCloud) $('videoTranscriptButton').textContent = 'KI mit Transkript';
  for (const format of supportedRecordingFormats()) $('videoExportFormat').append(new Option(format.toUpperCase(), format));
  if (video.readyState < 1) await waitFor(video, 'loadedmetadata');
  const duration = Number.isFinite(video.duration) ? video.duration : recording.durationMs / 1000;
  if (!(duration > 0)) { controls.hidden = true; onStatus('Das Video kann im Screen Recorder bearbeitet werden.'); return; }
  $('videoTrimEnd').value = duration.toFixed(2); $('videoCaptionEnd').value = duration.toFixed(2); $('videoShapeEnd').value = duration.toFixed(2);
  for (const element of controls.querySelectorAll('input[type=number]')) if (!/Shape(?:X|Y|Width|Height)$/.test(element.id)) element.max = duration;
  let shapes = [], abort, edited, exporting = false, previewStop;
  const shape = () => ({ type: $('videoShapeType').value, color: $('videoShapeColor').value, x: $('videoShapeX').value, y: $('videoShapeY').value, width: $('videoShapeWidth').value, height: $('videoShapeHeight').value, start: $('videoShapeStart').value, end: $('videoShapeEnd').value });
  const settings = () => normalizeVideoEdit({ start: $('videoTrimStart').value, end: $('videoTrimEnd').value, format: $('videoExportFormat').value,
    caption: { text: $('videoCaptionText').value, start: $('videoCaptionStart').value, end: $('videoCaptionEnd').value, fontSize: finite($('videoCaptionSize').value, 32) },
    shapes: [...shapes, ...($('videoShapeType').value !== 'none' ? [shape()] : [])] }, duration);
  function drawPreview() {
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    try { const edit = settings(); $('videoClipDuration').textContent = `${edit.duration.toFixed(1)} Sek. Ausschnitt`; if (video.currentTime >= edit.start && video.currentTime < edit.end) drawVideoOverlays(overlay.getContext('2d'), edit, video.currentTime - edit.start); }
    catch (error) { $('videoClipDuration').textContent = error.message; }
  }
  function changed() { drawPreview(); if (edited) $('videoEditStatus').textContent = 'Einstellungen geändert. Exportiere erneut, um sie in der Kopie zu übernehmen.'; }
  controls.addEventListener('input', changed); controls.addEventListener('change', changed);
  const onTimeUpdate = () => { if (previewStop !== undefined && video.currentTime >= previewStop) { video.pause(); previewStop = undefined; } drawPreview(); };
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('seeked', drawPreview); video.addEventListener('loadeddata', drawPreview);
  $('previewVideoEditButton').onclick = async () => { try { const edit = settings(); video.currentTime = edit.start; previewStop = edit.end; await video.play(); } catch (error) { $('videoEditStatus').textContent = error.message; } };
  function renderShapes() {
    $('videoShapeList').replaceChildren(); shapes.forEach((item, index) => { const row = document.createElement('div'); row.className = 'video-shape-row'; const text = document.createElement('span'); text.textContent = `${index + 1}. ${{ rectangle: 'Rahmen', arrow: 'Pfeil', redact: 'Schwärzung' }[item.type]} · ${item.start}–${item.end} Sek.`; const button = document.createElement('button'); button.className = 'tool'; button.type = 'button'; button.textContent = 'Entfernen'; button.onclick = () => { shapes.splice(index, 1); renderShapes(); drawPreview(); }; row.append(text, button); $('videoShapeList').append(row); });
  }
  $('addVideoShapeButton').onclick = () => {
    try { if ($('videoShapeType').value === 'none') throw new Error('Wähle zuerst Rahmen, Pfeil oder Schwärzen.'); if (shapes.length >= 20) throw new Error('Du kannst höchstens 20 Markierungen hinzufügen.'); settings(); shapes.push(shape()); $('videoShapeType').value = 'none'; renderShapes(); changed(); }
    catch (error) { $('videoEditStatus').textContent = error.message; }
  };
  function lock(locked) { exporting = locked; for (const element of controls.querySelectorAll('input,textarea,select,button')) element.disabled = locked; $('cancelVideoExportButton').disabled = false; $('cancelVideoExportButton').hidden = !locked; $('videoExportProgress').hidden = !locked; video.controls = !locked; }
  $('exportVideoButton').onclick = async () => {
    if (exporting) return;
    let edit; try { edit = settings(); } catch (error) { $('videoEditStatus').textContent = error.message; return; }
    video.pause(); abort = new AbortController(); lock(true); $('videoEditStatus').textContent = 'Video wird lokal exportiert. Das Original bleibt unverändert.';
    try {
      const result = await exportVideoEdit({ objectUrl, edit, signal: abort.signal, onProgress: value => { $('videoExportProgress').value = value; $('videoEditStatus').textContent = `Lokaler Export · ${Math.round(value * 100)} %`; } });
      if (abort.signal.aborted) throw new DOMException('Export abgebrochen', 'AbortError');
      const { blob, ...metadata } = result;
      edited = await ExtensionStore.putBlob({ name: `${recording.name || 'Video'} – bearbeitet`, kind: 'video', ...metadata, mimeType: blob.type, sourceId: recording.id, saveDestination: 'local', videoEdit: edit }, blob);
      $('videoExportResult').hidden = false;
      $('videoEditStatus').textContent = 'Bearbeitete Kopie lokal gespeichert.';
    } catch (error) { $('videoEditStatus').textContent = error.name === 'AbortError' ? 'Export abgebrochen. Das Original bleibt verfügbar.' : `Export fehlgeschlagen: ${error.message}`; }
    finally { lock(false); }
  };
  $('cancelVideoExportButton').onclick = () => abort?.abort();
  $('downloadEditedVideoButton').onclick = async () => { if (!edited) return; try { const url = URL.createObjectURL(await ExtensionStore.blob(edited.id)); await chrome.downloads.download({ url, filename: safeFilename(edited), saveAs: true }); setTimeout(() => URL.revokeObjectURL(url), 60000); } catch (error) { $('videoEditStatus').textContent = error.message; } };
  $('shareEditedVideoButton').onclick = async () => { if (!edited || !openCloud) return; try { await openCloud(edited.id); } catch (error) { $('videoEditStatus').textContent = error.message; } };
  const showAI = async (id, mode) => { try { await openAI(id, mode); $('videoEditStatus').textContent = 'KI-Assistent geöffnet. Wähle dort die gewünschte Funktion.'; } catch (error) { $('videoEditStatus').textContent = error.message; } };
  $('videoTranscriptButton').onclick = () => showAI(recording.id, 'transcript');
  $('analyzeEditedVideoButton').onclick = () => edited && showAI(edited.id, 'analyze');
  const beforeUnload = event => { if (exporting) { event.preventDefault(); event.returnValue = ''; } };
  const onPageHide = () => abort?.abort();
  window.addEventListener('beforeunload', beforeUnload); window.addEventListener('pagehide', onPageHide); drawPreview();
  return { dispose() { abort?.abort(); video.pause(); controls.remove(); stage.replaceWith(video); video.removeEventListener('timeupdate', onTimeUpdate); video.removeEventListener('seeked', drawPreview); video.removeEventListener('loadeddata', drawPreview); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', onPageHide); } };
}
