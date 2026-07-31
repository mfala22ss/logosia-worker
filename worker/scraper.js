// RSS scraper — fetches all enabled sources in parallel batches, inserts new
// articles into Postgres. Mirrors the headless half of the original news-bot.
//
// Returns: { fetched, inserted, skipped, failed }

const RSSParser = require('rss-parser');
const { db } = require('./lib/db');
const { normalizeUrl, extractImage, cleanSnippet, toStr } = require('./lib/normalize');
const { dedupCandidates } = require('./lib/dedup');
const { detectCountry } = require('./lib/geo-tagger');
const { isEphemeralLive } = require('./lib/ephemeral-live');
const { applyOutcomes } = require('./lib/source-health');
const { categorize } = require('./agents/categorizer');

// Note on the feeds that 403 here but load fine in a browser (measured
// 2026-07-31): the User-Agent is NOT the cause. Arab News returns 200 to a bare
// `fetch()` with OR without a UA, and 403 to rss-parser with OR without one.
// rss-parser v3 issues its request through node's `http` module, which sends
// almost no headers, and bot filters key on that overall shape rather than on
// the UA string alone. Setting `headers` here therefore changes nothing — it was
// tried and measured, so please do not re-add it expecting a fix.
//
// The transport that does work is `fetch()` + `parser.parseString()`. It was
// measured against 15 blocked feeds and recovered exactly ONE, so it is not
// worth rewriting this path for today. Revisit if the 403 count grows.
const parser = new RSSParser({
    customFields: {
        item: [
            'content:encoded',
            'description',
            'pubDate',
            ['media:content', 'mediaContent'],
            ['media:thumbnail', 'mediaThumbnail'],
            ['enclosure', 'enclosure'],
        ],
    },
    timeout: 12000,
});

const FETCH_CONCURRENCY = 8;

// PostgREST caps any single response at 1000 rows, so an unranged select silently
// truncates the source list rather than erroring. Page through explicitly.
const SOURCE_PAGE_SIZE = 1000;

const PREMIUM_NAMES = ["Reuters", "Associated Press", "Bloomberg", "Financial Times", "The Economist", "New York Times", "Politico"];

function safeDate(str) {
    if (!str) return new Date().toISOString();
    const t = new Date(str).getTime();
    return isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}
const FRESHNESS_HOURS = 168;  // 7 days — fills out country diversity

function isFresh(dateStr) {
    if (!dateStr) return true;
    const t = new Date(dateStr).getTime();
    if (isNaN(t)) return true;
    return (Date.now() - t) < FRESHNESS_HOURS * 3600_000;
}

// Returns an outcome, and writes nothing. Status bookkeeping moved to
// worker/lib/source-health.js so the whole run's outcomes can be judged together:
// a per-feed write cannot tell "this feed is dead" from "the network is down", and
// that distinction is the only thing standing between auto-disable and wiping the
// entire source list during a transient outage.
async function fetchFeed(source) {
    try {
        const parsed = await Promise.race([
            parser.parseURL(source.feed_url),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Feed timeout')), 12000)),
        ]);
        return { source, ok: true, items: parsed.items || [] };
    } catch (e) {
        const status = e.message.includes('timeout') ? 'timeout'
                     : e.message.includes('Status') ? 'http_error'
                     : 'parse_error';
        return { source, ok: false, status, error: e.message };
    }
}

// Premium membership is a column on sources, not a name match. Matching on the
// name pulled in outlets that merely share a word — "Politico Romania (Spotmedia)"
// is spotmedia.ro, "Business & Financial Times Ghana" is unrelated to the FT, and
// "Associated Press of Pakistan" is a different organisation. Matching on `domain`
// does not work either: Reuters, AP and Politico Romania all sit on news.google.com,
// because those feeds are Google News site: searches. The flag is set by
// db/migrations/20260728_is_premium.sql in the site repo.
function applyPremiumFilter(query) {
    return query.eq('is_premium', true);
}

// Reads every enabled source, paging past the 1000-row response cap.
// Ordered by id so page boundaries stay stable across requests.
async function fetchEnabledSources() {
    const premiumOnly = process.env.PREMIUM_ONLY === '1';
    if (premiumOnly) console.log('[scraper] PREMIUM_ONLY mode — filtering to premium sources');

    const sources = [];
    for (let from = 0; ; from += SOURCE_PAGE_SIZE) {
        let query = db.from('sources')
            .select('*')
            .eq('enabled', true)
            .order('id', { ascending: true })
            .range(from, from + SOURCE_PAGE_SIZE - 1);
        if (premiumOnly) query = applyPremiumFilter(query);

        const { data, error } = await query;
        if (error) throw new Error('[scraper] sources fetch failed: ' + error.message);

        sources.push(...data);
        if (data.length < SOURCE_PAGE_SIZE) return sources;
    }
}

