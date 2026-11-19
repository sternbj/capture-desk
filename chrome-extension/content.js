// Isolated-world helpers only; no recording controls are inserted into the page.
(() => {
  if (globalThis.__sternbergPageCapture) return;
  let original, regionResizeListener;
  const metrics = () => ({ width: innerWidth, height: innerHeight,
    totalHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    dpr: devicePixelRatio, x: scrollX, y: scrollY, title: document.title, url: location.href });
  globalThis.__sternbergPageCapture = {
    metrics,
    watchRegion() {
      if (regionResizeListener) removeEventListener("resize", regionResizeListener);
      regionResizeListener = () => chrome.runtime.sendMessage({ target: "background", type: "REGION_VIEWPORT_CHANGED", width: innerWidth, height: innerHeight }).catch(() => {});
      addEventListener("resize", regionResizeListener, { passive: true });
      return metrics();
    },
    unwatchRegion() {
      if (regionResizeListener) removeEventListener("resize", regionResizeListener);
      regionResizeListener = null;
      return true;
    },
    selectRegion(text) {
      return new Promise(resolve => {
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;touch-action:none";
        const shadow = host.attachShadow({ mode: "closed" });
        const shade = document.createElement("div"), selection = document.createElement("div"), hint = document.createElement("div");
        shade.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,.22)";
        selection.style.cssText = "position:absolute;border:2px solid #5788ff;background:rgba(87,136,255,.1);display:none;box-sizing:border-box";
        hint.style.cssText = "position:absolute;top:16px;left:50%;transform:translateX(-50%);padding:10px 16px;border-radius:8px;background:#fff;color:#202735;font:14px system-ui,sans-serif;box-shadow:0 2px 16px #0003;white-space:nowrap";
        hint.textContent = typeof text === "string" && text ? text : "Bereich mit der Maus aufziehen · Esc zum Abbrechen";
        shadow.append(shade, selection, hint); document.documentElement.append(host);
        let start;
        const done = rect => { document.removeEventListener("keydown", keydown, true); host.remove(); resolve(rect); };
        const keydown = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); done(null); } };
        document.addEventListener("keydown", keydown, true);
        host.addEventListener("pointerdown", event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          start = { x: Math.max(0, event.clientX), y: Math.max(0, event.clientY) };
          host.setPointerCapture(event.pointerId); selection.style.display = "block";
        });
        const rectFor = event => ({ x: Math.min(start.x, Math.max(0, event.clientX)), y: Math.min(start.y, Math.max(0, event.clientY)),
          width: Math.min(innerWidth, Math.abs(event.clientX - start.x)), height: Math.min(innerHeight, Math.abs(event.clientY - start.y)), viewportWidth: innerWidth, viewportHeight: innerHeight });
        host.addEventListener("pointermove", event => {
          if (!start) return;
          const rect = rectFor(event);
          Object.assign(selection.style, { left: rect.x + "px", top: rect.y + "px", width: rect.width + "px", height: rect.height + "px" });
        });
        host.addEventListener("pointerup", event => {
          if (!start) return;
          const rect = rectFor(event);
          if (rect.width < 4 || rect.height < 4) { start = null; selection.style.display = "none"; return; }
          done(rect);
        });
      });
    },
    prepare() {
      if (original) this.restore();
      original = { x: scrollX, y: scrollY, elements: [], styles: [] };
      for (const [element, property] of [[document.documentElement, "scroll-behavior"], [document.documentElement, "scroll-snap-type"], [document.body, "scroll-behavior"]])
        if (element) original.styles.push([element, property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
      document.documentElement.style.setProperty("scroll-behavior", "auto", "important");
      document.documentElement.style.setProperty("scroll-snap-type", "none", "important");
      if (document.body) document.body.style.setProperty("scroll-behavior", "auto", "important");
      for (const element of document.querySelectorAll("body *")) {
        const style = getComputedStyle(element);
        if (["fixed", "sticky"].includes(style.position) && element.getBoundingClientRect().height > 0)
          original.elements.push([element, element.style.getPropertyValue("visibility"), element.style.getPropertyPriority("visibility")]);
      }
      scrollTo({ left: 0, top: 0, behavior: "instant" });
      return metrics();
    },
    scroll(y) {
      if (!original) throw new Error("Page capture is not prepared");
      for (const [element, value, priority] of original.elements) {
        if (y > 0) element.style.setProperty("visibility", "hidden", "important");
        else if (value) element.style.setProperty("visibility", value, priority);
        else element.style.removeProperty("visibility");
      }
      scrollTo({ left: 0, top: y, behavior: "instant" });
      return metrics();
    },
    restore() {
      if (!original) return;
      for (const [element, value, priority] of original.elements) {
        if (value) element.style.setProperty("visibility", value, priority);
        else element.style.removeProperty("visibility");
      }
      for (const [element, property, value, priority] of original.styles) {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      }
      scrollTo({ left: original.x, top: original.y, behavior: "instant" });
      original = null;
    },
  };
})();
