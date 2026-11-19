import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const extension = new URL("../chrome-extension/", import.meta.url);
async function assistant(page, locale = "en") {
  await page.route("**/assistant-fixture/**", async route => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    if (name === "index.html") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"></head><body><button id="open">Open</button><script type="module">import {openAssistant} from "./assist-panel.js"; document.querySelector("#open").onclick=()=>openAssistant();</script></body></html>` });
    if (!["assist-panel.js", "ai-providers.js", "assist-panel.css"].includes(name)) return route.abort();
    await route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : "text/javascript", body: await readFile(new URL(name, extension)) });
  });
  await page.goto("/assistant-fixture/index.html");
  await page.locator("#open").click();
  await expect(page.locator("dialog")).toBeVisible();
}

test("the server-free AI assistant makes a request only on submit and forgets the key when closed", async ({ page }) => {
  const requests = [];
  await page.route("https://api.anthropic.com/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ headers: {
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "content-type,anthropic-version,x-api-key,anthropic-dangerous-direct-browser-access",
    }, status: 204 });
    requests.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
    await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" },
      json: { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ summary: "Fixture summary" }) }] } });
  });
  await assistant(page, "fr");
  await expect(page.getByRole("heading", { name: "Assistant IA" })).toBeVisible();
  await page.locator("[name='provider']").selectOption("anthropic");
  await page.locator("[name='key']").fill("synthetic-test-key");
  await page.locator("[name='source']").fill("Un court texte de test.");
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Exécuter" }).click();
  await expect(page.locator("[data-result] textarea")).toHaveValue("Enregistrement\n\nFixture summary");
  expect(requests).toHaveLength(1);
  expect(requests[0].headers["x-api-key"]).toBe("synthetic-test-key");
  expect(JSON.stringify(requests[0].body)).toContain("Un court texte de test.");
  await page.getByRole("button", { name: "Fermer" }).click();
  await page.locator("#open").click();
  await expect(page.locator("[name='key']")).toHaveValue("");
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain("synthetic-test-key");
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
