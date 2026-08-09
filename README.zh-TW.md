# PageMind ✨
### *一鍵搞定。你的 AI。任何頁面。*

> **已經付費訂閱 ChatGPT、Gemini 或 Claude？**
> 那就充分利用它 — 不需要額外付費、不需要 API Key、沒有用量限制、不被瀏覽器綁死。

PageMind 是一款 Chrome 擴充功能，**一鍵提取**當前網頁或 YouTube 影片的主要內容，自動送進你最愛的 AI 對話介面，讓 AI 幫你總結、翻譯、萃取重點 — 全程在你已登入的 AI 介面完成，資料完全由你掌控。

## 🚀 為什麼選擇 PageMind？

| ❌ 沒有 PageMind | ✅ 有了 PageMind |
|---|---|
| 複製文章 → 切換分頁 → 貼上 → 輸入提示詞 | **點一下，搞定** |
| 瀏覽器內建 AI，換瀏覽器就沒了 | 支援 3 大 AI，隨時切換 |
| 需要填 API Key、煩惱 token 費用 | 直接使用你現有的付費訂閱 |
| 閱讀長文、看影片消耗大量時間 | 秒懂重點，高效吸收 |

## ✨ 核心功能

- **⚡ One-Click 總結** — 點一下圖示即完成，沒有多餘步驟，沒有複製貼上。
- **🤖 支援 3 大 AI 訂閱** — 直接使用你已登入的帳號，無需 API Key：
  - **ChatGPT** (OpenAI)
  - **Gemini** (Google)
  - **Claude** (Anthropic)
- **📑 原生側邊面板** — 在 Chrome 原生 Side Panel 中使用 ChatGPT、Gemini 或 Claude。
- **🪟 三種 AI 開啟位置** — 可選原生 Side Panel、並排 Companion Window 或新分頁。
- **🖱️ 可設定工具列圖示** — 可選開啟 PageMind 選單、直接摘要或開關 Side Panel。
- **🎬 YouTube 逐字稿提取** — 自動抓取影片字幕，讓 AI 幫你「看」影片。
- **🧹 智慧清理內文** — 採用 Mozilla Readability.js，過濾廣告、選單等雜訊，只送出乾淨的正文。
- **📝 自訂提示詞** — 儲存常用指令，如「用繁體中文條列三個重點」、「幫我找出行動項目」、「用 ELI5 方式解釋」。
- **📋 剪貼簿備份** — 內容同步複製到剪貼簿，想手動貼也沒問題。

## 📦 安裝方式

目前可透過載入未封裝擴充功能的方式安裝：

### 方法一：下載 Release 壓縮檔（推薦）
1. 前往 [Releases](https://github.com/vincenthsu/pagemind/releases) 頁面。
2. 下載最新的 `pagemind-vX.X.X.zip` 壓縮檔。
3. 將檔案完整解壓縮。
4. 開啟 Chrome，前往 `chrome://extensions/`
5. 右上角開啟 **開發人員模式**
6. 點擊 **載入未封裝項目**
7. 選取剛才解壓縮的資料夾
8. 安裝完成！建議釘選到工具列以便隨時使用 📌

### 方法二：Clone 專案（適合開發者）
1. Clone 此專案：
   ```bash
   git clone https://github.com/vincenthsu/pagemind.git
   ```
2. 照著上述 4~8 的步驟，選取 clone 下來的資料夾即可安裝。
## 🎯 使用方式

1. 瀏覽任何文章、新聞或 YouTube 影片
2. 點擊工具列上的 **PageMind** 圖示（或點擊右鍵選單）
3. 選擇你的 **AI 提供者**（ChatGPT、Gemini 或 Claude）
4. 從下拉選單選擇提示詞，或點擊 ⚙ 新增自訂提示詞
5. 點擊 **Summarize This Page**
6. PageMind 會在你設定的 AI 開啟位置（Side Panel、並排視窗或新分頁）開啟 AI，內容自動送出，等待回應即可

> 部分 AI 提供者的登入、驗證或 OAuth 可能無法在 iframe 中執行。請使用 **在新分頁開啟** 完成登入後，再重新載入 Side Panel。

## ⚙️ 設定

點擊擴充功能介面的齒輪圖示 ⚙ 進入設定頁：

- 🤖 設定**預設 AI 提供者**
- 🪟 切換 **AI 開啟位置**（原生 Side Panel / 並排視窗 / 新分頁）
- 🖱️ 設定**工具列圖示點擊行為**（開啟 PageMind 選單 / 直接摘要 / 切換 Side Panel）
- 📝 管理與排序你的**自訂提示詞**

## 🔐 權限說明

PageMind **不會收集任何資料**，所有內容只在你的瀏覽器本機處理後，直接送往你已登入的 AI 介面。

| 權限 | 用途 |
|---|---|
| `activeTab` | 讀取當前分頁的網頁內容 |
| `scripting` | 注入 Readability / YouTube 字幕提取器 |
| `storage` | 儲存提示詞與設定（本機） |
| `clipboardWrite` | 將內容備份至剪貼簿 |
| `windows` / `tabs` | 開啟並管理 AI 視窗與分頁 |
| `sidePanel` | 在 Chrome 原生 Side Panel 中顯示 PageMind 及選取的 AI 提供者 |
| `declarativeNetRequestWithHostAccess` | 僅解除 PageMind 內嵌 AI 提供者子頁面的框架阻擋標頭 (X-Frame-Options / CSP) |

## 📄 授權

本專案採用 MIT License 授權 — 詳見 [LICENSE](LICENSE) 檔案。

*Also available in: [English](README.md)*
