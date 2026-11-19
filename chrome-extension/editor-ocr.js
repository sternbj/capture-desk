const messages = {
  'loading tesseract core': 'Texterkennung wird geladen',
  'initializing tesseract': 'Texterkennung wird vorbereitet',
  'loading language traineddata': 'Sprachdaten werden geladen',
  'initializing api': 'Sprache wird vorbereitet',
  'recognizing text': 'Text wird erkannt',
};
const aborted = () => new DOMException('Texterkennung abgebrochen', 'AbortError');

// Every path points inside the extension. workerBlobURL:false is required by
// MV3's strict script policy; no remote code, data, or image uploads are used.
export function createLocalOCR({ onProgress = () => {} } = {}) {
  let activeJob;
  const path = name => chrome.runtime.getURL(`vendor/ocr/${name}`);
  async function cancel() {
    const job = activeJob;
    if (!job) return;
    activeJob = null; job.cancelled = true; job.rejectCancellation(aborted());
    if (job.worker) await job.worker.terminate().catch(() => {});
  }
  async function recognize(image, language = 'eng+deu') {
    if (activeJob) throw new Error('Eine Texterkennung läuft bereits.');
    if (!globalThis.Tesseract?.createWorker) throw new Error('Die lokale Texterkennung konnte nicht geladen werden. Lade die Erweiterung neu.');
    const job = { worker: null, cancelled: false, rejectCancellation: null };
    const cancellation = new Promise((_resolve, reject) => { job.rejectCancellation = reject; });
    activeJob = job;
    const execution = (async () => {
      const created = await globalThis.Tesseract.createWorker(language, 1, {
        workerPath: path('worker.min.js'), corePath: path(''), langPath: path('').replace(/\/$/, ''),
        workerBlobURL: false, cacheMethod: 'none', legacyCore: false, legacyLang: false,
        logger: progress => {
          if (activeJob !== job || job.cancelled) return;
          onProgress({ label: messages[progress.status] || 'Texterkennung wird vorbereitet', progress: Math.max(0, Math.min(1, progress.progress || 0)) });
        },
      });
      if (job.cancelled) { await created.terminate(); throw aborted(); }
      job.worker = created;
      try {
        await created.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '150' });
        const result = await created.recognize(image);
        if (job.cancelled) throw aborted();
        return { text: result.data.text || '', confidence: result.data.confidence };
      } finally { await created.terminate().catch(() => {}); job.worker = null; }
    })();
    // Terminating a Tesseract worker does not reject its in-flight recognition
    // promise. The explicit cancellation race makes cancel/retry deterministic,
    // including cancellation while its local language files are still loading.
    try { return await Promise.race([execution, cancellation]); }
    finally { if (activeJob === job) activeJob = null; }
  }
  return { recognize, cancel };
}
