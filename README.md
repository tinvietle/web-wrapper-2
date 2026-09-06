# Local AI Relay

Run a local batch through a ChatGPT or Gemini tab that you have already signed in to. This uses the browser UI, not an official provider API.

## Connect the browser

1. Install Node.js 20+ and dependencies:

   ```bash
   npm install
   ```

2. Choose a private token, then start the relay:

   ```bash
   export APIBEAM_RELAY_TOKEN='choose-a-long-random-token'
   npm run apibeam:relay
   ```

3. In Chrome, visit `chrome://extensions`, enable **Developer mode**, then choose **Load unpacked** and select the `extension/` folder from this repository.

4. Open the extension's **Details** page → **Extension options**. Set:

   - Relay URL: `ws://127.0.0.1:8787`
   - Token: the exact `APIBEAM_RELAY_TOKEN` value above

5. Open and sign in to [ChatGPT](https://chatgpt.com/) or [Gemini](https://gemini.google.com/). The extension options page should show **Connected**.

## Run a crawl

Put your input text files in `chatgpt/input/` and the shared instruction in `prompt.txt`.

Run one item first:

```bash
npm run apibeam:chatgpt -- --limit 1
```

Run all ChatGPT inputs:

```bash
npm run apibeam:chatgpt
```

Run all inputs through Gemini:

```bash
npm run apibeam:gemini
```

Results are written to `chatgpt/output/` or `gemini/output/`. Existing valid results are skipped; add `-- --force` to rerun everything.
