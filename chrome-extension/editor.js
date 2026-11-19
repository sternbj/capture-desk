import { ExtensionStore } from './capture-core.js';
import { createLocalOCR } from './editor-ocr.js';
import { initVideoEditor } from './video-editor.js';
import { initializeTheme, setTheme } from './theme.js';
import { APP_ORIGIN } from './app-config.js';
import { openAssistant } from './assist-panel.js';
import './i18n.js';

const $ = id => document.getElementById(id);
$('openRecorderButton').hidden = !APP_ORIGIN;
function setRecordingTitle(text, userTitle = false) {
  const heading = $('recordingTitle');
  heading.toggleAttribute('data-user-title', userTitle);
  heading.textContent = text;
}
const params = new URLSearchParams(location.search);
const canvas = $('editorCanvas'), context = canvas.getContext('2d');
const overlay = $('overlayCanvas'), overlayContext = overlay.getContext('2d');
const outputTypes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const imageActions = ['downloadButton', 'openRecorderButton', 'copyImageButton', 'saveCopyButton', 'printButton', 'aiAssistantButton'];
const tools = new Set(['move', 'crop', 'pen', 'line', 'arrow', 'rectangle', 'ellipse', 'highlight', 'text', 'step', 'blur', 'pixelate', 'redact']);
let recording, baseImage, baseUrl = '', recordingId = params.get('id');
let tool = 'move', actions = [], redo = [], draft, pointerId, busy = false, dirty = false, savedCopy;
let ocrBusy = false, ocrGeneration = 0, dragDepth = 0, resizeRatio = 1;
let videoEditor;
const hints = {
  move: 'Wähle ein Werkzeug oder ziehe ein anderes Bild in dieses Fenster. Ein kopiertes Bild kannst du mit ⌘ / Strg + V einfügen.',
  crop: 'Ziehe einen Rahmen um den gewünschten Ausschnitt. Rückgängig stellt den vorherigen Ausschnitt wieder her.',
  pen: 'Zeichne direkt auf dem Screenshot.', line: 'Ziehe eine Linie vom Start- zum Endpunkt.', arrow: 'Ziehe vom Startpunkt bis zur Pfeilspitze.',
  rectangle: 'Ziehe ein Rechteck um den gewünschten Bereich.', ellipse: 'Ziehe eine Ellipse um den gewünschten Bereich.',
  highlight: 'Ziehe einen transparenten Farbmarker über den gewünschten Bereich.', text: 'Gib oben deinen Text ein und klicke auf die gewünschte Position.',
  step: 'Klicke, um fortlaufend nummerierte Schritte einzufügen.', blur: 'Ziehe über den Bereich, den du weichzeichnen möchtest. Für vertrauliche Inhalte verwende Schwärzen.',
  pixelate: 'Ziehe über den Bereich, den du verpixeln möchtest. Für vertrauliche Inhalte verwende Schwärzen.',
  redact: 'Ziehe über vertrauliche Inhalte. Export und gespeicherte Kopie enthalten dort nur schwarze Bildpunkte.',
};
async function api(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...values });
  if (!response || response.ok === false) throw new Error(response?.error || 'Die Erweiterung antwortet nicht.');
  return response;
}
function status(text, error = false) { $('editorStatus').textContent = text; $('editorStatus').classList.toggle('error', error); }
// Theme changes affect the editor interface only. Image/video pixels stay untouched.
initializeTheme({ onChange: ({ preference }) => { $('editorTheme').value = preference; } }).catch(() => {});
$('editorTheme').onchange = async () => {
  try { await setTheme($('editorTheme').value); }
  catch {
    $('editorTheme').value = document.documentElement.dataset.themePreference || 'system';
    status('Die Darstellung konnte nicht gespeichert werden. Versuche es erneut.', true);
  }
};
function imageName() { return $('recordingName').value.trim().slice(0, 120) || recording?.name || 'Screenshot'; }
function filename(extension, suffix = '') { return `${imageName().replace(/[^\p{L}\p{N}._ -]/gu, '-').slice(0, 90)}${suffix}.${extension}`; }
function checkDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 32767 || height > 32767 || width * height > 64000000)
    throw new Error('Wähle eine Bildgröße zwischen 1 und 32.767 Pixeln und insgesamt höchstens 64 Millionen Pixeln.');
}
function setTool(next) {
  tool = tools.has(next) ? next : 'move'; draft = null; pointerId = null; preview();
  $('canvasStack').dataset.tool = tool;
  for (const button of document.querySelectorAll('button[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
  $('drawingOptions').hidden = !['pen', 'line', 'arrow', 'rectangle', 'ellipse', 'highlight', 'text', 'step', 'blur', 'pixelate'].includes(tool);
  $('textValueLabel').hidden = tool !== 'text'; $('textSizeLabel').hidden = !['text', 'step'].includes(tool);
  $('fillShapeLabel').hidden = !['rectangle', 'ellipse'].includes(tool);
  $('effectStrengthLabel').hidden = !['blur', 'pixelate'].includes(tool);
  $('toolHint').textContent = hints[tool];
  if (tool === 'highlight' && $('drawColor').value === '#ef4444') $('drawColor').value = '#ffdc40';
  if (tool === 'text') $('textValue').focus();
}
function bounds(shape) {
  const x = Math.min(shape.x, shape.endX ?? shape.x), y = Math.min(shape.y, shape.endY ?? shape.y);
  return { x, y, width: Math.abs((shape.endX ?? shape.x) - shape.x), height: Math.abs((shape.endY ?? shape.y) - shape.y) };
}
function pixelBounds(shape, width = canvas.width, height = canvas.height) {
  const box = bounds(shape), x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
  return { x, y, width: Math.max(0, Math.min(width - x, Math.ceil(box.width))), height: Math.max(0, Math.min(height - y, Math.ceil(box.height))) };
}
function temporary(width, height) { const result = document.createElement('canvas'); result.width = width; result.height = height; return result; }
function imageEffect(ctx, shape) {
  const box = pixelBounds(shape, ctx.canvas.width, ctx.canvas.height);
  if (!box.width || !box.height) return;
  if (shape.type === 'pixelate') {
    const block = shape.strength || 16;
    const small = temporary(Math.max(1, Math.ceil(box.width / block)), Math.max(1, Math.ceil(box.height / block)));
    small.getContext('2d').drawImage(ctx.canvas, box.x, box.y, box.width, box.height, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(small, box.x, box.y, box.width, box.height);
  } else {
    // Sample padding around the region, then clip the final blur to that region.
    const padding = Math.ceil((shape.strength || 16) * 3), x = Math.max(0, box.x - padding), y = Math.max(0, box.y - padding);
    const width = Math.min(ctx.canvas.width - x, box.width + padding * 2), height = Math.min(ctx.canvas.height - y, box.height + padding * 2);
    const sample = temporary(width, height); sample.getContext('2d').drawImage(ctx.canvas, x, y, width, height, 0, 0, width, height);
    ctx.beginPath(); ctx.rect(box.x, box.y, box.width, box.height); ctx.clip(); ctx.filter = `blur(${shape.strength || 16}px)`; ctx.drawImage(sample, x, y);
  }
}
function drawShape(ctx, shape, isPreview = false) {
  ctx.save(); ctx.lineWidth = shape.lineWidth || 6; ctx.strokeStyle = shape.color || '#ef4444'; ctx.fillStyle = shape.color || '#ef4444'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const box = bounds(shape);
  if (shape.type === 'pen') {
    ctx.beginPath(); for (const [index, point] of shape.points.entries()) index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y);
    if (shape.points.length === 1) ctx.lineTo(shape.points[0].x + .1, shape.points[0].y + .1); ctx.stroke();
  } else if (shape.type === 'redact') { const rect = pixelBounds(shape); ctx.fillStyle = '#000'; ctx.fillRect(rect.x, rect.y, rect.width, rect.height); }
  else if (shape.type === 'rectangle') shape.fill ? ctx.fillRect(box.x, box.y, box.width, box.height) : ctx.strokeRect(box.x, box.y, box.width, box.height);
  else if (shape.type === 'ellipse') { ctx.beginPath(); ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2); shape.fill ? ctx.fill() : ctx.stroke(); }
  else if (shape.type === 'highlight') { ctx.globalAlpha = .32; ctx.fillRect(box.x, box.y, box.width, box.height); }
  else if (shape.type === 'line' || shape.type === 'arrow') {
    ctx.beginPath(); ctx.moveTo(shape.x, shape.y); ctx.lineTo(shape.endX, shape.endY); ctx.stroke();
    if (shape.type === 'arrow') {
      const angle = Math.atan2(shape.endY - shape.y, shape.endX - shape.x), head = Math.max(14, ctx.lineWidth * 3);
      ctx.beginPath(); ctx.moveTo(shape.endX - head * Math.cos(angle - Math.PI / 6), shape.endY - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(shape.endX, shape.endY); ctx.lineTo(shape.endX - head * Math.cos(angle + Math.PI / 6), shape.endY - head * Math.sin(angle + Math.PI / 6)); ctx.stroke();
    }
  } else if (shape.type === 'text') {
    ctx.font = `600 ${shape.fontSize}px system-ui,sans-serif`; ctx.textBaseline = 'top';
    shape.text.split('\n').forEach((line, index) => ctx.fillText(line, shape.x, shape.y + index * shape.fontSize * 1.3));
  } else if (shape.type === 'step') {
    const radius = Math.max(14, shape.fontSize * .72); ctx.beginPath(); ctx.arc(shape.x, shape.y, radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, radius * .1); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = `700 ${shape.fontSize}px system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(shape.number), shape.x, shape.y + 1);
  } else if (['crop', 'blur', 'pixelate'].includes(shape.type) && isPreview) {
    ctx.lineWidth = Math.max(1, canvas.width / 700); ctx.setLineDash([10, 6]); ctx.strokeStyle = '#5688ff'; ctx.fillStyle = '#5688ff22'; ctx.fillRect(box.x, box.y, box.width, box.height); ctx.strokeRect(box.x, box.y, box.width, box.height);
  } else if (['blur', 'pixelate'].includes(shape.type)) imageEffect(ctx, shape);
  ctx.restore();
}
function transform(action) {
  const source = temporary(canvas.width, canvas.height); source.getContext('2d').drawImage(canvas, 0, 0);
  if (action.type === 'crop') {
    canvas.width = action.rect.width; canvas.height = action.rect.height;
    context.drawImage(source, action.rect.x, action.rect.y, action.rect.width, action.rect.height, 0, 0, canvas.width, canvas.height);
  } else if (action.type === 'resize') {
    canvas.width = action.width; canvas.height = action.height; context.imageSmoothingQuality = 'high'; context.drawImage(source, 0, 0, canvas.width, canvas.height);
  } else if (action.type === 'rotate') {
    canvas.width = source.height; canvas.height = source.width; context.save(); context.translate(canvas.width / 2, canvas.height / 2); context.rotate(action.direction * Math.PI / 2); context.drawImage(source, -source.width / 2, -source.height / 2); context.restore();
  } else if (action.type === 'flip') {
    context.save(); context.setTransform(action.horizontal ? -1 : 1, 0, 0, action.horizontal ? 1 : -1, action.horizontal ? canvas.width : 0, action.horizontal ? 0 : canvas.height); context.drawImage(source, 0, 0); context.restore();
  }
}
function applyZoom() {
  if (!baseImage) return;
  const selected = $('zoomSelect').value;
  const zoom = selected === 'fit' ? Math.min(1, Math.max(50, $('canvasViewport').clientWidth - 50) / canvas.width, Math.max(50, $('canvasViewport').clientHeight - 50) / canvas.height) : Number(selected);
  $('canvasStack').style.width = `${Math.max(1, Math.round(canvas.width * zoom))}px`; canvas.style.width = '100%';
  $('canvasStack').dataset.zoom = String(zoom);
}
function render() {
  if (!baseImage) return;
  canvas.width = baseImage.naturalWidth || baseImage.width; canvas.height = baseImage.naturalHeight || baseImage.height; context.drawImage(baseImage, 0, 0);
  for (const action of actions) ['crop', 'resize', 'rotate', 'flip'].includes(action.type) ? transform(action) : drawShape(context, action);
  overlay.width = canvas.width; overlay.height = canvas.height;
  $('undoButton').disabled = !actions.length; $('redoButton').disabled = !redo.length; $('resetButton').disabled = !actions.length;
  $('recordingInfo').textContent = `${canvas.width.toLocaleString('de-DE')} × ${canvas.height.toLocaleString('de-DE')} Pixel · ${actions.length ? 'Bearbeitet' : 'Original'} · Lokal gespeichert`;
  $('resizeWidth').value = canvas.width; $('resizeHeight').value = canvas.height; resizeRatio = canvas.width / canvas.height;
  applyZoom();
}
function preview() { overlayContext.clearRect(0, 0, overlay.width, overlay.height); if (draft) drawShape(overlayContext, draft, true); }
function point(event) { const rect = overlay.getBoundingClientRect(); return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)), y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)) }; }
function commit(action) { actions.push(action); redo = []; dirty = true; savedCopy = null; draft = null; render(); status('Änderung übernommen. Speichere eine Kopie, um sie in deinen Aufnahmen zu behalten.'); }
overlay.addEventListener('pointerdown', event => {
  if (busy || tool === 'move' || event.button !== 0) return;
  const start = point(event), style = { color: $('drawColor').value, lineWidth: Number($('lineWidth').value), fill: $('fillShape').checked, strength: Number($('effectStrength').value) };
  if (tool === 'text') {
    const text = $('textValue').value.trim(); if (!text) { status('Gib zuerst oben deinen Text ein.', true); $('textValue').focus(); return; }
    commit({ type: 'text', ...start, ...style, text, fontSize: Number($('textSize').value) }); return;
  }
  if (tool === 'step') { commit({ type: 'step', ...start, ...style, number: actions.filter(action => action.type === 'step').length + 1, fontSize: Number($('textSize').value) }); return; }
  pointerId = event.pointerId; overlay.setPointerCapture(pointerId); draft = { type: tool, ...start, endX: start.x, endY: start.y, ...style, ...(tool === 'pen' ? { points: [start] } : {}) }; event.preventDefault(); preview();
});
overlay.addEventListener('pointermove', event => { if (!draft || event.pointerId !== pointerId) return; const end = point(event); draft.endX = end.x; draft.endY = end.y; if (draft.type === 'pen') draft.points.push(end); preview(); });
function finishPointer(event) {
  if (!draft || event.pointerId !== pointerId) return;
  const end = point(event), action = draft; action.endX = end.x; action.endY = end.y; draft = null; pointerId = null;
  try { overlay.releasePointerCapture(event.pointerId); } catch { /* Pointer may already be released. */ }
  if (action.type === 'crop') { const rect = pixelBounds(action); if (rect.width < 4 || rect.height < 4) { preview(); return; } commit({ type: 'crop', rect }); setTool('move'); }
  else if (action.type === 'pen' || Math.abs(action.endX - action.x) + Math.abs(action.endY - action.y) > 3) commit(action);
  else preview();
}
overlay.addEventListener('pointerup', finishPointer); overlay.addEventListener('pointercancel', () => { draft = null; pointerId = null; preview(); });
for (const button of document.querySelectorAll('button[data-tool]')) button.onclick = () => setTool(button.dataset.tool);
function undoAction() { if (!actions.length) return; redo.push(actions.pop()); dirty = true; savedCopy = null; render(); status('Änderung rückgängig gemacht.'); }
function redoAction() { if (!redo.length) return; actions.push(redo.pop()); dirty = true; savedCopy = null; render(); status('Änderung wiederhergestellt.'); }
$('undoButton').onclick = undoAction; $('redoButton').onclick = redoAction;
$('resetButton').onclick = () => { actions = []; redo = []; dirty = true; savedCopy = null; render(); status('Original wiederhergestellt.'); };
for (const [id, action] of [['rotateLeftButton', { type: 'rotate', direction: -1 }], ['rotateRightButton', { type: 'rotate', direction: 1 }], ['flipHorizontalButton', { type: 'flip', horizontal: true }], ['flipVerticalButton', { type: 'flip', horizontal: false }]]) $(id).onclick = () => commit(action);
$('resizeButton').onclick = () => { $('resizePanel').hidden = !$('resizePanel').hidden; $('resizeButton').setAttribute('aria-expanded', String(!$('resizePanel').hidden)); };
$('cancelResizeButton').onclick = () => { $('resizePanel').hidden = true; $('resizeButton').setAttribute('aria-expanded', 'false'); };
for (const dimension of ['Width', 'Height']) $('resize' + dimension).oninput = () => { if (!$('lockAspectRatio').checked) return; const number = Number($('resize' + dimension).value); $('resize' + (dimension === 'Width' ? 'Height' : 'Width')).value = Math.max(1, Math.round(dimension === 'Width' ? number / resizeRatio : number * resizeRatio)); };
$('resizePanel').onsubmit = event => { event.preventDefault(); try { const width = Math.round(Number($('resizeWidth').value)), height = Math.round(Number($('resizeHeight').value)); checkDimensions(width, height); commit({ type: 'resize', width, height }); $('cancelResizeButton').click(); } catch (error) { status(error.message, true); } };
$('zoomSelect').onchange = applyZoom;
for (const [id, direction] of [['zoomInButton', 1], ['zoomOutButton', -1]]) $(id).onclick = () => { const scales = [.25, .5, 1, 1.5, 2, 4], current = Number($('canvasStack').dataset.zoom || 1); const next = direction > 0 ? scales.find(scale => scale > current + .01) ?? 4 : [...scales].reverse().find(scale => scale < current - .01) ?? .25; $('zoomSelect').value = String(next); applyZoom(); };
new ResizeObserver(() => { if ($('zoomSelect').value === 'fit') applyZoom(); }).observe($('canvasViewport'));
function canvasBlob(type = 'image/png') {
  let output = canvas;
  if (type === 'image/jpeg') { output = temporary(canvas.width, canvas.height); const ctx = output.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, output.width, output.height); ctx.drawImage(canvas, 0, 0); }
  return new Promise((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('Das Bild konnte nicht exportiert werden.')), type, .92));
}
async function doAction(fn) {
  if (busy) return; busy = true; for (const id of imageActions) $(id).disabled = true;
  try { await fn(); } catch (error) { status(error.message, true); }
  finally { busy = false; for (const id of imageActions) $(id).disabled = !recording; }
}
async function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  try { await chrome.downloads.download({ url, filename: name, saveAs: true }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
async function saveCurrentCopy() {
  if (!baseImage) return recordingId;
  const signature = JSON.stringify({ actions, name: imageName() });
  if (savedCopy?.signature === signature) return savedCopy.id;
  if (!actions.length && imageName() === recording.name) return recordingId;
  const blob = await canvasBlob();
  const saved = await ExtensionStore.putBlob({ name: imageName(), mimeType: 'image/png', kind: 'image', width: canvas.width, height: canvas.height, durationMs: 0, sourceId: recordingId, captureMode: 'edited', saveDestination: 'local' }, blob);
  savedCopy = { signature, id: saved.id }; dirty = false; return saved.id;
}
$('downloadButton').onclick = () => doAction(async () => {
  if (!baseImage) { await api('DOWNLOAD_RECORDING', { id: recordingId }); status('Der Download wurde gestartet.'); return; }
  const format = $('imageFormat').value; await downloadBlob(await canvasBlob(outputTypes[format]), filename(format === 'jpeg' ? 'jpg' : format)); dirty = false; status('Der Download wurde gestartet.');
});
$('saveCopyButton').onclick = () => doAction(async () => { await saveCurrentCopy(); status('Bildkopie in deinen Browser-Aufnahmen gespeichert. Das Original bleibt erhalten.'); });
$('copyImageButton').onclick = () => doAction(async () => {
  if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw new Error('Die Zwischenablage ist hier nicht verfügbar. Lade das Bild als PNG herunter.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob() })]); status('Bild in die Zwischenablage kopiert.');
});
$('printButton').onclick = () => window.print();
$('openRecorderButton').onclick = () => doAction(async () => { const id = await saveCurrentCopy(); await api('OPEN_RECORDER', { id }); status('Die Aufnahme wird im Screen Recorder online gespeichert.'); });
$('aiAssistantButton').onclick = () => doAction(async () => openAssistant({
  name: recording?.name, image: baseImage ? await canvasBlob() : undefined,
}));
$('recordingName').oninput = () => { if (recording && imageName() !== recording.name) dirty = true; savedCopy = null; setRecordingTitle(imageName(), true); };
async function showImage(blob, name, existing) {
  videoEditor?.dispose(); videoEditor = null;
  await cancelOCR();
  const url = URL.createObjectURL(blob), image = new Image();
  try { await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Dieses Bildformat konnte nicht geöffnet werden. Wähle PNG, JPEG oder WebP.')); image.src = url; }); checkDimensions(image.naturalWidth, image.naturalHeight); }
  catch (error) { URL.revokeObjectURL(url); throw error; }
  if (baseUrl.startsWith('blob:')) URL.revokeObjectURL(baseUrl); baseUrl = url; baseImage = image;
  actions = []; redo = []; savedCopy = null; draft = null; dirty = false;
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; context.drawImage(image, 0, 0);
  recording = existing || await ExtensionStore.putBlob({ name: name.replace(/\.[a-z0-9]+$/i, '').slice(0, 120) || 'Importiertes Bild', kind: 'image', mimeType: 'image/png', width: image.naturalWidth, height: image.naturalHeight, durationMs: 0, captureMode: 'import', saveDestination: 'local' }, await canvasBlob());
  recordingId = recording.id; $('recordingName').value = recording.name || name || 'Screenshot'; setRecordingTitle($('recordingName').value, true);
  $('importPanel').hidden = true; $('errorPanel').hidden = true; $('videoResult').hidden = true; $('imageEditor').hidden = false;
  for (const element of document.querySelectorAll('.image-action')) { element.hidden = false; element.disabled = false; }
  $('formatLabel').hidden = false; $('downloadButton').disabled = false; $('openRecorderButton').disabled = false; $('aiAssistantButton').disabled = false;
  render(); setTool('move'); status(existing ? 'Screenshot lokal gespeichert. Bearbeite ihn oder teile eine bearbeitete Kopie.' : 'Bild lokal in deinen Browser-Aufnahmen gespeichert. Du kannst es jetzt bearbeiten.');
  history.replaceState(null, '', `${location.pathname}?id=${encodeURIComponent(recordingId)}`);
}
async function importFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { status('Wähle eine Bilddatei, zum Beispiel PNG, JPEG oder WebP.', true); return; }
  if (file.size > 100 * 1024 * 1024) { status('Dieses Bild ist größer als 100 MB. Wähle eine kleinere Datei.', true); return; }
  if (dirty && !confirm('Ungespeicherte Änderungen verwerfen und ein anderes Bild öffnen?')) return;
  await doAction(() => showImage(file, file.name || 'Bild aus der Zwischenablage'));
}
$('importImageButton').onclick = () => $('imageFile').click(); $('chooseImageButton').onclick = () => $('imageFile').click();
$('imageFile').onchange = async () => { await importFile($('imageFile').files[0]); $('imageFile').value = ''; };
document.addEventListener('paste', event => { const image = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith('image/')); if (!image) return; event.preventDefault(); importFile(image.getAsFile()); });
document.addEventListener('dragenter', event => { if (![...(event.dataTransfer?.types || [])].includes('Files')) return; event.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); importFile([...event.dataTransfer.files].find(file => file.type.startsWith('image/')) || event.dataTransfer.files[0]); });
const ocr = createLocalOCR({ onProgress: ({ label, progress }) => { $('ocrStatus').textContent = `${label} · ${Math.round(progress * 100)} %`; $('ocrProgress').value = progress; } });
function ocrButtons() { const hasText = Boolean($('ocrText').value.trim()); $('copyTextButton').disabled = !hasText; $('downloadTextButton').disabled = !hasText; }
async function cancelOCR() {
  if (!ocrBusy) return; ocrGeneration++; await ocr.cancel(); ocrBusy = false;
  $('runOCRButton').disabled = false; $('ocrLanguage').disabled = false; $('cancelOCRButton').hidden = true; $('ocrProgress').hidden = true; $('ocrStatus').textContent = 'Texterkennung abgebrochen.';
}
async function runOCR() {
  if (!baseImage || ocrBusy) return;
  ocrBusy = true; const generation = ++ocrGeneration; $('runOCRButton').disabled = true; $('ocrLanguage').disabled = true; $('cancelOCRButton').hidden = false; $('ocrProgress').hidden = false; $('ocrText').value = ''; ocrButtons();
  try {
    const image = await canvasBlob(); const result = await ocr.recognize(image, $('ocrLanguage').value);
    if (generation !== ocrGeneration) return;
    $('ocrText').value = result.text.trim(); $('ocrStatus').textContent = result.text.trim() ? `Text erkannt${Number.isFinite(result.confidence) ? ` · Erkennungssicherheit ${Math.round(result.confidence)} %` : ''}` : 'Kein Text gefunden. Wähle eine passende Sprache oder vergrößere den Textausschnitt.'; ocrButtons();
  } catch (error) { if (generation === ocrGeneration) $('ocrStatus').textContent = error.name === 'AbortError' ? 'Texterkennung abgebrochen.' : `Texterkennung fehlgeschlagen: ${error.message}`; }
  finally { if (generation === ocrGeneration) { ocrBusy = false; $('runOCRButton').disabled = false; $('ocrLanguage').disabled = false; $('cancelOCRButton').hidden = true; $('ocrProgress').hidden = true; } }
}
$('showOCRButton').onclick = () => { $('ocrPanel').hidden = false; applyZoom(); $('runOCRButton').focus(); };
$('closeOCRButton').onclick = async () => { await cancelOCR(); $('ocrPanel').hidden = true; applyZoom(); };
$('runOCRButton').onclick = runOCR; $('cancelOCRButton').onclick = cancelOCR; $('ocrText').oninput = ocrButtons;
$('copyTextButton').onclick = async () => { try { await navigator.clipboard.writeText($('ocrText').value); $('ocrStatus').textContent = 'Text kopiert.'; } catch { $('ocrText').select(); $('ocrStatus').textContent = 'Drücke ⌘ / Strg + C, um den markierten Text zu kopieren.'; } };
$('downloadTextButton').onclick = async () => { try { await downloadBlob(new Blob([$ ('ocrText').value], { type: 'text/plain;charset=utf-8' }), filename('txt')); $('ocrStatus').textContent = 'Text-Download gestartet.'; } catch (error) { $('ocrStatus').textContent = error.message; } };
$('openControlsButton').onclick = () => api('SHOW_CONTROLS').catch(error => status(error.message, true));
document.addEventListener('keydown', event => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
  if (modifier && key === 'z') { event.preventDefault(); event.shiftKey ? redoAction() : undoAction(); return; }
  if (modifier && key === 'y') { event.preventDefault(); redoAction(); return; }
  if (modifier && key === 's' && baseImage) { event.preventDefault(); $('saveCopyButton').click(); return; }
  if (modifier || event.altKey) return;
  const shortcuts = { v: 'move', c: 'crop', p: 'pen', l: 'line', a: 'arrow', r: 'rectangle', e: 'ellipse', h: 'highlight', t: 'text', n: 'step', b: 'blur', x: 'redact' };
  if (shortcuts[key] && baseImage) { event.preventDefault(); setTool(shortcuts[key]); }
  else if (key === 'escape') { setTool('move'); $('cancelResizeButton').click(); }
  else if (key === '0') { $('zoomSelect').value = 'fit'; applyZoom(); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { ocr.cancel().catch(() => {}); if (baseUrl.startsWith('blob:')) URL.revokeObjectURL(baseUrl); });
try {
  if (!recordingId) {
    $('importPanel').hidden = false; setRecordingTitle('Bild öffnen und bearbeiten'); $('importPanel').focus();
  } else {
    const response = await api('GET_RECORDING', { id: recordingId });
    recording = response.recording; const url = response.objectUrl;
    if (!recording || !url) throw new Error('Die Aufnahme ist nicht mehr verfügbar.');
    const image = recording.kind === 'image' || String(recording.mimeType || recording.type || '').startsWith('image/');
    if (image) {
      const blob = await fetch(url).then(response => { if (!response.ok) throw new Error('Der Screenshot konnte nicht geladen werden.'); return response.blob(); });
      await showImage(blob, recording.name || 'Screenshot', recording);
      setTool(params.get('tool') === 'crop' || recording.captureMode === 'region' ? 'crop' : 'move');
      if (params.get('tool') === 'ocr') { $('ocrPanel').hidden = false; applyZoom(); runOCR(); }
    } else {
      baseUrl = url; setRecordingTitle(recording.name || recording.displayName || 'Aufnahme', Boolean(recording.name || recording.displayName)); $('videoResult').hidden = false; $('recordedVideo').src = url;
      $('recordingInfo').textContent = `${recording.width && recording.height ? `${recording.width} × ${recording.height} · ` : ''}Video · Lokal gespeichert`; $('downloadButton').disabled = false; $('openRecorderButton').disabled = false; $('aiAssistantButton').disabled = false; status('Video lokal gespeichert. Für Bearbeiten und Teilen im Screen Recorder öffnen.');
      videoEditor = await initVideoEditor({
        video: $('recordedVideo'), recording, objectUrl: url, onStatus: status,
        openCloud: APP_ORIGIN ? id => api('OPEN_RECORDER', { id }) : null,
        openAI: (id, mode) => mode === 'transcript' && APP_ORIGIN
          ? api('OPEN_AI_ASSISTANT', { id, mode }) : openAssistant({ name: recording.name }),
      });
      status('Video lokal gespeichert. Schneide einen Ausschnitt und exportiere eine bearbeitete Kopie.');
    }
  }
} catch (error) {
  $('imageEditor').hidden = true; $('videoResult').hidden = true; $('errorPanel').hidden = false; $('errorText').textContent = error.message; setRecordingTitle('Aufnahme nicht verfügbar'); status('Die Aufnahme konnte nicht geladen werden.', true);
}
