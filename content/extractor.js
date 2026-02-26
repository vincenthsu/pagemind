// Injected on-demand into regular web pages by the service worker
// Depends on readability.js being injected first (provides global Readability class)
// Returns extracted article text as a string

(function extractPageContent() {
  try {
    if (typeof Readability === 'undefined') {
      // Readability not available — fall back to body text
      return document.body.innerText
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    }

    // Clone the document to avoid mutating the live DOM
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone);
    const article = reader.parse();

    if (article?.textContent) {
      const title = article.title ? `Title: ${article.title}\n\n` : '';
      const content = article.textContent
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      return title + content;
    }

    // Readability couldn't parse — fall back to body text
    return document.body.innerText
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  } catch (e) {
    // Last resort fallback
    try {
      return document.body.innerText.trim();
    } catch (_) {
      return '';
    }
  }
})();
