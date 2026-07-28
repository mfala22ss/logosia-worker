// Orchestrator — runs the pipeline: scrape → curate → translate → categorize → summarize.
//
// Usage:
//   node worker/index.js --once         # one pass, exit
//   node worker/index.js                # loop every SCRAPE_INTERVAL_MIN minutes (default 30)

require('dotenv').config({ path: '.env.local' });

const { scrape }       = require('./scraper');
const curator          = require('./agents/curator');
const clusterer        = require('./agents/clusterer');
const translator       = require('./agents/translator');
const categorizer      = require('./agents/categorizer');
const summarizer       = require('./agents/summarizer');

const INTERVAL_MIN = parseInt(process.env.SCRAPE_INTERVAL_MIN || '30', 10);
const ONCE         = process.argv.includes('--once');

// Stages run in order; each is isolated so one failure does not abort the rest.
const STAGES = [
    { name: 'scrape',  run: () => scrape() },
    { name: 'curator', run: () => curator.run({ limit: 500 }) },

    // Clusterer refines importance_score for the recent window using multi-source
    // corroboration — must run after curator (which sets the baseline + quality).
    { name: 'clusterer', run: () => clusterer.run() },

    // Categorization is keyword matching — free and fast. The old limit of 300/run
    // could not keep up with ~20k articles ingested per run, which left the site's
    // category filters matching almost nothing.
    { name: 'categorizer', run: () => categorizer.run({ limit: 5000 }) },

    { name: 'translator', run: () => translator.run({ limit: 150 }) },
    { name: 'summarizer', run: () => summarizer.run({ limit: 20 }) },
];

// Returns { total, failed } so the caller can decide the exit code.
async function pipeline() {
    const t0 = Date.now();
    console.log(`\n[orch] ===== Run starting @ ${new Date().toISOString()} =====`);

    let failed = 0;
    for (const stage of STAGES) {
        try {
            const result = await stage.run();
            if (result !== undefined) console.log(`[orch] ${stage.name}: ${JSON.stringify(result)}`);
        } catch (e) {
            failed++;
            console.error(`[orch] ${stage.name} failed:`, e.message);
        }
    }

    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[orch] ===== Run finished in ${dur}s — ${STAGES.length - failed}/${STAGES.length} stages ok =====\n`);
    return { total: STAGES.length, failed };
}

async function main() {
    const { total, failed } = await pipeline();

    if (ONCE) {
        // A run where every stage failed did no work at all — in practice an upstream
        // outage (database unreachable). Exit non-zero so CI reports it instead of
        // showing a green run that ingested nothing.
        if (failed === total) {
            console.error(`[orch] all ${total} stages failed — exiting 1`);
            process.exit(1);
        }
        process.exit(0);
    }

    console.log(`[orch] Looping every ${INTERVAL_MIN} min. Ctrl+C to stop.`);
    setInterval(pipeline, INTERVAL_MIN * 60_000);
}

main().catch(e => { console.error('[orch] fatal:', e); process.exit(1); });
