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

async function pipeline() {
    const t0 = Date.now();
    console.log(`\n[orch] ===== Run starting @ ${new Date().toISOString()} =====`);

    try {
        const scraped = await scrape();
        console.log(`[orch] scrape: ${JSON.stringify(scraped)}`);
    } catch (e) { console.error('[orch] scrape failed:', e.message); }

    try { await curator.run({ limit: 500 }); }
    catch (e) { console.error('[orch] curator failed:', e.message); }

    // Clusterer refines importance_score for the recent window using multi-source
    // corroboration — must run after curator (which sets the baseline + quality).
    try { await clusterer.run(); }
    catch (e) { console.error('[orch] clusterer failed:', e.message); }

    // Categorization is keyword matching — free and fast. The old limit of 300/run
    // could not keep up with ~20k articles ingested per run, which left the site's
    // category filters matching almost nothing.
    try { await categorizer.run({ limit: 5000 }); }
    catch (e) { console.error('[orch] categorizer failed:', e.message); }

    try { await translator.run({ limit: 150 }); }
    catch (e) { console.error('[orch] translator failed:', e.message); }

    try { await summarizer.run({ limit: 20 }); }
    catch (e) { console.error('[orch] summarizer failed:', e.message); }

    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[orch] ===== Run finished in ${dur}s =====\n`);
}

async function main() {
    await pipeline();
    if (ONCE) { process.exit(0); }

    console.log(`[orch] Looping every ${INTERVAL_MIN} min. Ctrl+C to stop.`);
    setInterval(pipeline, INTERVAL_MIN * 60_000);
}

main().catch(e => { console.error('[orch] fatal:', e); process.exit(1); });
