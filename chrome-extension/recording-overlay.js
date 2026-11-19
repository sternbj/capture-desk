(() => {
  const key = "__sternbergRecordingOverlay";
  if (globalThis[key]?.configure) return;

  const modes = new Set(["none", "pen", "arrow", "rectangle", "highlight"]);
  const host = document.createElement("div");
  host.setAttribute("data-sternberg-recording-overlay", "");
  host.setAttribute("aria-hidden", "true");
  for (const [property, value] of Object.entries({
    all: "initial", position: "fixed", inset: "0", width: "100%", height: "100%",
    "z-index": "2147483647", "pointer-events": "none", contain: "strict", overflow: "hidden",
  })) host.style.setProperty(property, value, "important");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host{color-scheme:light}
    canvas{display:block;position:absolute;inset:0;width:100%;height:100%;pointer-events:none;touch-action:auto;user-select:none}
    .halo{position:absolute;width:38px;height:38px;box-sizing:border-box;border:2px solid #e8ac18;border-radius:50%;background:#ffdf5b66;transform:translate(-50%,-50%);pointer-events:none}
    [hidden]{display:none!important}
  `;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-annotation-canvas", "");
  const halo = document.createElement("div");
  halo.className = "halo"; halo.hidden = true;
  halo.setAttribute("data-cursor-halo", "");
  shadow.append(style, canvas, halo);
  const context = canvas.getContext("2d");
  const strokes = [];
  let mode = "none", color = "#ff435b", cursorHighlight = false, destroyed = false;
  let draft = null, pointerId = null, frame = 0, ratio = 1;
  let cursor = null;

  function status() {
    return { mode, color, cursorHighlight, annotations: strokes.length, drawing: Boolean(draft), attached: host.isConnected, destroyed };
  }
  function mount() {
    if (destroyed) throw new Error("Die Zeichenfunktion wurde beendet.");
    if (!host.isConnected) document.documentElement.append(host);
  }
  function draw(stroke) {
    const offsetX = window.scrollX, offsetY = window.scrollY;
    context.save();
    context.translate(-offsetX, -offsetY);
    context.strokeStyle = stroke.color; context.fillStyle = stroke.color;
    context.lineCap = "round"; context.lineJoin = "round";
    context.lineWidth = stroke.mode === "highlight" ? 20 : 4;
    if (stroke.mode === "highlight") context.globalAlpha = .28;
    const first = stroke.points[0], last = stroke.points.at(-1);
    if (stroke.mode === "rectangle") {
      context.strokeRect(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.abs(last.x - first.x), Math.abs(last.y - first.y));
    } else if (stroke.mode === "arrow") {
      const angle = Math.atan2(last.y - first.y, last.x - first.x);
      const head = Math.min(18, Math.hypot(last.x - first.x, last.y - first.y) * .45);
      context.beginPath(); context.moveTo(first.x, first.y); context.lineTo(last.x, last.y);
      context.moveTo(last.x - head * Math.cos(angle - Math.PI / 6), last.y - head * Math.sin(angle - Math.PI / 6));
      context.lineTo(last.x, last.y);
      context.lineTo(last.x - head * Math.cos(angle + Math.PI / 6), last.y - head * Math.sin(angle + Math.PI / 6));
      context.stroke();
    } else if (stroke.points.length === 1) {
      context.beginPath(); context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2); context.fill();
    } else {
      context.beginPath(); context.moveTo(first.x, first.y);
      for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
    context.restore();
  }
  function render() {
    frame = 0;
    if (destroyed) return;
    const width = Math.max(1, window.innerWidth), height = Math.max(1, window.innerHeight);
    // Keep very large monitors within a reasonable transparent-canvas budget.
    ratio = Math.min(Math.max(1, window.devicePixelRatio || 1), 3, Math.sqrt(16777216 / (width * height)));
    const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    for (const stroke of strokes) draw(stroke);
    if (draft) draw(draft);
  }
  function scheduleRender() {
    if (!destroyed && !frame) frame = requestAnimationFrame(render);
  }
  function point(event) { return { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY }; }
  function releasePointer() {
    if (pointerId !== null) {
      try { if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId); } catch { /* The pointer may already have ended. */ }
    }
    pointerId = null;
  }
  function cancelDraft() { draft = null; releasePointer(); scheduleRender(); }
  function updateHalo() {
    halo.hidden = !cursorHighlight || !cursor;
    if (cursor) { halo.style.left = `${cursor.x}px`; halo.style.top = `${cursor.y}px`; }
  }
  function trackCursor(event) { cursor = { x: event.clientX, y: event.clientY }; updateHalo(); }
  function hideCursor() { cursor = null; updateHalo(); }
  function pointerDown(event) {
    if (mode === "none" || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation();
    pointerId = event.pointerId;
    draft = { mode, color, points: [point(event)] };
    canvas.setPointerCapture(pointerId);
    scheduleRender();
  }
  function extendDraft(event) {
    if (!draft || event.pointerId !== pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const next = point(event);
    if (draft.mode === "rectangle" || draft.mode === "arrow") draft.points[1] = next;
    else {
      const previous = draft.points.at(-1);
      if (Math.hypot(next.x - previous.x, next.y - previous.y) >= .5) draft.points.push(next);
    }
    scheduleRender();
  }
  function pointerUp(event) {
    if (!draft || event.pointerId !== pointerId) return;
    extendDraft(event);
    const first = draft.points[0], last = draft.points.at(-1);
    if (["pen", "highlight"].includes(draft.mode) || Math.hypot(last.x - first.x, last.y - first.y) > 3) strokes.push(draft);
    draft = null; releasePointer(); scheduleRender();
  }
  function pointerCancel(event) { if (event.pointerId === pointerId) cancelDraft(); }
  function editableEvent(event) {
    return event.composedPath().some(element => element instanceof Element &&
      (element.matches("input,textarea,select,[role=textbox]") || element.isContentEditable));
  }
  function keyDown(event) {
    if (mode === "none" || editableEvent(event)) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); configure({ mode: "none" });
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z" && (draft || strokes.length)) {
      event.preventDefault(); event.stopPropagation(); undo();
    }
  }
  function configure(input = {}) {
    mount();
    if (!input || typeof input !== "object") throw new Error("Ungültige Zeicheneinstellung.");
    if (Object.hasOwn(input, "mode")) {
      if (!modes.has(input.mode)) throw new Error("Unbekanntes Zeichenwerkzeug.");
      cancelDraft(); mode = input.mode;
    }
    if (Object.hasOwn(input, "color")) {
      if (typeof input.color !== "string" || input.color.length > 128 || !CSS.supports("color", input.color)) throw new Error("Ungültige Zeichenfarbe.");
      context.fillStyle = input.color; color = context.fillStyle;
    }
    if (Object.hasOwn(input, "cursorHighlight")) {
      if (typeof input.cursorHighlight !== "boolean") throw new Error("Ungültige Mausmarkierung.");
      cursorHighlight = input.cursorHighlight;
    }
    canvas.style.pointerEvents = mode === "none" ? "none" : "auto";
    canvas.style.touchAction = mode === "none" ? "auto" : "none";
    canvas.style.cursor = mode === "none" ? "auto" : "crosshair";
    updateHalo(); scheduleRender();
    return status();
  }
  function clear() { mount(); strokes.length = 0; cancelDraft(); return status(); }
  function undo() {
    mount();
    if (draft) cancelDraft(); else { strokes.pop(); scheduleRender(); }
    return status();
  }
  function destroy() {
    if (destroyed) return status();
    cancelDraft(); destroyed = true; mode = "none"; cursorHighlight = false;
    cancelAnimationFrame(frame); frame = 0; strokes.length = 0;
    window.removeEventListener("resize", scheduleRender);
    window.removeEventListener("scroll", scheduleRender, true);
    window.removeEventListener("pointermove", trackCursor, true);
    window.removeEventListener("blur", hideCursor);
    document.removeEventListener("pointerleave", hideCursor);
    window.removeEventListener("keydown", keyDown, true);
    canvas.removeEventListener("pointerdown", pointerDown);
    canvas.removeEventListener("pointermove", extendDraft);
    canvas.removeEventListener("pointerup", pointerUp);
    canvas.removeEventListener("pointercancel", pointerCancel);
    host.remove();
    if (globalThis[key] === api) delete globalThis[key];
    return status();
  }
  const api = Object.freeze({ configure, clear, undo, destroy });
  globalThis[key] = api;
  window.addEventListener("resize", scheduleRender, { passive: true });
  window.addEventListener("scroll", scheduleRender, { capture: true, passive: true });
  window.addEventListener("pointermove", trackCursor, { capture: true, passive: true });
  window.addEventListener("blur", hideCursor);
  document.addEventListener("pointerleave", hideCursor);
  window.addEventListener("keydown", keyDown, true);
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", extendDraft);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerCancel);
  configure();
})();
