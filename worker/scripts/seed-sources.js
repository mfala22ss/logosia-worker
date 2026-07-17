// Seeds the `sources` table from feeds.json + source-ratings.json.
// Idempotent: re-runs safely (upserts by feed_url).
//
// Usage: npm run db:seed-sources

const path = require('path');
const fs = require('fs');
const { db } = require('../lib/db');
const { domainOf } = require('../lib/normalize');

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
        };
    });

    console.log(`[seed-sources] Upserting ${rows.length} sources...`);

    // Batch upsert
    const { data, error } = await db
        .from('sources')
        .upsert(rows, { onConflict: 'feed_url' })
        .select('id');

    if (error) {
        console.error('[seed-sources] FAILED:', error.message);
        process.exit(1);
    }

    console.log(`[seed-sources] ✓ Upserted ${data.length} sources.`);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
