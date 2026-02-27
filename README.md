# AI Page Summarizer ✨

A powerful Google Chrome extension that extracts the main content of the current webpage or YouTube video transcript and sends it to your favorite AI provider (ChatGPT, Gemini, Claude, or Grok) for summarization and analysis.

## Features

- **Readability Extraction**: Uses Mozilla's Readability.js to extract clean text from articles, stripping away ads, navigation, and clutter.
- **YouTube Transcripts**: Automatically extracts video transcripts if you are on a YouTube video page.
- **Multi-Provider Support**: Choose your preferred AI to process the text:
  - 🟩 ChatGPT
  - 🟦 Gemini
  - 🟧 Claude
  - 🩵 Grok
- **Custom Prompts**: Save your own default prompts (e.g., "Summarize in 3 bullet points", "Extract action items", "Translate to Traditional Chinese").
- **Companion Window Mode**: Seamlessly opens the AI provider in a side-by-side companion window without losing context of your current page.
- **Clipboard Fallback**: Automatically copies the extracted content to your clipboard as a backup.

## Installation

Currently, the extension can be installed manually by loading the unpacked extension in Chrome:

1. Download or clone this repository to your local machine:
   ```bash
   git clone https://github.com/yourusername/ai-page-summarizer.git
   ```
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click the **Load unpacked** button.
5. Select the `ai-page-summarizer` directory.
6. The extension is now installed! You can pin it to your toolbar for easy access.

## Usage

1. Navigate to an article, webpage, or YouTube video you want to summarize.
2. Click the **AI Page Summarizer** icon in your Chrome toolbar.
3. Select your preferred **AI Provider** (ChatGPT, Gemini, Claude, or Grok).
4. Choose an existing prompt from the dropdown or configure new ones in the Settings (⚙).
5. Click **Summarize This Page**.
6. A new companion window (or tab, depending on your settings) will open, and the text will be automatically injected into the AI's chat frame and submitted.

## Settings

Click the gear icon (⚙) in the extension popup to access the Settings page where you can:
- Change your **Default AI Provider**.
- Switch the **Window Mode** between "Companion Window" (side-by-side) or "New Tab".
- Manage and reorder your **Custom Prompts**.

## Technical Details & Permissions

To function effectively, this extension requires the following permissions:
- `activeTab`: To extract content from the current tab when the user clicks the extension button.
- `scripting`: To inject the Readability extractor or YouTube transcript extractor.
- `storage`: To save your custom prompts, default provider, and UI preferences locally.
- `clipboardWrite`: To copy the extracted payload to your clipboard via an offscreen document.
- `windows` & `tabs`: To manage the popup companion window smoothly and create new tabs.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
