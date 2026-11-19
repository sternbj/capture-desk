import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizeOptions } from "../chrome-extension/capture-core.js";

const code = (await readFile(new URL("../chrome-extension/offscreen.js", import.meta.url), "utf8")).replace(/^import[^\n]+\n/m, "");

function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve };
}

function captureEngine({ setupWait, nativeStop = true, failAfterBytes } = {}) {
  class TestTrack extends EventTarget {
    readyState = "live";
    label = "Testbildschirm";
    applyConstraints = async () => {};
    getSettings = () => ({ displaySurface: "monitor" });
    stop() { this.readyState = "ended"; }
    endSharing() { this.stop(); this.dispatchEvent(new Event("ended")); }
  }
  const sourceTrack = new TestTrack();
  const saved = new Map(), notifications = [];
  let recorder, starts = 0, stops = 0;
  const makeVideo = () => ({
    style: {}, setAttribute() {}, remove() {}, play: async () => {},
    readyState: 2, videoWidth: 1280, videoHeight: 720,
    requestVideoFrameCallback: callback => setTimeout(callback, 0),
    cancelVideoFrameCallback: clearTimeout,
  });
  const context = vm.createContext({
    AbortController,
    chrome: { runtime: {
      id: "test", onMessage: { addListener() {} },
      async sendMessage(message) { notifications.push(message); },
    } },
    setTimeout: (callback, duration) => setTimeout(callback, duration === 8000 ? 15 : duration),
    clearTimeout, setInterval, clearInterval, Blob,
    document: { createElement: makeVideo, body: { append() {} } },
    AudioContext: class {
      createMediaStreamDestination() { return { stream: { getAudioTracks: () => [] } }; }
      createConstantSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
      async resume() {}
      async close() {}
    },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    MediaRecorder: class extends EventTarget {
      state = "inactive";
      mimeType = "video/webm";
      constructor() { super(); recorder = this; }
      start() { starts++; this.state = "recording"; }
      pause() {
        this.state = "paused";
        queueMicrotask(() => this.dispatchEvent(new Event("pause")));
      }
      stop() {
        assert.notEqual(this.state, "inactive");
        stops++;
        this.state = "inactive";
        if (nativeStop) queueMicrotask(() => this.onstop?.());
      }
      data(bytes) { this.ondataavailable?.({ data: new Blob([bytes]) }); }
    },
    normalizeOptions,
    recordingMimeType: () => "video/webm",
    ExtensionStore: {
      async begin(record) {
        const entry = { ...record, id: "capture", bytes: 0, status: "recording" };
        saved.set(entry.id, entry);
        await setupWait?.promise;
        return { ...entry };
      },
      async append(id, blob) {
        const record = saved.get(id);
        if (record.bytes >= failAfterBytes) throw new Error("Storage exhausted");
        record.bytes += blob.size;
      },
      async update(id, patch) { return { ...Object.assign(saved.get(id), patch) }; },
    },
  });
  const api = vm.runInContext(code + "\n({ prepare, begin, pause, finish, publicState })", context);
  return {
    ...api, saved, notifications, sourceTrack,
    prepare: (options = {}) => api.prepare({
      options: { source: "screen", microphone: false, systemAudio: false, countdown: 0, ...options },
      stream: { getVideoTracks: () => [sourceTrack], getTracks: () => [sourceTrack], getAudioTracks: () => [] },
    }),
    recorder: () => recorder, starts: () => starts, stops: () => stops,
    completions: () => notifications.filter(message => message.type === "RECORDING_FINISHED"),
  };
}

test("ending display sharing during the countdown cancels promptly and creates no recording", async () => {
  const engine = captureEngine();
  await engine.prepare({ countdown: 10 });
  const starting = engine.begin();
  await new Promise(resolve => setTimeout(resolve, 20));
  engine.sourceTrack.endSharing();
  await assert.rejects(starting, /Bildschirmfreigabe.*beendet/);
  assert.equal(engine.publicState().status, "error");
  assert.equal(engine.publicState().sourceReady, false);
  assert.equal(engine.saved.size, 0);
  assert.equal(engine.starts(), 0);
  assert.equal(engine.completions().length, 0);
});

