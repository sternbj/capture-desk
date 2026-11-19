# Use a ChatGPT or Claude subscription

Open **AI assistant** in Capture Desk and choose **ChatGPT** or **Claude**. On the web, use the prepared prompt in the provider's own chat. To analyze an image, download it from the assistant and attach it in the chat.

## Use a subscription inside the Chrome extension on macOS

Install Node.js 22 or later and download or clone the Capture Desk source. In `chrome://extensions`, turn on Developer mode and copy the ID of your Capture Desk extension. From the source folder, replace `EXTENSION_ID` with that ID and run:

```sh
node native/install.mjs EXTENSION_ID
```

The installer registers the helper for that Chrome extension under your macOS account. Chrome asks for permission to connect when you first use a subscription feature. The helper runs on demand on your Mac.

If you installed Claude Code outside the usual locations, add `--claude "/absolute/path/to/claude"` to the install command.

- **ChatGPT.** Choose **Continue with ChatGPT** and authorize an eligible ChatGPT plan in OpenAI's sign-in page. You can manage shared plan usage in [ChatGPT settings](https://chatgpt.com/settings/usage). Capture Desk encrypts the connection credentials locally with a key stored in macOS Keychain. [OpenAI's documentation](https://developers.openai.com/siwc/token-sharing-open-source)
- **Claude.** Install or update the [official Claude Code CLI](https://code.claude.com/docs/en/setup). Run `claude auth login` in Terminal and sign in with your Claude plan. Return to Capture Desk to check the connection. The helper runs your installed Claude Code with tools disabled using your own sign-in. [Claude plan usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

Only the selected prompt and material go to the provider when you run an action. For a recording, load an existing TXT, SRT or VTT transcript or paste its text.

## Disconnect or uninstall

Disconnect ChatGPT in the assistant before uninstalling to remove the local connection. You can also revoke access from the login connections in ChatGPT settings. Your Claude sign-in is managed by Claude Code.

```sh
node native/install.mjs --uninstall
```
