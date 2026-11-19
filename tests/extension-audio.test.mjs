import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

function track(deviceId = "default", enabled = true) {
  return { enabled, readyState: "live", label: `${deviceId} microphone`,
    getSettings: () => ({ deviceId }),
    stop() { this.readyState = "ended"; } };
}

async function audioEngine({ microphone = [], sourceAudio = [], status = "recording", failAcquisition = false } = {}) {
  const requests = [], nodes = [], acquired = [];
  let acquisitionFailure = failAcquisition;
  let acquisitionBarrier;
  class FakeStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
  }
  const outputTrack = track("mixed-output");
  const destination = { stream: new FakeStream([outputTrack]) };
  const mixer = {
    state: "running", resume: async () => {},
    createMediaStreamDestination: () => destination,
    createMediaStreamSource(stream) {
      const node = { stream, connected: null, disconnected: false,
        connect(target) { this.connected = target; },
        disconnect() { this.disconnected = true; this.connected = null; } };
      nodes.push(node); return node;
    },
  };
  const context = vm.createContext({
    chrome: { runtime: { id: "recorder", onMessage: { addListener() {} }, sendMessage: async () => ({}) } },
    MediaStream: FakeStream,
    navigator: { mediaDevices: {
      async getUserMedia(constraints) {
        requests.push(constraints);
        if (acquisitionBarrier) await acquisitionBarrier;
        if (acquisitionFailure) throw new Error("Microphone permission denied");
        const deviceId = constraints.audio?.deviceId?.exact || "default";
        const stream = new FakeStream([track(deviceId)]); acquired.push(stream); return stream;
      },
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "default", label: "System microphone" },
        { kind: "audioinput", deviceId: "usb", label: "USB microphone" },
        { kind: "audiooutput", deviceId: "speaker", label: "Speakers" },
        { kind: "videoinput", deviceId: "camera", label: "Camera" },
      ],
    } },
    setTimeout, clearTimeout, URL, Blob, console,
  });
  const code = (await readFile(new URL("../chrome-extension/offscreen.js", import.meta.url), "utf8"))
    .replace(/^import[^\n]+\n/, "") + `
globalThis.audioTest={setAudioState,publicState,
  setSeparateSourcePlayback:gain=>{sourceRecordingGain = gain;},
  setMicrophoneDevice: typeof setMicrophoneDevice === "function" ? setMicrophoneDevice : async()=>{throw new Error("Missing live device switching");},
  audioDevices: typeof audioDevices === "function" ? audioDevices : async()=>{throw new Error("Missing audio device list");},
  output:()=>mixedAudio,
  finish:()=>{state={...state,status:"idle"};recorder=null;},
  init:(m,s,status,mixer,destination)=>{
    microphone=m.length?new MediaStream(m):null;source=new MediaStream(s);
    audioContext=mixer;audioDestination=destination;mixedAudio=destination.stream;
    microphoneNode=m.length?mixer.createMediaStreamSource(microphone):null;
    microphoneNode?.connect(destination);
    state={status,settings:{microphone:m.length>0}};recorder={state:status};
  }};`;
  vm.runInContext(code, context);
  context.audioTest.init(microphone, sourceAudio, status, mixer, destination);
  return { ...context.audioTest, requests, nodes, acquired, destination, outputTrack,
    failAcquisition(value = true) { acquisitionFailure = value; },
    holdAcquisition(promise) { acquisitionBarrier = promise; } };
}

test("live microphone and source audio can be muted and restored independently", async () => {
  const microphone = { enabled: true, readyState: "live" }, source = { enabled: true, readyState: "live" };
  const engine = await audioEngine({ microphone: [microphone], sourceAudio: [source] });
  let result = await engine.setAudioState({ microphoneEnabled: false });
  assert.equal(microphone.enabled, false); assert.equal(source.enabled, true);
  assert.equal(result.state.microphoneMuted, true); assert.equal(result.state.sourceAudioMuted, false);
  result = await engine.setAudioState({ microphoneEnabled: true, sourceAudioEnabled: false });
  assert.equal(microphone.enabled, true); assert.equal(source.enabled, false);
  assert.equal(result.state.microphoneAvailable, true); assert.equal(result.state.sourceAudioAvailable, true);
});

