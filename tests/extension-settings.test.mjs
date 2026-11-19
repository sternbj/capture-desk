import assert from "node:assert/strict";
import test from "node:test";
import * as captureCore from "../chrome-extension/capture-core.js";
const { normalizeOptions, safeFilename } = captureCore;

const recorderSupporting = predicate => ({ isTypeSupported: predicate });

test("new recordings enable voice and source audio by default", () => {
  const options = normalizeOptions({ source: "screen" });
  assert.equal(options.microphone, true);
  assert.equal(options.systemAudio, true);
  assert.equal(options.controlBar, true);
});

test("an explicit audio-off choice is respected", () => {
  const options = normalizeOptions({ source: "tab", microphone: false, systemAudio: false });
  assert.equal(options.microphone, false);
  assert.equal(options.systemAudio, false);
});

test("the floating control bar can be explicitly disabled", () => {
  assert.equal(normalizeOptions({ controlBar: false }).controlBar, false);
});

test("new recordings default to automatic format, private online storage and default camera", () => {
  const options = normalizeOptions({});
  assert.equal(options.format, "auto");
  assert.equal(options.saveDestination, "cloud");
  assert.equal(options.cameraDeviceId, "");
  assert.equal(options.camera, false);
});

test("folder videos preserve the separate screenshot destination and migrate legacy choices", () => {
  assert.equal(normalizeOptions({ saveDestination: "folder" }).saveDestination, "folder");
  assert.equal(normalizeOptions({ saveDestination: "folder" }).screenshotDestination, "local");
  assert.equal(normalizeOptions({ saveDestination: "folder", screenshotDestination: "cloud" }).screenshotDestination, "cloud");
  assert.equal(normalizeOptions({ saveDestination: "local" }).screenshotDestination, "local");
  assert.equal(normalizeOptions({ saveDestination: "cloud" }).screenshotDestination, "cloud");
});

test("explicit recording format, local storage and camera device survive normalization", () => {
  for (const format of ["auto", "mp4", "webm"]) {
    const options = normalizeOptions({ format, saveDestination: "local", camera: true, cameraDeviceId: "usb-camera" });
    assert.equal(options.format, format);
    assert.equal(options.saveDestination, "local");
    assert.equal(options.cameraDeviceId, "usb-camera");
    assert.equal(options.camera, true);
  }
});

test("unsupported setting values fall back safely and camera device IDs remain bounded", () => {
  const options = normalizeOptions({ format: "mov", saveDestination: "external-drive", cameraDeviceId: 42 });
  assert.equal(options.format, "auto");
  assert.equal(options.saveDestination, "cloud");
  assert.equal(options.cameraDeviceId, "");
  assert.equal(normalizeOptions({ cameraDeviceId: "c".repeat(300) }).cameraDeviceId, "c".repeat(256));
});

test("supported format choices reflect actual MediaRecorder support", () => {
  assert.equal(typeof captureCore.supportedRecordingFormats, "function");
  assert.deepEqual(captureCore.supportedRecordingFormats(recorderSupporting(() => true)), ["mp4", "webm"]);
  assert.deepEqual(captureCore.supportedRecordingFormats(recorderSupporting(mime => mime.startsWith("video/webm"))), ["webm"]);
  assert.deepEqual(captureCore.supportedRecordingFormats(recorderSupporting(mime => mime.startsWith("video/mp4"))), ["mp4"]);
  assert.deepEqual(captureCore.supportedRecordingFormats(recorderSupporting(() => false)), []);
});

test("automatic format prefers playable MP4 with AVC and AAC when available", () => {
  const Recorder = recorderSupporting(mime => (mime.includes("avc1") && mime.includes("mp4a")) || mime.startsWith("video/webm"));
  const mime = captureCore.recordingMimeType("auto", Recorder);
  assert.match(mime, /^video\/mp4;/);
  assert.match(mime, /avc1/);
  assert.match(mime, /mp4a/);
});

test("automatic format falls back to WebM when MP4 encoding is unavailable", () => {
  const Recorder = recorderSupporting(mime => mime.includes("vp9") && mime.includes("opus"));
  assert.match(captureCore.recordingMimeType("auto", Recorder), /^video\/webm;.*vp9.*opus/);
});

test("MIME selection falls through supported codec candidates and generic containers", () => {
  assert.match(captureCore.recordingMimeType("webm", recorderSupporting(mime => mime.includes("vp8"))), /vp8/);
  assert.equal(captureCore.recordingMimeType("webm", recorderSupporting(mime => mime === "video/webm")), "video/webm");
  assert.equal(captureCore.recordingMimeType("mp4", recorderSupporting(mime => mime === "video/mp4")), "video/mp4");
});

