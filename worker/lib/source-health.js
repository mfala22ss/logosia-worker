// Source health — tracks per-feed fetch failures and retires dead feeds.
//
// Before this, a permanently-dead feed threw on every run forever: it consumed a
// concurrency slot, added 12s of timeout to the batch, and left `last_status` set
// to an error nobody read. Feeds do die permanently — Reuters and AP both
// discontinued their public RSS entirely (see db/bootstrap.sql).
//
// ── The failure mode this must not cause ───────────────────────────────────
// Auto-disable is a destructive action driven by a signal that is unreliable in
// exactly the situation where it fires hardest. A Supabase outage, a GitHub
// Actions network blip, or a DNS wobble makes EVERY feed fail at once. A naive
// counter would then disable the entire source list in one run and the site would
// have nothing to serve — converting a ten-minute transient into a manual repair.
//
// Three independent guards:
//   1. Consecutive only. Any success resets the counter to zero. A feed must fail
//      FAILURE_THRESHOLD runs in a row — hours of sustained failure, not one bad
//      minute — before it is eligible.
//   2. Protected classes are never disabled. Premium and tier-1 sources are the
//      editorial backbone; if one of those breaks, a human must decide, because
//      silently dropping Reuters changes what the site IS.
//   3. Blast-radius cap. If more than MAX_DISABLES_PER_RUN feeds are eligible in
//      a single run, that is an infrastructure fault, not N independent feed
//      deaths. Disable nothing and say so loudly.

const { db } = require('./db');

// At 12 runs/day, 8 consecutive failures is ~16 hours of a feed being continuously
// broken. Publishers do have multi-hour outages; almost none have 16-hour ones.
const FAILURE_THRESHOLD = parseInt(process.env.SOURCE_FAILURE_THRESHOLD || '8', 10);

// Above this, blame the network, not the feeds. Sized to be larger than plausible
// simultaneous independent failures but far smaller than the source list.
const MAX_DISABLES_PER_RUN = parseInt(process.env.MAX_DISABLES_PER_RUN || '10', 10);

// Same 500-id ceiling as the retainer: supabase-js serialises `.in()` into the
// request URI and ~1000 bigints overruns the gateway's 8KB limit with an opaque 414.
const BATCH_SIZE = 500;

// A source is protected if it is premium or tier 1 (wire services and government
// sources). These are the feeds whose absence is a product change.
function isProtected(source) {
    return source.is_premium === true || source.tier === 1;
}

async function updateInBatches(ids, patch) {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const chunk = ids.slice(i, i + BATCH_SIZE);
        const { error } = await db.from('sources').update(patch).in('id', chunk);
        if (error) throw new Error('[source-health] update failed: ' + error.message);
    }
}

// Applies one run's fetch outcomes.
//
// `outcomes` is [{ source, ok, status, error }]. Returns a summary that lands in
// worker_runs.stages so the watchdog can alert on churn.
async function applyOutcomes(outcomes) {
    const now = new Date().toISOString();

    const succeeded = outcomes.filter(o => o.ok);
    const failed    = outcomes.filter(o => !o.ok);

    // Success resets the counter. Done as a bulk update rather than per-source so a
    // healthy run costs a handful of round trips instead of one per feed.
    if (succeeded.length) {
        await updateInBatches(succeeded.map(o => o.source.id), {
            last_fetched_at:      now,
            last_status:          'ok',
            last_error:           null,
            consecutive_failures: 0,
        });
    }

    // Failures increment. supabase-js cannot express `set x = x + 1`, so the new
    // value is computed from the row read at the start of this run. That read is
    // this process's own snapshot and the workflow's `concurrency` group prevents
    // two runs overlapping, so there is no lost-update race to guard against.
    const eligible = [];
    for (const outcome of failed) {
        const next = (outcome.source.consecutive_failures || 0) + 1;

        const { error } = await db.from('sources').update({
            last_fetched_at:      now,
            last_status:          outcome.status,
            last_error:           (outcome.error || '').slice(0, 240),
            consecutive_failures: next,
        }).eq('id', outcome.source.id);

        if (error) {
            console.warn(`[source-health] could not record failure for ${outcome.source.name}: ${error.message}`);
            continue;
        }

        if (next >= FAILURE_THRESHOLD && !isProtected(outcome.source)) {
            eligible.push({ source: outcome.source, failures: next, reason: outcome.error });
        } else if (next >= FAILURE_THRESHOLD) {
            // Protected feeds still get flagged. The point is not to disable them —
            // it is that a dead wire service is the single most important thing a
            // human could be told about, and it must not pass silently.
            console.error(
                `[source-health] ⚠ PROTECTED source "${outcome.source.name}" has failed ` +
                `${next} consecutive runs and will NOT be auto-disabled — needs a human.`
            );
        }
    }

    // Guard 3: mass failure means infrastructure, not feeds.
    if (eligible.length > MAX_DISABLES_PER_RUN) {
        console.error(
            `[source-health] ⚠ ${eligible.length} sources crossed the failure threshold in one run ` +
            `(cap ${MAX_DISABLES_PER_RUN}). That is an infrastructure fault, not ${eligible.length} ` +
            `independent feed deaths — disabling NOTHING. Counters are preserved, so if this is real ` +
            `it will disable them once the count falls under the cap.`
        );
        return {
            ok: succeeded.length,
            failed: failed.length,
            disabled: 0,
            suppressed: eligible.length,
            protected_failing: failed.filter(o => isProtected(o.source)).length,
        };
    }

    for (const { source, failures, reason } of eligible) {
        const { error } = await db.from('sources').update({
            enabled:         false,
            disabled_at:     now,
            disabled_reason: `auto: ${failures} consecutive failures — ${(reason || 'unknown').slice(0, 160)}`,
        }).eq('id', source.id);

        if (error) {
            console.warn(`[source-health] could not disable ${source.name}: ${error.message}`);
            continue;
        }
        console.warn(`[source-health] ✗ disabled "${source.name}" after ${failures} consecutive failures`);
    }

    return {
        ok: succeeded.length,
        failed: failed.length,
        disabled: eligible.length,
        suppressed: 0,
        protected_failing: failed.filter(o => isProtected(o.source)).length,
    };
}

module.exports = { applyOutcomes, isProtected, FAILURE_THRESHOLD, MAX_DISABLES_PER_RUN };