test("a source that ends during the initial database write cannot start a recorder", async () => {
  const setupWait = deferred();
  const engine = captureEngine({ setupWait });
  await engine.prepare();
  const starting = engine.begin();
  while (!engine.saved.size) await nextTurn();
  engine.sourceTrack.endSharing();
  setupWait.resolve();
  await assert.rejects(starting, /Bildschirmfreigabe.*beendet/);
  assert.equal(engine.starts(), 0);
  assert.equal(engine.saved.get("capture").status, "interrupted");
  assert.equal(engine.completions().length, 0);
});

test("ending sharing while paused saves committed bytes once, including a concurrent STOP request", async () => {
  const engine = captureEngine();
  await engine.prepare();
  await engine.begin();
  engine.recorder().data("already captured");
  await engine.pause();
  engine.sourceTrack.endSharing();
  const [finished, repeated] = await Promise.all([engine.finish(), engine.finish()]);
  assert.equal(engine.stops(), 1);
  assert.equal(finished.recording.bytes, 16);
  assert.equal(finished.recording.status, "finished");
  assert.equal(repeated.recording.id, finished.recording.id);
  assert.equal(engine.publicState().status, "idle");
  assert.equal(engine.completions().length, 1);
  assert.equal(engine.completions()[0].state.status, "idle");
});

test("native stop racing the track-ended event waits for final data without stopping twice", async () => {
  const engine = captureEngine({ nativeStop: false });
  await engine.prepare();
  await engine.begin();
  engine.recorder().state = "inactive";
  engine.sourceTrack.endSharing();
  engine.recorder().data("final chunk");
  engine.recorder().onstop();
  const result = await engine.finish();
  assert.equal(engine.stops(), 0);
  assert.equal(result.recording.bytes, 11);
  assert.equal(result.recording.status, "finished");
  assert.equal(engine.completions().length, 1);
});

test("a delayed pause acknowledgement cannot revive a capture that stopped sharing", async () => {
  const engine = captureEngine();
  await engine.prepare();
  await engine.begin();
  const active = engine.recorder();
  active.data("test");
  active.pause = () => { active.state = "paused"; };
  const pausing = engine.pause();
  engine.sourceTrack.endSharing();
  await engine.finish();
  assert.equal((await pausing).state.status, "idle");
  active.dispatchEvent(new Event("pause"));
  assert.equal(engine.publicState().status, "idle");
  assert.equal(engine.completions().length, 1);
});

test("a database write failure retains earlier committed chunks", async () => {
  const engine = captureEngine({ failAfterBytes: 5 });
  await engine.prepare();
  await engine.begin();
  engine.recorder().data("first");
  engine.recorder().data("failed");
  engine.sourceTrack.endSharing();
  const result = await engine.finish();
  assert.equal(result.recording.bytes, 5);
  assert.equal(result.recording.status, "interrupted");
  assert.equal(result.state.status, "error");
  assert.match(result.state.error, /Aufnahmen in Chrome/);
  assert.equal(engine.completions().length, 1);
});

test("empty captures and timeouts are reported as interrupted", async () => {
  const empty = captureEngine();
  await empty.prepare();
  await empty.begin();
  empty.sourceTrack.endSharing();
  const emptyResult = await empty.finish();
  assert.equal(emptyResult.recording.bytes, 0);
  assert.equal(emptyResult.recording.status, "interrupted");
  assert.match(emptyResult.state.error, /keine Videodaten/);

  const timeout = captureEngine({ nativeStop: false });
  await timeout.prepare();
  await timeout.begin();
  timeout.recorder().data("saved segment");
  timeout.sourceTrack.endSharing();
  const timedOut = await timeout.finish();
  assert.equal(timedOut.recording.bytes, 13);
  assert.equal(timedOut.recording.status, "interrupted");
  assert.match(timedOut.state.error, /Aufnahmen in Chrome/);
  timeout.recorder().onstop();
  assert.equal(timeout.completions().length, 1);
});
