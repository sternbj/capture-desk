// This content script is installed only on the recorder's canonical origin.
// The background worker independently checks this tab, origin and short-lived grant.
(() => {
  const origin = window.location.origin;
  const query = new URL(window.location.href).searchParams;
  const nonce = query.get("extensionImport"), extensionId = query.get("extensionId");
  if (!/^[a-f0-9]{64}$/.test(nonce || "") || extensionId !== chrome.runtime.id) return;
  const accepted = new Set(["IMPORT_METADATA", "IMPORT_CHUNK", "IMPORT_DONE"]);
  let pending = 0;
  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== origin || !message ||
        message.source !== "sternberg-recorder-app" || !accepted.has(message.type) ||
        message.nonce !== nonce || message.extensionId !== extensionId ||
        !/^[a-z0-9-]{1,80}$/i.test(message.requestId || "")) return;
    if (message.type === "IMPORT_CHUNK" &&
        (!Number.isSafeInteger(message.offset) || message.offset < 0 ||
         !Number.isSafeInteger(message.length) || message.length < 1 || message.length > 524288)) return;
    const respond = (result) => window.postMessage({
      ...result,
      source: "sternberg-recorder-extension",
      requestId: message.requestId,
      extensionId,
    }, origin);
    if (pending >= 4) { respond({ ok: false, error: "An import request is already in progress. Please retry." }); return; }
    pending++;
    try {
      const result = await chrome.runtime.sendMessage({
        target: "background", type: message.type, nonce,
        ...(message.type === "IMPORT_CHUNK" ? { offset: message.offset, length: message.length } : {}),
      });
      respond(result && typeof result === "object" ? result : { ok: false, error: "The extension did not return import data." });
    } catch (error) {
      respond({ ok: false, error: String(error?.message || "The extension connection closed.").slice(0, 300) });
    } finally { pending--; }
  });
})();
