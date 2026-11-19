import { AI_PROVIDERS, aiHostPermission, runBrowserAI } from "./ai-providers.js";

const words = {
  de: {
    title: "KI-Assistent", close: "Schließen", provider: "Anbieter", model: "Modell", key: "Eigener API-Schlüssel", local: "Ollama-Adresse", action: "Funktion", analyze: "Zusammenfassen", ask: "Frage stellen", translate: "Übersetzen", question: "Deine Frage", language: "Sprache der Antwort", source: "Text oder Transkript", upload: "Transkript aus Datei", send: "Ausführen", waiting: "Anfrage läuft…", stop: "Abbrechen", result: "Ergebnis", copy: "Kopieren", copied: "Ergebnis kopiert.", copyError: "Kopiere den Text direkt aus dem Ergebnisfeld.", fileError: "Wähle eine TXT-, SRT- oder VTT-Datei mit höchstens 1 MB.", keyNote: "Der Schlüssel gilt nur für dieses offene Fenster.", denied: "Der Zugriff auf den gewählten Anbieter wurde nicht erlaubt.", needsSource: "Füge zuerst Text oder ein Transkript ein.", image: "Bild für die Analyse", imageError: "Das Bild konnte nicht gelesen werden.",
    disclosure: "Nur die hier gewählten Inhalte gehen an {provider}. Der Anbieter kann Gebühren berechnen.", ollama: "Die Anfrage geht an Ollama auf diesem Computer. Ollama muss laufen und Zugriffe von dieser Seite erlauben.",
  },
  en: {
    title: "AI assistant", close: "Close", provider: "Provider", model: "Model", key: "Your API key", local: "Ollama address", action: "Action", analyze: "Summarize", ask: "Ask a question", translate: "Translate", question: "Your question", language: "Response language", source: "Text or transcript", upload: "Load transcript from file", send: "Run", waiting: "Sending request…", stop: "Cancel", result: "Result", copy: "Copy", copied: "Result copied.", copyError: "Select and copy the result directly.", fileError: "Choose a TXT, SRT or VTT file up to 1 MB.", keyNote: "The key is kept only while this dialog is open.", denied: "Access to the selected provider was declined.", needsSource: "Add text or a transcript first.", image: "Image for analysis", imageError: "The image could not be read.",
    disclosure: "Only the contents selected here go to {provider}. Your provider may charge for requests.", ollama: "The request goes to Ollama on this computer. Ollama must be running and allow requests from this page.",
  },
  fr: {
    title: "Assistant IA", close: "Fermer", provider: "Fournisseur", model: "Modèle", key: "Votre clé API", local: "Adresse Ollama", action: "Action", analyze: "Résumer", ask: "Poser une question", translate: "Traduire", question: "Votre question", language: "Langue de la réponse", source: "Texte ou transcription", upload: "Charger un fichier de transcription", send: "Exécuter", waiting: "Envoi de la demande…", stop: "Annuler", result: "Résultat", copy: "Copier", copied: "Résultat copié.", copyError: "Sélectionnez et copiez directement le résultat.", fileError: "Choisissez un fichier TXT, SRT ou VTT de 1 Mo maximum.", keyNote: "La clé est conservée uniquement pendant l’ouverture de cette fenêtre.", denied: "L’accès au fournisseur choisi a été refusé.", needsSource: "Ajoutez d’abord du texte ou une transcription.", image: "Image à analyser", imageError: "Impossible de lire l’image.",
    disclosure: "Seuls les contenus sélectionnés ici sont envoyés à {provider}. Ce fournisseur peut facturer les demandes.", ollama: "La demande est envoyée à Ollama sur cet ordinateur. Ollama doit être actif et accepter les demandes de cette page.",
  },
  es: {
    title: "Asistente de IA", close: "Cerrar", provider: "Proveedor", model: "Modelo", key: "Tu clave de API", local: "Dirección de Ollama", action: "Acción", analyze: "Resumir", ask: "Hacer una pregunta", translate: "Traducir", question: "Tu pregunta", language: "Idioma de la respuesta", source: "Texto o transcripción", upload: "Cargar un archivo de transcripción", send: "Ejecutar", waiting: "Enviando la solicitud…", stop: "Cancelar", result: "Resultado", copy: "Copiar", copied: "Resultado copiado.", copyError: "Selecciona y copia directamente el resultado.", fileError: "Elige un archivo TXT, SRT o VTT de hasta 1 MB.", keyNote: "La clave solo se conserva mientras el cuadro está abierto.", denied: "Se rechazó el acceso al proveedor seleccionado.", needsSource: "Primero añade texto o una transcripción.", image: "Imagen para analizar", imageError: "No se pudo leer la imagen.",
    disclosure: "Solo se envía a {provider} el contenido seleccionado aquí. El proveedor puede cobrar por las solicitudes.", ollama: "La solicitud va a Ollama en este equipo. Ollama debe estar en ejecución y permitir solicitudes desde esta página.",
  },
};

