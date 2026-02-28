// Injected on-demand into YouTube watch pages by the service worker (MAIN world)
// Extracts video info AND fetches transcript.
//
// Strategy (2025-compatible):
//   1. Read ytInitialPlayerResponse from the page for the INNERTUBE_API_KEY
//   2. Call the Innertube /player API impersonating ANDROID client to get
//      captionTracks with a valid baseUrl (no ip=0.0.0.0 issue)
//   3. Fetch the transcript XML from the baseUrl using XHR
//      (XHR bypasses YouTube's page Service Worker and sends cookies)

(async function extractYouTubeTranscript() {
  const RE_XML = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

  try {
    const videoId = new URL(location.href).searchParams.get('v');
    if (!videoId) return { error: 'No video ID found' };

    const videoTitle = document.title.replace(/ - YouTube$/, '').trim();
    const header = `YouTube Video: ${videoTitle}\nURL: ${location.href}\n\n`;

    // --- Step 1: Get INNERTUBE_API_KEY from the page ---
    let apiKey = null;

    // Try from ytcfg (fastest, already in page memory)
    if (typeof ytcfg !== 'undefined' && ytcfg?.data_) {
      apiKey = ytcfg.data_.INNERTUBE_API_KEY;
    }

    // Fallback: extract from page HTML
    if (!apiKey) {
      try {
        const pageHtml = await xhrGet(`https://www.youtube.com/watch?v=${videoId}`);
        const match = pageHtml.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
        if (match) apiKey = match[1];
      } catch { /* will fail below */ }
    }

    if (!apiKey) {
      return { content: header + '[Could not find INNERTUBE_API_KEY]' };
    }

    // --- Step 2: Call Innertube /player API as ANDROID client ---
    // The ANDROID client returns captionTracks with baseUrls that work
    // without cookies (no ip=0.0.0.0 problem).
    let captionTracks = null;
    try {
      const playerJson = await xhrPost(
        `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
        JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38',
            },
          },
          videoId: videoId,
        })
      );
      const playerData = JSON.parse(playerJson);
      captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    } catch (e) {
      // Fallback: try from ytInitialPlayerResponse in page
      if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse) {
        captionTracks = ytInitialPlayerResponse?.captions
          ?.playerCaptionsTracklistRenderer?.captionTracks;
      }
    }

    if (!captionTracks || captionTracks.length === 0) {
      return { content: header + '[No captions/transcript available for this video]' };
    }

    // --- Step 3: Pick best track (prefer manual over ASR) ---
    const track =
      captionTracks.find((t) => t.kind !== 'asr') ||
      captionTracks.find((t) => t.kind === 'asr') ||
      captionTracks[0];

    if (!track?.baseUrl) {
      return { content: header + '[Caption track URL not found]' };
    }

    const lang = track.name?.simpleText || track.languageCode || 'unknown';

    // Clean the baseUrl — remove fmt param that might cause issues
    let transcriptUrl = track.baseUrl.replace(/&fmt=\w+/, '');

    // --- Step 4: Fetch transcript XML ---
    let transcriptXml;
    try {
      transcriptXml = await xhrGet(transcriptUrl);
    } catch (e) {
      return { content: header + `[Transcript fetch failed: ${e}]` };
    }

    if (!transcriptXml || transcriptXml.trim().length === 0) {
      return { content: header + '[Transcript response was empty]' };
    }

    // Check if we got HTML error page instead of XML
    const trimmed = transcriptXml.trim();
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
      return { content: header + '[YouTube returned an error page instead of transcript XML]' };
    }

    // --- Step 5: Parse XML ---
    const segments = [];
    let match;
    while ((match = RE_XML.exec(transcriptXml)) !== null) {
      const text = match[3]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n/g, ' ')
        .trim();
      if (text) segments.push(text);
    }

    if (segments.length === 0) {
      return {
        content: header + `[Could not parse transcript]\nPreview: ${transcriptXml.substring(0, 500)}`,
      };
    }

    return { content: header + `Transcript (${lang}):\n` + segments.join(' ') };
  } catch (err) {
    return { error: err.message };
  }

  // --- Helpers ---

  function xhrGet(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(`HTTP ${xhr.status}`);
        }
      };
      xhr.onerror = () => reject('Network error');
      xhr.send();
    });
  }

  function xhrPost(url, body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(`HTTP ${xhr.status}`);
        }
      };
      xhr.onerror = () => reject('Network error');
      xhr.send(body);
    });
  }
})();
