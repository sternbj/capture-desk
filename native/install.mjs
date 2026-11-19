import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findClaude } from "./claude.mjs";
import { extensionIdPattern, hostName } from "./host.mjs";

const runtime = ["host.mjs", "claude.mjs", "chatgpt.mjs"];
const privateFile = 0o600;

async function replace(path, contents, mode = privateFile) {
  const temporary = join(dirname(path), ".capture-desk-" + randomUUID());
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function shellLiteral(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export async function installNativeHost({
  extensionId, uninstall = false, home = homedir(), platform = process.platform, node = process.execPath,
  claudePath, source = new URL("./", import.meta.url),
}) {
  if (platform !== "darwin") throw new Error("The Capture Desk AI helper currently supports Google Chrome on macOS.");
  if (!uninstall && !extensionIdPattern.test(extensionId)) throw new Error("Enter the 32-letter Capture Desk extension ID from chrome://extensions.");
  const support = join(home, "Library", "Application Support");
  const directory = join(support, "Capture Desk", "Native AI");
  const launcher = join(directory, "capture-desk-ai");
  const registry = join(support, "Google", "Chrome", "NativeMessagingHosts");
  const manifestPath = join(registry, hostName + ".json");

  if (uninstall) {
    let existing;
    try { existing = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { manifestPath }; throw error; }
    if (existing.name !== hostName || existing.path !== launcher)
      throw new Error("The existing Chrome registration points to a different program.");
    await rm(manifestPath);
    return { manifestPath };
  }

  if (!isAbsolute(node) || Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Install Node.js 22 or later, then rerun this command.");
  await access(node, constants.X_OK);
  if (claudePath) {
    if (!isAbsolute(claudePath)) throw new Error("Enter the absolute path to your Claude Code executable.");
    await access(claudePath, constants.X_OK);
  }
  const modules = await Promise.all(runtime.map(file => readFile(new URL(file, source))));
  const origin = `chrome-extension://${extensionId}/`;
  const config = { origin, claudePath: claudePath ?? await findClaude(home) };

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(registry, { recursive: true });
  for (let index = 0; index < runtime.length; index++)
    await replace(join(directory, runtime[index]), modules[index]);
  await replace(join(directory, "host-config.json"), JSON.stringify(config));
  const launch = "#!/bin/sh\nexec " + shellLiteral(node) + " " + shellLiteral(join(directory, "host.mjs")) + ' "$@"\n';
  await replace(launcher, launch, 0o700);
  const manifest = { name: hostName, description: "Capture Desk subscription assistant", path: launcher,
    type: "stdio", allowed_origins: [origin] };
  await replace(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestPath, claudePath: config.claudePath };
}

async function main(args) {
  try {
    const uninstall = args[0] === "--uninstall";
    const explicitClaude = args.length === 3 && args[1] === "--claude" && Boolean(args[2]);
    if (args.length !== 1 && !(explicitClaude && !uninstall))
      throw new Error("Usage: node native/install.mjs <extension-id> [--claude <absolute-path>] or node native/install.mjs --uninstall");
    const result = await installNativeHost({ extensionId: args[0], uninstall, claudePath: explicitClaude ? args[2] : undefined });
    if (uninstall) process.stdout.write("Capture Desk AI helper disconnected from Chrome.\n");
    else {
      process.stdout.write("Capture Desk AI helper is registered. Reopen the extension before connecting.\n");
      if (!result.claudePath) process.stdout.write("Install Claude Code separately to connect your Claude plan.\n");
    }
  } catch (error) {
    process.stderr.write((error.message || "Could not register Capture Desk AI helper.") + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => process.argv[1])).href) await main(process.argv.slice(2));
