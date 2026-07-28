// Run records — one row in `worker_runs` per pipeline run.
//
// Exists because of the 2026-07-20 outage: the site served no news for eight days
// and nothing anywhere could answer "when did the pipeline last actually work?"
// without a human opening GitHub Actions and reading logs. The watchdog
// (worker/scripts/watchdog.js) answers that question from this table.
//
// Hard rule: NOTHING in here may throw. Recording is observability, not work. The
// moment the database is unreachable — precisely when a record would be most
// useful — writing one becomes impossible, and the pipeline must still run and
// still report its own exit code. Every function swallows its errors and warns.

const { db } = require('./db');

// GitHub Actions sets these; absent when run locally.
const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_WORKFLOW } = process.env;

// Postgres text columns are unbounded, but an error string built from a stack
// trace can be enormous and there is no value past the first few lines.
const MAX_ERROR_CHARS = 2000;

function runUrl() {
    if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function jobName() {
    return GITHUB_WORKFLOW || 'local';
}

// Opens a run record and returns a handle. On failure the handle is still valid
// and simply does nothing — callers never branch on whether recording worked.
async function start({ dbBytes = null } = {}) {
    const startedAt = new Date();
    let id = null;

    try {
        const { data, error } = await db
            .from('worker_runs')
            .insert({
                started_at: startedAt.toISOString(),
                job:        jobName(),
                run_url:    runUrl(),
                db_bytes:   dbBytes,
            })
            .select('id')
            .single();

        if (error) console.warn('[run-record] insert failed:', error.message);
        else id = data.id;
    } catch (e) {
        console.warn('[run-record] insert threw:', e.message);
    }

    return { id, startedAt };
}

// Closes the record. `ok` is deliberately "zero stages failed", not "some stages
// worked": partial success is how this site degrades silently. The categorizer
// dying left 98.9% of articles uncategorized while every run stayed green.
async function finish(handle, { stages, failed, error = null } = {}) {
    if (!handle || handle.id === null) return;

    const finishedAt = Date.now();
    const durationMs = finishedAt - handle.startedAt.getTime();

    try {
        const { error: updateError } = await db
            .from('worker_runs')
            .update({
                finished_at:   new Date(finishedAt).toISOString(),
                duration_ms:   durationMs,
                ok:            failed === 0,
                stages_total:  Object.keys(stages || {}).length,
                stages_failed: failed,
                stages:        stages || {},
                error:         error ? String(error).slice(0, MAX_ERROR_CHARS) : null,
            })
            .eq('id', handle.id);

        if (updateError) console.warn('[run-record] update failed:', updateError.message);
    } catch (e) {
        console.warn('[run-record] update threw:', e.message);
    }
}

module.exports = { start, finish };
