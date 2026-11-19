import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const extension = new URL("../chrome-extension/", import.meta.url);
async function assistant(page, locale = "en", image = false) {
  await page.route("**/assistant-fixture/**", async route => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    if (name === "index.html") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"></head><body><button id="open">Open</button><script type="module">import {openAssistant} from "./assist-panel.js"; document.querySelector("#open").onclick=()=>openAssistant(${image ? '{image: new Blob(["fixture-image"], {type:"image/png"})}' : ""});</script></body></html>` });
    if (!["assist-panel.js", "ai-providers.js", "assist-panel.css"].includes(name)) return route.abort();
    await route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : "text/javascript", body: await readFile(new URL(name, extension)) });
  });
  await page.goto("/assistant-fixture/index.html");
  await page.locator("#open").click();
  await expect(page.locator("dialog")).toBeVisible();
}

test("the server-free AI assistant makes a request only on submit and forgets the key when closed", async ({ page }) => {
  const requests = [];
  await page.route("https://openrouter.ai/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ headers: {
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "content-type,authorization,x-title",
    }, status: 204 });
    requests.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
    await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" },
      json: { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ summary: "Fixture summary" }) } }] } });
  });
  await assistant(page, "fr");
  await expect(page.getByRole("heading", { name: "Assistant IA" })).toBeVisible();
  await page.locator("[name='provider']").selectOption("openrouter");
  await page.locator("[name='key']").fill("synthetic-test-key");
  await page.locator("[name='source']").fill("Un court texte de test.");
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Exécuter" }).click();
  await expect(page.locator("[data-result] textarea")).toHaveValue("Enregistrement\n\nFixture summary");
  expect(requests).toHaveLength(1);
  expect(requests[0].headers.authorization).toBe("Bearer synthetic-test-key");
  expect(JSON.stringify(requests[0].body)).toContain("Un court texte de test.");
  await page.getByRole("button", { name: "Fermer" }).click();
  await page.locator("#open").click();
  await page.locator("[name='provider']").selectOption("openrouter");
  await expect(page.locator("[name='key']")).toHaveValue("");
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain("synthetic-test-key");
});

test("the browser chat workflow copies only after a click and uses fixed provider links without API fields", async ({ page }) => {
  await page.addInitScript(() => {
    window.copied = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => window.copied.push(text) } });
  });
  const outsideRequests = [];
  await page.route(/^https:\/\//, route => {
    outsideRequests.push(route.request().url());
    return route.abort();
  });

  await assistant(page, "de");
  const provider = page.locator("[name='provider']");
  const source = page.locator("[name='source']");
  const key = page.locator("[name='key']"), model = page.locator("[name='model']");
  const chat = page.locator("[data-open]");
  await expect(provider).toHaveValue("chatgpt");
  await expect(key).toBeHidden();
  await expect(model).toBeHidden();
  await expect(page.locator("[data-run]")).toBeHidden();
  await expect(chat).toHaveAttribute("href", "https://chatgpt.com/");
  await expect(chat).toHaveAttribute("target", "_blank");
  await expect(chat).toHaveAttribute("rel", /noreferrer/);
  await source.fill("Nur dieser Text soll kopiert werden.");
  expect(await page.evaluate(() => window.copied)).toEqual([]);

  await page.getByRole("button", { name: "Text für Chat kopieren" }).click();
  const [prompt] = await page.evaluate(() => window.copied);
  expect(prompt).toContain("Nur dieser Text soll kopiert werden.");
  expect(prompt).toContain("de");
  await expect(page.locator("[data-status]")).toContainText("Text kopiert");

  await provider.selectOption("openrouter");
  await key.fill("fixture-key");
  await provider.selectOption("claude");
  await expect(key).toBeHidden();
  await expect(model).toBeHidden();
  await expect(key).toHaveValue("");
  await expect(source).toHaveValue("Nur dieser Text soll kopiert werden.");
  await expect(chat).toHaveAttribute("href", "https://claude.ai/");
  expect(outsideRequests).toEqual([]);
});

test("a screenshot can be saved locally and attached in chat when the clipboard is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("denied"); } } });
  });
  await assistant(page, "fr", true);
  await page.getByRole("button", { name: "Copier le texte pour le chat" }).click();
  const prompt = page.locator("[data-prompt] textarea");
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue(/image/i);
  await expect(prompt).not.toHaveValue(/fixture-image|base64/i);

  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Enregistrer l’image" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("capture-desk.png");
  expect(await readFile(await download.path(), "utf8")).toBe("fixture-image");
});

