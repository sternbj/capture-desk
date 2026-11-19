import { readFile, realpath } from "node:fs/promises";
import { endianness } from "node:os";
import { pathToFileURL } from "node:url";
import { handleClaude, findClaude } from "./claude.mjs";

export const hostName = "com.capture_desk.ai";
export const extensionIdPattern = /^[a-p]{32}$/;
const extensionOriginPattern = /^chrome-extension:\/\/[a-p]{32}\/$/;
const maxImage = 10 * 1024 * 1024;
const maxInput = 15 * 1024 * 1024;
const maxOutput = 1024 * 1024;
const integerOrder = endianness() === "LE" ? "LE" : "BE";
const decoder = new TextDecoder("utf-8", { fatal: true });
const methods = new Set(["status", "connect", "disconnect", "run"]);
const providers = new Set(["chatgpt", "claude"]);
const errorCodes = new Set(["missingClaude", "signInRequired", "planRequired", "providerError", "imageUnsupported", "cancelled"]);
const failure = (code = "providerError") => ({ ok: false, code });

function textField(value, limit) {
  return typeof value === "string" && Buffer.byteLength(value) <= limit && value.trim().length > 0;
}

function imageField(image) {
  return image && ["image/png", "image/jpeg", "image/webp"].includes(image.mime) &&
    typeof image.data === "string" && image.data.length <= Math.ceil(maxImage / 3) * 4 &&
    image.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data) &&
    Buffer.byteLength(image.data, "base64") <= maxImage;
}

function validAccountId(value) {
  return textField(value, 300) && /^[A-Za-z0-9_-]+$/.test(value);
}

function validateMessage(message) {
  if (!message || !methods.has(message.op) || !providers.has(message.provider)) return null;
  const { op, provider, request } = message;
  if (op === "connect" && provider === "chatgpt") {
    const { newAccount, accountId } = message;
    if (accountId !== undefined) {
      if (newAccount === true || !validAccountId(accountId)) return null;
      return { op, provider, accountId };
    }
    return { op, provider, ...(newAccount === true && { newAccount: true }) };
  }
  if (op !== "run") return { op, provider };
  if (!textField(request?.system, 16 * 1024) || !textField(request.prompt, 1024 * 1024)) return null;
  const { system, prompt, image } = request;
  if (image !== undefined && !imageField(image)) return null;
  return { op, provider, request: { system, prompt, ...(image && { image: { mime: image.mime, data: image.data } }) } };
}

function sanitizeResponse(response, { op, provider }) {
  if (response?.ok !== true) return failure(errorCodes.has(response?.code) ? response.code : "providerError");
  if (op === "run") {
    if (!textField(response.answer, 600000)) return failure();
    return { ok: true, answer: response.answer, ...(textField(response.model, 300) && { model: response.model }) };
  }
  const accountInfo = { ok: true, connected: response.connected === true,
    ...(textField(response.account, 300) && { account: response.account }) };
  if (provider === "chatgpt" && (op === "status" || op === "connect")) {
    if (validAccountId(response.accountId)) accountInfo.accountId = response.accountId;
    if (Array.isArray(response.accounts)) accountInfo.accounts = response.accounts.slice(0, 20)
      .filter(item => validAccountId(item?.id))
      .map(({ id, account, connected }) => ({
        id, connected: connected === true, ...(textField(account, 300) && { account }),
      }));
  }
  if (provider === "chatgpt" && op === "disconnect" && typeof response.revoked === "boolean")
    accountInfo.revoked = response.revoked;
  return accountInfo;
}

function encode(message) {
  let bytes = Buffer.from(JSON.stringify(message));
  if (bytes.length > maxOutput) bytes = Buffer.from(JSON.stringify(failure()));
  const header = Buffer.alloc(4);
  header[`writeUInt32${integerOrder}`](bytes.length);
  return Buffer.concat([header, bytes]);
}

async function dispatch(message, signal, config) {
  if (message.provider === "claude") {
    return handleClaude(message, signal, config.claudePath || await findClaude());
  }
  const { handleChatGPT } = await import("./chatgpt.mjs");
  return handleChatGPT(message, signal);
}

/**
 * A Chrome native messaging port owns one request. Keep reading stdin during
 * inference so a closed browser tab cancels the provider operation.
 */
export function serveNativeHost({
  input = process.stdin, output = process.stdout, origin, config,
  handle = dispatch, timeout = 5 * 60 * 1000,
}) {
  if (!extensionOriginPattern.test(origin) || config?.origin !== origin) {
    output.end();
    input.destroy();
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const controller = new AbortController();
    const { signal } = controller;
    const header = Buffer.alloc(4);
    let headerRead = 0;
    let bodyRead = 0;
    let body;
    let active = false;
    let finished = false;
    let abandon = false;

    function finish(response) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.removeListener("SIGTERM", disconnect);
      process.removeListener("SIGINT", disconnect);
      input.destroy();
      if (!output.destroyed && !output.writableEnded) output.end(!abandon && response ? encode(response) : undefined);
      resolve();
    }

    function disconnect() {
      abandon = true;
      controller.abort();
      if (!active) finish();
    }

    function rejectFrame() {
      controller.abort();
      finish(failure());
    }

    async function processFrame() {
      active = true;
      try {
        let message;
        try { message = validateMessage(JSON.parse(decoder.decode(body))); } catch { /* Invalid input frame. */ }
        if (!message) return finish(failure());
        const response = await handle(message, signal, config);
        finish(signal.aborted ? failure("cancelled") : sanitizeResponse(response, message));
      } catch {
        finish(failure(signal.aborted ? "cancelled" : "providerError"));
      }
    }

    function receive(chunk) {
      if (active) return rejectFrame();
      let offset = 0;
      if (!body) {
        const count = chunk.copy(header, headerRead, 0, 4 - headerRead);
        headerRead += count;
        offset += count;
        if (headerRead < 4) return;
        const length = header[`readUInt32${integerOrder}`]();
        if (length === 0 || length > maxInput) return rejectFrame();
        body = Buffer.allocUnsafe(length);
      }
      const remaining = chunk.length - offset;
      if (bodyRead + remaining > body.length) return rejectFrame();
      bodyRead += chunk.copy(body, bodyRead, offset);
      if (bodyRead === body.length) void processFrame();
    }

    const timer = setTimeout(() => {
      controller.abort();
      if (!active) finish(failure("cancelled"));
    }, timeout);
    timer.unref();
    process.once("SIGTERM", disconnect);
    process.once("SIGINT", disconnect);
    input.on("data", receive);
    input.once("end", disconnect);
    input.once("error", disconnect);
    output.once("error", disconnect);
  });
}

async function main() {
  try {
    const config = JSON.parse(await readFile(new URL("./host-config.json", import.meta.url), "utf8"));
    await serveNativeHost({ origin: process.argv[2], config });
  } catch {
    process.stdin.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => process.argv[1])).href) await main();
