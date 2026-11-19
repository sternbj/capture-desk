import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { handleChatGPT } from "../native/chatgpt.mjs";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const plan = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const client = "oaiapp_capture_desk_fixture";
const instant = Date.UTC(2026, 10, 19);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", use: "sig", alg: "RS256" };
const json = (object, status = 200) => new Response(JSON.stringify(object), { status });
const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");

function token(claims) {
  const prefix = part({ kid: jwk.kid, alg: jwk.alg }) + "." + part(claims);
  return prefix + "." + sign("RSA-SHA256", Buffer.from(prefix), privateKey).toString("base64url");
}

function sse(events) {
  const body = Buffer.from(events.map(event => "data: " + JSON.stringify(event) + "\r\n\r\n").join(""));
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < body.length; i += 11) controller.enqueue(body.subarray(i, i + 11));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

function fixture({
  callbacks = {}, claims = {}, scope = plan, terminal = true,
  revoked = true, refreshError, corruptSignature = false, failExchangeOnce = false,
} = {}) {
  let state;
  let clock = instant;
  let attempts = 0;
  let activeAuthorization;
  let browserAccount = { id: client, claims };
  const issuedClients = new Set();
  const calls = [];
  const store = {
    locked: (_signal, action) => action(),
    read: () => structuredClone(state),
    write: value => { state = structuredClone(value); },
  };
  const openBrowser = async value => {
    activeAuthorization = new URL(value);
    const query = activeAuthorization.searchParams;
    assert.equal(activeAuthorization.origin + activeAuthorization.pathname, issuer + "/api/accounts/authorize");
    assert.equal(query.get("response_type"), "code");
    assert.equal(query.get("resource"), resource);
    assert.equal(query.get("scope"), plan);
    assert.equal(query.get("code_challenge_method"), "S256");
    assert.match(query.get("ext_agent_host_id"), /^urn:uuid:/);
    const callback = new URL(query.get("redirect_uri"));
    assert.equal(callback.hostname, "127.0.0.1");
    assert.equal(callback.pathname, "/auth/callback");
    callback.searchParams.set("state", "attacker-guess");
    assert.equal((await fetch(callback)).status, 404);
    callback.search = new URLSearchParams({
      code: "fixture-auth-code", state: query.get("state"), client_id: browserAccount.id, ...callbacks,
    });
    assert.equal((await fetch(callback)).status, 200);
  };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    if (url === issuer + "/api/accounts/oauth/token") {
      const form = options.body;
      assert.equal(options.method, "POST");
      assert.equal(form.get("client_id"), browserAccount.id);
      assert.equal(form.get("resource"), resource);
      if (form.get("grant_type") === "refresh_token") {
        assert.equal(form.get("scope"), null);
        assert.equal(form.get("refresh_token"), "synthetic-refresh-" + attempts);
        if (refreshError) return json({ error: refreshError }, 400);
      } else {
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("code"), "fixture-auth-code");
        assert.equal(form.get("redirect_uri"), activeAuthorization.searchParams.get("redirect_uri"));
        assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"),
          activeAuthorization.searchParams.get("code_challenge"));
        const known = issuedClients.has(browserAccount.id);
        assert.equal(activeAuthorization.searchParams.get("client_id"), known ? browserAccount.id : "dynamic_agent_client");
        assert.equal(activeAuthorization.searchParams.get("agent_name_hint"), known ? null : "Capture Desk");
        issuedClients.add(browserAccount.id);
        if (failExchangeOnce) {
          failExchangeOnce = false;
          return json({ error: "invalid_grant" }, 400);
        }
      }
      attempts++;
      let identity = token({
        aud: browserAccount.id, iss: issuer, exp: clock / 1000 + 3600, nonce: activeAuthorization.searchParams.get("nonce"),
        sub: "fixture-subject", email: "example@example.org", ...browserAccount.claims,
      });
      if (corruptSignature) {
        const lastPart = identity.lastIndexOf(".") + 1;
        identity = identity.slice(0, lastPart) + (identity[lastPart] === "a" ? "b" : "a") + identity.slice(lastPart + 1);
      }
      return json({
        access_token: "synthetic-access-" + attempts, expires_in: 3600, token_type: "Bearer",
        refresh_token: "synthetic-refresh-" + attempts, id_token: identity, scope,
      });
    }
    if (url === issuer + "/.well-known/openid-configuration") {
      return json({ issuer, jwks_uri: issuer + "/fixture-jwks", revocation_endpoint: issuer + "/fixture-revoke" });
    }
    if (url === issuer + "/fixture-jwks") return json({ keys: [jwk] });
    if (url === issuer + "/fixture-revoke") {
      assert.deepEqual(Object.fromEntries(options.body), {
        token: "synthetic-refresh-" + attempts, token_type_hint: "refresh_token", client_id: browserAccount.id,
      });
      return new Response(null, { status: revoked ? 200 : 403 });
    }
    assert.equal(options.headers.Authorization, "Bearer synthetic-access-" + attempts);
    if (url === resource + "/models") return json({ models: [
      { slug: "gpt-6.2-hidden", visibility: "hidden" }, { slug: "gpt-6.2-sol", visibility: "list" },
    ] });
    if (url === resource + "/responses") {
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Accept, "text/event-stream");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-6.2-sol");
      assert.equal(body.instructions, "Analyze the selected recording.");
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(body.tools, undefined);
      assert.equal(body.input[0].role, "user");
      assert.deepEqual(body.input[0].content[0], { type: "input_text", text: "Question about this frame" });
      if (body.input[0].content.length === 2) {
        assert.deepEqual(body.input[0].content[1], { type: "input_image", image_url: "data:image/png;base64,Zg==", detail: "auto" });
      }
      return sse([
        { type: "response.output_text.delta", delta: "Capturé " },
        { type: "response.output_text.delta", delta: "✓" },
        ...(terminal ? [{ type: "response.completed" }] : []),
      ]);
    }
    throw new Error("Unexpected network request");
  };
  const context = { store, now: () => clock, openBrowser, fetcher, authTimeout: 4000 };
  return {
    calls, store, authorization: () => activeAuthorization,
    browserAccount: (id, claims) => { browserAccount = { id, claims }; },
    grant: value => { scope = value; },
    advance: milliseconds => { clock += milliseconds; },
    invoke: (op, data, signal) => handleChatGPT({ provider: "chatgpt", op, ...(op === "run" ? { request: data } : data) }, signal, context),
  };
}

