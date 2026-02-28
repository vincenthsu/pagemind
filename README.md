# PageMind ✨
### *One click. Your AI. Any page.*

> **Already paying for ChatGPT, Gemini, Claude, or Grok?**
> Put that subscription to work — no extra cost, no API keys, no usage limits, no browser lock-in.

PageMind is a Chrome extension that **extracts the core content** of any webpage or YouTube video and delivers it straight into your favorite AI chat interface in one click — letting AI summarize, translate, or analyze it for you, all within your own account.

## 🚀 Why PageMind?

| ❌ Without PageMind | ✅ With PageMind |
|---|---|
| Copy article → switch tab → paste → type a prompt | **One click. Done.** |
| Browser-native AI that disappears when you switch browsers | Works with 4 major AI providers, always |
| API keys, tokens, and unexpected bills | Uses your existing paid subscription |
| Spending 20 minutes reading a long article | Get the key insights in seconds |

## ✨ Features

- **⚡ One-Click Summarization** — Click the icon, and you're done. No copy-pasting, no tab juggling.
- **🤖 4 AI Providers, Your Choice** — Works directly with your logged-in accounts. No API key needed:
  - **ChatGPT** (OpenAI)
  - **Gemini** (Google)
  - **Claude** (Anthropic)
  - **Grok** (xAI)
- **🎬 YouTube Transcript Extraction** — Automatically pulls video transcripts so AI can "watch" the video for you.
- **🧹 Smart Content Cleaning** — Powered by Mozilla's Readability.js to strip ads, navbars, and clutter — only the good stuff gets sent.
- **📝 Custom Prompts** — Save your go-to instructions like "Summarize in 3 bullet points", "Extract action items", or "Explain like I'm 5".
- **🪟 Companion Window Mode** — AI opens side-by-side so you never lose your place on the original page.
- **📋 Clipboard Fallback** — Content is also copied to your clipboard as a backup, just in case.

## 📦 Installation

The extension can be installed by loading it as an unpacked extension in Chrome:

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/pagemind.git
   ```
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the `pagemind` folder
6. Done! Pin it to your toolbar for quick access 📌

## 🎯 Usage

1. Navigate to any article, webpage, or YouTube video
2. Click the **PageMind** icon in your Chrome toolbar
3. Select your preferred **AI Provider**
4. Pick a prompt from the dropdown, or configure your own via Settings (⚙)
5. Click **Summarize This Page**
6. A companion window opens with your AI — content is injected and submitted automatically

## ⚙️ Settings

Click the gear icon ⚙ in the extension popup to:

- 🤖 Set your **default AI provider**
- 🪟 Choose **window mode** — Companion Window (side-by-side) or New Tab
- 📝 Add, edit, and reorder your **custom prompts**

## 🔐 Permissions & Privacy

PageMind **does not collect or transmit any of your data**. All content is processed locally in your browser and sent directly to the AI interface you're already logged into.

| Permission | Purpose |
|---|---|
| `activeTab` | Read the current page's content when you click the extension |
| `scripting` | Inject the Readability / YouTube transcript extractor |
| `storage` | Save your prompts and preferences locally |
| `clipboardWrite` | Copy extracted content to clipboard as a fallback |
| `windows` / `tabs` | Open and manage the AI companion window |

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

*Also available in: [繁體中文](README.zh-TW.md)*
