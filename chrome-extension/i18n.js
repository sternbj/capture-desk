import capture from "./i18n-capture.js";
import editing from "./i18n-editing.js";

const languages = ["de", "en", "fr", "es"];
const labels = [
  ["Sprache der Oberfläche", "Interface language", "Langue de l’interface", "Idioma de la interfaz"],
  ["Sprache von Chrome", "Chrome language", "Langue de Chrome", "Idioma de Chrome"],
  ["KI mit Transkript", "AI with transcript", "IA avec transcription", "IA con transcripción"],
  ["Capture Desk · Aufnahme beenden", "Capture Desk · Stop recording", "Capture Desk · Arrêter l’enregistrement", "Capture Desk · Detener la grabación"],
  ["Stoppen und speichern", "Stop and save", "Arrêter et enregistrer", "Detener y guardar"],
];
const rows = [...capture, ...editing, ...labels];
const key = value => value.replace(/\s+/g, " ").trim();
const exact = new Map(rows.map(row => [key(row[0]), row]));
const patterns = rows.filter(row => /\{\d+\}/.test(row[0])).map(row => {
  const parts = key(row[0]).split(/(\{\d+\})/);
  const slots = parts.filter(part => /^\{\d+\}$/.test(part));
  const matcher = new RegExp("^" + parts.map(part => /^\{\d+\}$/.test(part) ? "(.+?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");
  return { row, slots, matcher };
});
const translatedNodes = new WeakMap();
const translatedAttributes = new WeakMap();
const documents = new Map();
const attributes = ["aria-label", "title", "placeholder", "alt"];
const ignored = "script,style,code,pre,.cd-assistant,.recording-card strong,.recording-card small,[data-user-title]";
const initialLanguage = typeof document !== "undefined" ? document.documentElement.lang : "de";
let locale = "de";
const storageKey = "captureDeskLanguage";

function preferredLocale(preference) {
  const requested = preference && preference !== "auto" ? preference
    : globalThis.chrome?.i18n?.getUILanguage?.() || initialLanguage || navigator.language;
  const language = requested.toLowerCase().split(/[-_]/)[0];
  return languages.includes(language) ? language : "en";
}

export function translateText(original, language = locale) {
  const index = languages.indexOf(language);
  if (index < 1 || !original?.trim()) return original;
  const value = key(original);
  const row = exact.get(value);
  let translated = row?.[index];
  if (!translated) {
    for (const template of patterns) {
      const match = template.matcher.exec(value);
      if (!match || !template.row[index]) continue;
      translated = template.row[index].replace(/\{\d+\}/g, slot => match[template.slots.indexOf(slot) + 1]);
      break;
    }
  }
  if (!translated) return original;
  return original.match(/^\s*/)[0] + translated + original.match(/\s*$/)[0];
}

function translateNode(node) {
  if (!node.parentElement || node.parentElement.closest(ignored + ",textarea,input")) return;
  const previous = translatedNodes.get(node);
  const original = previous?.result === node.data ? previous.original : node.data;
  const result = translateText(original);
  if (result !== original) translatedNodes.set(node, { original, result });
  else translatedNodes.delete(node);
  if (node.data !== result) node.data = result;
}

function translateAttributes(element) {
  if (element.closest(ignored)) return;
  let previous = translatedAttributes.get(element);
  for (const attribute of attributes) {
    const current = element.getAttribute(attribute);
    if (current === null) continue;
    const saved = previous?.get(attribute);
    const original = saved?.result === current ? saved.original : current;
    const result = translateText(original);
    if (result !== original) {
      if (!previous) { previous = new Map(); translatedAttributes.set(element, previous); }
      previous.set(attribute, { original, result });
    } else previous?.delete(attribute);
    if (current !== result) element.setAttribute(attribute, result);
  }
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) { translateNode(root); return; }
  if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root);
  if (!root.ownerDocument && root.nodeType !== Node.DOCUMENT_NODE) return;
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) translateAttributes(node);
    else translateNode(node);
  }
}

function applyLocale(preference) {
  locale = preferredLocale(preference);
  for (const doc of documents.keys()) {
    doc.documentElement.lang = locale;
    translateTree(doc);
  }
}

export function localizeDocument(doc = document) {
  if (documents.has(doc)) { translateTree(doc); return; }
  doc.documentElement.lang = locale;
  translateTree(doc);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "characterData") translateNode(record.target);
      else if (record.type === "attributes") translateAttributes(record.target);
      else record.addedNodes.forEach(translateTree);
    }
  });
  observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
  documents.set(doc, observer);
  if (doc !== document) doc.defaultView.addEventListener("pagehide", () => { observer.disconnect(); documents.delete(doc); }, { once: true });
}

export async function enableLanguagePicker(select) {
  const stored = await chrome.storage.local.get(storageKey);
  select.value = stored[storageKey] || "auto";
  select.addEventListener("change", async () => {
    await chrome.storage.local.set({ [storageKey]: select.value });
    applyLocale(select.value);
  });
}

if (typeof document !== "undefined") {
  localizeDocument();
  globalThis.chrome?.storage?.local?.get(storageKey).then(values => applyLocale(values[storageKey])).catch(() => applyLocale("auto"));
  globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes[storageKey]) applyLocale(changes[storageKey].newValue);
  });
}
