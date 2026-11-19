import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";

let browser, context, page;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
beforeEach(async () => {
  context = await browser.newContext();
  await context.route("http://localhost/**", async route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (!name) return route.fulfill({ contentType: "text/html", body: "<title>Ordner-Test</title>" });
    if (!["recording-folder.js", "capture-core.js"].includes(name)) return route.abort();
    const body = await readFile(new URL(`../chrome-extension/${name}`, import.meta.url));
    return route.fulfill({ contentType: "text/javascript", body });
  });
  page = await context.newPage();
  await page.goto("http://localhost/");
});
afterEach(async () => { await context?.close(); });

// Use Chromium's private disposable filesystem for real file handles and IDB cloning.
async function selectFolder(name = "Testordner") {
  return page.evaluate(async name => {
    const module = await import("/recording-folder.js");
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(name, { create: true });
    let options;
    window.showDirectoryPicker = config => { options = config; return Promise.resolve(directory); };
    const selection = module.pickRecordingFolder();
    const calledBeforeYield = options?.mode === "readwrite";
    return { name: await selection, calledBeforeYield };
  }, name);
}

test("folder selection persists across reload, can be replaced and cleared, and survives a cancelled picker", async () => {
  assert.equal(await page.evaluate(async () => (await import("/recording-folder.js")).getRecordingFolder()), null);
  assert.deepEqual(await selectFolder(), { name: "Testordner", calledBeforeYield: true });
  await page.reload();
  const result = await page.evaluate(async () => {
    const { getRecordingFolder, pickRecordingFolder } = await import("/recording-folder.js");
    window.showDirectoryPicker = () => Promise.reject(new DOMException("Cancelled", "AbortError"));
    try { await pickRecordingFolder(); } catch (error) { if (error.name !== "AbortError") throw error; }
    return (await getRecordingFolder()).name;
  });
  assert.equal(result, "Testordner");
  assert.equal((await selectFolder("Anderer Ordner")).name, "Anderer Ordner");
  assert.equal(await page.evaluate(async () => {
    const api = await import("/recording-folder.js");
    await api.clearRecordingFolder();
    return api.getRecordingFolder();
  }), null);
});

test("records correct exported format, preserves user files and deduplicates concurrent and retried saves", async () => {
  await selectFolder();
  const info = await page.evaluate(async () => {
    const { getRecordingFolder, writeRecordingToFolder } = await import("/recording-folder.js");
    const directory = await getRecordingFolder();
    const record = { name: "Meeting / Kunde", createdAt: 1700000000000, id: "fixture-1", mimeType: "video/webm" };
    const blob = new Blob(["example video"], { type: "video/mp4;codecs=avc1" });
    const [name, concurrent] = await Promise.all([writeRecordingToFolder(record, blob), writeRecordingToFolder(record, blob)]);
    const original = await directory.getFileHandle(name);
    const userWriter = await original.createWritable();
    await userWriter.write("changed video"); // Same number of bytes; content matters.
    await userWriter.close();
    const alternate = await writeRecordingToFolder(record, blob);
    const retried = await writeRecordingToFolder(record, blob);
    return { name, concurrent, alternate, retried, count: (await Array.fromAsync(directory.keys())).length,
      original: await (await original.getFile()).text(),
      saved: await (await (await directory.getFileHandle(alternate)).getFile()).text() };
  });
  assert.match(info.name, /fixture-1/);
  assert.match(info.name, /\.mp4$/);
  assert.doesNotMatch(info.name, /[\\/:]/);
  assert.equal(info.concurrent, info.name);
  assert.notEqual(info.alternate, info.name);
  assert.equal(info.retried, info.alternate);
  assert.equal(info.count, 2);
  assert.equal(info.original, "changed video");
  assert.equal(info.saved, "example video");
});

test("saving without a grant reports the next action and never requests permission in the background", async () => {
  const write = () => page.evaluate(async () => {
    const { writeRecordingToFolder } = await import("/recording-folder.js");
    try {
      await writeRecordingToFolder({ id: "one", name: "Audio" }, new Blob(["test"], { type: "video/webm" }));
      return "";
    } catch (error) { return error.message; }
  });
  assert.match(await write(), /Ordner.*wähl|[Ww]ähle.*Ordner/i);
  await selectFolder();
  await page.evaluate(() => {
    FileSystemHandle.prototype.queryPermission = async () => "prompt";
    FileSystemHandle.prototype.requestPermission = () => { throw new Error("Unexpected permission prompt"); };
  });
  assert.match(await write(), /Ordner.*wähl|[Ww]ähle.*Ordner/i);
});

