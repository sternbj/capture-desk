import { safeFilename } from "./capture-core.js";

const access = { mode: "readwrite" };
const chooseAgain = "Klicke in den Recorder-Einstellungen auf „Schreibzugriff erlauben“ oder wähle den Speicherordner erneut.";

async function folderSetting(mode, operation) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("sternberg-recorder-storage-folder", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("settings", mode);
      const request = operation(tx.objectStore("settings"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || new Error("Chrome konnte die Ordnereinstellung nicht speichern."));
    });
  } finally { db.close(); }
}

export async function pickRecordingFolder() {
  if (!globalThis.showDirectoryPicker) throw new Error("Öffne die Recorder-Einstellungen in Chrome, um einen Ordner auszuwählen.");
  // The native dialog must be called while the user's click still has transient activation.
  const folder = await globalThis.showDirectoryPicker({ id: "sternberg-recordings", mode: "readwrite" });
  if (await folder.queryPermission(access) !== "granted") throw new Error(chooseAgain);
  await folderSetting("readwrite", store => store.put(folder, "directory"));
  return folder.name;
}

export async function getRecordingFolder() {
  return (await folderSetting("readonly", store => store.get("directory"))) ?? null;
}

export async function clearRecordingFolder() {
  await folderSetting("readwrite", store => store.delete("directory"));
}

function recordingFilename(record, blob) {
  const mimeType = blob.type.split(";")[0].trim().toLowerCase();
  if (!["video/mp4", "video/webm", "image/png", "image/jpeg", "image/webp"].includes(mimeType) || !blob.size || !record.id)
    throw new Error("Die Aufnahme ist unvollständig oder das Dateiformat wird nicht unterstützt.");
  const safe = safeFilename({ name: record.name, mimeType });
  const extension = safe.slice(safe.lastIndexOf("."));
  const name = safe.slice(0, -extension.length).trim();
  // Leave room for the timestamp, ID and collision suffix on filesystems with a 255-byte limit.
  let title = "";
  const encoder = new TextEncoder();
  for (const character of name) {
    if (encoder.encode(title + character).length > 110) break;
    title += character;
  }
  const date = new Date(record.createdAt);
  const stamp = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19).replaceAll(":", "-") : "Aufnahme";
  const id = String(record.id).replace(/[^\w-]/g, "_").slice(0, 64);
  return { stem: `${stamp} ${title || "Aufnahme"} ${id}`, extension };
}

async function sameContents(file, blob) {
  if (file.size !== blob.size) return false;
  const block = 1024 * 1024;
  for (let at = 0; at < file.size; at += block) {
    const [a, b] = await Promise.all([file, blob].map(item => item.slice(at, at + block).arrayBuffer()));
    const bytes = new Uint8Array(b);
    if (!new Uint8Array(a).every((value, index) => value === bytes[index])) return false;
  }
  return true;
}

async function saveFile(directory, stem, extension, blob) {
  for (let index = 1; ; index++) {
    const name = `${stem}${index === 1 ? "" : ` (${index})`}${extension}`;
    try {
      const existing = await directory.getFileHandle(name);
      if (await sameContents(await existing.getFile(), blob)) return name;
      continue;
    } catch (error) {
      if (error.name === "TypeMismatchError") continue; // An existing directory occupies this name.
      if (error.name !== "NotFoundError") throw error;
    }
    const handle = await directory.getFileHandle(name, { create: true });
    let writer;
    try {
      // Chrome commits the replacement only when close succeeds.
      writer = await handle.createWritable({ mode: "exclusive" });
      if ((await handle.getFile()).size) {
        await writer.abort();
        continue;
      }
      await writer.write(blob);
      await writer.close();
      return name;
    } catch (error) {
      if (writer) {
        await writer.abort().catch(() => {});
        // Discard only the empty placeholder opened by this attempt.
        try {
          const current = await directory.getFileHandle(name);
          if (await current.isSameEntry(handle) && !(await current.getFile()).size)
            await directory.removeEntry(name);
        } catch { /* The folder can be unplugged or its permission revoked mid-write. */ }
      }
      throw error;
    }
  }
}

export async function writeRecordingToFolder(record, blob) {
  const directory = await getRecordingFolder();
  if (!directory) throw new Error("Wähle zuerst einen Speicherordner in den Recorder-Einstellungen.");
  const { stem, extension } = recordingFilename(record, blob);
  try {
    if (await directory.queryPermission(access) !== "granted")
      throw new DOMException(chooseAgain, "NotAllowedError");
    // Multiple extension pages and worker events may retry the same recording simultaneously.
    return await navigator.locks.request("sternberg-recording-file:" + stem + extension,
      () => saveFile(directory, stem, extension, blob));
  } catch (error) {
    if (["NotAllowedError", "SecurityError", "NotFoundError"].includes(error.name)) throw new Error(chooseAgain, { cause: error });
    throw new Error("Die Aufnahme konnte nicht in den Ordner geschrieben werden. Prüfe den Speicherplatz und den Schreibzugriff und versuche es erneut.", { cause: error });
  }
}
