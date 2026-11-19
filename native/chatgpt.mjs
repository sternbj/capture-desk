import { spawn, execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// Public Sign in with ChatGPT protocol for local open-source apps:
// https://developers.openai.com/siwc/token-sharing-open-source
const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const tokenUrl = issuer + "/api/accounts/oauth/token";
const authUrl = issuer + "/api/accounts/authorize";
const callbackPath = "/auth/callback";
const dynamicClient = "dynamic_agent_client";
const maxAccounts = 20;
const planScope = "chatgpt.tokens.use.direct";
const scopes = "openid profile email offline_access resource.invoke " + planScope;
const expiredRefreshCodes = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused",
]);
const planErrors = new Set([
  "subscription_sharing_user_not_eligible", "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_not_enabled", "subscription_sharing_scope_missing",
  "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context",
]);
const service = "com.capture_desk.chatgpt";
const keyAccount = "local-credential-encryption-key";
const credentialContext = Buffer.from(service + ":v1");
const exec = promisify(execFile);
const secret = () => randomBytes(32).toString("base64url");
const safeString = (value, max) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
const failure = code => ({ ok: false, code });
const problem = code => Object.assign(new Error("ChatGPT operation failed"), { code });
const validClientId = value => value !== dynamicClient && safeString(value, 300) && /^[a-zA-Z0-9_-]+$/.test(value);

function runWithInput(command, args, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(problem("providerError")));
    child.stdin.end(input);
  });
}

async function keychainKey({ create, signal }) {
  try {
    const { stdout } = await exec("/usr/bin/security", [
      "find-generic-password", "-s", service, "-a", keyAccount, "-w",
    ], { signal, timeout: 15000, maxBuffer: 4096 });
    const value = stdout.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw problem("providerError");
    return Buffer.from(value, "base64url");
  } catch (error) {
    // security returns errSecItemNotFound (-25300, truncated to an 8-bit process status).
    // Never overwrite a key that was present but could not be unlocked.
    if (!create || error.code !== 44) throw error;
  }
  const key = secret();
  // The security CLI's interactive input stays on stdin, outside process arguments.
  await runWithInput("/usr/bin/security", ["-i"],
    "add-generic-password -s " + service + " -a " + keyAccount + " -w " + key + "\n", signal);
  return Buffer.from(key, "base64url");
}

async function withFileLock(path, signal, action) {
  signal?.throwIfAborted();
  const lock = spawn("/usr/bin/lockf", ["-k", "-t", "15", path, "/bin/cat"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const acquired = new Promise((resolve, reject) => {
    lock.stdout.once("data", resolve);
    lock.once("error", reject);
    lock.once("exit", () => reject(problem("providerError")));
    lock.stdin.on("error", reject);
  });
  const cancelWait = () => lock.kill();
  signal?.addEventListener("abort", cancelWait, { once: true });
  try {
    lock.stdin.write("lock\n");
    await acquired;
    signal?.removeEventListener("abort", cancelWait);
    signal?.throwIfAborted();
    return await action();
  } finally {
    signal?.removeEventListener("abort", cancelWait);
    lock.stdin.end();
  }
}

function macStore() {
  const directory = join(homedir(), "Library", "Application Support", "Capture Desk", "Native AI");
  const path = join(directory, "chatgpt-v1.bin");
  return {
    async read(signal) {
      let payload;
      try {
        payload = await readFile(path, { signal });
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      if (payload.length < 29 || payload.length > 2 * 1024 * 1024) throw problem("providerError");
      const key = await keychainKey({ create: false, signal });
      const cipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
      cipher.setAAD(credentialContext);
      cipher.setAuthTag(payload.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(payload.subarray(28)), cipher.final()]).toString());
    },
    async write(state, signal) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const key = await keychainKey({ create: true, signal });
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(credentialContext);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
      const temporary = join(directory, ".chatgpt-" + randomUUID());
      try {
        await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600, flag: "wx", signal });
        signal?.throwIfAborted();
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async locked(signal, action) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return withFileLock(join(directory, "chatgpt.lock"), signal, action);
    },
  };
}

