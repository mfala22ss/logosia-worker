// Orchestrator — runs the pipeline: scrape → curate → translate → categorize → summarize.
//
// Usage:
//   node worker/index.js --once         # one pass, exit
//   node worker/index.js                # loop every SCRAPE_INTERVAL_MIN minutes (default 30)

require('dotenv').config({ path: '.env.local' });

const { dbSizeBytes, formatBytes, DISK_LIMIT_BYTES } = require('./lib/db');
const runRecord        = require('./lib/run-record');

const { scrape }       = require('./scraper');
const retainer         = require('./agents/retainer');
const curator          = require('./agents/curator');
const clusterer        = require('./agents/clusterer');
const translator       = require('./agents/translator');
const categorizer      = require('./agents/categorizer');
const summarizer       = require('./agents/summarizer');
const liveResolver     = require('./agents/live-resolver');

const INTERVAL_MIN = parseInt(process.env.SCRAPE_INTERVAL_MIN || '30', 10);
const ONCE         = process.argv.includes('--once');

// Stages run in order; each is isolated so one failure does not abort the rest.
//
// Each entry holds the agent MODULE, not a closure that calls it. The difference
// is when a mistake surfaces. `run: () => liveResolver.run()` with no matching
// require is valid syntax and loads clean — it throws ReferenceError only when
// the stage is actually invoked, which is once an hour on a runner nobody is
// watching. That shipped on 2026-07-31 and the live-resolver stage failed every
// run for four days while the pipeline reported success. `agent: liveResolver`
// is evaluated when this array is constructed, so the same mistake now throws at
// require time — caught by `node worker/scripts/smoke.js` in CI, and by running
// the worker locally at all.
const STAGES = [
    // Retention runs first so the volume has headroom before the scrape inserts.
    // Running it last would mean every run peaks at the pre-cleanup size, which is
    // what filled the 500MB free-tier disk on 2026-07-20 and took the site down.
    { name: 'retainer', agent: retainer },

    { name: 'scrape',  agent: { run: scrape } },
    { name: 'curator', agent: curator, args: { limit: 500 } },

    // Clusterer refines importance_score for the recent window using multi-source
    // corroboration — must run after curator (which sets the baseline + quality).
    { name: 'clusterer', agent: clusterer },

    // Categorization is keyword matching — free and fast. The old limit of 300/run
    // could not keep up with ~20k articles ingested per run, which left the site's
    // category filters matching almost nothing.
    { name: 'categorizer', agent: categorizer, args: { limit: 5000 } },

    { name: 'translator', agent: translator, args: { limit: 150 } },
    { name: 'summarizer', agent: summarizer, args: { limit: 20 } },

    // Independent of the article pipeline — it touches live_channels, not
    // articles. Runs last because nothing downstream needs it and it talks to a
    // third party: if YouTube is having a bad day, the news has already landed.
    { name: 'live-resolver', agent: liveResolver },
];

// Per-stage detail is capped before it goes into the worker_runs jsonb column.
// Stage results are small objects today, but an agent that starts returning an
// array of every row it touched would write megabytes per run into the same
// volume this pipeline exists to keep under 500MB.
const MAX_STAGE_DETAIL_CHARS = 500;

function summarizeResult(result) {
    if (result === undefined) return null;
    const json = JSON.stringify(result);
    return json.length > MAX_STAGE_DETAIL_CHARS ? json.slice(0, MAX_STAGE_DETAIL_CHARS) + '…' : result;
}

// Returns { total, failed } so the caller can decide the exit code.
async function pipeline() {
    const t0 = Date.now();
    console.log(`\n[orch] ===== Run starting @ ${new Date().toISOString()} =====`);

    // Read the gauge BEFORE the retainer runs, so the recorded series is the
    // high-water mark of each cycle rather than the post-cleanup trough. A trough
    // series would have looked healthy right up to the day the disk filled.
    const dbBytes = await dbSizeBytes();
    if (dbBytes !== null) {
        const pct = ((dbBytes / DISK_LIMIT_BYTES) * 100).toFixed(1);
        console.log(`[orch] db size ${formatBytes(dbBytes)} / ${formatBytes(DISK_LIMIT_BYTES)} (${pct}%)`);
    }

    const handle = await runRecord.start({ dbBytes });

    const stages = {};
    let failed = 0;
    for (const stage of STAGES) {
        try {
            const result = await stage.agent.run(stage.args);
            stages[stage.name] = { ok: true, result: summarizeResult(result) };
            if (result !== undefined) console.log(`[orch] ${stage.name}: ${JSON.stringify(result)}`);
        } catch (e) {
            failed++;
            stages[stage.name] = { ok: false, error: e.message };
            console.error(`[orch] ${stage.name} failed:`, e.message);
        }
    }

    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[orch] ===== Run finished in ${dur}s — ${STAGES.length - failed}/${STAGES.length} stages ok =====\n`);

    await runRecord.finish(handle, { stages, failed });

    return { total: STAGES.length, failed };
}

async function main() {
    const { total, failed } = await pipeline();

    if (ONCE) {
        // A run where every stage failed did no work at all — in practice an upstream
        // outage (database unreachable). Exit non-zero so CI reports it instead of
        // showing a green run that ingested nothing.
        //
        // PARTIAL failure deliberately still exits 0. It is not "fine" — it is caught
        // by worker/scripts/watchdog.js, which reads worker_runs.stages_failed and
        // raises an issue. Failing CI on it too would double-alert on every transient
        // Groq rate-limit, and an alert channel that cries wolf gets muted.
        if (failed === total) {
            console.error(`[orch] all ${total} stages failed — exiting 1`);
            process.exit(1);
        }
        process.exit(0);
    }

    console.log(`[orch] Looping every ${INTERVAL_MIN} min. Ctrl+C to stop.`);
    setInterval(pipeline, INTERVAL_MIN * 60_000);
}

// Only self-start when invoked directly. Required so `pipeline` and `STAGES` can
// be imported (by tests, or by any caller that needs the canonical stage list)
// without kicking off a scrape as a side effect of the require.
if (require.main === module) {
    main().catch(e => { console.error('[orch] fatal:', e); process.exit(1); });
}

module.exports = { STAGES, pipeline };
