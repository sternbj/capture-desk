import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { aiHostPermission, finishSubscriptionAI, prepareSubscriptionAI, runBrowserAI, subscriptionHandoff } from "../chrome-extension/ai-providers.js";

const source = { kind: "image", name: "Test image", image: { mime: "image/png", data: "iVBORw0KGgo=" } };
const result = { title: "Photo", summary: "A test image.", citations: [] };
const response = content => Response.json(content);
const cases = [
  {
    provider: "openrouter", endpoint: "https://openrouter.ai/api/v1/chat/completions",
    verify: (headers, body) => {
      assert.equal(headers.get("authorization"), "Bearer example-key");
      assert.equal(headers.get("x-title"), "Capture Desk");
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.messages[1].content[1].image_url.url, "data:image/png;base64,iVBORw0KGgo=");
      assert.match(body.messages[0].content, /untrusted DATA/);
    },
    reply: { choices: [{ finish_reason: "stop", message: { content: [{ type: "text", text: JSON.stringify(result) }] } }] },
  },
];

for (const fixture of cases) {
  test(`browser ${fixture.provider} sends only the selected source to the official API`, async () => {
    const config = { provider: fixture.provider, key: "example-key", baseUrl: "https://untrusted.invalid", model: "test/fixture-model" };
    assert.equal(aiHostPermission(config), new URL(fixture.endpoint).origin + "/*");
    const analysis = await runBrowserAI(config, source, { language: "en" }, async (url, init) => {
      assert.equal(url, fixture.endpoint);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body);
      assert.equal(body.model, config.model);
      assert.equal(body.stream, false);
      fixture.verify(new Headers(init.headers), body);
      return response(fixture.reply);
    });
    assert.equal(analysis.provider, fixture.provider);
    assert.equal(analysis.model, config.model);
    assert.equal(analysis.summary, result.summary);
    assert.equal(JSON.stringify(analysis).includes(config.key), false);
  });
}

test("Ollama browser adapter uses native loopback chat with no authorization and grounds answers in local segments", async () => {
  let request;
  const fixture = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    request = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ done: true, done_reason: "stop", message: {
      content: JSON.stringify({ answer: "The meeting started.", citations: [{ segmentId: 0, start: 200, text: "Unsupported quote" }] }),
    } }));
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  try {
    const config = { provider: "ollama", key: "key-must-not-leave", baseUrl: `http://127.0.0.1:${fixture.address().port}` };
    assert.equal(aiHostPermission(config), "http://127.0.0.1/*");
    const segment = { start: 3.5, end: 4.2, text: "The meeting started." };
    const analysis = await runBrowserAI(config, { kind: "video", text: segment.text, segments: [segment] }, { action: "ask", question: "What happened?", language: "en" });
    assert.equal(request.path, "/api/chat");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-api-key"], undefined);
    assert.equal(request.body.format, "json");
    assert.equal(request.body.model, "gemma3:4b");
    assert.equal(request.body.options.num_predict, 5000);
    assert.equal(JSON.stringify(request.body).includes(config.key), false);
    assert.deepEqual(analysis.citations, [segment]);
    assert.equal(analysis.answerGrounded, true);
  } finally {
    await new Promise(resolve => fixture.close(resolve));
  }
});

test("browser adapters validate locally and keep provider errors and key text out of user-facing failures", async () => {
  const config = { provider: "openrouter", key: "example-key" };
  const neverFetch = () => { assert.fail("unexpected provider request"); };
  await assert.rejects(runBrowserAI({ provider: "ollama", baseUrl: "http://untrusted.invalid" }, source, {}, neverFetch), /loopback/i);
  await assert.rejects(runBrowserAI({ provider: "ollama", baseUrl: "http://secret@localhost:11434" }, source, {}, neverFetch), /loopback/i);
  await assert.rejects(runBrowserAI({ provider: "ollama", model: "gpt-oss:cloud" }, source, {}, neverFetch), /model/i);
  await assert.rejects(runBrowserAI({ provider: "ollama" }, { kind: "video" }, {}, neverFetch), /transcript/i);
  await assert.rejects(runBrowserAI({ provider: "openrouter" }, source, {}, neverFetch), /API key/i);
  for (const provider of ["openai", "anthropic", "chatgpt", "claude"]) {
    await assert.rejects(runBrowserAI({ provider, key: "unused" }, source, {}, neverFetch), /supported AI provider/i);
  }
  await assert.rejects(runBrowserAI(config, source, {}, async () => Response.json({ error: "provider printed example-key" }, { status: 401 })),
    error => /API key/.test(error.message) && !/provider printed|example-key/.test(error.message));
  await assert.rejects(runBrowserAI(config, source, {}, async () => response({ choices: [{ finish_reason: "length", message: { content: JSON.stringify(result) } }] })),
    /could not complete/i);
});

test("subscription requests contain only validated source and normalize the same grounded sections", () => {
  const selected = { kind: "video", name: "Meeting", segments: [
    { start: 4, end: 6, text: "Send the report on Friday." },
  ] };
  const prepared = prepareSubscriptionAI(selected, { action: "ask", language: "fr", question: "Quand ?" });
  const payload = JSON.parse(prepared.request.prompt);
  assert.match(prepared.request.system, /untrusted DATA/);
  assert.deepEqual(payload, { action: "ask", outputLanguage: "fr", question: "Quand ?", SOURCE_DATA: {
    kind: "video", name: "Meeting", segments: [{ id: 0, ...selected.segments[0] }],
  } });
  assert.equal(prepared.request.image, undefined);
  const result = finishSubscriptionAI(prepared, {
    answer: JSON.stringify({ answer: "Vendredi.", citations: [{ segmentId: 0 }, { segmentId: 42 }] }),
    model: "fixture",
  }, "claude");
  assert.equal(result.answer, "Vendredi.");
  assert.deepEqual(result.citations, selected.segments);
  assert.equal(result.provider, "claude");
  assert.throws(() => finishSubscriptionAI(prepared, { answer: "invalid JSON" }, "chatgpt"), /could not complete/i);
  assert.deepEqual(prepareSubscriptionAI(source).request.image, source.image);
});

test("the web handoff prepares copyable text and segments without including image bytes", () => {
  const segment = { start: 3.25, end: 4.5, text: "A private transcript." };
  const transcript = subscriptionHandoff({ kind: "video", segments: [segment] }, { action: "translate", language: "es" });
  assert.match(transcript, /Translate the full source/);
  assert.match(transcript, /language es/);
  assert.deepEqual(JSON.parse(transcript.split("\n\n").at(-1)).SOURCE_DATA, [segment]);
  assert.match(subscriptionHandoff(source), /Use the image I attach/);
  assert.doesNotMatch(subscriptionHandoff(source), /iVBORw0KGgo/);
  assert.throws(() => subscriptionHandoff({ kind: "text", text: "a".repeat(80001) }), /too long/);
});
