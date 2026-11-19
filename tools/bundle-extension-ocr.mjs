// Build the self-contained OCR runtime. No OCR code or language data is fetched
// from the network when the extension is used.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(root, 'chrome-extension/vendor/ocr');
await mkdir(destination, { recursive: true });
const files = [
  ['tesseract.js/dist/tesseract.min.js', 'tesseract.min.js'],
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js/dist/tesseract.min.js.LICENSE.txt', 'LICENSE-browser-deps.txt'],
  ['tesseract.js/dist/worker.min.js.LICENSE.txt', 'LICENSE-worker-deps.txt'],
  ['tesseract.js/LICENSE.md', 'LICENSE-tesseract.txt'],
  ['tesseract.js-core/LICENSE', 'LICENSE-core.txt'],
  ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].map(variant => [`tesseract.js-core/tesseract-core-${variant}.wasm.js`, `tesseract-core-${variant}.wasm.js`]),
  ...['eng', 'deu'].map(language => [`@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`, `${language}.traineddata.gz`]),
  ...['eng', 'deu'].map(language => [`@tesseract.js-data/${language}/package.json`, `PACKAGE-${language}.json`]),
];
for (const [source, name] of files) await copyFile(join(root, 'node_modules', source), join(destination, name));
const version = JSON.parse(await readFile(join(root, 'node_modules/tesseract.js/package.json'), 'utf8')).version;
await writeFile(join(destination, 'README.txt'), `Local OCR runtime: Tesseract.js ${version}.\nThe editor uses OEM 1 (LSTM only), with scalar, SIMD and relaxed-SIMD cores.\nEnglish and German int8 language data are bundled from @tesseract.js-data (MIT).\nTesseract.js and core: Apache-2.0. No remote scripts, data, or image uploads.\n`);
console.log(`Bundled OCR ${version}: ${files.length} local runtime files`);
