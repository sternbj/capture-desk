export const defaultPreferences = Object.freeze({
  screenshotDelaySeconds: 3,
  desktopDelaySeconds: 0,
  skipAnnotation: "never",
  screenshotFormat: "png",
  autoDownload: false,
  downloadDirectory: "",
  askWhereToSave: true,
  addDateUrl: false,
  retinaScale: false,
  dateFormat: "dmy",
  timeFormat: "24",
  defaultTab: "last",
  theme: "system",
  showContextMenu: true,
  filenamePrefix: "Screenshot",
});

const choices = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const boolean = (value, fallback) => typeof value === "boolean" ? value : fallback;
const seconds = (value, allowed, fallback) => choices(Number(value), allowed, fallback);

// Chrome downloads accept paths relative to the browser's download directory.
// Reject traversal and absolute paths instead of turning them into new targets.
export function safeDownloadDirectory(value = "") {
  if (typeof value !== "string") return "";
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.length > 160 || /^(?:\/|[a-z]:|~(?:\/|$))/i.test(path)) return "";
  const parts = path.split("/");
  if (parts.some(part => !part.trim() || /^\.{1,2}$/.test(part.trim()))) return "";
  const clean = parts.map(part => part.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, "-").trim().replace(/[. ]+$/g, ""));
  if (clean.some(part => !part || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return "";
  return clean.join("/");
}

export function normalizePreferences(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  let filenamePrefix = typeof input.filenamePrefix === "string"
    ? input.filenamePrefix.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-").replace(/\s+/g, " ").trim().replace(/^[. ]+|[. ]+$/g, "").slice(0, 60).trim()
    : "";
  if (!filenamePrefix) filenamePrefix = defaultPreferences.filenamePrefix;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filenamePrefix)) filenamePrefix = `_${filenamePrefix}`;
  return {
    screenshotDelaySeconds: seconds(input.screenshotDelaySeconds, [3, 5, 10], defaultPreferences.screenshotDelaySeconds),
    desktopDelaySeconds: seconds(input.desktopDelaySeconds, [0, 3, 5, 10], defaultPreferences.desktopDelaySeconds),
    skipAnnotation: choices(input.skipAnnotation, ["never", "always", "fullpage"], defaultPreferences.skipAnnotation),
    screenshotFormat: choices(input.screenshotFormat, ["png", "jpeg", "webp"], defaultPreferences.screenshotFormat),
    autoDownload: boolean(input.autoDownload, defaultPreferences.autoDownload),
    downloadDirectory: safeDownloadDirectory(input.downloadDirectory),
    askWhereToSave: boolean(input.askWhereToSave, defaultPreferences.askWhereToSave),
    addDateUrl: boolean(input.addDateUrl, defaultPreferences.addDateUrl),
    retinaScale: boolean(input.retinaScale, defaultPreferences.retinaScale),
    dateFormat: choices(input.dateFormat, ["dmy", "ymd", "mdy"], defaultPreferences.dateFormat),
    timeFormat: choices(String(input.timeFormat ?? ""), ["24", "12"], defaultPreferences.timeFormat),
    defaultTab: choices(input.defaultTab, ["record", "screenshot", "last"], defaultPreferences.defaultTab),
    theme: choices(input.theme, ["system", "light", "dark"], defaultPreferences.theme),
    showContextMenu: boolean(input.showContextMenu, defaultPreferences.showContextMenu),
    filenamePrefix,
  };
}

export async function updatePreferences(storage, patch = {}) {
  const saved = await storage.get("recorderPreferences");
  const previous = saved?.recorderPreferences;
  const existing = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
  const preferences = normalizePreferences({ ...existing, ...patch });
  await storage.set({ recorderPreferences: { ...existing, ...preferences } });
  return preferences;
}

// Read current capture settings immediately before saving, so a settings page
// never overwrites a newer microphone, source, format or storage selection.
export async function updateCapturePreferences(storage, input = {}) {
  const saved = await storage.get("captureSettings");
  const existing = saved?.captureSettings && typeof saved.captureSettings === "object" ? saved.captureSettings : {};
  const duration = Number(input.autoStopSeconds);
  const settings = {
    ...existing,
    countdown: seconds(input.countdown, [0, 3, 5, 10], 3),
    autoStopSeconds: Number.isFinite(duration) && duration >= 0 ? Math.min(21600, Math.round(duration)) : 0,
    microphoneReminder: boolean(input.microphoneReminder, true),
  };
  await storage.set({ captureSettings: settings });
  return settings;
}
