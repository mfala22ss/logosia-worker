// Ported from worldmonitor/shared/ephemeral-live-classifier.js
// Filters out "WATCH LIVE: briefing" teasers — expiring viewing instructions,
// not durable news events. Prevents them inflating importance scores.

const WATCH_LIVE_PREFIX_RE   = /^\s*(?:watch\s+live|watch\s*:\s*live)\b[\s:;\-–—]*/i;
const WATCH_WITH_LIVE_RE     = /^\s*watch\s*:\s*.*\blive\b/i;
const LIVE_PREFIX_RE         = /^\s*live\s*:\s*/i;
const LIVE_EVENT_NOUN_RE     = /\b(?:briefing|press\s+briefing|press\s+conference|conference|hearing|testimony|remarks|speech|address|town\s+hall|livestream|live\s+stream)\b/i;
const LIVE_PROGRAMMING_RE    = /\b(?:watch|broadcast|airs?|airing|listen|tune\s+in|follow\s+live)\b/i;

function isEphemeralLive(title) {
    if (!title || typeof title !== 'string') return false;
    const t = title.trim();
    if (WATCH_LIVE_PREFIX_RE.test(t)) return true;
    if (WATCH_WITH_LIVE_RE.test(t))   return true;
    if (LIVE_PREFIX_RE.test(t)) {
        const after = t.replace(LIVE_PREFIX_RE, '').trim();
        if (LIVE_EVENT_NOUN_RE.test(after))  return true;
        if (LIVE_PROGRAMMING_RE.test(after)) return true;
    }
    return false;
}

module.exports = { isEphemeralLive };