const prompt = { system: "Analyze the selected recording.", prompt: "Question about this frame" };
const account = {
  ok: true, connected: true, account: "example@example.org", accountId: client,
  accounts: [{ id: client, account: "example@example.org", connected: true }],
};
const signedOut = { ...account, connected: false, accounts: [{ ...account.accounts[0], connected: false }] };

test("ChatGPT discovers a model and runs an image with verified OAuth, persisted host ID, rotating tokens and revocation", async () => {
  const fake = fixture();
  assert.deepEqual(await fake.invoke("status"), { ok: true, connected: false });
  assert.deepEqual(await fake.invoke("run", prompt), { ok: false, code: "signInRequired" });
  assert.deepEqual(await fake.invoke("connect"), account);
  assert.deepEqual(await fake.invoke("status"), account);
  const originalHostId = fake.authorization().searchParams.get("ext_agent_host_id");
  fake.advance(3598000);
  assert.deepEqual(await fake.invoke("run", { ...prompt, image: { mime: "image/png", data: "Zg==" } }),
    { ok: true, answer: "Capturé ✓", model: "gpt-6.2-sol" });
  assert.equal(fake.store.read().registrations[0].refreshToken, "synthetic-refresh-2");
  assert.deepEqual(await fake.invoke("disconnect"), signedOut);
  assert.deepEqual(fake.store.read().registrations[0], { account: account.account, clientId: client, subject: "fixture-subject" });
  assert.deepEqual(await fake.invoke("connect"), account);
  assert.equal(fake.authorization().searchParams.get("ext_agent_host_id"), originalHostId);
});

