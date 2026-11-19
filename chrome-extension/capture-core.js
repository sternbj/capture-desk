// Shared extension-origin storage. Chunk writes commit before memory is released.
const DATABASE = "sternberg-recorder-extension";
let database;
const open = () => database ||= new Promise((resolve, reject) => {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("recordings", { keyPath: "id" });
    const chunks = db.createObjectStore("chunks", { keyPath: ["id", "seq"] });
    chunks.createIndex("byOffset", ["id", "offset"]);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function transaction(stores, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    try { result = work(tx); } catch (error) { tx.abort(); reject(error); return; }
    tx.oncomplete = () => resolve(typeof result === "function" ? result() : result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("Browser storage write failed"));
  });
}
export const ExtensionStore = {
  async get(id) {
    return transaction(["recordings"], "readonly", tx => {
      const request = tx.objectStore("recordings").get(id);
      return () => request.result;
    });
  },
  async list() {
    const values = await transaction(["recordings"], "readonly", tx => {
      const request = tx.objectStore("recordings").getAll();
      return () => request.result;
    });
    return values.filter(item => item.bytes > 0).sort((a, b) => b.createdAt - a.createdAt);
  },
  async begin(metadata = {}) {
    const record = { durationMs: 0, ...metadata, id: crypto.randomUUID(), bytes: 0, nextSeq: 0,
      createdAt: Date.now(), status: metadata.status || "recording" };
    await transaction(["recordings"], "readwrite", tx => tx.objectStore("recordings").add(record));
    return record;
  },
  async update(id, changes) {
    return transaction(["recordings"], "readwrite", tx => {
      const store = tx.objectStore("recordings"), request = store.get(id);
      let result;
      request.onsuccess = () => {
        if (!request.result) return;
        result = { ...request.result, ...changes, id };
        store.put(result);
      };
      return () => result;
    });
  },
  async append(id, blob) {
    const data = await blob.arrayBuffer();
    return transaction(["recordings", "chunks"], "readwrite", tx => {
      const store = tx.objectStore("recordings"), request = store.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) { tx.abort(); return; }
        tx.objectStore("chunks").add({ id, seq: record.nextSeq++, offset: record.bytes, data });
        record.bytes += data.byteLength;
        store.put(record);
      };
    });
  },
  async putBlob(metadata, blob) {
    const record = await this.begin({ ...metadata, mimeType: blob.type || metadata.mimeType });
    try {
      for (let offset = 0; offset < blob.size; offset += 524288)
        await this.append(record.id, blob.slice(offset, offset + 524288));
      return this.update(record.id, { status: "finished" });
    } catch (error) {
      await this.update(record.id, { status: "interrupted", error: error.message }).catch(() => {});
      throw error;
    }
  },
  async blob(id) {
    const record = await this.get(id);
    if (!record) throw new Error("Recording not found");
    const size = record.bytes;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Die Aufnahme ist unvollständig.");
    // Keep the recorded byte count fixed if capture continues. Only one batch
    // of raw bytes is needed at a time; the browser manages the immutable Blobs.
    const parts = [], batchSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < size; offset += batchSize) {
      const end = Math.min(offset + batchSize, size);
      const bytes = await this.readRange(id, offset, end);
      if (bytes.byteLength !== end - offset) throw new Error("Die Aufnahme ist unvollständig.");
      parts.push(new Blob([bytes]));
    }
    return new Blob(parts, { type: record.mimeType || "video/webm" });
  },
  async readRange(id, start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
      throw new Error("Invalid recording range");
    const parts = await transaction(["chunks"], "readonly", tx => {
      const chunks = [];
      const request = tx.objectStore("chunks").index("byOffset").openCursor(
        IDBKeyRange.bound([id, 0], [id, end - 1]), "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const item = cursor.value;
        const from = Math.max(0, start - item.offset), to = Math.min(item.data.byteLength, end - item.offset);
        if (to > from) chunks.unshift(item.data.slice(from, to));
        if (item.offset > start) cursor.continue();
      };
      return () => chunks;
    });
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  },
  async remove(id) {
    await transaction(["recordings", "chunks"], "readwrite", tx => {
      tx.objectStore("recordings").delete(id);
      tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    });
  },
};

export function isFinishedVideo(recording) {
  if (!recording || recording.status !== "finished" || !(recording.bytes > 0) || recording.error) return false;
  return recording.kind === "video" || (!recording.kind && recording.mimeType?.startsWith("video/") === true);
}

