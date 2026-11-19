import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fakeMediaScript } from "./media-fixture.js";

const assets = new Set(["index.html", "style.css", "locales.js", "recorder.js", "recording-store.js", "sw.js"]);
const type = { html: "text/html", css: "text/css", js: "text/javascript" };
async function openPortable(page) {
  // Test the static app at a project-site subpath, without its own backend.
  await page.route("**/portable/**", async route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1) || "index.html";
    if (!assets.has(name)) return route.abort();
    const body = await readFile(new URL("../standalone/" + name, import.meta.url));
    await route.fulfill({ contentType: type[name.split(".").at(-1)], body });
  });
  await page.addInitScript(fakeMediaScript);
  await page.goto("/portable/");
  await page.locator("#locale").selectOption("en");
}

test("portable recorder crops, pauses, resumes, downloads and restores a playable video", async ({ page }) => {
  await openPortable(page);
  await page.locator("#displayAudio").uncheck();
  await page.locator("#source").click();
  await expect(page.locator("#status")).toHaveText("Source ready");
  await page.locator("#cropArea").click();
  await expect(page.locator("#cropSelection")).toBeVisible();
  for (const [field, value] of [["left", "10"], ["top", "20"], ["width", "50"], ["height", "50"]]) {
    await page.locator("#" + field).fill(value);
    await page.locator("#" + field).press("Tab");
  }
  await page.locator("#start").click();
  await expect(page.locator("#status")).toHaveText("Recording");
  await expect(page.locator(".transport")).toHaveAttribute("data-floating", "true");
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Paused");
  await page.locator("#pause").click();
  await expect(page.locator("#status")).toHaveText("Recording");
  await page.waitForFunction(() => document.querySelector("#timer").textContent !== "00:00");
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveText("Ready to download");
  await expect(page.locator("#download")).toHaveAttribute("download", /\.(webm|mp4)$/);
  await page.waitForFunction(() => document.querySelector("#recording").readyState >= 2);
  const video = await page.locator("#recording").evaluate(video => ({
    width: video.videoWidth, height: video.videoHeight, duration: video.duration,
  }));
  expect(video.width).toBe(640);
  expect(video.height).toBe(360);
  expect(video.duration).toBeGreaterThan(.8);
  const downloaded = page.waitForEvent("download");
  await page.locator("#download").click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.(webm|mp4)$/);

  await page.reload();
  await page.locator("#showBackups").click();
  await page.locator("#backupList button").click();
  await expect(page.locator("#status")).toHaveText("Backup ready to download");
  await page.waitForFunction(() => document.querySelector("#recording").readyState >= 2);
});

test("portable recorder saves when sharing ends and persists its independent locale", async ({ page }) => {
  await openPortable(page);
  await page.locator("#locale").selectOption("de");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("#source")).toHaveText("Bildschirm oder Fenster wählen");
  await page.reload();
  await expect(page.locator("#locale")).toHaveValue("de");
  await page.locator("#locale").selectOption("fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.locator("#source")).toHaveText("Choisir un écran ou une fenêtre");
  await page.locator("#locale").selectOption("es");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.locator("#displayAudio").uncheck();
  await page.locator("#source").click();
  await page.locator("#start").click();
  await expect(page.locator("#status")).toHaveText("Grabando");
  await page.waitForFunction(() => document.querySelector("#timer").textContent !== "00:00");
  await page.evaluate(() => {
    const track = document.querySelector("#preview").srcObject.getVideoTracks()[0];
    track.stop();
    track.dispatchEvent(new Event("ended"));
  });
  await expect(page.locator("#status")).toHaveText("Vídeo listo para descargar");
  await page.waitForFunction(() => document.querySelector("#recording").readyState >= 2);
});

test("portable recorder reloads offline after a visit to its static subpath", async ({ page }) => {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const folder = "/public/portable/";
    const name = path.startsWith(folder) ? path.slice(folder.length) || "index.html" : null;
    if (!assets.has(name)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const file = await readFile(new URL("../standalone/" + name, import.meta.url));
      response.writeHead(200, { "Content-Type": type[name.split(".").at(-1)] }).end(file);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const stopServer = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  try {
    await page.goto("http://127.0.0.1:" + server.address().port + "/public/portable/");
    await page.locator("#locale").selectOption("de");
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await stopServer();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.locator("h1")).toHaveText("Bildschirmaufnahme");
  } finally {
    await stopServer();
  }
});
