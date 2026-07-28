// Retainer agent — enforces the storage retention policy.
//
// Added after the 2026-07-20 outage, when the free-tier 500MB volume filled and
// Postgres started returning `could not extend file: No space left on device`.
// The whole pipeline was dead for eight days. schema.sql had declared a `pruned`
// column for storage management since day one, but nothing ever set it and no
// code ever deleted a row, so ingestion grew without bound.
//
// Two passes, oldest-first, keyed on ingested_at (published_at is supplied by the
// feed and is frequently missing or wrong, so it cannot be trusted for storage
// decisions):
//
//   delete  — rows older than DELETE_AFTER_DAYS are removed outright
//   prune   — rows older than PRUNE_AFTER_DAYS keep their metadata but lose the
//             bulky text/image fields, so they still count for clustering and
//             corroboration without holding the payload
//
// Pinned articles (editor's picks) are exempt from both passes.

const { db } = require('../lib/db');

const PRUNE_AFTER_DAYS  = parseInt(process.env.PRUNE_AFTER_DAYS  || '3',  10);
const DELETE_AFTER_DAYS = parseInt(process.env.DELETE_AFTER_DAYS || '14', 10);

// Rows per round-trip. Large range deletes on one statement hit Supabase's
// statement timeout once the table is big, so both passes work in batches.
//
// Capped at 500 because supabase-js serialises `.in('id', ids)` into the URL
// query string as `id=in.(1,2,...)`. At 500 bigint ids that is roughly 5KB,
// which stays under the 8KB request-URI limit the gateway enforces; 1000 ids
// overruns it and the request fails with 414 rather than a useful error.
const BATCH_SIZE = 500;

// Bounds a single run at 50k rows per pass. Ingest measured ~4-6k articles/run
// at ~12 runs/day, so this keeps up comfortably while capping worst-case runtime
// if a backlog ever builds up.
const MAX_BATCHES = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Fields cleared on prune. Everything else (title, url, scores, cluster_id) is
// metadata the site and the clusterer still need.
const PRUNED_FIELDS = {
    snippet:        null,
    summary:        null,
    image_url:      null,
    title_original: null,
    pruned:         true,
};

function cutoff(days) {
    return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

// Selects a batch of ids, then acts on them by id. Selecting first keeps each
// write statement small and predictable instead of asking Postgres to plan an
// open-ended range mutation.
async function selectBatch(before, extraFilter) {
    let query = db
        .from('articles')
        .select('id')
        .lt('ingested_at', before)
        .eq('is_pinned', false)
        .order('ingested_at', { ascending: true })
        .limit(BATCH_SIZE);

    if (extraFilter) query = extraFilter(query);

    const { data, error } = await query;
    if (error) throw new Error('[retainer] select failed: ' + error.message);
    return (data || []).map(r => r.id);
}

async function deletePass() {
    const before = cutoff(DELETE_AFTER_DAYS);
    let deleted = 0;

    for (let i = 0; i < MAX_BATCHES; i++) {
        const ids = await selectBatch(before);
        if (!ids.length) break;

        const { error } = await db.from('articles').delete().in('id', ids);
        if (error) throw new Error('[retainer] delete failed: ' + error.message);

        deleted += ids.length;
        if (ids.length < BATCH_SIZE) break;
    }

    return deleted;
}

async function prunePass() {
    const before = cutoff(PRUNE_AFTER_DAYS);
    let pruned = 0;

    for (let i = 0; i < MAX_BATCHES; i++) {
        const ids = await selectBatch(before, q => q.eq('pruned', false));
        if (!ids.length) break;

        // update, not upsert: upsert would run an INSERT path and trip the NOT NULL
        // checks on title/url/url_normalized before reaching the conflict clause.
        const { error } = await db.from('articles').update(PRUNED_FIELDS).in('id', ids);
        if (error) throw new Error('[retainer] prune failed: ' + error.message);

        pruned += ids.length;
        if (ids.length < BATCH_SIZE) break;
    }

    return pruned;
}

// Delete runs before prune: it removes the largest rows outright, so the prune
// pass never does redundant work on records that are about to disappear anyway.
async function run() {
    const deleted = await deletePass();
    const pruned  = await prunePass();

    console.log(
        `[retainer] ✓ deleted ${deleted} (>${DELETE_AFTER_DAYS}d), ` +
        `pruned ${pruned} (>${PRUNE_AFTER_DAYS}d).`
    );

    return { deleted, pruned };
}

module.exports = { run, PRUNE_AFTER_DAYS, DELETE_AFTER_DAYS };