test("the extension requests native permission only on a subscription action and sends one message per port", async ({ page }) => {
  await page.addInitScript(() => {
    const runtime = { id: "capture-desk-fixture" };
    window.bridge = { permissions: [], messages: [], disconnected: 0 };

    function channel() {
      const listeners = new Set();
      return { addListener: cb => listeners.add(cb), removeListener: cb => listeners.delete(cb), emit: value => listeners.forEach(cb => cb(value)) };
    }
    function connectNative(name) {
      const onMessage = channel(), onDisconnect = channel();
      return {
        onMessage, onDisconnect,
        postMessage(request) {
          window.bridge.messages.push({ name, request });
          if (request.op === "run" && request.provider === "claude") return;
          let reply = { ok: true, connected: request.op !== "disconnect", account: "Test account" };
          if (request.provider === "chatgpt") Object.assign(reply, {
            accountId: "current", accounts: [{ id: "current", account: "Test account" }, { id: "another", account: "Other account" }],
          });
          if (request.op === "run") reply = { ok: true, answer: '{"summary":"Fixture answer"}', model: "fixture-model" };
          if (request.op === "disconnect") reply.revoked = false;
          setTimeout(() => onMessage.emit(reply), 0);
        },
        disconnect() { window.bridge.disconnected += 1; },
      };
    }
    Object.assign(window.chrome ??= {}, { runtime, permissions: { request: async value => {
      window.bridge.permissions.push(value);
      runtime.connectNative = connectNative;
      return true;
    } } });
  });
  await assistant(page);
  const provider = page.locator("[name='provider']");
  await page.locator("[name='source']").fill("Only send after clicking Run.");
  expect(await page.evaluate(() => window.bridge.messages)).toEqual([]);

  await page.getByRole("button", { name: "Check sign-in" }).click();
  await expect(page.locator("[data-account]")).toHaveText("Connected as Test account.");
  await page.getByRole("combobox", { name: "Saved ChatGPT accounts" }).selectOption("another");
  await page.getByRole("button", { name: "Use selected account" }).click();
  await expect(page.locator("[data-account]")).toHaveText("Connected as Test account.");
  await page.getByRole("button", { name: "Use another ChatGPT account" }).click();
  await expect(page.locator("[data-account]")).toHaveText("Connected as Test account.");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("[data-result] textarea")).toHaveValue(/Fixture answer/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("[data-status]")).toContainText("Signed out on this device");
  await expect(page.getByRole("link", { name: "Open ChatGPT settings" })).toBeVisible();

  await provider.selectOption("claude");
  await page.getByRole("button", { name: "Check Claude Code" }).click();
  await expect(page.locator("[data-account]")).toHaveText("Connected as Test account.");
  await page.getByRole("button", { name: "Run" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-status]")).toHaveText("Cancelled.");
  const bridge = await page.evaluate(() => window.bridge);
  const messages = bridge.messages.map(({ request }) => request);
  expect(bridge.permissions).toEqual(messages.map(() => ({ permissions: ["nativeMessaging"] })));
  expect(bridge.disconnected).toBe(7);
  expect(bridge.messages.map(item => item.name)).toEqual(Array(7).fill("com.capture_desk.ai"));
  expect(messages[0]).toEqual({ op: "status", provider: "chatgpt" });
  expect(messages[1]).toEqual({ op: "connect", provider: "chatgpt", accountId: "another" });
  expect(messages[2]).toEqual({ op: "connect", provider: "chatgpt", newAccount: true });
  expect(messages[3].request.prompt).toContain("Only send after clicking Run.");
  expect(messages[4]).toEqual({ op: "disconnect", provider: "chatgpt" });
  expect(messages[5]).toEqual({ op: "status", provider: "claude" });
  expect(messages[6].op).toBe("run");
});

test("Ollama hides the key and rejects addresses outside the local machine before a request", async ({ page }) => {
  await assistant(page, "es");
  await expect(page.getByRole("heading", { name: "Asistente de IA" })).toBeVisible();
  await page.locator("[name='provider']").selectOption("ollama");
  await expect(page.locator("[name='key']")).toBeHidden();
  await page.locator("[name='baseUrl']").fill("https://remote.example.test");
  await page.locator("[name='source']").fill("Texto de prueba.");
  await page.getByRole("button", { name: "Ejecutar" }).click();
  await expect(page.locator("[data-status]")).toContainText("dirección local de Ollama");
});