function prepareCallback({ state, signal, timeout }) {
  let resolveCallback;
  let rejectCallback;
  let finished = false;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // A cancellation before opening the browser is reported by the caller too.
  callback.catch(() => {});
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, (request, response) => {
    const host = "127.0.0.1:" + server.address().port;
    const headers = {
      "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'",
    };
    let url;
    try { url = new URL(request.url, "http://" + host); } catch { /* Invalid request target. */ }
    const receivedState = url?.searchParams.get("state") || "";
    const valid = !finished && request.method === "GET" && request.headers.host === host &&
      url?.host === host && url.pathname === callbackPath && url.searchParams.getAll("state").length === 1 &&
      receivedState.length === state.length && Buffer.byteLength(receivedState) === Buffer.byteLength(state) &&
      timingSafeEqual(Buffer.from(receivedState), Buffer.from(state));
    if (!valid) {
      response.writeHead(404, headers).end("This callback is unavailable.");
      return;
    }
    finished = true;
    // Do not put codes or provider errors in the returned browser page.
    response.writeHead(200, headers).end("Return to Capture Desk to continue. You can close this tab.");
    resolveCallback(url.searchParams);
  });
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  const cancel = () => rejectCallback(problem("cancelled"));
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeout);
  timer.unref();
  server.once("error", rejectCallback);
  return {
    async listen() {
      const listening = new Promise(resolve => server.once("listening", resolve));
      server.listen({ port: 0, host: "127.0.0.1", exclusive: true });
      await Promise.race([listening, callback]);
      signal?.throwIfAborted();
      return "http://127.0.0.1:" + server.address().port + callbackPath;
    },
    callback,
    close() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      stop();
    },
  };
}

async function fetchJSON(fetcher, url, { signal, ...options } = {}) {
  const deadline = AbortSignal.timeout(20000);
  const response = await fetcher(url, {
    ...options, signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: "error",
  });
  return { response, data: await response.json().catch(() => null) };
}

async function form(fetcher, url, fields, signal) {
  return fetchJSON(fetcher, url, { method: "POST", body: new URLSearchParams(fields), signal });
}

async function discover(fetcher, name, signal) {
  const { response, data } = await fetchJSON(fetcher, issuer + "/.well-known/openid-configuration", { signal });
  if (!response.ok || data?.issuer !== issuer || !safeString(data[name], 2048)) throw problem("providerError");
  const url = new URL(data[name]);
  if (url.origin !== issuer || url.username || url.password || url.hash) throw problem("providerError");
  return url.href;
}

async function verifyIdentity(fetcher, idToken, client, nonce, now, signal) {
  if (!safeString(idToken, 16000)) throw problem("providerError");
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw problem("providerError");
  const [rawHeader, rawBody, rawSignature] = parts;
  const parse = part => JSON.parse(Buffer.from(part, "base64url").toString());
  const header = parse(rawHeader);
  if (header.alg !== "RS256" || !safeString(header.kid, 300)) throw problem("providerError");
  const keysUrl = await discover(fetcher, "jwks_uri", signal);
  const { response, data } = await fetchJSON(fetcher, keysUrl, { signal });
  const key = response.ok && Array.isArray(data?.keys) && data.keys.find(candidate =>
    candidate.kid === header.kid && candidate.kty === "RSA" &&
    (!candidate.use || candidate.use === "sig") && (!candidate.alg || candidate.alg === header.alg));
  if (!key || !verify("RSA-SHA256", Buffer.from(rawHeader + "." + rawBody),
    createPublicKey({ key, format: "jwk" }), Buffer.from(rawSignature, "base64url"))) throw problem("providerError");
  const claims = parse(rawBody);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audiences.includes(client) ||
      (audiences.length > 1 && claims.azp !== client) || (claims.azp !== undefined && claims.azp !== client) ||
      !Number.isFinite(claims.exp) || claims.exp * 1000 <= now ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > now + 30000)) ||
      claims.nonce !== nonce || !safeString(claims.sub, 1000)) throw problem("providerError");
  return claims;
}

function tokenRecord(data, now, previous) {
  if (!safeString(data?.access_token, 20000) || !safeString(data.refresh_token, 20000) ||
      String(data.token_type).toLowerCase() !== "bearer" || !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 || data.expires_in > 86400) throw problem("providerError");
  const granted = grantedScopes(data, previous);
  return {
    accessToken: data.access_token, refreshToken: data.refresh_token,
    scopes: granted, expiresAt: now + data.expires_in * 1000,
  };
}

function grantedScopes(data, previous) {
  return typeof data?.scope === "string" ? data.scope.split(/\s+/) : previous?.scopes || [];
}

function registrationOnly(registration) {
  const { clientId, subject, account } = registration;
  return { clientId, subject, account };
}

function activeAccount(state) {
  return state?.registrations.find(item => item.clientId === state.activeId);
}

function publicAccountState(state) {
  const active = activeAccount(state);
  const accounts = state?.registrations.map((item, index) => {
    const label = item.account || "ChatGPT";
    const repeated = state.registrations.slice(0, index).filter(other => (other.account || "ChatGPT") === label).length;
    const account = repeated ? Buffer.from(label).subarray(0, 280).toString("utf8").replace(/\uFFFD$/, "") +
      " (" + (repeated + 1) + ")" : label;
    return { id: item.clientId, account, connected: Boolean(item.refreshToken) };
  });
  const current = accounts?.find(item => item.id === active?.clientId);
  return {
    ok: true, connected: Boolean(current?.connected),
    ...(current && { account: current.account, accountId: current.id }),
    ...(accounts?.length && { accounts }),
  };
}

