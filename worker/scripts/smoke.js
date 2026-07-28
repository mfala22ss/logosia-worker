// Smoke test — the CI gate on automated PRs.
//
// This repo has no type checker, so there is no build step to fail. That leaves a
// gap an agent-authored PR walks straight into: a typo in a require path or an
// export name is invisible to `node --check` and only surfaces when the hourly
// cron runs it. This loads every module and asserts the invariants that must hold
// regardless of what changed.
//
// Runs with placeholder credentials by design. A check that needs production
// secrets cannot gate a pull request.

const assert = require('node:assert');

const MODULES = [
    '../index',
    '../scraper',
    '../agents/retainer',
    '../agents/curator',
    '../agents/clusterer',
    '../agents/categorizer',
    '../agents/translator',
    '../agents/summarizer',
    '../lib/db',
    '../lib/run-record',
    '../lib/source-health',
    '../lib/alert',
    '../lib/normalize',
    '../lib/dedup',
    '../lib/geo-tagger',
    '../lib/ephemeral-live',
];

function loadAll() {
    const loaded = {};
    for (const path of MODULES) {
        loaded[path] = require(path);
        console.log(`  ✓ ${path}`);
    }
    return loaded;
}

// The retainer must be the first stage. Running it later means every cycle peaks
// at the pre-cleanup size instead of making headroom before the scrape inserts —
// which is the precise mechanism that filled the 500MB volume on 2026-07-20 and
// took the site down for eight days. A comment in index.js says so; this makes it
// a failing build instead of a hope.
function assertStageOrder() {
    const { STAGES } = require('../index');

    assert.ok(Array.isArray(STAGES) && STAGES.length, 'worker/index.js must export a non-empty STAGES array');
    assert.strictEqual(
        STAGES[0].name,
        'retainer',
        `retainer must be the FIRST pipeline stage (found "${STAGES[0].name}"). ` +
        'Running retention after the scrape recreates the 2026-07-20 disk-full outage.',
    );

    // The clusterer refines importance_score using the baseline and quality the
    // curator sets, so inverting them silently degrades ranking with no error.
    const order = STAGES.map(s => s.name);
    assert.ok(
        order.indexOf('curator') < order.indexOf('clusterer'),
        'curator must run before clusterer — the clusterer refines the scores the curator sets.',
    );

    console.log(`  ✓ stage order: ${order.join(' → ')}`);
}

function main() {
    const assertOrderOnly = process.argv.includes('--assert-stage-order');

    if (assertOrderOnly) {
        console.log('[smoke] asserting stage order…');
        assertStageOrder();
        console.log('[smoke] ✓ stage order OK');
        return;
    }

    console.log('[smoke] loading modules…');
    loadAll();
    console.log('[smoke] ✓ all modules loaded');
}

try {
    main();
} catch (e) {
    console.error('[smoke] ✗', e.message);
    process.exit(1);
}
