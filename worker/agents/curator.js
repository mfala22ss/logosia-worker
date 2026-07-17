// Curator agent — assigns importance_score (0-100) and quality_score (0-10).
// Rejects garbage (low quality_score → filtered from public feed by the API layer).
//
// Heuristic, no AI required (saves Groq quota for translation/summary).

const { db } = require('../lib/db');
const { diplomacyKeywords, diplomacyFlashpointPairs } = require('../data/diplomacy-keywords.json');

const IMPORTANCE_KEYWORDS = {
    crisis:      ['war', 'attack', 'crisis', 'crash', 'collapse', 'breaking', 'urgent', 'emergency', 'invasion', 'strike'],
    macro:       ['inflation', 'rate cut', 'rate hike', 'recession', 'gdp', 'unemployment', 'fed ', 'ecb', 'opec'],
    geopolitics: ['nato', 'sanctions', 'treaty', 'summit', 'putin', 'xi jinping', 'trump', 'china', 'russia', 'ukraine', 'iran', 'israel', 'gaza'],
    market:      ['bitcoin', 'stock', 'market', 'crypto', 'ipo', 'merger', 'acquisition', 'bankruptcy'],
};

const GARBAGE_PATTERNS = [
    /^(opinion|column|editorial):/i,
    /\b(horoscope|recipe|quiz|gallery|listicle)\b/i,
    /\bsponsored\b/i,
    /^\s*$/,
    // Affiliate / lifestyle / commerce spam — common in CNN/USA Today feeds
    /\b(home equity|cash out|mortgage rate|refinance|loan|credit card offer)\b/i,
    /\b(\d+ (best|most useful|amazing|essential|incredible|must-have))\b/i,
    /\b(best (?:deals|gifts|products|amazon)|amazon prime)\b/i,
    /\b(workout|skincare|recipe|composting|gardening|travel hack)\b/i,
    /\b(dream big|easy way to|simple trick|surprising)\b/i,
    /\b(top \d+ (?:gadgets|products|things))\b/i,
    /\b(deals? you (?:can|should))\b/i,
];

function scoreArticle(article) {
    const text = ((article.title || '') + ' ' + (article.snippet || '')).toLowerCase();
    let importance = 0;
    let quality    = 5;

    // Importance from keyword hits
    for (const list of Object.values(IMPORTANCE_KEYWORDS)) {
        for (const kw of list) if (text.includes(kw)) importance += 8;
    }

    // Diplomacy keyword boost — any ceasefire/treaty/negotiation term
    for (const kw of diplomacyKeywords) {
        if (text.includes(kw)) { importance += 10; break; }
    }

    // Flashpoint pair boost — e.g. ["iran","ceasefire"] together signals major event
    for (const [geo, event] of diplomacyFlashpointPairs) {
        if (text.includes(geo) && text.includes(event)) { importance += 20; break; }
    }

    // Tier-based trust adjustment (1=wire/govt, 2=major, 3=specialist/state, 4=aggregator)
    const tier = article.tier || 2;
    if (tier === 1)      { quality += 2; importance += 15; }
    else if (tier === 3) { quality -= 1; }
    else if (tier === 4) { quality -= 2; }

    // Verified state-media: lower trust but still newsworthy → boost importance, lower quality
    if (article.is_state_media) { importance += 5; quality -= 1; }

    // Has image → reads as more polished
    if (article.image_url)      quality += 1;
    // Short title (<30) often means link spam
    if ((article.title || '').length < 25) quality -= 1;
    if ((article.snippet || '').length > 100) quality += 1;

    // Source credibility lifts quality
    if (article.factual_score >= 8) quality += 1;
    if (article.factual_score <= 3) quality -= 2;

    // Garbage patterns floor it
    for (const re of GARBAGE_PATTERNS) {
        if (re.test(article.title)) { quality = Math.min(quality, 2); break; }
    }

    return {
        importance_score: Math.max(0, Math.min(100, importance)),
        quality_score:    Math.max(1, Math.min(10, quality)),
    };
}

async function run({ limit = 500 } = {}) {
    // Select on quality_score only. The clusterer overwrites importance_score for
    // recent articles, so a clustered-but-unscored article would still have
    // quality_score = 0 — keying on quality alone ensures curator always reaches it.
    //
    // Ordered by id, not ingested_at. id is the bigserial primary key: already
    // indexed and monotonic with insertion, so it means the same thing here while
    // letting Postgres walk the index instead of sorting the whole table.
    // ingested_at has no index — measured against production, it exceeded the 8s
    // statement timeout (9.5s, HTTP 500) while id returned in 0.34s. That timeout
    // is why this agent has been failing every run.
    const { data: articles, error } = await db
        .from('articles')
        .select('id, url, url_normalized, title, snippet, image_url, is_state_media, factual_score, tier')
        .eq('quality_score', 0)
        .order('id', { ascending: false })
        .limit(limit);

    if (error) throw new Error('[curator] fetch failed: ' + error.message);
    if (!articles?.length) return { processed: 0 };

    const updates = articles.map(a => ({ id: a.id, url: a.url, url_normalized: a.url_normalized, title: a.title, ...scoreArticle(a) }));

    // Batch upsert — single round-trip instead of N individual updates
    const { error: upsertErr } = await db
        .from('articles')
        .upsert(updates, { onConflict: 'id' });

    if (upsertErr) {
        throw new Error('[curator] batch upsert failed: ' + upsertErr.message);
    }

    const processed = updates.length;
    console.log(`[curator] ✓ Scored ${processed}/${articles.length} articles.`);
    return { processed };
}

module.exports = { run, scoreArticle, IMPORTANCE_KEYWORDS };
