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

// How many feeds may be retired in a single run. This is a RATE LIMIT on a
// destructive action, not a safety check — see MASS_FAILURE_RATIO for that.
const MAX_DISABLES_PER_RUN = parseInt(process.env.MAX_DISABLES_PER_RUN || '10', 10);

// The actual infrastructure-vs-feeds discriminator: what fraction of THIS run's
// fetches failed.
//
// The first version used the absolute eligible count as the safety check — if
// more than MAX_DISABLES_PER_RUN feeds crossed the threshold, disable nothing.
// That deadlocked: 87 feeds were genuinely dead, 87 > 10 on every run, so the
// guard suppressed every disable forever and 0 feeds were ever retired. A backlog
// larger than the cap could never drain, and the cap could never be reached from
// above. The guard was permanently on.
//
// Rate is the right signal because it answers the question the guard is actually
// asking. If 400 of 508 feeds fetched fine and 87 failed, the network is
// demonstrably working and those 87 are dead on their own merits. If 500 of 508
// failed, it is the network, no matter how many crossed the counter.
const MASS_FAILURE_RATIO = parseFloat(process.env.MASS_FAILURE_RATIO || '0.5');

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

    // Guard 3: judge the RUN, not the backlog. A run where most fetches succeeded
    // is strong evidence the network is fine and the failures are the feeds' own.
    //
    // Not conclusive, and worth naming the gap: a partial outage — one flaky DNS
    // resolver, a regional route, a single CDN having a bad hour — could take out
    // a minority of feeds while the majority sail through, and this rule would
    // read that as feed death and retire them. That is the residual risk the
    // per-run cap exists to bound: the worst case is MAX_DISABLES_PER_RUN wrong
    // retirements, all logged with their reason, all reversible by flipping
    // `enabled` back. Re-running the seeder restores anything in feeds.json.
    const failureRatio = outcomes.length ? failed.length / outcomes.length : 0;

    if (failureRatio > MASS_FAILURE_RATIO) {
        console.error(
            `[source-health] ⚠ ${failed.length}/${outcomes.length} fetches failed this run ` +
            `(${(failureRatio * 100).toFixed(0)}%, threshold ${(MASS_FAILURE_RATIO * 100).toFixed(0)}%). ` +
            `That is an infrastructure fault, not ${eligible.length} independent feed deaths — ` +
            `disabling NOTHING. Counters are preserved and will drain once a run succeeds normally.`
        );
        return {
            ok: succeeded.length,
            failed: failed.length,
            disabled: 0,
            suppressed: eligible.length,
            protected_failing: failed.filter(o => isProtected(o.source)).length,
        };
    }

    // Drain worst-first so the most-certainly-dead go first, capped per run. A
    // large backlog now shrinks by MAX_DISABLES_PER_RUN each run instead of
    // being suppressed wholesale, and the per-run cap still bounds the damage of
    // a wrong call to something a single revert can undo.
    eligible.sort((a, b) => b.failures - a.failures);
    const toDisable = eligible.slice(0, MAX_DISABLES_PER_RUN);
    const deferred  = eligible.length - toDisable.length;

    if (deferred > 0) {
        console.warn(
            `[source-health] ${eligible.length} feeds eligible; retiring the ${toDisable.length} worst ` +
            `this run, ${deferred} deferred to later runs.`
        );
    }

    for (const { source, failures, reason } of toDisable) {
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
