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
    '../agents/live-resolver',
    '../lib/db',
    '../lib/run-record',
    '../lib/source-health',
    '../lib/alert',
    '../lib/youtube-live',
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

// Every stage must carry a callable agent.
//
// The orchestrator swallows a per-stage throw by design — one bad stage must not
// abort the other seven. That safety property is also a blindfold: a stage wired
// to nothing fails identically to a stage whose API call timed out, and the run
// still exits 0. live-resolver was wired to an undeclared identifier on
// 2026-07-31 and failed silently for four days; the site's Live page served zero
// channels the whole time because the columns that stage writes stayed null.
//
// Holding the module in STAGES rather than a closure means a missing require now
// throws when `../index` is required — loadAll() above already covers that case.
// This check covers the rest of the shape: a stage present but wired to a module
// that exports no run(), which loads clean and would fail the same silent way.
function assertStageAgents() {
    const { STAGES } = require('../index');

    for (const stage of STAGES) {
        assert.ok(
            stage.agent && typeof stage.agent.run === 'function',
            `stage "${stage.name}" has no callable agent.run() — it would throw at ` +
            'invocation time on the hourly runner, where a per-stage throw is caught ' +
            'and the run still reports success.',
        );
    }

    console.log(`  ✓ ${STAGES.length} stages have a callable agent.run()`);
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

    console.log('[smoke] asserting stage wiring…');
    assertStageAgents();
    console.log('[smoke] ✓ stage wiring OK');
}

try {
    main();
} catch (e) {
    console.error('[smoke] ✗', e.message);
    process.exit(1);
}
