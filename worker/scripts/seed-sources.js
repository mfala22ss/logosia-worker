// Seeds the `sources` table from feeds.json + source-ratings.json.
// Idempotent: re-runs safely (upserts by feed_url).
//
// feeds.json is the source of truth. Rows whose feed_url is no longer in the file
// are disabled, not deleted — the articles table references sources by id, so
// deleting would orphan history. Disabling stops the scraper fetching them.
//
// Usage: npm run db:seed-sources
//        npm run db:seed-sources -- --dry-run    # report changes, write nothing

const path = require('path');
const fs = require('fs');
const { db } = require('../lib/db');
const { domainOf } = require('../lib/normalize');

// PostgREST caps any response at 1000 rows. Reading the source list unranged would
// silently return a subset — and every unread row would then look like an orphan
// and be disabled. Page explicitly.
const SELECT_PAGE = 1000;
const DISABLE_BATCH = 200;

// Sources shown under the ★ Premium tab. Exact names — never substring matching.
// Matching on the name pulled in outlets that merely share a word: "Politico Romania
// (Spotmedia)" is spotmedia.ro, "Business & Financial Times Ghana" is unrelated to
// the FT, and "Associated Press of Pakistan" is a different organisation. Matching on
// the domain does not work either, because Reuters, AP and Politico Romania all sit
// on news.google.com — those feeds are Google News site: searches.
//
// This list is the source of truth for the is_premium column. The equivalent SQL in
// db/migrations/20260728_is_premium.sql only backfills an already-populated table;
// on a fresh database the seeder is what sets the flag.
const PREMIUM_SOURCE_NAMES = new Set([
    // Reuters and AP both discontinued public RSS (verified 2026-07-28:
    // feeds.reuters.com no longer resolves, reutersagency.com/feed and
    // apnews.com/hub/ap-top-news.rss both 404). These are Google News feeds
    // restricted with site:reuters.com / site:apnews.com, so the articles are
    // genuinely theirs even though the link goes via a Google redirect.
    'Reuters World', 'Reuters Business', 'Reuters Canada',
    'Reuters Africa', 'Reuters Health', 'Reuters Technology',
    'Associated Press',
    // Official publisher feeds.
    'Bloomberg', 'Bloomberg Technology',
    'Financial Times', 'Financial Times Markets',
    'New York Times',
    'Politico', 'Politico EU', 'Politico EU Technology',
    'The Economist', 'The Economist Finance', 'The Economist Leaders',
    'The Economist Briefing', 'The Economist Britain', 'The Economist Europe',
    'The Economist Asia', 'The Economist Business', 'The Economist Science',
    'The Economist World This Week',
]);

// Ordered by id so page boundaries stay stable between requests.
async function fetchEnabledSources() {
    const sources = [];
    for (let from = 0; ; from += SELECT_PAGE) {
        const { data, error } = await db
            .from('sources')
            .select('id, name, feed_url, country')
            .eq('enabled', true)
            .order('id', { ascending: true })
            .range(from, from + SELECT_PAGE - 1);
        if (error) {
            console.error('[seed-sources] source fetch failed:', error.message);
            process.exit(1);
        }
        sources.push(...data);
        if (data.length < SELECT_PAGE) return sources;
    }
}

async function main() {
    const feeds = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/feeds.json'), 'utf8'));
    const ratingsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/source-ratings.json'), 'utf8'));
    const { _meta, ...ratings } = ratingsRaw;

    const rows = feeds.map(f => {
        const domain = domainOf(f.url);
        // Try domain match first, then strip subdomains
        let rating = ratings[domain];
        if (!rating) {
            const parts = domain.split('.');
            for (let i = 1; i < parts.length - 1; i++) {
                const cand = parts.slice(i).join('.');
                if (ratings[cand]) { rating = ratings[cand]; break; }
            }
        }
        return {
            name:           f.name,
            domain,
            feed_url:       f.url,
            country:        (f.origin || '').replace(/[\[\]]/g, '') || null,
            language:       f.language || 'en',
            bias:           rating?.bias ?? 0,
            factual:        rating?.factual ?? 5,
            credibility:    rating?.credibilityScore ?? 50,
            type:           rating?.type || 'unknown',
            is_state_media: rating?.bias === 99 || rating?.type === 'state_media',
            intel_source:   f.intelSource === true,
            tier:           f.tier ?? 2,
            enabled:        true,
            is_premium:     PREMIUM_SOURCE_NAMES.has(f.name),
        };
    });

    const dryRun = process.argv.includes('--dry-run');
    if (dryRun) console.log('[seed-sources] DRY RUN — no writes');

    console.log(`[seed-sources] Upserting ${rows.length} sources...`);

    if (!dryRun) {
        const { data, error } = await db
            .from('sources')
            .upsert(rows, { onConflict: 'feed_url' })
            .select('id');

        if (error) {
            console.error('[seed-sources] FAILED:', error.message);
            process.exit(1);
        }
        console.log(`[seed-sources] ✓ Upserted ${data.length} sources.`);
    }

    await disableOrphans(rows.map(r => r.feed_url), dryRun);
    process.exit(0);
}

// Any enabled row whose feed_url is no longer in feeds.json is an orphan. Without
// this the scraper keeps fetching removed feeds forever: deleting a feed from
// feeds.json had no effect on what actually got scraped, because the upsert above
// only ever writes enabled:true and never turns anything off.
async function disableOrphans(currentUrls, dryRun) {
    const urlSet = new Set(currentUrls);
    const enabled = await fetchEnabledSources();
    const orphans = enabled.filter(s => !urlSet.has(s.feed_url));

    if (!orphans.length) {
        console.log('[seed-sources] ✓ No orphaned sources.');
        return;
    }

    console.log(`[seed-sources] ${orphans.length} orphaned sources (enabled but absent from feeds.json):`);
    for (const o of orphans) console.log(`    ${o.country || '???'}  ${o.name}`);

    if (dryRun) {
        console.log('[seed-sources] DRY RUN — would disable the above.');
        return;
    }

    for (let i = 0; i < orphans.length; i += DISABLE_BATCH) {
        const chunk = orphans.slice(i, i + DISABLE_BATCH);
        const { error } = await db
            .from('sources')
            .update({ enabled: false })
            .in('id', chunk.map(o => o.id));
        if (error) {
            console.error('[seed-sources] disable failed:', error.message);
            process.exit(1);
        }
    }
    console.log(`[seed-sources] ✓ Disabled ${orphans.length} orphaned sources.`);
}

main().catch(e => { console.error(e); process.exit(1); });