test("a worker writes to the folder selected in a window and cleans up when a write fails", async () => {
  await selectFolder();
  const result = await page.evaluate(async () => {
    const { getRecordingFolder, writeRecordingToFolder } = await import("/recording-folder.js");
    const directory = await getRecordingFolder();
    const blob = new Blob(["my test recording"], { type: "video/webm" });
    const record = { id: "worker-file", name: "Arbeitsprobe", createdAt: 1700000000000 };
    const originalWrite = FileSystemWritableFileStream.prototype.write;
    FileSystemWritableFileStream.prototype.write = async function (bytes) {
      await originalWrite.call(this, bytes.slice(0, 3));
      throw new DOMException("Test error", "QuotaExceededError");
    };
    let message;
    try { await writeRecordingToFolder(record, blob); }
    catch (error) { message = error.message; }
    finally { FileSystemWritableFileStream.prototype.write = originalWrite; }
    const afterFailure = await Array.fromAsync(directory.keys());
    const workerCode = `
      import { writeRecordingToFolder } from "http://localhost/recording-folder.js";
      onmessage = async ({data: {record, blob}}) => {
        try { postMessage({ name: await writeRecordingToFolder(record, blob) }); }
        catch (error) { postMessage({ error: error.message }); }
      };
    `;
    const url = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    try {
      const answer = await new Promise((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage({ record, blob });
      });
      if (answer.error) throw new Error(answer.error);
      const saved = await directory.getFileHandle(answer.name);
      return { message, afterFailure, saved: await (await saved.getFile()).text() };
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });
  assert.match(result.message, /Speicherplatz/);
  assert.deepEqual(result.afterFailure, []);
  assert.equal(result.saved, "my test recording");
});

test("recording export reads a fixed snapshot in bounded batches without changing its bytes or MIME", async () => {
  const result = await page.evaluate(async () => {
    const { ExtensionStore } = await import("/capture-core.js");
    const bytes = new Uint8Array(10 * 1024 * 1024 + 117);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i + (i >>> 11)) % 251;
    const type = "video/mp4;codecs=avc1,mp4a";
    const record = await ExtensionStore.putBlob({ kind: "video" }, new Blob([bytes], { type }));
    const sizes = [];
    const snapshot = await ExtensionStore.blob.call({
      get: id => ExtensionStore.get(id),
      readRange: async (id, start, end) => {
        sizes.push(end - start);
        if (start === 0) await ExtensionStore.append(id, new Blob(["later"]));
        return ExtensionStore.readRange(id, start, end);
      },
    }, record.id);
    return { sizes, size: snapshot.size, expectedSize: bytes.length, mime: snapshot.type,
      identical: new Uint8Array(await snapshot.arrayBuffer()).every((value, i) => value === bytes[i]) };
  });
  assert.ok(result.sizes.length >= 2 && Math.max(...result.sizes) <= 8 * 1024 * 1024);
  assert.equal(result.size, result.expectedSize);
  assert.equal(result.mime, "video/mp4;codecs=avc1,mp4a");
  assert.equal(result.identical, true);
});

test("empty recordings retain their MIME and a backup removed between reads fails the export", async () => {
  const result = await page.evaluate(async () => {
    const { ExtensionStore } = await import("/capture-core.js");
    const record = await ExtensionStore.begin();
    const empty = await ExtensionStore.blob(record.id);
    const block = new Blob([new Uint8Array(1024 * 1024)]);
    for (let i = 0; i < 9; i++) await ExtensionStore.append(record.id, block);
    let error;
    try {
      await ExtensionStore.blob.call({
        get: id => ExtensionStore.get(id),
        readRange: async (id, start, end) => {
          if (start > 0) await ExtensionStore.remove(id);
          return ExtensionStore.readRange(id, start, end);
        },
      }, record.id);
    } catch (failure) { error = failure.message; }
    return { empty: [empty.size, empty.type], error };
  });
  assert.deepEqual(result.empty, [0, "video/webm"]);
  assert.match(result.error || "", /unvollständig/i);
});