function saveRegistration(state, registration) {
  const index = state.registrations.findIndex(item => item.clientId === registration.clientId);
  if (index < 0) state.registrations.push(registration);
  else state.registrations[index] = registration;
}

async function connect({ fetcher, store, openBrowser, now, authTimeout }, { newAccount, accountId }, signal) {
  return store.locked(signal, async () => {
    let state = await store.read(signal);
    if (!state) {
      state = { hostId: "urn:uuid:" + randomUUID(), registrations: [] };
      await store.write(state, signal);
    }
    const saved = accountId ? state.registrations.find(item => item.clientId === accountId)
      : newAccount ? undefined : activeAccount(state);
    if ((accountId && !saved) || (!saved && state.registrations.length >= maxAccounts)) throw problem("providerError");
    const selectedClient = saved?.clientId || state.pendingClientId;
    const verifier = secret();
    const nonce = secret();
    const callbackState = secret();
    const listener = prepareCallback({ state: callbackState, signal, timeout: authTimeout });
    try {
      const redirectUri = await listener.listen();
      const authorize = new URL(authUrl);
      authorize.search = new URLSearchParams({
        client_id: selectedClient || dynamicClient,
        ...(!selectedClient && { agent_name_hint: "Capture Desk" }),
        ...(saved?.planDisabled && { prompt: "consent" }),
        ext_agent_host_id: state.hostId, response_type: "code", redirect_uri: redirectUri,
        scope: scopes, resource, state: callbackState, nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      });
      await openBrowser(authorize.href, signal);
      const callback = await listener.callback;
      if (callback.get("error") === "access_denied") return failure("planRequired");
      const code = callback.get("code");
      const returnedClient = callback.get("client_id");
      const clientId = selectedClient || returnedClient;
      if (callback.has("error") || !safeString(code, 8192) || !validClientId(clientId) ||
          (returnedClient && returnedClient !== clientId) ||
          (!saved && state.registrations.some(item => item.clientId === clientId))) throw problem("providerError");
      if (!selectedClient) {
        // Keep the server-issued registration across a failed token exchange.
        // It cannot become active until its signed identity is verified.
        state.pendingClientId = clientId;
        await store.write(state, signal);
      }
      const { response, data } = await form(fetcher, tokenUrl, {
        grant_type: "authorization_code", client_id: clientId, code,
        code_verifier: verifier, redirect_uri: redirectUri, resource,
      }, signal);
      if (!response.ok) throw problem("providerError");
      const identity = await verifyIdentity(fetcher, data?.id_token, clientId, nonce, now(), signal);
      if (saved && identity.sub !== saved.subject) throw problem("providerError");
      const account = [identity.email, identity.name].find(value => safeString(value, 300));
      const identityRecord = { clientId, subject: identity.sub, account, idToken: data.id_token };
      const allowed = grantedScopes(data).includes(planScope);
      const registration = allowed ? { ...identityRecord, ...tokenRecord(data, now()) } : { ...identityRecord, planDisabled: true };
      saveRegistration(state, registration);
      if (clientId === state.pendingClientId) delete state.pendingClientId;
      if (allowed || !state.activeId) state.activeId = clientId;
      await store.write(state, signal);
      return allowed ? publicAccountState(state) : failure("planRequired");
    } finally {
      listener.close();
    }
  });
}

async function getSession({ fetcher, store, now }, signal, rejected) {
  return store.locked(signal, async () => {
    const state = await store.read(signal);
    const saved = activeAccount(state);
    if (saved?.planDisabled) throw problem("planRequired");
    if (!saved?.refreshToken || (rejected && rejected.clientId !== saved.clientId)) throw problem("signInRequired");
    if (saved.expiresAt - 60000 > now() && saved.accessToken !== rejected?.accessToken) return saved;
    // The provider can rotate this token even if the caller disconnects.
    const { response, data } = await form(fetcher, tokenUrl, {
      grant_type: "refresh_token", client_id: saved.clientId, refresh_token: saved.refreshToken, resource,
    });
    if (!response.ok) {
      const code = typeof data?.error === "string" ? data.error : data?.error?.code;
      if (expiredRefreshCodes.has(code)) {
        saveRegistration(state, registrationOnly(saved));
        await store.write(state);
        throw problem("signInRequired");
      }
      throw problem("providerError");
    }
    if (!grantedScopes(data, saved).includes(planScope)) {
      saveRegistration(state, { ...registrationOnly(saved), planDisabled: true });
      await store.write(state);
      throw problem("planRequired");
    }
    // After token rotation, finish the encrypted write even if the requesting tab closed.
    const updated = { ...saved, ...tokenRecord(data, now(), saved) };
    saveRegistration(state, updated);
    await store.write(state);
    return updated;
  });
}

