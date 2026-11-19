const allowed = new Set(["system", "light", "dark"]);
const normalize = value => allowed.has(value) ? value : "system";
const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
const subscribers = new Set();
let preference = "system", started = false, ready, revision = 0, writeQueue = Promise.resolve();

function resolvedTheme() { return preference === "system" ? media?.matches ? "dark" : "light" : preference; }
function apply() {
  const resolved = resolvedTheme(), root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  for (const listener of subscribers) listener({ preference, resolved });
}
function storageChanged(changes, area) {
  if (area !== "local" || !Object.hasOwn(changes, "recorderPreferences")) return;
  ++revision;
  preference = normalize(changes.recorderPreferences.newValue?.theme);
  apply();
}
function start() {
  if (started) return ready;
  started = true;
  // Resolve the browser scheme before waiting for extension storage.
  apply();
  if (media?.addEventListener) media.addEventListener("change", apply);
  else media?.addListener?.(apply);
  globalThis.chrome?.storage?.onChanged?.addListener(storageChanged);
  const version = revision;
  ready = (async () => {
    const stored = await chrome.storage.local.get("recorderPreferences");
    if (revision === version) { preference = normalize(stored.recorderPreferences?.theme); apply(); }
  })();
  return ready;
}

export async function initializeTheme({ onChange } = {}) {
  if (typeof onChange === "function") subscribers.add(onChange);
  const loading = start();
  if (typeof onChange === "function") onChange({ preference, resolved: resolvedTheme() });
  await loading;
  return {
    get preference() { return preference; },
    get resolved() { return resolvedTheme(); },
    setTheme,
    destroy() { if (typeof onChange === "function") subscribers.delete(onChange); },
  };
}

export async function setTheme(value) {
  await start().catch(() => {});
  const next = normalize(value);
  const write = writeQueue.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get("recorderPreferences");
    await chrome.storage.local.set({ recorderPreferences: { ...stored.recorderPreferences, theme: next } });
    preference = next; ++revision; apply();
    return { preference, resolved: resolvedTheme() };
  });
  writeQueue = write;
  return write;
}
