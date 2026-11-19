import { AI_PROVIDERS, aiHostPermission, finishSubscriptionAI, prepareSubscriptionAI, runBrowserAI, subscriptionHandoff } from "./ai-providers.js";

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
const subscriptions = {
  chatgpt: { label: "ChatGPT", website: "https://chatgpt.com/" },
  claude: { label: "Claude", website: "https://claude.ai/" },
};
const helperGuide = "https://github.com/sternbj/capture-desk/blob/main/docs/ai-subscriptions.md";
const subscriptionWords = {
  de: {
    connect: "Mit ChatGPT anmelden", check: "Claude Code prüfen", checkChatGPT: "Anmeldung prüfen", disconnect: "Abmelden", switchAccount: "Anderes ChatGPT-Konto nutzen",
    savedAccounts: "Gespeicherte ChatGPT-Konten", useSaved: "Gewähltes Konto nutzen", fallbackAccount: "ChatGPT-Konto {number}",
    connecting: "Schließe die Anmeldung im Browser ab…", checking: "Verbindung wird geprüft…", disconnecting: "Abmeldung läuft…",
    connected: "{provider} ist verbunden.", account: "Verbunden als {account}.", signedOut: "Abgemeldet.",
    revocationPending: "Lokal abgemeldet. Entferne den Zugriff zusätzlich in den ChatGPT-Einstellungen.", settings: "ChatGPT-Einstellungen öffnen",
    setup: "Lokalen KI-Helfer einrichten", chatgpt: "Nutze dein ChatGPT-Abo über den lokalen KI-Helfer.",
    claude: "Melde dich mit deinem Abo in Claude Code an und prüfe hier die Verbindung.",
    disclosure: "Wenn du die Anfrage ausführst, erhält {provider} den ausgewählten Text oder das ausgewählte Bild.",
    fallback: "Im Browser-Chat fortfahren", handoff: "Kopiere den vorbereiteten Text und füge ihn in {provider} ein.",
    copyPrompt: "Text für Chat kopieren", prompt: "Text für den Chat", copied: "Text kopiert. Füge ihn im Chat ein.",
    copyError: "Kopiere den markierten Text manuell.", open: "{provider} öffnen", download: "Bild speichern",
    attach: "Speichere das Bild und füge es im Chat als Anhang hinzu.", helperMissing: "Der lokale KI-Helfer ist noch nicht verfügbar. Prüfe die Einrichtung.",
    missingClaude: "Installiere oder aktualisiere Claude Code und melde dich dort mit deinem Claude-Abo an.",
    signInRequired: "Melde dich zuerst bei {provider} an.", planRequired: "Dafür brauchst du ein passendes {provider}-Abo.",
    providerError: "Die Anfrage ist fehlgeschlagen. Prüfe die Verbindung und versuche es erneut.",
    imageUnsupported: "Das Bild lässt sich hier nicht auswerten. Hänge es im Browser-Chat an.", cancelled: "Vorgang abgebrochen.",
  },
  en: {
    connect: "Continue with ChatGPT", check: "Check Claude Code", checkChatGPT: "Check sign-in", disconnect: "Sign out", switchAccount: "Use another ChatGPT account",
    savedAccounts: "Saved ChatGPT accounts", useSaved: "Use selected account", fallbackAccount: "ChatGPT account {number}",
    connecting: "Finish signing in in your browser…", checking: "Checking connection…", disconnecting: "Signing out…",
    connected: "{provider} is connected.", account: "Connected as {account}.", signedOut: "Signed out.",
    revocationPending: "Signed out on this device. Remove the app’s access in ChatGPT settings.", settings: "Open ChatGPT settings",
    setup: "Set up the local AI helper", chatgpt: "Use your ChatGPT subscription through the local AI helper.",
    claude: "Sign in to Claude Code with your subscription and check the connection here.",
    disclosure: "When you run the request, {provider} receives the selected text or image.",
    fallback: "Continue in browser chat", handoff: "Copy the prepared text and paste it into {provider}.",
    copyPrompt: "Copy text for chat", prompt: "Text for the chat", copied: "Text copied. Paste it in the chat.",
    copyError: "Copy the selected text manually.", open: "Open {provider}", download: "Save image",
    attach: "Save the image and attach it in the chat.", helperMissing: "The local AI helper is unavailable. Check its setup.",
    missingClaude: "Install or update Claude Code and sign in there with your Claude subscription.",
    signInRequired: "Sign in to {provider} first.", planRequired: "You need an eligible {provider} plan for this feature.",
    providerError: "The request failed. Check the connection and try again.",
    imageUnsupported: "This image cannot be analyzed here. Attach it in the browser chat.", cancelled: "Cancelled.",
  },
  fr: {
    connect: "Continuer avec ChatGPT", check: "Vérifier Claude Code", checkChatGPT: "Vérifier la connexion", disconnect: "Se déconnecter", switchAccount: "Utiliser un autre compte ChatGPT",
    savedAccounts: "Comptes ChatGPT enregistrés", useSaved: "Utiliser le compte sélectionné", fallbackAccount: "Compte ChatGPT {number}",
    connecting: "Terminez la connexion dans votre navigateur…", checking: "Vérification de la connexion…", disconnecting: "Déconnexion…",
    connected: "{provider} est connecté.", account: "Connecté avec le compte {account}.", signedOut: "Déconnecté.",
    revocationPending: "Déconnexion sur cet appareil. Supprimez l’accès de l’application dans les paramètres de ChatGPT.", settings: "Ouvrir les paramètres de ChatGPT",
    setup: "Configurer l’assistant IA local", chatgpt: "Utilisez votre abonnement ChatGPT via l’assistant IA local.",
    claude: "Connectez-vous à Claude Code avec votre abonnement, puis vérifiez la connexion ici.",
    disclosure: "Quand vous lancez la demande, {provider} reçoit le texte ou l’image sélectionnés.",
    fallback: "Continuer dans le chat web", handoff: "Copiez le texte préparé et collez-le dans {provider}.",
    copyPrompt: "Copier le texte pour le chat", prompt: "Texte pour le chat", copied: "Texte copié. Collez-le dans le chat.",
    copyError: "Copiez manuellement le texte sélectionné.", open: "Ouvrir {provider}", download: "Enregistrer l’image",
    attach: "Enregistrez l’image et joignez-la dans le chat.", helperMissing: "L’assistant IA local est indisponible. Vérifiez sa configuration.",
    missingClaude: "Installez ou mettez à jour Claude Code et connectez-vous avec votre abonnement Claude.",
    signInRequired: "Connectez-vous d’abord à {provider}.", planRequired: "Cette fonction nécessite un abonnement {provider} compatible.",
    providerError: "La demande a échoué. Vérifiez la connexion et réessayez.",
    imageUnsupported: "Cette image ne peut pas être analysée ici. Joignez-la dans le chat web.", cancelled: "Annulé.",
  },
  es: {
    connect: "Continuar con ChatGPT", check: "Comprobar Claude Code", checkChatGPT: "Comprobar sesión", disconnect: "Cerrar sesión", switchAccount: "Usar otra cuenta de ChatGPT",
    savedAccounts: "Cuentas de ChatGPT guardadas", useSaved: "Usar la cuenta seleccionada", fallbackAccount: "Cuenta de ChatGPT {number}",
    connecting: "Completa el inicio de sesión en tu navegador…", checking: "Comprobando la conexión…", disconnecting: "Cerrando sesión…",
    connected: "{provider} está conectado.", account: "Sesión iniciada como {account}.", signedOut: "Sesión cerrada.",
    revocationPending: "Se cerró la sesión en este dispositivo. Quita el acceso de la aplicación en los ajustes de ChatGPT.", settings: "Abrir los ajustes de ChatGPT",
    setup: "Configurar el asistente de IA local", chatgpt: "Usa tu suscripción de ChatGPT con el asistente de IA local.",
    claude: "Inicia sesión en Claude Code con tu suscripción y comprueba aquí la conexión.",
    disclosure: "Cuando ejecutes la solicitud, {provider} recibirá el texto o la imagen seleccionados.",
    fallback: "Continuar en el chat web", handoff: "Copia el texto preparado y pégalo en {provider}.",
    copyPrompt: "Copiar el texto para el chat", prompt: "Texto para el chat", copied: "Texto copiado. Pégalo en el chat.",
    copyError: "Copia a mano el texto seleccionado.", open: "Abrir {provider}", download: "Guardar imagen",
    attach: "Guarda la imagen y adjúntala en el chat.", helperMissing: "El asistente de IA local no está disponible. Revisa su configuración.",
    missingClaude: "Instala o actualiza Claude Code e inicia sesión allí con tu suscripción de Claude.",
    signInRequired: "Primero inicia sesión en {provider}.", planRequired: "Esta función requiere una suscripción compatible de {provider}.",
    providerError: "La solicitud falló. Revisa la conexión e inténtalo otra vez.",
    imageUnsupported: "La imagen no se puede analizar aquí. Adjúntala en el chat web.", cancelled: "Cancelado.",
  },
};
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

