import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../chrome-extension/theme.js", import.meta.url), "utf8")).replace(/^export /gm, "");
function environment({ dark = false, preferences = {}, hold = false, fail = false } = {}) {
  const root = { dataset: {}, style: {} }, mediaListeners = new Set(), storageListeners = new Set();
  let stored = { ...preferences }, release, shouldFail = fail;
  const media = { matches: dark, addEventListener: (_type, listener) => mediaListeners.add(listener) };
  const storage = {
    local: {
      get: async () => {
        if (shouldFail) throw new Error("Storage unavailable");
        if (hold) return new Promise(resolve => { release = resolve; });
        return { recorderPreferences: { ...stored } };
      },
      set: async values => { stored = { ...values.recorderPreferences }; change(stored); },
    },
    onChanged: { addListener: listener => storageListeners.add(listener) },
  };
  function change(preferences, area = "local") {
    stored = { ...preferences };
    for (const listener of storageListeners) listener({ recorderPreferences: { newValue: preferences } }, area);
  }
  const context = { document: { documentElement: root }, chrome: { storage }, matchMedia: () => media };
  vm.runInNewContext(`${source}\nglobalThis.theme = { initializeTheme, setTheme };`, context);
  return { ...context.theme, root, change, preferences: () => stored, recover: () => { shouldFail = false; }, release: value => release(value), scheme: dark => { media.matches = dark; for (const listener of mediaListeners) listener({ matches: dark }); } };
}

test("the default follows Chrome’s color scheme and updates native control colors live", async () => {
  const env = environment({ dark: true }), changes = [];
  const theme = await env.initializeTheme({ onChange: value => changes.push(value) });
  assert.equal(theme.preference, "system"); assert.equal(theme.resolved, "dark");
  assert.equal(env.root.dataset.theme, "dark"); assert.equal(env.root.dataset.themePreference, "system");
  assert.equal(env.root.style.colorScheme, "dark");
  env.scheme(false);
  assert.equal(theme.resolved, "light"); assert.equal(env.root.style.colorScheme, "light");
  assert.equal(changes.at(-1).resolved, "light");
});

test("explicit overrides ignore Chrome changes and update when another extension surface changes storage", async () => {
  const env = environment({ dark: true, preferences: { theme: "light" } }), theme = await env.initializeTheme();
  assert.equal(theme.resolved, "light"); env.scheme(false); env.scheme(true);
  assert.equal(env.root.dataset.theme, "light");
  env.change({ theme: "dark" }); assert.equal(theme.preference, "dark");
  env.scheme(false); assert.equal(env.root.dataset.theme, "dark");
  env.change({ theme: "light" }, "sync"); assert.equal(env.root.dataset.theme, "dark");
  env.change({ theme: "system" }); assert.equal(env.root.dataset.theme, "light");
});

test("theme writes preserve other preferences and serialize rapid changes", async () => {
  const env = environment({ preferences: { theme: "system", lastTab: "screenshot", futurePreference: "keep" } });
  const theme = await env.initializeTheme();
  await Promise.all([env.setTheme("light"), theme.setTheme("dark")]);
  assert.deepEqual(env.preferences(), { theme: "dark", lastTab: "screenshot", futurePreference: "keep" });
  assert.equal(theme.resolved, "dark");
  await theme.setTheme("system"); env.scheme(true);
  assert.equal(env.root.dataset.theme, "dark"); assert.equal(env.root.dataset.themePreference, "system");
});

test("a late initial storage read does not overwrite a newer live override", async () => {
  const env = environment({ dark: false, hold: true });
  const pending = env.initializeTheme();
  assert.equal(env.root.dataset.theme, "light");
  env.change({ theme: "dark" });
  env.release({ recorderPreferences: { theme: "light" } });
  const theme = await pending;
  assert.equal(theme.preference, "dark"); assert.equal(env.root.dataset.theme, "dark");
});

test("initial storage failure retains the Chrome fallback and an explicit retry can recover", async () => {
  const env = environment({ dark: true, fail: true });
  await assert.rejects(env.initializeTheme(), /Storage unavailable/);
  assert.equal(env.root.dataset.theme, "dark");
  env.recover(); await env.setTheme("light");
  assert.equal(env.root.dataset.theme, "light"); assert.equal(env.preferences().theme, "light");
});
