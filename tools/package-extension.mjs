import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(project, "chrome-extension");
const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
const storeBuild = process.argv.includes("--store");
let companionOrigin = "";
if (process.env.CAPTURE_DESK_APP_ORIGIN) {
  assert.ok(!storeBuild, "The public store package does not include a deployment-specific companion");
  const url = new URL(process.env.CAPTURE_DESK_APP_ORIGIN);
  const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
  assert.ok((url.protocol === "https:" || (loopback && url.protocol === "http:")) &&
    !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "CAPTURE_DESK_APP_ORIGIN must be an HTTPS origin or a local loopback HTTP origin");
  companionOrigin = url.origin;
  manifest.content_scripts = [{ matches: [`${url.protocol}//${url.hostname}/*`], js: ["bridge.js"], run_at: "document_start" }];
}
assert.equal(manifest.manifest_version, 3);
assert.ok(manifest.name && manifest.version);
const required = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  "controls.html", "controls-view.html", "controls.js", "controls.css",
  "devices.html", "devices.js", "devices.css",
  "floatingbar.html", "floatingbar.js", "floatingbar.css",
  "editor.html", "editor.js", "editor.css", "editor-ocr.js", "video-editor.js",
  "options.html", "options.js", "options.css", "preferences.js", "theme.js", "recording-overlay.js", "recording-folder.js",
  "vendor/ocr/tesseract.min.js", "vendor/ocr/worker.min.js", "vendor/ocr/eng.traineddata.gz", "vendor/ocr/deu.traineddata.gz",
  "offscreen.html", "offscreen.js", "capture-core.js", "bridge.js",
  "app-config.js",
  "assist-panel.js", "assist-panel.css", "ai-providers.js", "i18n.js", "i18n-capture.js", "i18n-editing.js",
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
].filter(Boolean);
for (const relative of required) {
  assert.ok(!relative.includes("..") && !relative.startsWith("/"));
  assert.ok((await stat(join(extension, relative))).isFile(), `Missing extension file: ${relative}`);
}
for (const icons of [manifest.icons, manifest.action?.default_icon]) {
  assert.ok(icons && icons[16] && icons[32], "Declare extension and toolbar icons at 16 and 32 pixels");
  for (const [size, relative] of Object.entries(icons)) {
    const png = await readFile(join(extension, relative));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `Icon must be PNG: ${relative}`);
    assert.equal(png.readUInt32BE(16), Number(size), `Wrong icon width: ${relative}`);
    assert.equal(png.readUInt32BE(20), Number(size), `Wrong icon height: ${relative}`);
  }
}
async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported extension entry: ${name}`);
  }
  return files.sort();
}
const files = await listFiles(extension);
for (const file of files)
  if (file.endsWith(".js")) execFileSync(process.execPath, ["--check", join(extension, file)], { stdio: "pipe" });
const outputDirectory = join(project, "artifacts");
await mkdir(outputDirectory, { recursive: true });
const output = join(outputDirectory, storeBuild ? "Capture-Desk-Chrome-Web-Store.zip" : "ScreenRecorder-Chrome.zip");
const temporary = join(outputDirectory, `extension-${Date.now()}.zip`);
const staging = await mkdtemp(join(tmpdir(), "capture-desk-build-"));
try {
  const stagedExtension = join(staging, "chrome-extension");
  await cp(extension, stagedExtension, { recursive: true });
  await writeFile(join(stagedExtension, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(stagedExtension, "app-config.js"), `export const APP_ORIGIN = ${JSON.stringify(companionOrigin)};\n`);
  const paths = storeBuild ? files : files.map(file => join("chrome-extension", file));
  execFileSync("zip", ["-q", "-X", temporary, ...paths], { cwd: storeBuild ? stagedExtension : staging, stdio: "pipe" });
  const contents = execFileSync("unzip", ["-Z1", temporary], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(contents, paths);
  execFileSync("unzip", ["-tqq", temporary], { stdio: "pipe" });
  await rename(temporary, output);
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(temporary, { force: true });
}
const bytes = await readFile(output);
const report = {
  name: manifest.name,
  version: manifest.version,
  minimumChromeVersion: manifest.minimum_chrome_version,
  files: files.length,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
await writeFile(join(outputDirectory, storeBuild ? "chrome-web-store-package.json" : "extension-package.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ path: output, ...report }, null, 2));
