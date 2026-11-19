import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { handleClaude } from "../native/claude.mjs";
import { serveNativeHost } from "../native/host.mjs";
import { installNativeHost } from "../native/install.mjs";

const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const image = { mime: "image/png", data: "iVBORw0KGgo=" };
const request = { system: "Use only the selected source.", prompt: "A private prompt · con acento", image };
const integerOrder = endianness() === "LE" ? "LE" : "BE";

function header(length) {
  const prefix = Buffer.alloc(4);
  prefix[`writeUInt32${integerOrder}`](length);
  return prefix;
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([header(body.length), body]);
}

function readReply(buffer) {
  if (!buffer.length) return null;
  const length = buffer[`readUInt32${integerOrder}`]();
  assert.equal(buffer.length, 4 + length);
  return JSON.parse(buffer.subarray(4).toString("utf8"));
}

function testPort(handle, { caller = origin } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", chunk => chunks.push(chunk));
  const reply = once(output, "end").then(() => readReply(Buffer.concat(chunks)));
  const done = serveNativeHost({ input, output, origin: caller, config: { origin }, handle });
  return { input, reply, done };
}

test("accepts one fragmented native message and limits the provider input/output fields", async () => {
  const message = { op: "run", provider: "claude", request, path: "/unexpected", apiKey: "unexpected" };
  const port = testPort(async (received, signal) => {
    assert.deepEqual(received, { op: "run", provider: "claude", request });
    assert.equal(signal.aborted, false);
    return { ok: true, answer: "résumé", model: "Claude Code", token: "unexpected" };
  });
  const encoded = frame(message);
  for (const fragment of [encoded.subarray(0, 2), encoded.subarray(2, 6), encoded.subarray(6)])
    port.input.write(fragment);
  assert.deepEqual(await port.reply, { ok: true, answer: "résumé", model: "Claude Code" });
  await port.done;
});

test("only an explicit ChatGPT connection can request a new account", async () => {
  const cases = [
    [{ op: "connect", provider: "chatgpt", newAccount: true }, { op: "connect", provider: "chatgpt", newAccount: true }],
    [{ op: "connect", provider: "chatgpt", newAccount: "true" }, { op: "connect", provider: "chatgpt" }],
    [{ op: "connect", provider: "chatgpt", accountId: "oaiapp_test-1" }, { op: "connect", provider: "chatgpt", accountId: "oaiapp_test-1" }],
    [{ op: "connect", provider: "claude", newAccount: true, accountId: "oaiapp_test-1" }, { op: "connect", provider: "claude" }],
    [{ op: "status", provider: "chatgpt", newAccount: true }, { op: "status", provider: "chatgpt" }],
  ];
  for (const [message, expected] of cases) {
    const port = testPort(async received => {
      assert.deepEqual(received, expected);
      return { ok: true, connected: true };
    });
    port.input.write(frame(message));
    assert.deepEqual(await port.reply, { ok: true, connected: true });
  }
});

test("exposes only bounded display information for saved ChatGPT accounts", async () => {
  const accounts = [
    { id: "invalid?account", account: "this ID is rejected" },
    ...Array.from({ length: 23 }, (_, index) => ({
      id: "oaiapp_" + index, account: "Account " + index, connected: index === 0,
      accessToken: "a value that must not be exposed",
    })),
  ];
  const result = { ok: true, connected: true, accountId: "oaiapp_0", accounts, refreshToken: "none", revoked: false };
  const chatgpt = testPort(async () => result);
  chatgpt.input.write(frame({ op: "status", provider: "chatgpt" }));
  const response = await chatgpt.reply;
  assert.deepEqual(Object.keys(response), ["ok", "connected", "accountId", "accounts"]);
  assert.equal(response.accountId, "oaiapp_0");
  assert.equal(response.accounts.length, 19);
  assert.deepEqual(response.accounts[0], { id: "oaiapp_0", account: "Account 0", connected: true });
  const claude = testPort(async () => result);
  claude.input.write(frame({ op: "status", provider: "claude" }));
  assert.deepEqual(await claude.reply, { ok: true, connected: true });
});

test("rejects unrelated callers, invalid shapes, oversize and extra frames before provider calls", async () => {
  let calls = 0;
  const handler = async () => { calls++; return { ok: true }; };
  const denied = testPort(handler, { caller: "chrome-extension://pppppppppppppppppppppppppppppppp/" });
  assert.equal(await denied.reply, null);
  const messages = [
    header(30 * 1024 * 1024),
    frame({ op: "run", provider: "none", request }),
    frame({ op: "connect", provider: "chatgpt", newAccount: true, accountId: "oaiapp_conflict" }),
    frame({ op: "connect", provider: "chatgpt", accountId: "oaiapp_invalid?x=y" }),
    frame({ op: "connect", provider: "chatgpt", accountId: "a".repeat(301) }),
    frame({ op: "run", provider: "claude", request: { ...request, image: { mime: "image/svg+xml", data: "" } } }),
    Buffer.concat([header(2), Buffer.from([0xc0, 0xc0])]),
    Buffer.concat([frame({ op: "status", provider: "chatgpt" }), frame({ op: "status", provider: "chatgpt" })]),
  ];
  for (const encoded of messages) {
    const port = testPort(handler);
    port.input.write(encoded);
    assert.deepEqual(await port.reply, { ok: false, code: "providerError" });
  }
  assert.equal(calls, 0);
});

