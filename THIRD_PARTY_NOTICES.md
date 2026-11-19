# Third-party components

- The extension includes [Lucide](https://lucide.dev/) icon paths under the ISC license. See `chrome-extension/icons/LICENSE-lucide`.
- The generated OCR runtime includes [Tesseract.js](https://github.com/naptha/tesseract.js) and [Tesseract.js Core](https://github.com/naptha/tesseract.js-core), under Apache-2.0. Their notices and bundled dependencies' notices are included in the generated extension.
- OCR language data is obtained from [naptha/tessdata](https://github.com/naptha/tessdata) via `@tesseract.js-data/eng` and `@tesseract.js-data/deu`. Those wrapper packages list MIT. The upstream [Tesseract training data](https://github.com/tesseract-ocr/tessdata) is Apache-2.0.
