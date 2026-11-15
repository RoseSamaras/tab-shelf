# Tab Shelf

**Close the tabs you're keeping "for later" without losing them.**

Tab Shelf is a Chrome extension that saves your open tabs (link plus a text snapshot of each page), closes them to free memory, and uses a local or free AI model to summarize every page and group them by topic, with a short brief on what to read first.

Developed by **Rose Samaras** · X [@RoseSamaras](https://x.com/RoseSamaras) · [reaudit.io](https://reaudit.io), brand visibility · [rose@reaudit.io](mailto:rose@reaudit.io)

---

## Features

- **Stash** this tab, this window, or all windows from the toolbar popup, with an optional note on why you're keeping them. Shortcut: `Alt+Shift+S` stashes the current window.
- **Summaries** of every page: 2–3 sentences, a guess at why you kept it, and a topic label.
- **Digest**: groups the whole shelf into topics and writes a short brief on what's worth reading first and what you can let go.
- **Search** across titles, summaries, notes and the full text of every saved page.
- **Views**: Topics, By date, Stale (never reopened after 30 days) and Done.
- **Memory freed**: an estimate of how much memory each stash released, with a running total.
- **Auto-stash** (optional): closes tabs you haven't looked at for a number of days.
- **Private sites**: pages from sites you list are never sent to a cloud model.
- **Light, dark or system theme.**
- **Works with free models**: Ollama, Chrome's built-in on-device AI, OpenRouter free models, or any OpenAI-compatible server.

## AI Wrapped (optional)

Turn it on in **Settings → AI Wrapped** to see what you use AI for (ChatGPT, Gemini, Claude, Perplexity, Copilot, Google AI Mode, DeepSeek, Grok) and to donate the **labels**, never your text, to the free, public AI Demand Index.

- Your prompts and the replies are captured as you use those sites and stay in this browser (text deleted after 30 days).
- Each prompt is labelled on your computer from fixed lists: request kind, journey stage, category, topic, brands named (prompt and reply), sites cited.
- **Automatic** mode donates at the first midnight at least 12 hours after you asked; until then you can edit labels, keep things private or delete them. **Review** mode sends nothing until you press Donate.
- Open **AI Wrapped** (popup or Settings) for your summary, the waiting list, past donations (withdraw any of them) and **What is sent**: the exact payload of the next donation.
- Health and legal questions are kept private unless you switch that on.
- Light on memory: the capture script only wakes after you send a prompt, reads the reply until it stops changing, then goes quiet. Labelling is plain rules, no model.

For local testing the index address defaults to `http://localhost:3001` (the Reaudit dev server); change it in Settings.
Sites marked "new" in Settings have not been tested against their current page layout yet.

## Set it up locally

You need Chrome 130 or later, or another Chromium browser (Edge, Brave, Arc). Chrome's on-device AI needs Chrome 138 or later.

1. **Get the code**
   ```bash
   git clone https://github.com/RoseSamaras/tab-shelf.git
   ```
   Or click **Code → Download ZIP** on GitHub and unzip it.

2. **Load it into Chrome**
   - Open `chrome://extensions`
   - Turn on **Developer mode** (top right)
   - Click **Load unpacked** and select the `tab-shelf` folder, the one that directly contains `manifest.json`
   - Pin Tab Shelf to the toolbar. Settings open automatically the first time.

3. **Pick a model** in Settings → Summaries, then click **Summarize a sample page** to check it works. You can skip this: tabs are still saved, and summaries catch up once a model is ready.

4. **Updating**: pull or unzip the new version into the **same folder**, then click the reload icon on the Tab Shelf card in `chrome://extensions`. Your shelf is kept.

There is no build step, no dependencies to install and no server. It's plain JavaScript modules loaded directly by Chrome.

## Choosing a model

| Option | Cost | Where it runs | Notes |
|---|---|---|---|
| **Automatic** (default) | Free | Local first | Uses Ollama if running, then Chrome on-device AI, then any other server you set, then OpenRouter |
| **Ollama** | Free | Your computer | Best results. Gives summaries, topics and "why you kept it" |
| **Chrome on-device AI** | Free | Your computer | Nothing to install on supported hardware. Summaries only. Runs while the shelf page is open |
| **OpenRouter free models** | Free, rate-limited | Cloud | Pick a model ending in `:free` from the list in Settings |
| **Other OpenAI-compatible** | Varies | Local or cloud | LM Studio (`http://localhost:1234/v1`), llama.cpp, vLLM, hosted APIs |

### Ollama

1. Install [Ollama](https://ollama.com) and download a model:
   ```bash
   ollama pull gemma3:4b
   ```
   Any small instruct model works. 3–8B models give good summaries; models under 1B often give weak ones.
2. In Settings, choose your model from the dropdown. It lists everything you have installed.

Tab Shelf handles Ollama's browser-extension block for you. If Settings still reports that Ollama blocks the extension, allow it manually:

```bash
# macOS (then quit Ollama from the menu bar and reopen it)
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
# Linux
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
# Windows (then restart Ollama)
setx OLLAMA_ORIGINS "chrome-extension://*"
```

Models whose name ends in `cloud` (for example `qwen3.5:cloud`) run on Ollama's servers, not your computer. Tab Shelf treats them as cloud models.

### Performance

Local models use a lot of CPU while they run. By default Tab Shelf summarizes in the background only while you're away from the keyboard, or right away while the shelf page is open in front of you. Only one page is summarized at a time. Use **Pause summaries** in the popup to stop all model work instantly.

## Your data

**Everything stays in your browser.** Tab Shelf stores links, page snapshots, summaries, notes, the digest and your settings in Chrome's extension storage on your computer. There is no account, no server and no tracking. The only data that leaves your computer is page text sent to a cloud model, and only if you choose one (OpenRouter, an Ollama `cloud` model, or a hosted API).

On macOS the data lives in:
```
~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/<extension-id>/
```

> ⚠️ **If you uninstall Tab Shelf (click "Remove" in `chrome://extensions`), everything it stored is permanently deleted.** Chrome removes an extension's storage together with the extension, and there is no way to recover it.

Things to know:
- **Closing Chrome, restarting or reloading the extension is safe.** Your shelf is kept.
- **Load it from the same folder every time.** Chrome gives unpacked extensions an ID based on the folder path. If you load a copy from a different folder, Chrome treats it as a new extension with an empty shelf.
- **Nothing is synced.** Each Chrome profile and each computer has its own shelf.
- **Back up before removing or moving it**: Settings → Your data → **Export shelf as JSON**.

## Contributing

**Tab Shelf is open for contributions.** Bug reports, ideas, design improvements and pull requests are all welcome, whether it's a one-line fix or a whole new feature.

### Ways to help

- **Report a bug**: [open an issue](https://github.com/RoseSamaras/tab-shelf/issues) with your Chrome version, the model you use, what you expected and what happened. Screenshots and console errors help a lot (right-click the toolbar icon → **Inspect popup**, or **Inspect views: service worker** on the extension card).
- **Suggest a feature**: open an issue describing the problem it solves.
- **Send a pull request**: fork the repo, make your change on a branch, and open a PR explaining what it does and how you tested it.

### Ideas we'd love help with

- **Import** a JSON export to restore a shelf
- **A fixed extension ID**, so moving the folder never loses data
- **Meaning-based search** with local embeddings ("that article about citation decay")
- **Scheduled digests** (for example a Monday-morning brief)
- **Summaries in more languages**, including Greek
- **Firefox and Safari** versions
- **Optional sync** between computers
- **Reading-time estimates** and better stale-tab suggestions
- **Keyboard navigation** on the shelf page
- **Tests**, and a small test harness for the Chrome APIs

### Development notes

- Plain ES modules, no bundler. Edit a file, click reload on the extension card, and refresh the page.
- Keep it local-first: nothing should leave the browser unless the user chose a cloud model.
- Set page text with `textContent` (the `h()` helper in `src/ui.js`), never `innerHTML`. Page titles and summaries come from arbitrary websites.
- Chrome's on-device AI isn't available in the service worker, which is why the shelf page also runs the summary queue.

```
manifest.json          Manifest V3 config
src/background.js      service worker: stashing, page capture, auto-stash, alarms, Ollama header rule
src/queue.js           summary queue (one runner at a time, idle-aware)
src/llm.js             models: Chrome Summarizer/Prompt API, Ollama structured output, OpenAI-compatible chat
src/store.js           storage wrapper (items and page text in separate keys), stats
src/library.js         shelf page
src/popup.js           toolbar popup
src/options.js         settings page
src/theme.js           light/dark/system theme, applied before paint
src/ui.js              small DOM helpers
styles.css             all styles, including the paper texture
vendor/Readability.js  Mozilla Readability for clean page text
```

### Known limitations

- Tabs Chrome has put to sleep are saved as links only, since there's no live page to read.
- PDFs and some protected pages (like the Chrome Web Store) can't be read.
- The memory figure is a conservative estimate. Per-tab CPU isn't available to extensions in regular Chrome.
- Search matches words, not meaning.

## License

MIT © Rose Samaras. See [LICENSE](LICENSE). Bundles [Mozilla Readability](https://github.com/mozilla/readability), licensed under Apache-2.0 (see `vendor/Readability-LICENSE.md`).

## Author

**Rose Samaras**
- X: [@RoseSamaras](https://x.com/RoseSamaras)
- Web: [reaudit.io](https://reaudit.io), brand visibility in AI search
- Email: [rose@reaudit.io](mailto:rose@reaudit.io)
