import { spawn } from "node:child_process";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const safeSettings = ["--setting-sources", "", "--settings", '{"disableAllHooks":true}'];
const printArgs = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--tools", "", "--disallowedTools", "*", "--strict-mcp-config", "--disable-slash-commands",
  "--no-chrome", "--no-session-persistence", "--max-turns", "1", ...safeSettings,
];

const error = code => ({ ok: false, code });

export async function findClaude(home = homedir()) {
  const paths = [
    join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch { /* Try the next standard installation path. */ }
  }
  return null;
}

function cliEnvironment(path, cwd) {
  const env = {
    HOME: homedir(),
    PATH: [dirname(process.execPath), dirname(path), "/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"].join(":"),
    PWD: cwd,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runClaude(path, args, { cwd, input, signal, timeout, limit }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, {
      cwd, env: cliEnvironment(path, cwd), shell: false, stdio: ["pipe", "pipe", "ignore"],
    });
    const output = [];
    let size = 0;
    let stopped = false;
    let forceKill;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 2000);
      forceKill.unref();
    };
    const timer = setTimeout(stop, timeout);
    timer.unref();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > limit) stop();
      if (!stopped) output.push(chunk);
    });
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal.removeEventListener("abort", stop);
      if (stopped) reject(new Error("Claude Code did not complete."));
      else resolve({ code, text: Buffer.concat(output).toString("utf8") });
    });
  });
}

function parseClaudeResponse(text) {
  let result;
  let model;
  for (const line of text.trim().split("\n")) {
    const event = JSON.parse(line);
    if (event.type === "system" && event.subtype === "init") {
      // The CLI enumerates tools in its init event. Reject any unexpected
      // tool setup rather than displaying a response from an agent session.
      if (event.tools?.length || event.mcp_servers?.length) return error("providerError");
      model = event.model;
    }
    if (event.type === "assistant" && event.message?.content?.some(part => part.type === "tool_use"))
      return error("providerError");
    if (event.type === "result") result = event;
  }
  return result?.subtype === "success" && !result.is_error && typeof result.result === "string" && result.result.trim()
    ? { ok: true, answer: result.result, model: model || "Claude Code" }
    : error("providerError");
}

export async function handleClaude(message, signal, path) {
  if (message.op === "disconnect") return { ok: true, connected: false };
  // The path is selected locally by the installer and is never part of a browser message.
  if (!path || !isAbsolute(path)) return error("missingClaude");
  try { await access(path, constants.X_OK); } catch { return error("missingClaude"); }

  const cwd = await mkdtemp(join(tmpdir(), "capture-desk-ai-"));
  try {
    const auth = await runClaude(path, [...safeSettings, "auth", "status"], {
      cwd, signal, timeout: 12000, limit: 16 * 1024,
    });
    let status;
    try { status = JSON.parse(auth.text); } catch { return error("missingClaude"); }
    if (!status?.loggedIn) return error("signInRequired");
    if (auth.code !== 0 || status.authMethod !== "claude.ai") return error("planRequired");
    if (message.op !== "run") {
      return { ok: true, connected: true, account: status.email || status.emailAddress };
    }

    const { system, prompt, image } = message.request;
    // The documented Claude SDK transport uses stream-json user messages
    // on stdin. Text and image bytes never enter command-line arguments.
    const content = [{ type: "text", text: prompt }];
    if (image) content.push({ type: "image", source: {
      type: "base64", media_type: image.mime, data: image.data,
    } });
    const input = JSON.stringify({
      type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "",
    }) + "\n";
    const systemFile = join(cwd, "system.txt");
    await writeFile(systemFile, system, { mode: 0o600, flag: "wx" });
    const result = await runClaude(path, [...printArgs, "--system-prompt-file", systemFile], {
      cwd, input, signal, timeout: 240000, limit: 2 * 1024 * 1024,
    });
    if (result.code !== 0) return error("providerError");
    return parseClaudeResponse(result.text);
  } catch {
    return error(signal.aborted ? "cancelled" : "providerError");
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
