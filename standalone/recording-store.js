(() => {
  let database;
  function open() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("capture-desk-portable", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("recordings", { keyPath: "id" });
        request.result.createObjectStore("chunks", { keyPath: ["id", "sequence"] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => { database = null; throw error; });
    return database;
  }
  async function transaction(stores, mode, handle) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const result = handle(tx);
      tx.oncomplete = () => resolve(result?.());
      tx.onabort = () => reject(tx.error || new Error("Storage transaction was interrupted"));
    });
  }
  function save(record) {
    return transaction("recordings", "readwrite", tx => {
      tx.objectStore("recordings").put(record);
    });
  }
  async function append(record, blob, durationMs) {
    const data = await blob.arrayBuffer();
    const updated = {
      ...record,
      mimeType: record.mimeType || blob.type.split(";")[0],
      count: record.count + 1,
      bytes: record.bytes + blob.size,
      durationMs,
    };
    await transaction(["recordings", "chunks"], "readwrite", tx => {
      tx.objectStore("chunks").add({ id: record.id, sequence: record.count, data });
      tx.objectStore("recordings").put(updated);
    });
    return updated;
  }
  async function list() {
    const records = await transaction("recordings", "readonly", tx => {
      const request = tx.objectStore("recordings").getAll();
      return () => request.result;
    });
    return records.filter(record => record.bytes > 0).sort((a, b) => b.createdAt - a.createdAt);
  }
  async function read(record) {
    const chunks = await transaction("chunks", "readonly", tx => {
      const parts = [];
      const order = IDBKeyRange.bound([record.id, 0], [record.id, record.count - 1]);
      const request = tx.objectStore("chunks").openCursor(order);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        parts.push(new Blob([cursor.value.data || cursor.value.blob]));
        cursor.continue();
      };
      return () => parts;
    });
    const video = new Blob(chunks, { type: record.mimeType.split(";")[0] });
    if (video.size !== record.bytes) throw new Error("Recording backup is incomplete");
    return video;
  }

  // Add duration to live-header WebM without rewriting the video clusters.
  // This follows the recorder extension's existing bounded-header algorithm.
  async function finalizeWebm(blob, durationMs) {
    if (!blob.type.includes("webm") || !(durationMs > 0)) return blob;
    try {
      const bytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
      const vint = (offset, identifier = false) => {
        let mask = 128, length = 1;
        if (!bytes[offset]) throw new Error("Invalid WebM element");
        while (!(bytes[offset] & mask)) { mask >>= 1; length++; }
        let value = identifier ? bytes[offset] : bytes[offset] & (mask - 1);
        let unknown = !identifier && value === mask - 1;
        for (let i = 1; i < length; i++) {
          value = value * 256 + bytes[offset + i];
          unknown &&= bytes[offset + i] === 255;
        }
        return { length, value, unknown };
      };
      function element(offset) {
        const tag = vint(offset, true), size = vint(offset + tag.length);
        const start = offset + tag.length + size.length;
        return { id: tag.value, offset, start, end: start + size.value, size };
      }
      const segment = element(element(0).end);
      if (segment.id !== 0x18538067 || !segment.size.unknown) return blob;
      let info;
      for (let offset = segment.start; offset < bytes.length;) {
        const item = element(offset);
        if (item.id === 0x114d9b74 || item.end <= offset || item.end > bytes.length) return blob;
        if (item.id === 0x1549a966) { info = item; break; }
        offset = item.end;
      }
      if (!info) return blob;
      let scale = 1000000;
      for (let offset = info.start; offset < info.end;) {
        const item = element(offset);
        if (item.id === 0x4489 || item.end <= offset || item.end > info.end) return blob;
        if (item.id === 0x2ad7b1) {
          scale = 0;
          for (let i = item.start; i < item.end; i++) scale = scale * 256 + bytes[i];
        }
        offset = item.end;
      }
      if (!scale) return blob;
      const duration = new Uint8Array(11);
      duration.set([0x44, 0x89, 0x88]);
      new DataView(duration.buffer).setFloat64(3, durationMs * 1e6 / scale);
      const size = info.end - info.start + duration.length;
      let length = info.size.length;
      while (size >= 2 ** (7 * length) - 1) length++;
      const sizeBytes = new Uint8Array(length);
      let remaining = size;
      for (let i = length - 1; i >= 0; i--) {
        sizeBytes[i] = remaining % 256;
        remaining = Math.floor(remaining / 256);
      }
      sizeBytes[0] |= 1 << (8 - length);
      return new Blob(
        [blob.slice(0, info.offset), new Uint8Array([0x15, 0x49, 0xa9, 0x66]), sizeBytes,
          blob.slice(info.start, info.end), duration, blob.slice(info.end)],
        { type: blob.type },
      );
    } catch { return blob; }
  }
  window.captureDeskRecordingStore = { save, append, list, read, finalizeWebm };
})();