export function normalizeRegion(region) {
  if (!region || !["x", "y", "width", "height", "viewportWidth", "viewportHeight"].every(key => Number.isFinite(region[key]))) return null;
  const { x, y, viewportWidth, viewportHeight } = region;
  if (x < 0 || y < 0 || viewportWidth < 4 || viewportHeight < 4 || viewportWidth > 32760 || viewportHeight > 32760) return null;
  const width = Math.min(region.width, viewportWidth - x), height = Math.min(region.height, viewportHeight - y);
  return width >= 4 && height >= 4 ? { x, y, width, height, viewportWidth, viewportHeight } : null;
}
export function screenshotSaveDestination(settings = {}) {
  if (["local", "cloud"].includes(settings.screenshotDestination)) return settings.screenshotDestination;
  return ["local", "folder"].includes(settings.saveDestination) ? "local" : "cloud";
}
export function normalizeOptions(input = {}) {
  const source = ["tab", "window", "screen", "camera"].includes(input.source) ? input.source : "tab";
  const regionCapture = source !== "camera" && input.regionCapture === true;
  return {
    source, name: String(input.name || "Screen recording").trim().slice(0, 120) || "Screen recording",
    microphone: input.microphone !== false, systemAudio: source !== "camera" && input.systemAudio !== false,
    microphoneDeviceId: typeof input.microphoneDeviceId === "string" ? input.microphoneDeviceId.slice(0, 256) : "",
    cameraDeviceId: typeof input.cameraDeviceId === "string" ? input.cameraDeviceId.slice(0, 256) : "",
    format: ["mp4", "webm", "auto"].includes(input.format) ? input.format : "auto",
    saveDestination: ["local", "folder"].includes(input.saveDestination) ? input.saveDestination : "cloud",
    screenshotDestination: screenshotSaveDestination(input),
    controlBar: input.controlBar !== false,
    camera: source === "camera" || input.camera === true,
    regionCapture,
    region: regionCapture ? normalizeRegion(input.region) : null,
    microphoneReminder: input.microphoneReminder !== false,
    autoStopSeconds: Number.isFinite(Number(input.autoStopSeconds)) ? Math.min(21600, Math.max(0, Math.round(Number(input.autoStopSeconds)))) : 0,
    cameraPosition: ["bottom-right", "bottom-left", "top-right", "top-left"].includes(input.cameraPosition) ? input.cameraPosition : "bottom-right",
    frameRate: [24, 30, 60].includes(Number(input.frameRate)) ? Number(input.frameRate) : 30,
    bitrate: [2500000, 4000000, 8000000].includes(Number(input.bitrate)) ? Number(input.bitrate) : 4000000,
    resolution: [720, 1080, 2160].includes(Number(input.resolution)) ? Number(input.resolution) : "source",
    countdown: [0, 3, 5, 10].includes(Number(input.countdown)) ? Number(input.countdown) : 3,
  };
}
const RECORDING_FORMATS = {
  mp4: ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"],
  webm: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
};
export function supportedRecordingFormats(Recorder = globalThis.MediaRecorder) {
  return Object.entries(RECORDING_FORMATS).filter(([, candidates]) =>
    candidates.some(type => Recorder?.isTypeSupported?.(type))).map(([format]) => format);
}
export function recordingMimeType(format = "auto", Recorder = globalThis.MediaRecorder) {
  const formats = format === "auto" ? Object.keys(RECORDING_FORMATS) : [format];
  for (const value of formats) {
    const supported = RECORDING_FORMATS[value]?.find(type => Recorder?.isTypeSupported?.(type));
    if (supported) return supported;
  }
  const label = format === "mp4" ? "MP4" : format === "webm" ? "WebM" : "Dieses Videoformat";
  throw new Error(`${label} wird von dieser Chrome-Version nicht unterstützt. Wähle ein verfügbares Videoformat.`);
}
export function safeFilename(record) {
  const extension = record.mimeType?.includes("png") ? "png" : record.mimeType?.includes("jpeg") ? "jpg" : record.mimeType?.includes("webp") ? "webp" : record.mimeType?.includes("mp4") ? "mp4" : "webm";
  return `${String(record.name || "recording").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").slice(0, 120)}.${extension}`;
}

// Adds duration to Chrome's live-header WebM without rewriting media clusters.
export async function finalizeWebm(blob, durationMs) {
  if (!blob.type.includes("webm") || !(durationMs > 0)) return blob;
  try {
    const bytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    const vint = (offset, identifier = false) => {
      let mask = 128, length = 1;
      if (!bytes[offset]) throw new Error("Invalid WebM");
      while (!(bytes[offset] & mask)) { mask >>= 1; length++; }
      if (length > 8) throw new Error("Invalid WebM");
      let value = identifier ? bytes[offset] : bytes[offset] & (mask - 1);
      let unknown = !identifier && value === mask - 1;
      for (let i = 1; i < length; i++) { value = value * 256 + bytes[offset + i]; unknown &&= bytes[offset + i] === 255; }
      return { length, value, unknown };
    };
    const element = offset => {
      const tag = vint(offset, true), size = vint(offset + tag.length), start = offset + tag.length + size.length;
      return { id: tag.value, offset, start, end: start + size.value, size };
    };
    const segment = element(element(0).end);
    if (segment.id !== 0x18538067 || !segment.size.unknown) return blob;
    let info;
    for (let p = segment.start; p < bytes.length;) {
      const item = element(p);
      if (item.id === 0x114d9b74) return blob;
      if (item.id === 0x1549a966) { info = item; break; }
      if (item.end > bytes.length || item.end <= p) return blob;
      p = item.end;
    }
    if (!info || info.end > bytes.length) return blob;
    let scale = 1000000;
    for (let p = info.start; p < info.end;) {
      const item = element(p);
      if (item.id === 0x4489) return blob;
      if (item.id === 0x2ad7b1) {
        scale = 0;
        for (let i = item.start; i < item.end; i++) scale = scale * 256 + bytes[i];
      }
      p = item.end;
    }
    const duration = new Uint8Array(11); duration.set([0x44, 0x89, 0x88]);
    new DataView(duration.buffer).setFloat64(3, durationMs * 1e6 / scale);
    const size = info.end - info.start + duration.length;
    let length = info.size.length;
    while (size >= 2 ** (7 * length) - 1) length++;
    const sizeBytes = new Uint8Array(length); let remaining = size;
    for (let i = length - 1; i >= 0; i--) { sizeBytes[i] = remaining % 256; remaining = Math.floor(remaining / 256); }
    sizeBytes[0] |= 1 << (8 - length);
    return new Blob([blob.slice(0, info.offset), new Uint8Array([0x15, 0x49, 0xa9, 0x66]), sizeBytes, blob.slice(info.start, info.end), duration, blob.slice(info.end)], { type: blob.type });
  } catch { return blob; }
}
