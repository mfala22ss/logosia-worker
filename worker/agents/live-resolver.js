// Live resolver — precomputes which channels are streaming, so the site does not
// have to ask YouTube on the request path.
//
// Before this, app/live/page.tsx resolved every enabled channel's @handle per
// request. Measured 2026-07-31: ~830ms and ~1MB per channel, 33 channels, all on
// handles. Cold render 6.5s, warm 2.3s, and the page could not paint until the
// slowest of 33 concurrent YouTube requests came back. A Next.js fetch cache with
// revalidate:600 hid it for ten minutes at a time; whoever arrived after each
// expiry paid the full cost.
//
// This is the same shape as everything else here: the worker writes, the site
// reads. The page becomes one indexed Supabase query.
//
// ── The tradeoff, stated plainly ──────────────────────────────────────────
// Resolution is now as fresh as the pipeline cadence, not 10 minutes. Scheduled
// runs land roughly every 2 hours (GitHub throttles them heavily), so a stream
// that ends between runs would keep showing as live. That is handled on the read
// side: the page treats a row older than its staleness window as offline. The
// failure mode is a tile going dark slightly early, not a dead embed — which
// matches the existing rule that an honest Offline beats a wrong video.

const { db } = require('../lib/db');
const { resolveYouTubeLiveId } = require('../lib/youtube-live');

// YouTube tolerates this comfortably and 33 channels finish in a few seconds.
// Kept well below the scraper's concurrency because each response is ~1MB.
const CONCURRENCY = parseInt(process.env.LIVE_RESOLVE_CONCURRENCY || '6', 10);

async function run() {
    const { data: channels, error } = await db
        .from('live_channels')
        .select('id, name, youtube_id')
        .eq('enabled', true)
        .order('sort_order');

    if (error) throw new Error('[live-resolver] select failed: ' + error.message);
    if (!channels?.length) {
        console.log('[live-resolver] no enabled channels.');
        return { resolved: 0, live: 0, failed: 0 };
    }

    const now = new Date().toISOString();
    const results = [];

    for (let i = 0; i < channels.length; i += CONCURRENCY) {
        const batch = channels.slice(i, i + CONCURRENCY);
        results.push(...await Promise.all(batch.map(async (channel) => {
            // Non-handle ids (a bare video id, or live_stream?channel=UC...) are
            // already directly embeddable and need no lookup. Marked live so the
            // page keeps rendering them exactly as it did before.
            if (!channel.youtube_id?.startsWith('@')) {
                return { channel, videoId: null, isLive: true, error: null, skipped: true };
            }
            const r = await resolveYouTubeLiveId(channel.youtube_id);
            return { channel, ...r, skipped: false };
        })));
    }

    // One write per channel. supabase-js cannot express a bulk UPDATE of
    // differing values, and upsert would take the INSERT path and trip the NOT
    // NULL check on `name` before reaching the conflict clause — the same trap
    // documented in the retainer.
    let live = 0, failed = 0;
    for (const r of results) {
        if (r.error) failed++;
        if (r.isLive) live++;

        const { error: updateError } = await db.from('live_channels').update({
            resolved_video_id: r.videoId,
            resolved_is_live:  r.isLive,
            resolved_at:       now,
            resolve_error:     r.error,
        }).eq('id', r.channel.id);

        if (updateError) {
            console.warn(`[live-resolver] could not record ${r.channel.name}: ${updateError.message}`);
        }
    }

    const offline = results.filter(r => !r.isLive && !r.error).map(r => r.channel.name);
    if (offline.length) console.log(`[live-resolver] offline: ${offline.join(', ')}`);

    const broken = results.filter(r => r.error);
    for (const b of broken) console.warn(`[live-resolver] ✗ ${b.channel.name}: ${b.error}`);

    console.log(`[live-resolver] ✓ ${results.length} channels — ${live} live, ${failed} failed.`);
    return { resolved: results.length, live, failed };
}

module.exports = { run };