async function scrape() {
    const sources = await fetchEnabledSources();

    if (!sources?.length) {
        console.warn('[scraper] No enabled sources — run `npm run db:seed-sources` first.');
        return { fetched: 0, inserted: 0, skipped: 0, failed: 0 };
    }

    console.log(`[scraper] Fetching ${sources.length} sources in batches of ${FETCH_CONCURRENCY}...`);

    const outcomes = [];
    for (let i = 0; i < sources.length; i += FETCH_CONCURRENCY) {
        const batch = sources.slice(i, i + FETCH_CONCURRENCY);
        outcomes.push(...await Promise.all(batch.map(fetchFeed)));
    }

    const fetched = outcomes.filter(o => o.ok);
    const failed  = outcomes.length - fetched.length;
    console.log(`[scraper] ✓ Fetched ${fetched.length}/${sources.length} (${failed} failed)`);

    // Health bookkeeping is applied to the whole run at once, and is non-fatal:
    // a scrape that fetched articles must still insert them even if the
    // bookkeeping write fails. Losing a counter update costs one run of latency
    // on auto-disable; losing the insert costs the site its news.
    let health = null;
    try {
        health = await applyOutcomes(outcomes);
    } catch (e) {
        console.warn('[scraper] source health bookkeeping failed:', e.message);
    }

    // Flatten + filter + dedupe before bulk insert
    const candidates = [];
    for (const { source, items } of fetched) {
        for (const item of items) {
            const url = item.link;
            if (!url) continue;
            if (!/^https?:\/\//i.test(url)) continue;
            if (!isFresh(item.isoDate || item.pubDate)) continue;
            if (isEphemeralLive(item.title)) continue;

            const rawContent = toStr(item['content:encoded']) || toStr(item.content) || item.contentSnippet || toStr(item.description) || '';
            candidates.push({
                source_id:          source.id,
                url,
                url_normalized:     normalizeUrl(url),
                title:              (item.title || 'Untitled').slice(0, 500),
                title_original:     (item.title || 'Untitled').slice(0, 500),
                snippet:            cleanSnippet(rawContent),
                image_url:          extractImage(item, rawContent),
                published_at:       safeDate(item.isoDate || item.pubDate),
                country:            detectCountry(item.title, source.country),
                language:           source.language,
                bias_score:         source.bias,
                factual_score:      source.factual,
                tier:               source.tier || 2,
                is_state_media:     source.is_state_media,
                verification_status: source.is_state_media ? 'state_media' : 'single_source',
            });
        }
    }

    if (candidates.length === 0) {
        console.log('[scraper] No fresh items found.');
        return { fetched: fetched.length, inserted: 0, skipped: 0, failed, health };
    }

    // In-memory semantic dedup: collapses same-story articles across sources.
    // URL dedup still happens at DB level via onConflict: 'url'.
    const before = candidates.length;
    const deduped = dedupCandidates(candidates);
    console.log(`[scraper] Dedup: ${before} → ${deduped.length} articles (${before - deduped.length} cross-source dupes dropped)`);

    // Categorize inline. It is a pure keyword function of title + snippet — both
    // already in memory here — so this costs no extra database round trip.
    //
    // It used to run only as a separate hourly agent, which could not keep up: a run
    // ingests ~20k articles and the agent managed a few thousand before hitting the
    // statement timeout. 98.9% of the table ended up with categories='{}', so the
    // site's category filters matched almost nothing. Doing it at insert means new
    // articles are never uncategorized, and the agent is left to drain the backlog.
    //
    // Applied after dedup so dropped duplicates are not categorized for nothing.
    let categorized = 0;
    for (const article of deduped) {
        const cats = categorize(article);
        article.category   = cats[0] || 'general';
        article.categories = cats.length ? cats : ['general'];
        if (cats.length) categorized++;
    }
    console.log(`[scraper] Categorized ${categorized}/${deduped.length} inline (${deduped.length - categorized} no keyword match → general)`);

    // Batch upsert in chunks — large single upserts timeout on Supabase free tier
    const UPSERT_BATCH = 200;
    let insertedCount = 0;
    console.log(`[scraper] Upserting ${deduped.length} articles in batches of ${UPSERT_BATCH}...`);
    for (let i = 0; i < deduped.length; i += UPSERT_BATCH) {
        const chunk = deduped.slice(i, i + UPSERT_BATCH);
        const { data: ins, error: insErr } = await db
            .from('articles')
            .upsert(chunk, { onConflict: 'url', ignoreDuplicates: true })
            .select('id');
        if (insErr) throw new Error('[scraper] upsert failed: ' + insErr.message);
        insertedCount += ins?.length || 0;
    }
    console.log(`[scraper] ✓ Inserted ${insertedCount} new articles (${deduped.length - insertedCount} duplicates).`);

    return {
        fetched: fetched.length,
        inserted: insertedCount,
        skipped: candidates.length - insertedCount,
        failed,
        health,
    };
}

module.exports = { scrape };