test("requires the scope from the token exchange, even if the callback grants it", async () => {
  const fake = fixture({ scope: "openid profile email", callbacks: { scope: plan } });
  assert.deepEqual(await fake.invoke("connect"), { ok: false, code: "planRequired" });
  assert.deepEqual(await fake.invoke("status"), signedOut);
  assert.deepEqual(await fake.invoke("run", prompt), { ok: false, code: "planRequired" });
  fake.grant(plan);
  assert.deepEqual(await fake.invoke("connect"), account);
  assert.equal(fake.authorization().searchParams.get("prompt"), "consent");
});

test("rejects forged, wrongly scoped identity claims and OAuth denial", async () => {
  for (const args of [
    { corruptSignature: true }, { claims: { aud: "wrong-client" } },
    { claims: { nonce: "wrong-nonce" } }, { claims: { exp: instant / 1000 - 1 } },
  ]) {
    const fake = fixture(args);
    assert.deepEqual(await fake.invoke("connect"), { ok: false, code: "providerError" });
    assert.deepEqual(await fake.invoke("status"), { ok: true, connected: false });
  }
  const denied = fixture({ callbacks: { error: "access_denied" } });
  assert.deepEqual(await denied.invoke("connect"), { ok: false, code: "planRequired" });
  assert.equal(denied.calls.length, 0);
});

test("never reports an interrupted Responses stream as a successful answer", async () => {
  const fake = fixture({ terminal: false });
  assert.equal((await fake.invoke("connect")).ok, true);
  assert.deepEqual(await fake.invoke("run", prompt), { ok: false, code: "providerError" });
});

test("clears expired renewable credentials or credentials whose revocation cannot be confirmed", async () => {
  const revoked = fixture({ revoked: false });
  assert.equal((await revoked.invoke("connect")).ok, true);
  assert.deepEqual(await revoked.invoke("disconnect"), { ...signedOut, revoked: false });
  assert.equal(revoked.store.read().registrations[0].accessToken, undefined);

  const expired = fixture({ refreshError: "invalid_grant" });
  assert.equal((await expired.invoke("connect")).ok, true);
  expired.advance(3601000);
  assert.deepEqual(await expired.invoke("run", prompt), { ok: false, code: "signInRequired" });
  assert.equal(expired.store.read().registrations[0].refreshToken, undefined);
  assert.equal(expired.store.read().registrations[0].clientId, client);
});

test("cancelled requests do not open the browser or contact the provider", async () => {
  const fake = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await fake.invoke("connect", undefined, controller.signal), { ok: false, code: "cancelled" });
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.authorization(), undefined);
});

test("retries an invalid grant with the pending registration and never exposes an unverified account", async () => {
  const fake = fixture({ failExchangeOnce: true });
  assert.deepEqual(await fake.invoke("connect"), { ok: false, code: "providerError" });
  assert.deepEqual(await fake.invoke("status"), { ok: true, connected: false });
  assert.equal(fake.store.read().pendingClientId, client);
  assert.deepEqual(await fake.invoke("connect"), account);
  assert.equal(fake.store.read().pendingClientId, undefined);
});

test("keeps separate credentials for multiple registrations and never replaces the active account on an invalid sign-in", async () => {
  const fake = fixture();
  const second = "oaiapp_another_workspace";
  assert.deepEqual(await fake.invoke("connect"), account);
  fake.browserAccount(second, { nonce: "invalid", sub: "another-account" });
  assert.deepEqual(await fake.invoke("connect", { newAccount: true }), { ok: false, code: "providerError" });
  assert.deepEqual(await fake.invoke("status"), account);
  assert.equal(fake.store.read().pendingClientId, second);
  fake.browserAccount(second, { sub: "another-account" });
  const connected = await fake.invoke("connect", { newAccount: true });
  assert.equal(connected.accountId, second);
  assert.equal(connected.account, "example@example.org (2)");
  assert.equal(connected.accounts.length, 2);
  fake.browserAccount(client, { sub: "wrong-account" });
  assert.deepEqual(await fake.invoke("connect", { accountId: client }), { ok: false, code: "providerError" });
  assert.deepEqual(await fake.invoke("status"), connected);
  fake.browserAccount(client, {});
  const switched = await fake.invoke("connect", { accountId: client });
  assert.equal(switched.accountId, client);
  assert.deepEqual(switched.accounts, connected.accounts);
});