test("muting audio in a region recording leaves the captured tab audible", async () => {
  const source = track("tab");
  const engine = await audioEngine({ sourceAudio: [source] });
  const recordingGain = { gain: { value: 1 } };
  engine.setSeparateSourcePlayback(recordingGain);
  let result = await engine.setAudioState({ sourceAudioEnabled: false });
  assert.equal(result.state.sourceAudioMuted, true);
  assert.equal(recordingGain.gain.value, 0);
  assert.equal(source.enabled, true);
  result = await engine.setAudioState({ sourceAudioEnabled: true });
  assert.equal(result.state.sourceAudioMuted, false);
  assert.equal(recordingGain.gain.value, 1);
});

test("an initially disabled microphone can be enabled into the existing recorder audio track", async () => {
  const engine = await audioEngine();
  const output = engine.output();
  const result = await engine.setAudioState({ microphoneEnabled: true });
  assert.equal(result.state.microphoneAvailable, true);
  assert.equal(result.state.microphoneMuted, false);
  assert.equal(engine.requests.length, 1);
  assert.equal(engine.output(), output);
  assert.equal(engine.output().getAudioTracks()[0], engine.outputTrack);
  assert.equal(engine.nodes.at(-1).connected, engine.destination);
});

test("invalid or unavailable source audio is rejected before changing microphone tracks", async () => {
  const microphone = track("default");
  const engine = await audioEngine({ microphone: [microphone] });
  await assert.rejects(async () => engine.setAudioState({ microphoneEnabled: false, sourceAudioEnabled: true }), /Quellton/);
  assert.equal(microphone.enabled, true);
  assert.equal(engine.requests.length, 0);
  await assert.rejects(async () => engine.setAudioState({ microphoneEnabled: "false" }), /Ungültig/);
  assert.equal(microphone.enabled, true);
});

test("a failed microphone request leaves existing source audio unchanged", async () => {
  const source = { enabled: true, readyState: "live" };
  const engine = await audioEngine({ sourceAudio: [source], failAcquisition: true });
  await assert.rejects(async () => engine.setAudioState({ microphoneEnabled: true, sourceAudioEnabled: false }), /permission|Mikrofon/i);
  assert.equal(engine.requests.length, 1);
  assert.equal(source.enabled, true);
  assert.equal(engine.publicState().microphoneAvailable, false);
});

test("switching microphone devices keeps the mixed recorder track and stops the old input after connection", async () => {
  const old = track("built-in");
  const engine = await audioEngine({ microphone: [old] });
  const output = engine.output(), oldNode = engine.nodes[0];
  old.stop = () => {
    assert.notEqual(engine.nodes.at(-1), oldNode);
    assert.equal(engine.nodes.at(-1).connected, engine.destination);
    old.readyState = "ended";
  };
  const result = await engine.setMicrophoneDevice("usb");
  assert.equal(engine.requests[0].audio.deviceId.exact, "usb");
  assert.equal(engine.output(), output);
  assert.equal(engine.output().getAudioTracks()[0], engine.outputTrack);
  assert.equal(engine.nodes.at(-1).connected, engine.destination);
  assert.equal(oldNode.disconnected, true);
  assert.equal(old.readyState, "ended");
  assert.equal(result.state.microphoneDeviceId, "usb");
  assert.equal(result.state.microphoneMuted, false);
});

test("switching microphone while muted preserves the mute state", async () => {
  const old = track("built-in", false);
  const engine = await audioEngine({ microphone: [old], status: "paused" });
  const result = await engine.setMicrophoneDevice("usb");
  assert.equal(engine.acquired[0].getAudioTracks()[0].enabled, false);
  assert.equal(result.state.microphoneMuted, true);
  assert.equal(result.state.status, "paused");
});