function callNative(request, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let port;
    try { port = chrome.runtime.connectNative("com.capture_desk.ai"); }
    catch { resolve({ ok: false, code: "helperMissing" }); return; }

    function close() {
      signal.removeEventListener("abort", abort);
      port.onMessage.removeListener(message);
      port.onDisconnect.removeListener(disconnected);
      port.disconnect();
    }
    function message(reply) {
      close();
      resolve(reply);
    }
    function disconnected() {
      // Reading lastError avoids an unchecked runtime error in Chrome when the host is missing.
      const failed = Boolean(chrome.runtime.lastError);
      signal.removeEventListener("abort", abort);
      port.onMessage.removeListener(message);
      port.onDisconnect.removeListener(disconnected);
      resolve({ ok: false, code: failed ? "helperMissing" : "providerError" });
    }
    function abort() {
      close();
      reject(signal.reason);
    }

    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnected);
    signal.addEventListener("abort", abort, { once: true });
    try { port.postMessage(request); }
    catch { close(); resolve({ ok: false, code: "helperMissing" }); }
  });
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
  const sub = subscriptionWords[locale] || subscriptionWords.en;
  const native = Boolean(globalThis.chrome?.runtime?.id && chrome.permissions?.request);
  const dialog = document.createElement("dialog");
  dialog.className = "cd-assistant";
  dialog.setAttribute("aria-labelledby", "cd-assist-title");
  dialog.innerHTML = `
<form autocomplete="off">
  <header><h2 id="cd-assist-title">${l.title}</h2><button type="button" data-close aria-label="${l.close}">×</button></header>
  <div class="cd-assist-grid">
    <label>${l.provider}<select name="provider"></select></label>
    <label data-model>${l.model}<input name="model" maxlength="160" required></label>
    <label data-key>${l.key}<input name="key" type="password" maxlength="1024" spellcheck="false" aria-describedby="cd-key-note"></label>
    <label data-local hidden>${l.local}<input name="baseUrl" type="url" value="http://127.0.0.1:11434" maxlength="100"></label>
    <label>${l.action}<select name="action"><option value="analyze">${l.analyze}</option><option value="ask">${l.ask}</option><option value="translate">${l.translate}</option></select></label>
    <label>${l.language}<select name="language"></select></label>
  </div>
  <p id="cd-key-note" data-key-note>${l.keyNote}</p>
  <label data-question hidden>${l.question}<textarea name="question" rows="2" maxlength="2000"></textarea></label>
  <section data-text>
    <label>${l.source}<textarea name="source" rows="5" maxlength="80000"></textarea></label>
    <label>${l.upload}<input name="file" type="file" accept=".txt,.srt,.vtt"></label>
  </section>
  <p data-image hidden></p>
  <section data-native hidden>
    <p data-native-note></p>
    <div class="cd-assist-inline">
      <button type="button" data-connect></button><button type="button" data-check hidden>${sub.checkChatGPT}</button>
      <button type="button" data-disconnect hidden>${sub.disconnect}</button><button type="button" data-switch-account hidden>${sub.switchAccount}</button>
      <a data-setup href="${helperGuide}" target="_blank" rel="noopener noreferrer">${sub.setup}</a>
    </div>
    <p data-account></p>
    <div class="cd-assist-inline" data-accounts hidden>
      <label>${sub.savedAccounts}<select name="savedAccount"></select></label>
      <button type="button" data-use-saved>${sub.useSaved}</button>
    </div>
  </section>
  <p data-disclosure></p>
  <div class="cd-assist-actions"><button type="submit" data-run>${l.send}</button><button type="button" data-stop hidden>${l.stop}</button></div>
  <details data-handoff hidden>
    <summary>${sub.fallback}</summary>
    <p data-handoff-info></p>
    <p data-attach hidden>${sub.attach}</p>
    <div class="cd-assist-inline">
      <button type="button" data-copy-prompt>${sub.copyPrompt}</button>
      <button type="button" data-download hidden>${sub.download}</button>
      <a data-open target="_blank" rel="noopener noreferrer"></a>
    </div>
    <label data-prompt hidden>${sub.prompt}<textarea readonly rows="5"></textarea></label>
  </details>
  <p data-status role="status" aria-live="polite"></p>
  <a data-revocation hidden href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">${sub.settings}</a>
  <section data-result hidden><label>${l.result}<textarea readonly rows="8"></textarea></label><button type="button" data-copy>${l.copy}</button></section>
</form>`;
  const form = dialog.querySelector("form"), fields = form.elements;
  const element = attribute => dialog.querySelector(`[data-${attribute}]`);
  const status = element("status"), submit = element("run");
  const result = element("result"), output = result.querySelector("textarea");
  const prompt = element("prompt"), promptOutput = prompt.querySelector("textarea");
  const handoff = element("handoff"), chatLink = element("open");
  const nativeAccount = element("account"), connect = element("connect"), disconnect = element("disconnect");
  const check = element("check"), revocation = element("revocation");
  const switchAccount = element("switch-account"), savedAccounts = element("accounts"), useSaved = element("use-saved");
  const providerId = () => fields.provider.value;
  const selectedSubscription = () => Object.hasOwn(subscriptions, providerId()) ? subscriptions[providerId()] : null;
  let controller, connected = false, chatGPTAccountKnown = false;

  const setAvailability = () => {
    const running = Boolean(controller);
    for (const control of fields) control.disabled = running && !control.matches("[data-close], [data-stop]");
    fields.model.disabled = running || Boolean(selectedSubscription());
    fields.key.disabled = running || providerId() !== "openrouter";
    fields.baseUrl.disabled = running || providerId() !== "ollama";
    element("stop").hidden = !running;
    disconnect.hidden = providerId() !== "chatgpt" || !connected;
    switchAccount.hidden = providerId() !== "chatgpt" || !chatGPTAccountKnown;
    savedAccounts.hidden = providerId() !== "chatgpt" || !fields.savedAccount.options.length;
  };
  for (const [id, provider] of Object.entries({ ...subscriptions, openrouter: AI_PROVIDERS.openrouter, ollama: AI_PROVIDERS.ollama })) {
    fields.provider.append(new Option(provider.label, id));
  }
  for (const [id, label] of Object.entries(languages)) fields.language.append(new Option(label, id));
  fields.language.value = languages[locale] ? locale : "en";

  const refreshProvider = () => {
    const id = providerId(), subscription = selectedSubscription(), local = id === "ollama", key = id === "openrouter";
    fields.model.value = subscription ? "" : AI_PROVIDERS[id].model;
    fields.key.value = "";
    fields.key.required = key;
    element("model").hidden = Boolean(subscription);
    element("key").hidden = !key;
    element("key-note").hidden = !key;
    element("local").hidden = !local;
    element("native").hidden = !native || !subscription;
    submit.hidden = !native && Boolean(subscription);
    handoff.hidden = !subscription;
    handoff.open = !native;
    connected = false;
    nativeAccount.textContent = "";
    check.hidden = id !== "chatgpt";
    revocation.hidden = true;
    result.hidden = true;
    output.value = "";
    prompt.hidden = true;
    promptOutput.value = "";
    status.textContent = "";

    if (subscription) {
      connect.textContent = id === "chatgpt" ? sub.connect : sub.check;
      element("native-note").textContent = sub[id];
      element("handoff-info").textContent = sub.handoff.replace("{provider}", subscription.label);
      chatLink.href = subscription.website;
      chatLink.textContent = sub.open.replace("{provider}", subscription.label);
      element("disclosure").textContent = native ? sub.disclosure.replace("{provider}", subscription.label) : "";
    } else {
      element("disclosure").textContent = local ? l.ollama : l.disclosure.replace("{provider}", AI_PROVIDERS[id].label);
    }
    setAvailability();
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
    element("attach").hidden = false;
    element("download").hidden = false;
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

  const reportInputError = () => {
    const text = fields.source.value.trim();
    if (!image && (!text || text.length > fields.source.maxLength)) {
      status.textContent = text ? l.fileError + " · Max. 80 000" : l.needsSource;
      fields.source.focus();
      return true;
    }
    if (fields.action.value === "ask" && !fields.question.value.trim()) {
      fields.question.value = "";
      fields.question.reportValidity();
      fields.question.focus();
      return true;
    }
    return false;
  };
  const sourceInput = () => image ? { kind: "image", name } : { kind: "text", name, text: fields.source.value.trim() };
  const requestInput = () => ({ action: fields.action.value, question: fields.question.value.trim(), language: fields.language.value });

  const beginRequest = (message = l.waiting) => {
    controller = new AbortController();
    setAvailability();
    result.hidden = true;
    revocation.hidden = true;
    status.textContent = message;
    return controller.signal;
  };
  const endRequest = () => {
    controller = undefined;
    setAvailability();
  };
  const showResult = value => {
    output.value = renderResult(value);
    result.hidden = false;
    status.textContent = "";
  };

  element("copy-prompt").onclick = async () => {
    if (reportInputError()) return;
    const subscription = selectedSubscription();
    let text;
    try { text = subscriptionHandoff(sourceInput(), requestInput()); }
    catch { status.textContent = sub.providerError; return; }
    try {
      await navigator.clipboard.writeText(text);
      if (!dialog.open || selectedSubscription() !== subscription) return;
      prompt.hidden = true;
      promptOutput.value = "";
      status.textContent = sub.copied;
    } catch {
      if (!dialog.open || selectedSubscription() !== subscription) return;
      promptOutput.value = text;
      prompt.hidden = false;
      promptOutput.focus();
      promptOutput.select();
      status.textContent = sub.copyError;
    }
  };
  element("download").onclick = () => {
    if (!image) return;
    const href = URL.createObjectURL(image), link = document.createElement("a");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[image.type] || "png";
    link.href = href;
    link.download = `capture-desk.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  };

  const nativeError = code => {
    const messages = ["helperMissing", "missingClaude", "signInRequired", "planRequired", "providerError", "imageUnsupported", "cancelled"];
    if (["helperMissing", "imageUnsupported"].includes(code)) handoff.open = true;
    if (["helperMissing", "missingClaude", "signInRequired"].includes(code)) {
      connected = false;
      nativeAccount.textContent = "";
    }
    const message = messages.includes(code) ? sub[code] : sub.providerError;
    status.textContent = message.replace("{provider}", selectedSubscription().label);
  };
  const loadAccounts = (accounts, accountId) => {
    const valid = accounts.filter(item => /^[a-z0-9_-]{1,300}$/i.test(item?.id || ""));
    const choices = [...new Map(valid.map(item => [item.id, item])).values()];
    fields.savedAccount.replaceChildren(...choices.map(({ id, account }, index) => {
      const fallback = sub.fallbackAccount.replace("{number}", index + 1);
      const duplicate = choices.some(other => other.id !== id && other.account === account);
      return new Option(account ? (duplicate ? `${account} · ${fallback}` : account) : fallback, id);
    }));
    if (choices.some(({ id }) => id === accountId)) fields.savedAccount.value = accountId;
    if (choices.length) chatGPTAccountKnown = true;
  };
  const runNative = async (op, { source, options, newAccount, accountId } = {}) => {
    if (controller) return;
    const provider = providerId(), subscription = selectedSubscription();
    const signal = beginRequest({ connect: sub.connecting, status: sub.checking, disconnect: sub.disconnecting }[op]);
    try {
      if (!await chrome.permissions.request({ permissions: ["nativeMessaging"] })) {
        status.textContent = l.denied;
        handoff.open = true;
        return;
      }
      signal.throwIfAborted();
      let prepared;
      if (op === "run") {
        if (image) source = { ...source, image: await readImage(image) };
        prepared = prepareSubscriptionAI(source, options);
      }
      const reply = await callNative({
        op, provider, ...(prepared && { request: prepared.request }),
        ...(newAccount && { newAccount: true }), ...(accountId && { accountId }),
      }, signal);
      if (!reply?.ok) { nativeError(reply?.code); return; }
      if (op === "run") { showResult(finishSubscriptionAI(prepared, reply, provider)); return; }

      connected = op !== "disconnect" && reply.connected === true;
      if (provider === "chatgpt") {
        if (connected || reply.account) chatGPTAccountKnown = true;
        if (Array.isArray(reply.accounts)) loadAccounts(reply.accounts, reply.accountId);
      }
      nativeAccount.textContent = connected ? (typeof reply.account === "string" && reply.account
        ? sub.account.replace("{account}", reply.account) : sub.connected.replace("{provider}", subscription.label)) : "";
      revocation.hidden = !(op === "disconnect" && reply.revoked === false);
      status.textContent = op === "disconnect" ? (revocation.hidden ? sub.signedOut : sub.revocationPending) : "";
      if (op !== "disconnect" && !connected) nativeError("signInRequired");
    } catch (error) {
      nativeError(error.name === "AbortError" ? "cancelled" : "providerError");
    } finally { endRequest(); }
  };
  connect.onclick = () => runNative(providerId() === "chatgpt" ? "connect" : "status");
  check.onclick = () => runNative("status");
  disconnect.onclick = () => runNative("disconnect");
  switchAccount.onclick = () => runNative("connect", { newAccount: true });
  useSaved.onclick = () => runNative("connect", { accountId: fields.savedAccount.value });

  form.onsubmit = async event => {
    event.preventDefault();
    if (controller || reportInputError()) return;
    const source = sourceInput(), request = requestInput();
    if (selectedSubscription()) {
      if (native) await runNative("run", { source, options: request });
      return;
    }

    const config = { provider: providerId(), model: fields.model.value, key: fields.key.value.trim(), baseUrl: fields.baseUrl.value };
    const signal = beginRequest();
    try {
      if (native) {
        const origin = aiHostPermission(config);
        if (!await chrome.permissions.request({ origins: [origin] })) throw new Error(l.denied);
      }
      const input = image ? { ...source, image: await readImage(image) } : source;
      showResult(await runBrowserAI(config, input, { ...request, signal }));
    } catch (error) {
      const localized = requestErrors[locale]?.[/loopback/i.test(error.message) ? 0 : 1];
      status.textContent = error.name === "AbortError" ? "" : error.message === l.denied ? l.denied : localized || error.message || l.imageError;
    }
    finally { endRequest(); }
  };
  document.body.append(dialog);
  existingDialog = dialog;
  dialog.showModal();
}
