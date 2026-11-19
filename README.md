# Capture Desk

Capture Desk records your screen or a selected rectangle and keeps the result in your browser. It works without a Capture Desk account or a recording server.

- **Chrome extension** — record a display, window or Chrome tab, choose an area, and use the floating controls. Capture and edit screenshots, trim and mark up videos, and save files to an optional local folder.
- **Desktop browser app** — record, crop and download in Firefox, Safari and Chromium when the browser exposes the required screen capture APIs.
- **Optional AI assistant** — analyze screenshots or supplied text and transcripts. Use a ChatGPT or Claude subscription, an OpenRouter key, or a local Ollama model. The recorder interface is available in English, German, French and Spanish.

[Open the browser app](https://sternbj.github.io/capture-desk/standalone/) · [Download Chrome builds](https://github.com/sternbj/capture-desk/releases) · [Data use](https://sternbj.github.io/capture-desk/privacy.html)

## Record

In Chrome, install the extension, choose a source, and turn on **Record an area** if you want to draw a rectangle in the preview. Use the floating bar to pause, stop or open recording settings. During a full-display recording, the bar opens after pausing so it stays outside the video. You can also end Chrome's share to save a recording. Find your copies under **Recordings in Chrome**.

In the browser app, choose a source through the browser and keep the recorder page open. Position the crop after sharing the source. The browser controls which sources and source audio are available. Turn on the microphone separately for narration. On desktop Safari and Firefox, use the in-page recording controls when an always-on-top controls window is unavailable.

## AI

Open **AI assistant** and choose the provider. For a video, paste its transcript or open a TXT, SRT or VTT file. For an image, open the assistant from the Chrome image editor or capture a frame in the browser app. The assistant uses the source you explicitly choose. For videos, provide the transcript.

| Provider | Setup |
| --- | --- |
| ChatGPT subscription | On macOS in Chrome, use the local helper and authorize an eligible plan with **Continue with ChatGPT**. You can also open ChatGPT and paste the prepared prompt. |
| Claude subscription | On macOS in Chrome, use the local helper and sign in to the official Claude Code app with your plan. You can also open Claude and paste the prepared prompt. |
| OpenRouter | Enter your own OpenRouter API key and choose a model supporting the input you plan to send. |
| Ollama | Run Ollama on the same computer. Pull a model, such as `gemma3:4b` for image and text input, and use `http://127.0.0.1:11434`. |

The [subscription setup](docs/ai-subscriptions.md) explains the optional helper and what to do in a browser without it. Capture Desk holds an OpenRouter key only while the assistant is open. A local Ollama setup can use `OLLAMA_NO_CLOUD=1`. If Ollama rejects requests from the browser, allow the exact app origin via `OLLAMA_ORIGINS` in Ollama's process environment and restart Ollama. Use `http://127.0.0.1:4173` for the default local website or `https://sternbj.github.io` for GitHub Pages. For Chrome, use `chrome-extension://<id>` with the ID shown on the Capture Desk extension card in `chrome://extensions`. Use a local model and the [Ollama configuration guide](https://docs.ollama.com/faq).

For a long transcript, choose a model whose context window can fit the input or process the sections separately. If the browser asks for local network access to reach Ollama, allow it for the recorder page after checking the local address.

## Run from source

Requirements for development are Node.js 22+, npm, and the `zip` and `unzip` command-line tools. FFmpeg is used by some verification scripts.

```sh
npm ci
npm run ocr:extension
npm run package:extension
npm run package:store
npm start
```

Open [the local browser app](http://127.0.0.1:4173/standalone/). The server in this command serves local files only. To load the Chrome extension during development, open `chrome://extensions`, turn on Developer mode and use **Load unpacked** with the `chrome-extension` directory. GitHub release archives include the generated OCR files.

Run the tests with `npx playwright install chromium firefox webkit` followed by `npm test`. Recording tests use synthetic sources and the AI tests use fixture responses.

[Chrome Web Store publishing and updates](docs/chrome-web-store.md) · [MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