test("a mute requested during a device switch also mutes the replacement microphone", async () => {
  const old = track("built-in");
  const engine = await audioEngine({ microphone: [old] });
  let release;
  engine.holdAcquisition(new Promise(resolve => { release = resolve; }));
  const switching = engine.setMicrophoneDevice("usb");
  await Promise.resolve();
  assert.equal(engine.requests.length, 1);
  await engine.setAudioState({ microphoneEnabled: false });
  assert.equal(old.enabled, false);
  release(); await switching;
  assert.equal(engine.acquired[0].getAudioTracks()[0].enabled, false);
  assert.equal(engine.publicState().microphoneMuted, true);
});

test("a later mute overrides enabling an initially absent microphone while permission is pending", async () => {
  const engine = await audioEngine();
  let release;
  engine.holdAcquisition(new Promise(resolve => { release = resolve; }));
  const enabling = engine.setAudioState({ microphoneEnabled: true });
  await Promise.resolve();
  assert.equal(engine.requests.length, 1);
  await engine.setAudioState({ microphoneEnabled: false });
  release(); await enabling;
  assert.equal(engine.acquired[0].getAudioTracks()[0].enabled, false);
  assert.equal(engine.publicState().microphoneMuted, true);
});

test("a later source-audio choice overrides an earlier combined request waiting for a microphone", async () => {
  const source = track("source-audio");
  const engine = await audioEngine({ sourceAudio: [source] });
  let release;
  engine.holdAcquisition(new Promise(resolve => { release = resolve; }));
  const enabling = engine.setAudioState({ microphoneEnabled: true, sourceAudioEnabled: false });
  await Promise.resolve();
  assert.equal(engine.requests.length, 1);
  await engine.setAudioState({ sourceAudioEnabled: true });
  release(); await enabling;
  assert.equal(source.enabled, true);
  assert.equal(engine.publicState().sourceAudioMuted, false);
});

test("failed microphone switching leaves the current input connected and usable", async () => {
  const old = track("built-in");
  const engine = await audioEngine({ microphone: [old], failAcquisition: true });
  const output = engine.output(), oldNode = engine.nodes[0];
  await assert.rejects(engine.setMicrophoneDevice("missing"), /permission|Mikrofon/i);
  assert.equal(old.readyState, "live");
  assert.equal(old.enabled, true);
  assert.equal(oldNode.connected, engine.destination);
  assert.equal(oldNode.disconnected, false);
  assert.equal(engine.output(), output);
  assert.equal(engine.publicState().microphoneDeviceId, "built-in");
});

test("device enumeration exposes microphone inputs and the selected input", async () => {
  const engine = await audioEngine({ microphone: [track("usb")] });
  const result = await engine.audioDevices();
  assert.deepEqual(Array.from(result.devices, item => ({ deviceId: item.deviceId, label: item.label })), [
    { deviceId: "default", label: "System microphone" }, { deviceId: "usb", label: "USB microphone" },
  ]);
  assert.equal(result.microphoneDeviceId, "usb");
});

test("a microphone acquired after recording stops is released instead of attached", async () => {
  const engine = await audioEngine();
  let release;
  engine.holdAcquisition(new Promise(resolve => { release = resolve; }));
  const switching = engine.setMicrophoneDevice("usb");
  await Promise.resolve();
  engine.finish(); release();
  await assert.rejects(switching, /Aufnahme|beendet|stopped|ended/i);
  assert.equal(engine.acquired.length, 1);
  assert.equal(engine.acquired[0].getAudioTracks()[0].readyState, "ended");
  assert.equal(engine.nodes.length, 0);
});

test("audio changes are allowed while paused and rejected after the recording ends", async () => {
  const track = { enabled: true, readyState: "live" };
  const paused = await audioEngine({ microphone: [track], status: "paused" });
  await paused.setAudioState({ microphoneEnabled: false }); assert.equal(track.enabled, false);
  const idle = await audioEngine({ microphone: [track], status: "idle" });
  await assert.rejects(async () => idle.setAudioState({ microphoneEnabled: true }), /Aufnahme/);
  assert.equal(track.enabled, false);
  await assert.rejects(idle.setMicrophoneDevice("usb"), /Aufnahme/);
  assert.equal(idle.requests.length, 0);
});
