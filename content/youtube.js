// Injected on-demand into YouTube watch pages by the service worker
// Extracts video transcript using YouTube's internal ytInitialPlayerResponse
// Returns a formatted string with the video title, URL, and transcript

(async function extractYouTubeTranscript() {
  try {
    const videoId = new URL(location.href).searchParams.get('v');
    if (!videoId) return null;

    const videoTitle = document.title.replace(/ - YouTube$/, '').trim();
    const header = `YouTube Video: ${videoTitle}\nURL: ${location.href}\n\n`;

    // ytInitialPlayerResponse is injected by YouTube into every watch page
    const playerResponse = window.ytInitialPlayerResponse;
    if (!playerResponse) {
      return header + '[Could not access video data — please summarize based on the title and URL]';
    }

    // Find caption tracks
    const captionTracks =
      playerResponse?.captions
        ?.playerCaptionsTracklistRenderer
        ?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      return header + '[No captions/transcript available for this video]';
    }

    // Prefer manual English captions, then auto-generated English, then first available
    const track =
      captionTracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ||
      captionTracks.find((t) => t.languageCode === 'en') ||
      captionTracks.find((t) => t.languageCode?.startsWith('en')) ||
      captionTracks[0];

    if (!track?.baseUrl) {
      return header + '[Caption track URL unavailable]';
    }

    // Fetch the transcript in JSON3 format
    const response = await fetch(track.baseUrl + '&fmt=json3');
    if (!response.ok) {
      return header + `[Transcript fetch failed: HTTP ${response.status}]`;
    }

    const data = await response.json();

    // Parse caption events into plain text
    const transcript = (data.events || [])
      .filter((e) => e.segs && e.segs.length > 0)
      .map((e) => e.segs.map((s) => s.utf8 || '').join(''))
      .filter((line) => line.trim() && line.trim() !== '\n')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!transcript) {
      return header + '[Transcript is empty]';
    }

    return header + 'Transcript:\n' + transcript;

  } catch (e) {
    const title = document.title.replace(/ - YouTube$/, '').trim();
    return `YouTube Video: ${title}\nURL: ${location.href}\n\n[Transcript extraction error: ${e.message}]`;
  }
})();