test("explicit unsupported formats fail clearly instead of silently changing containers", () => {
  assert.throws(() => captureCore.recordingMimeType("mp4", recorderSupporting(mime => mime.startsWith("video/webm"))), /MP4/);
  assert.throws(() => captureCore.recordingMimeType("webm", recorderSupporting(mime => mime.startsWith("video/mp4"))), /WebM/);
});

test("a browser with no supported recording container returns no choices and fails clearly", () => {
  const Recorder = recorderSupporting(() => false);
  assert.deepEqual(captureCore.supportedRecordingFormats(Recorder), []);
  assert.throws(() => captureCore.recordingMimeType("auto", Recorder), /MP4|WebM|Format|Video|supported|unterstützt/i);
});

test("download filename extension follows the recorded MIME rather than the requested format", () => {
  assert.equal(safeFilename({ name: "Review", format: "mp4", mimeType: "video/webm;codecs=vp9,opus" }), "Review.webm");
  assert.equal(safeFilename({ name: "Review", format: "webm", mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2" }), "Review.mp4");
  assert.equal(safeFilename({ name: "Screen", mimeType: "image/png" }), "Screen.png");
  assert.equal(safeFilename({ name: "Screen", mimeType: "image/jpeg" }), "Screen.jpg");
});

test("camera-only capture enables camera and never requests desktop source audio", () => {
  const options = normalizeOptions({ source: "camera", camera: false, systemAudio: true, cameraDeviceId: "usb", microphone: false });
  assert.equal(options.source, "camera");
  assert.equal(options.camera, true);
  assert.equal(options.systemAudio, false);
  assert.equal(options.microphone, false);
  assert.equal(options.cameraDeviceId, "usb");
});

test("microphone reminders can be disabled explicitly and otherwise remain on", () => {
  assert.equal(normalizeOptions({}).microphoneReminder, true);
  assert.equal(normalizeOptions({ microphoneReminder: false }).microphoneReminder, false);
});

test("countdown supports ten seconds and rejects unsupported durations", () => {
  for (const countdown of [0, 3, 5, 10]) assert.equal(normalizeOptions({ countdown }).countdown, countdown);
  assert.equal(normalizeOptions({ countdown: 17 }).countdown, 3);
});

test("auto-stop accepts active recording seconds and bounds invalid values to six hours", () => {
  assert.equal(normalizeOptions({}).autoStopSeconds, 0);
  assert.equal(normalizeOptions({ autoStopSeconds: -1 }).autoStopSeconds, 0);
  assert.equal(normalizeOptions({ autoStopSeconds: "150" }).autoStopSeconds, 150);
  assert.equal(normalizeOptions({ autoStopSeconds: NaN }).autoStopSeconds, 0);
  assert.equal(normalizeOptions({ autoStopSeconds: Infinity }).autoStopSeconds, 0);
  assert.equal(normalizeOptions({ autoStopSeconds: 1e9 }).autoStopSeconds, 21600);
});

test("custom recording regions apply to opted-in tabs, windows, or displays and clamp to the source bounds", () => {
  const region = { x: 30, y: 40, width: 900, height: 800, viewportWidth: 640, viewportHeight: 480 };
  const options = normalizeOptions({ source: "tab", regionCapture: true, region });
  assert.equal(options.regionCapture, true);
  assert.deepEqual(options.region, { ...region, width: 610, height: 440 });
  assert.equal(normalizeOptions({ source: "tab", region }).region, null);
  assert.equal(normalizeOptions({ source: "camera", regionCapture: true, region }).region, null);
  for (const source of ["window", "screen"]) {
    const normalized = normalizeOptions({ source, regionCapture: true, region });
    assert.equal(normalized.regionCapture, true);
    assert.deepEqual(normalized.region, options.region);
  }
});

test("invalid region coordinates cannot reach crop division or reveal an unselected area", () => {
  const valid = { x: 0, y: 0, width: 100, height: 80, viewportWidth: 640, viewportHeight: 480 };
  for (const bad of [{ x: -1 }, { y: -1 }, { width: 2 }, { height: 3 }, { viewportWidth: 0 }, { viewportHeight: -4 }, { x: Infinity }, { width: NaN }, { x: 639 }, { viewportWidth: 40000 }])
    assert.equal(normalizeOptions({ source: "tab", regionCapture: true, region: { ...valid, ...bad } }).region, null, JSON.stringify(bad));
});
