// Resolves a YouTube channel handle to its current live video id.
//
// Ported from lib/youtube-live.ts in the site repo, which used to run this on
// every request to /live. Same logic, same two-signal rule; the difference is
// where it runs. See worker/agents/live-resolver.js.

// The og:video embed URL carries the 11-character video id.
const OG_VIDEO_RE = /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/;

// When a channel is NOT streaming, /live still serves a page carrying an
// og:video embed — for the channel's most recent ordinary upload. Matching the
// embed alone therefore cannot distinguish "streaming now" from "streamed
// something once", and the caller renders whatever it is given. That is how the
// France 24 tile ended up showing a Hamilton cast recording.
//
// YouTube marks a genuine live stream with "isLive": true in the embedded player
// config, so both signals are required. Reporting not-live on a miss makes the
// tile render its Offline state, which is honest, instead of an unrelated video.
const IS_LIVE_RE = /"isLive"\s*:\s*true/;

// These pages are ~1MB. A slow one must not stall the pipeline stage.
const TIMEOUT_MS = 15_000;

// Googlebot's UA is what the site version used and what YouTube serves a
// server-rendered page to. A browser UA gets the JS shell, which carries neither
// signal we need.
const USER_AGENT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/**
 * Returns { videoId, isLive, error }.
 *
 * Never throws. A channel that fails to resolve must not take down the other 32
 * or fail the stage — its tile simply renders Offline, which is the same thing
 * the caller would show anyway.
 */
async function resolveYouTubeLiveId(handle) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(`https://www.youtube.com/${handle}/live`, {
            headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
            signal: controller.signal,
            redirect: 'follow',
        });

        if (!res.ok) return { videoId: null, isLive: false, error: `HTTP ${res.status}` };

        const html = await res.text();
        const isLive = IS_LIVE_RE.test(html);
        const match = html.match(OG_VIDEO_RE);

        // The video id is recorded even when not live, purely for debugging a
        // channel that looks stuck. The page keys on isLive, never on the id.
        return { videoId: match ? match[1] : null, isLive, error: null };
    } catch (e) {
        const message = e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : e.message;
        return { videoId: null, isLive: false, error: String(message).slice(0, 200) };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { resolveYouTubeLiveId };