const languages = { de: "Deutsch", en: "English", fr: "Français", es: "Español" };
const requestErrors = {
  de: ["Nutze für Ollama eine lokale Adresse auf diesem Rechner, zum Beispiel http://127.0.0.1:11434.", "Prüfe Anbieter, Modell, Zugriff und Verbindung und versuche es erneut."],
  fr: ["Utilisez une adresse Ollama locale, par exemple http://127.0.0.1:11434.", "Vérifiez le fournisseur, le modèle, l’accès et la connexion, puis réessayez."],
  es: ["Usa una dirección local de Ollama, por ejemplo http://127.0.0.1:11434.", "Comprueba el proveedor, el modelo, el acceso y la conexión y vuelve a intentarlo."],
};
let existingDialog;

function readImage(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ mime: blob.type, data: reader.result.split(",")[1] });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function renderResult(value) {
  return [value.title, value.summary, value.answer, value.translation?.text,
    ...(value.keyPoints || []), ...(value.actionItems || [])].filter(Boolean).join("\n\n");
}

export function openAssistant({ name = "", image } = {}) {
  existingDialog?.close();
  if (!document.querySelector("link[data-assistant-styles]")) {
    const styles = document.createElement("link");
    styles.rel = "stylesheet";
    styles.href = new URL("assist-panel.css", import.meta.url).href;
    styles.dataset.assistantStyles = "";
    document.head.append(styles);
  }
  const locale = document.documentElement.lang.split("-")[0];
  const l = words[locale] || words.en;
  const dialog = document.createElement("dialog");
  dialog.className = "cd-assistant";
  dialog.setAttribute("aria-labelledby", "cd-assist-title");
  dialog.innerHTML = `
<form autocomplete="off">
  <header><h2 id="cd-assist-title">${l.title}</h2><button type="button" data-close aria-label="${l.close}">×</button></header>
  <div class="cd-assist-grid">
    <label>${l.provider}<select name="provider"></select></label>
    <label>${l.model}<input name="model" maxlength="160" required></label>
    <label data-key>${l.key}<input name="key" type="password" maxlength="1024" spellcheck="false" aria-describedby="cd-key-note"></label>
    <label data-local hidden>${l.local}<input name="baseUrl" type="url" value="http://127.0.0.1:11434" maxlength="100"></label>
    <label>${l.action}<select name="action"><option value="analyze">${l.analyze}</option><option value="ask">${l.ask}</option><option value="translate">${l.translate}</option></select></label>
    <label>${l.language}<select name="language"></select></label>
  </div>
  <p id="cd-key-note">${l.keyNote}</p>
  <label data-question hidden>${l.question}<textarea name="question" rows="2" maxlength="2000"></textarea></label>
  <section data-text>
    <label>${l.source}<textarea name="source" rows="5" maxlength="80000"></textarea></label>
    <label>${l.upload}<input name="file" type="file" accept=".txt,.srt,.vtt"></label>
  </section>
  <p data-image hidden></p>
  <p data-disclosure></p>
  <div class="cd-assist-actions"><button type="submit">${l.send}</button><button type="button" data-stop hidden>${l.stop}</button></div>
  <p data-status role="status" aria-live="polite"></p>
  <section data-result hidden><label>${l.result}<textarea readonly rows="8"></textarea></label><button type="button" data-copy>${l.copy}</button></section>
</form>`;
  const form = dialog.querySelector("form"), fields = form.elements;
  const element = attribute => dialog.querySelector(`[data-${attribute}]`);
  const status = element("status"), submit = form.querySelector('button[type="submit"]');
  const result = element("result"), output = result.querySelector("textarea");
  let controller;
  const setRunning = running => {
    for (const control of fields) control.disabled = running && !control.matches("[data-close], [data-stop]");
    fields.baseUrl.disabled = running || fields.provider.value !== "ollama";
    element("stop").hidden = !running;
    submit.disabled = running;
  };
  for (const [id, provider] of Object.entries(AI_PROVIDERS)) fields.provider.append(new Option(provider.label, id));
  for (const [id, label] of Object.entries(languages)) fields.language.append(new Option(label, id));
  fields.language.value = languages[locale] ? locale : "en";
  const refreshProvider = () => {
    const id = fields.provider.value, selected = AI_PROVIDERS[id], local = id === "ollama";
    fields.model.value = selected.model;
    fields.key.value = "";
    fields.key.required = !local;
    fields.baseUrl.disabled = !local;
    element("key").hidden = local;
    element("local").hidden = !local;
    element("disclosure").textContent = local ? l.ollama : l.disclosure.replace("{provider}", selected.label);
  };
  refreshProvider();
  fields.provider.onchange = refreshProvider;
  fields.action.onchange = () => {
    fields.question.required = fields.action.value === "ask";
    element("question").hidden = !fields.question.required;
  };
  if (image) {
    element("text").hidden = true;
    element("image").hidden = false;
    element("image").textContent = name ? l.image + " · " + name : l.image;
  }
  fields.file.onchange = async () => {
    const file = fields.file.files[0];
    try {
      if (file?.size > 1024 * 1024 || (file && !/\.(?:txt|srt|vtt)$/i.test(file.name))) throw new Error(l.fileError);
      if (file) {
        const text = await file.text();
        if (text.length > fields.source.maxLength) throw new Error(l.fileError + " · Max. 80 000");
        fields.source.value = text;
      }
      status.textContent = "";
    } catch (error) { fields.file.value = ""; status.textContent = error.message; }
  };
  element("close").onclick = () => dialog.close();
  element("stop").onclick = () => controller?.abort();
  element("copy").onclick = async () => {
    try { await navigator.clipboard.writeText(output.value); status.textContent = l.copied; }
    catch { output.select(); status.textContent = l.copyError; }
  };
  dialog.addEventListener("close", () => {
    controller?.abort();
    fields.key.value = "";
    dialog.remove();
    if (existingDialog === dialog) existingDialog = undefined;
  }, { once: true });
  form.onsubmit = async event => {
    event.preventDefault();
    if (controller) return;
    const text = fields.source.value.trim();
    if (!image && !text) { status.textContent = l.needsSource; fields.source.focus(); return; }
    const config = { provider: fields.provider.value, model: fields.model.value, key: fields.key.value.trim(), baseUrl: fields.baseUrl.value };
    const request = { action: fields.action.value, question: fields.question.value.trim(), language: fields.language.value };
    controller = new AbortController();
    setRunning(true);
    result.hidden = true;
    status.textContent = l.waiting;
    try {
      if (globalThis.chrome?.runtime?.id && chrome.permissions?.request) {
        const origin = aiHostPermission(config);
        if (!await chrome.permissions.request({ origins: [origin] })) throw new Error(l.denied);
      }
      const source = image ? { kind: "image", name, image: await readImage(image) } : { kind: "text", name, text };
      const response = await runBrowserAI(config, source, { ...request, signal: controller.signal });
      output.value = renderResult(response);
      result.hidden = false;
      status.textContent = "";
    } catch (error) {
      const localized = requestErrors[locale]?.[/loopback/i.test(error.message) ? 0 : 1];
      status.textContent = error.name === "AbortError" ? "" : error.message === l.denied ? l.denied : localized || error.message || l.imageError;
    }
    finally {
      controller = undefined;
      setRunning(false);
    }
  };
  document.body.append(dialog);
  existingDialog = dialog;
  dialog.showModal();
}
