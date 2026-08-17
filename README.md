# PageMind ✨
### *One click. Your AI. Any page.*

> **Already paying for ChatGPT, Gemini, or Claude?**
> Put that subscription to work — no extra cost, no API keys, no usage limits, no browser lock-in.

PageMind is a Chrome extension that **extracts the core content** of any webpage or YouTube video and delivers it straight into your favorite AI chat interface in one click — letting AI summarize, translate, or analyze it for you, all within your own account.

## 🚀 Why PageMind?

| ❌ Without PageMind | ✅ With PageMind |
|---|---|
| Copy article → switch tab → paste → type a prompt | **One click. Done.** |
| Browser-native AI that disappears when you switch browsers | Works with 3 major AI providers, always |
| API keys, tokens, and unexpected bills | Uses your existing paid subscription |
| Spending 20 minutes reading a long article | Get the key insights in seconds |

## ✨ Features

- **⚡ One-Click Summarization** — Click the icon, and you're done. No copy-pasting, no tab juggling.
- **🤖 3 AI Providers, Your Choice** — Works directly with your logged-in accounts. No API key needed:
  - **ChatGPT** (OpenAI)
  - **Gemini** (Google)
  - **Claude** (Anthropic)
- **📑 Native Side Panel** — Use ChatGPT, Gemini, or Claude beside the current page in Chrome's native Side Panel.
- **🪟 Three Provider Destinations** — Send summaries to the Side Panel, a side-by-side Companion Window, or a New Tab.
- **🖱️ Configurable Toolbar Icon** — Open the PageMind menu, summarize directly, or toggle the Side Panel.
- **🎬 YouTube Transcript Extraction** — Automatically pulls video transcripts so AI can "watch" the video for you.
- **🧹 Smart Content Cleaning** — Powered by Mozilla's Readability.js to strip ads, navbars, and clutter — only the good stuff gets sent.
- **📝 Custom Prompts** — Save your go-to instructions like "Summarize in 3 bullet points", "Extract action items", or "Explain like I'm 5".
- **📋 Clipboard Fallback** — Content is also copied to your clipboard as a backup, just in case.
- **🌐 Multi-Language Interface** — English and Traditional Chinese (Taiwan); follows your browser language by default, or pick one in Settings.

## 📦 Installation

The extension can be installed by loading it as an unpacked extension in Chrome:

### Method 1: Download from Release (Recommended)
1. Go to the [Releases](https://github.com/vincenthsu/pagemind/releases) page.
2. Download the latest `pagemind-vX.X.X.zip` file.
3. Unzip the downloaded file.
4. Open Chrome and go to `chrome://extensions/`
5. Enable **Developer mode** (toggle in the top-right corner)
6. Click **Load unpacked**
7. Select the unzipped `pagemind` folder
8. Done! Pin it to your toolbar for quick access 📌

### Method 2: Clone Repository (For Developers)
1. Clone this repository:
   ```bash
   git clone https://github.com/vincenthsu/pagemind.git
   ```
2. Follow steps 4-8 from above, selecting the cloned folder.
## 🎯 Usage

1. Navigate to any article, webpage, or YouTube video
2. Click the **PageMind** icon in your Chrome toolbar (or right-click for options)
3. Select your preferred **AI Provider**
4. Pick a prompt from the dropdown, or configure your own via Settings (⚙)
5. Click **Summarize This Page**
6. PageMind opens your selected AI Provider Window (Side Panel, Companion Window, or New Tab) — content is injected and submitted automatically

> Provider sign-in, verification, or OAuth may refuse to run inside an iframe. Use **Open in New Tab**, finish sign-in, then reload the Side Panel.

## ⚙️ Settings

Click the gear icon ⚙ in the extension popup to:

- 🌐 Choose the **interface language** — Match browser language, English, or 正體中文（台灣）
- 🤖 Set your **default AI provider**
- 🪟 Choose **AI Provider Window** — Chrome Side Panel, Companion Window (side-by-side), or New Tab
- 🖱️ Choose **Toolbar Icon Action** — Open PageMind Menu, Summarize Directly, or Toggle Side Panel
- 📝 Add, edit, and reorder your **custom prompts**

## 🔐 Permissions & Privacy

PageMind **does not collect or transmit any of your data**. All content is processed locally in your browser and sent directly to the AI interface you're already logged into.

| Permission | Purpose |
|---|---|
| `activeTab` | Read the current page's content when you click the extension |
| `scripting` | Inject the Readability / YouTube transcript extractor |
| `storage` | Save your prompts and preferences locally |
| `clipboardWrite` | Copy extracted content to clipboard as a fallback |
| `windows` / `tabs` | Open and manage AI windows and tabs |
| `sidePanel` | Display PageMind and the selected AI provider in Chrome's native Side Panel |
| `declarativeNetRequestWithHostAccess` | Remove frame-blocking headers only for AI provider subframes embedded by PageMind |

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

*Also available in: [繁體中文](README.zh-TW.md)*