async function disconnect({ fetcher, store }, signal) {
  return store.locked(signal, async () => {
    const state = await store.read(signal);
    const saved = activeAccount(state);
    if (!saved?.refreshToken) return publicAccountState(state);
    let revoked = false;
    for (const wait of [0, 250, 1000]) {
      try {
        if (wait) await delay(wait, undefined, { signal });
        const revokeUrl = await discover(fetcher, "revocation_endpoint", signal);
        const { response } = await form(fetcher, revokeUrl, {
          token: saved.refreshToken, token_type_hint: "refresh_token", client_id: saved.clientId,
        }, signal);
        revoked = response.status === 200;
        if (revoked || response.status < 500) break;
      } catch {
        if (signal?.aborted) break;
      }
    }
    saveRegistration(state, registrationOnly(saved));
    await store.write(state);
    return { ...publicAccountState(state), ...(!revoked && { revoked: false }) };
  });
}

function providerCode(event, fallback) {
  const code = event?.error?.code || event?.response?.error?.code || event?.code;
  if (planErrors.has(code)) return "planRequired";
  if (code === "subscription_sharing_invalid_user") return "signInRequired";
  return fallback;
}

async function readAnswer(response) {
  let answer = "";
  let received = 0;
  let pending = "";
  let completed = false;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > 8 * 1024 * 1024) throw problem("providerError");
    pending += decoder.decode(chunk, { stream: true });
    const events = pending.split(/\r?\n\r?\n/);
    pending = events.pop();
    for (const wireEvent of events) {
      const data = wireEvent.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") answer += event.delta;
      if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
        throw problem(providerCode(event, "providerError"));
      }
      if (event.type === "response.completed") completed = true;
    }
    if (completed) break;
  }
  if (!completed || !safeString(answer, 600000) || !answer.trim()) throw problem("providerError");
  return answer;
}

async function run(context, request, signal) {
  let saved = await getSession(context, signal);
  const { fetcher } = context;
  const { system, prompt, image } = request || {};
  if (!safeString(system, 16 * 1024) || !safeString(prompt, 1024 * 1024) ||
      (image !== undefined && (!image || !["image/png", "image/jpeg", "image/webp"].includes(image.mime) ||
       !safeString(image.data, Math.ceil(10 * 1024 * 1024 / 3) * 4) ||
       !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length % 4 !== 0 ||
       Buffer.byteLength(image.data, "base64") > 10 * 1024 * 1024))) throw problem("providerError");
  const headers = () => ({ Authorization: "Bearer " + saved.accessToken });
  const list = () => fetchJSON(fetcher, resource + "/models", { signal, headers: headers() });
  let catalog = await list();
  if (catalog.response.status === 401) {
    saved = await getSession(context, signal, saved);
    catalog = await list();
  }
  if (!catalog.response.ok) throw problem(providerCode(catalog.data, catalog.response.status === 401 ? "signInRequired" : "providerError"));
  const models = Array.isArray(catalog.data?.models) ? catalog.data.models.filter(model =>
    model.visibility === "list" && safeString(model.slug, 160) &&
    /^[a-z0-9][a-z0-9._-]+$/i.test(model.slug) && !/\bcodex\b/i.test(model.slug)) : [];
  const selected = models.find(model => /\bsol\b/i.test(model.slug)) || models[0];
  if (!selected) throw problem("providerError");
  const content = [{ type: "input_text", text: prompt }];
  if (image) content.push({ type: "input_image", image_url: "data:" + image.mime + ";base64," + image.data, detail: "auto" });
  const deadline = AbortSignal.timeout(240000);
  const response = await fetcher(resource + "/responses", {
    method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { ...headers(), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ model: selected.slug, instructions: system, input: [{ role: "user", content }], store: false, stream: true }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw problem(providerCode(error, response.status === 401 ? "signInRequired" : "providerError"));
  }
  return { ok: true, answer: await readAnswer(response), model: selected.slug };
}

export async function handleChatGPT(message, signal, fixture = {}) {
  const context = {
    fetcher: globalThis.fetch, store: macStore(), now: Date.now, authTimeout: 270000,
    openBrowser: (url, abortSignal) => exec("/usr/bin/open", [url], { signal: abortSignal, timeout: 10000 }),
    ...fixture,
  };
  try {
    signal?.throwIfAborted();
    switch (message?.op) {
      case "status": return publicAccountState(await context.store.read(signal));
      case "connect": return await connect(context, message, signal);
      case "disconnect": return await disconnect(context, signal);
      case "run": return await run(context, message.request, signal);
      default: return failure("providerError");
    }
  } catch (error) {
    const code = signal?.aborted ? "cancelled" : error?.code;
    return failure(["signInRequired", "planRequired", "cancelled"].includes(code) ? code : "providerError");
  }
}
