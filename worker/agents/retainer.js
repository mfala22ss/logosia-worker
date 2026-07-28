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

const { db, dbSizeBytes, formatBytes, DISK_LIMIT_BYTES } = require('../lib/db');

const PRUNE_AFTER_DAYS  = parseInt(process.env.PRUNE_AFTER_DAYS  || '3',  10);
const DELETE_AFTER_DAYS = parseInt(process.env.DELETE_AFTER_DAYS || '14', 10);

// ── Disk-headroom guard ────────────────────────────────────────────────────
//
// The static 3d/14d windows were never measured against the 500MB volume — they
// were a guess made while cleaning up the 2026-07-20 outage. If ingest volume
// grows (more feeds, wordier sources, a backlog after downtime) the fixed windows
// stop being sufficient and the disk fills again in exactly the same way, only
// this time with a retainer running and appearing to work.
//
// So the windows are a floor, not a fixed value. Above SOFT the run halves both
// windows; above HARD it collapses them to the emergency minimums. Recovery is
// automatic: the tightening is computed per run from the CURRENT size, so once
// usage drops back the windows widen again on the next run with no intervention.
//
// The thresholds are deliberately well below 100%. Postgres needs free disk to
// write WAL, and once it cannot, it wedges in a crash-recovery loop where NO SQL
// runs at all — not TRUNCATE, not DROP INDEX, not the dashboard editor. There is
// no reactive fix at 100%; the only workable margin is the one taken early.
const SOFT_THRESHOLD_PCT = parseInt(process.env.DISK_SOFT_PCT || '70', 10);
const HARD_THRESHOLD_PCT = parseInt(process.env.DISK_HARD_PCT || '85', 10);

// Emergency floors. Below these the site has no content worth serving, so there
// is nothing to gain by shrinking further — at that point the problem is ingest
// volume or the plan, not retention.
const EMERGENCY_PRUNE_DAYS  = 1;
const EMERGENCY_DELETE_DAYS = 3;

// worker_runs grows unbounded by the same mechanism that killed the database the
// first time: a table nothing ever deletes from. ~96 rows/day is negligible until
// it is not, and "negligible" is what `articles` was on day one.
const WORKER_RUNS_RETAIN_DAYS = parseInt(process.env.WORKER_RUNS_RETAIN_DAYS || '30', 10);

// Chooses the retention windows for THIS run from current disk usage.
// Returns the configured defaults when the size is unknown — a failure to read
// the gauge must not silently trigger emergency deletion of real content.
function windowsFor(usedBytes) {
    if (usedBytes === null) {
        return { pruneDays: PRUNE_AFTER_DAYS, deleteDays: DELETE_AFTER_DAYS, level: 'normal', pct: null };
    }

    const pct = (usedBytes / DISK_LIMIT_BYTES) * 100;

    if (pct >= HARD_THRESHOLD_PCT) {
        return {
            pruneDays:  Math.min(PRUNE_AFTER_DAYS,  EMERGENCY_PRUNE_DAYS),
            deleteDays: Math.min(DELETE_AFTER_DAYS, EMERGENCY_DELETE_DAYS),
            level: 'hard',
            pct,
        };
    }

    if (pct >= SOFT_THRESHOLD_PCT) {
        return {
            pruneDays:  Math.max(EMERGENCY_PRUNE_DAYS,  Math.floor(PRUNE_AFTER_DAYS  / 2)),
            deleteDays: Math.max(EMERGENCY_DELETE_DAYS, Math.floor(DELETE_AFTER_DAYS / 2)),
            level: 'soft',
            pct,
        };
    }

    return { pruneDays: PRUNE_AFTER_DAYS, deleteDays: DELETE_AFTER_DAYS, level: 'normal', pct };
}

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

async function deletePass(deleteDays) {
    const before = cutoff(deleteDays);
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

async function prunePass(pruneDays) {
    const before = cutoff(pruneDays);
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

// Trims worker_runs. Separate from the article passes because the volumes differ
// by four orders of magnitude — this is a single small range delete, not a batched
// walk, and it is not worth the round trips to select ids first.
async function trimRunHistory() {
    const { error } = await db
        .from('worker_runs')
        .delete()
        .lt('started_at', cutoff(WORKER_RUNS_RETAIN_DAYS));

    // Non-fatal. This table existing at all is an improvement over not knowing
    // anything; failing the retainer over its housekeeping would be a regression.
    if (error) console.warn('[retainer] worker_runs trim failed:', error.message);
}

// Delete runs before prune: it removes the largest rows outright, so the prune
// pass never does redundant work on records that are about to disappear anyway.
async function run() {
    const usedBytes = await dbSizeBytes();
    const { pruneDays, deleteDays, level, pct } = windowsFor(usedBytes);

    if (level !== 'normal') {
        console.warn(
            `[retainer] ⚠ disk at ${pct.toFixed(1)}% ` +
            `(${formatBytes(usedBytes)}/${formatBytes(DISK_LIMIT_BYTES)}) — ` +
            `${level} threshold crossed, tightening retention to ` +
            `prune>${pruneDays}d delete>${deleteDays}d for this run.`
        );
    }

    const deleted = await deletePass(deleteDays);
    const pruned  = await prunePass(pruneDays);
    await trimRunHistory();

    console.log(
        `[retainer] ✓ deleted ${deleted} (>${deleteDays}d), ` +
        `pruned ${pruned} (>${pruneDays}d).`
    );

    // used_bytes / used_pct land in worker_runs.stages, which gives the watchdog a
    // usage series to trend on rather than a single instantaneous reading.
    return {
        deleted,
        pruned,
        prune_days:  pruneDays,
        delete_days: deleteDays,
        level,
        used_bytes:  usedBytes,
        used_pct:    pct === null ? null : Number(pct.toFixed(1)),
    };
}

module.exports = {
    run,
    windowsFor,
    PRUNE_AFTER_DAYS,
    DELETE_AFTER_DAYS,
    SOFT_THRESHOLD_PCT,
    HARD_THRESHOLD_PCT,
};