test("aborts a pending request when Chrome disconnects and keeps provider errors private", async () => {
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  let cancelled = false;
  const port = testPort(async (_message, signal) => {
    begin();
    await once(signal, "abort");
    cancelled = signal.aborted;
    throw new Error("private provider error");
  });
  port.input.write(frame({ op: "run", provider: "chatgpt", request }));
  await started;
  port.input.end();
  assert.equal(await port.reply, null);
  assert.equal(cancelled, true);

  const failure = testPort(async () => { throw new Error("unexpected private output"); });
  failure.input.write(frame({ op: "status", provider: "chatgpt" }));
  assert.deepEqual(await failure.reply, { ok: false, code: "providerError" });


  const disconnected = testPort(async () => ({ ok: true, connected: false, revoked: false }));
  disconnected.input.write(frame({ op: "disconnect", provider: "chatgpt" }));
  assert.deepEqual(await disconnected.reply, { ok: true, connected: false, revoked: false });
});

async function tempDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), "capture-desk-host-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function fakeClaude(t, { method = "claude.ai", loggedIn = true } = {}) {
  const dir = await tempDirectory(t);
  const path = join(dir, "claude");
  const code = `
const fs = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
assert.equal(args[args.indexOf("--setting-sources") + 1], "");
assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).disableAllHooks, true);
if (args.includes("auth")) {
  assert.deepEqual(fs.readdirSync(process.cwd()), []);
  assert.deepEqual(args.slice(-2), ["auth", "status"]);
  process.stdout.write(JSON.stringify({ loggedIn:${loggedIn}, authMethod:${JSON.stringify(method)} }));
  process.exitCode = ${loggedIn ? 0 : 1};
} else {
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "*");
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--max-turns") + 1], "1");
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--no-session-persistence"])
    assert.ok(args.includes(flag), flag);
  assert.deepEqual(fs.readdirSync(process.cwd()), ["system.txt"]);
  const systemFile = args[args.indexOf("--system-prompt-file") + 1];
  assert.equal(fs.statSync(systemFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(systemFile, "utf8"), "Use only the selected source.");
  assert.ok(!args.includes(${JSON.stringify(request.prompt)}));
  const msg = JSON.parse(fs.readFileSync(0, "utf8"));
  assert.equal(msg.type, "user");
  assert.deepEqual(msg.message.content, [
    { type: "text", text: ${JSON.stringify(request.prompt)} },
    { type: "image", source: { type: "base64", media_type: "image/png", data: ${JSON.stringify(image.data)} } },
  ]);
  process.stdout.write(JSON.stringify({type:"system",subtype:"init",tools:[],mcp_servers:[],model:"claude-fixture"}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"résumé"}));
}`;
  await writeFile(path, `#!${process.execPath}\n${code}`, { mode: 0o700 });
  return path;
}

test("Claude streams the selected text and image with no tools or inherited credentials", async t => {
  const path = await fakeClaude(t);
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = "test-value";
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await handleClaude({ op: "connect" }, signal, path), { ok: true, connected: true, account: undefined });
  assert.deepEqual(await handleClaude({ op: "run", request }, signal, path), { ok: true, answer: "résumé", model: "claude-fixture" });
});

test("Claude requires its own subscription login before starting a model", async t => {
  const [consolePath, signedOutPath] = await Promise.all([
    fakeClaude(t, { method: "api_key" }),
    fakeClaude(t, { method: "none", loggedIn: false }),
  ]);
  const signal = new AbortController().signal;
  assert.deepEqual(await handleClaude({ op: "run", request }, signal, consolePath), { ok: false, code: "planRequired" });
  assert.deepEqual(await handleClaude({ op: "run", request }, signal, signedOutPath), { ok: false, code: "signInRequired" });
  assert.deepEqual(await handleClaude({ op: "run", request }, signal, null), { ok: false, code: "missingClaude" });
});

test("installer and launcher work from paths with spaces and apostrophes, tied to one extension ID", async t => {
  const homeBase = await tempDirectory(t);
  const home = join(homeBase, "Tester's home");
  const sourcePath = await tempDirectory(t);
  const source = pathToFileURL(sourcePath + "/");
  for (const file of ["host.mjs", "claude.mjs"]) {
    const original = await readFile(new URL("../native/" + file, import.meta.url));
    await writeFile(join(sourcePath, file), original);
  }
  await writeFile(join(sourcePath, "chatgpt.mjs"), `export async function handleChatGPT() { return { ok: true, connected: true, account: "fixture" }; }`);
  const claudePath = await fakeClaude(t);
  const extensionId = origin.split("/")[2];
  const options = { extensionId, home, source, platform: "darwin", claudePath };
  const { manifestPath } = await installNativeHost(options);
  assert.deepEqual(await installNativeHost(options), { manifestPath, claudePath });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest.allowed_origins, [origin]);
  assert.equal((await stat(manifest.path)).mode & 0o777, 0o700);

  const child = spawn(manifest.path, [origin], { stdio: ["pipe", "pipe", "ignore"] });
  const chunks = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  child.stdin.write(frame({ op: "status", provider: "chatgpt" }));
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.deepEqual(readReply(Buffer.concat(chunks)), { ok: true, connected: true, account: "fixture" });
  await installNativeHost({ ...options, uninstall: true });
  await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
  await installNativeHost({ ...options, uninstall: true });
});
