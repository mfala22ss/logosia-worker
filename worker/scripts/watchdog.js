// Watchdog — the thing that was missing on 2026-07-20.
//
// That day Postgres wedged in a crash-recovery loop, Supabase's own control plane
// kept reporting the project ACTIVE_HEALTHY while its health API said UNHEALTHY,
// and the site served no news for eight days before a human happened to notice.
// Every ingredient of the failure was observable from outside. Nothing was
// observing.
//
// Runs on its own schedule, independent of the pipeline. Reads state, decides
// whether the system is healthy, and escalates in two directions:
//
//   alert   → a human, via ntfy/Telegram/Discord (worker/lib/alert.js)
//   issue   → a GitHub issue mentioning @claude, which triggers .github/workflows/
//             claude.yml to investigate and open a PR
//
// ── Why not everything gets an @claude issue ──────────────────────────────
// Escalation is split by whether an agent can actually act. A failing stage or a
// broken scraper is code: Claude can read the log, reproduce, and open a PR. A
// full disk or an unreachable database is NOT code — on 2026-07-20 no SQL could
// run at all, so an agent would have been just as locked out as a human. Summoning
// Claude for those burns tokens producing a PR that cannot possibly help, and
// worse, produces a plausible-looking PR that makes it LOOK handled. Infra
// failures alert a human and stop there.
//
// Usage: node worker/scripts/watchdog.js

require('dotenv').config({ path: '.env.local' });

const { db, dbSizeBytes, formatBytes, DISK_LIMIT_BYTES } = require('../lib/db');
const { alert } = require('../lib/alert');

// ── Thresholds ─────────────────────────────────────────────────────────────
// Measured, not assumed. The first version of this used 90 minutes on the theory
// that an hourly cron produces a success every hour. It does not:
//
//   observed starts: 00:03 · 22:07 · 20:15 · 18:17 · 16:27 · 14:05  (~2h apart)
//
// GitHub does not guarantee scheduled workflows fire on time — they are queued
// best-effort and are routinely delayed under load — and a full run then takes a
// further 8-14 minutes. So a perfectly healthy pipeline sits >90 minutes past its
// last success for a large part of every cycle, and the watchdog paged on it
// every 15 minutes for three days.
//
// 240 minutes clears the observed ~2h cadence plus the 3h21m excursion seen on
// 2026-07-31, with room for one skipped cron on top.
//
// This is calibration against measured behaviour, not muting an inconvenient
// alarm — a distinction worth holding onto, because they look identical from the
// diff. The test: does the threshold still catch the failure it was built for?
// The 2026-07-20 outage ran EIGHT DAYS. Catching it in 4 hours instead of 90
// minutes loses nothing that mattered. If these numbers ever need raising again,
// that is evidence the cron delivery has degraded further and is itself the
// finding — do not raise them silently.
const MAX_MINUTES_SINCE_SUCCESS = parseInt(process.env.WATCHDOG_MAX_MINUTES || '240', 10);

// Separate and much wider: this asks "is the SCHEDULER alive at all?", not "did
// the run succeed?". GitHub disables scheduled workflows in public repos after a
// stretch of repository inactivity, which kills the cron with no failure, no
// email, and no red run — the pipeline simply stops existing. A recency check on
// successful runs cannot distinguish that from a normal outage; only the absence
// of ANY run row can.
const MAX_MINUTES_SINCE_ANY_RUN = parseInt(process.env.WATCHDOG_MAX_SILENCE || '360', 10);

// A pipeline that runs, goes green, and ingests nothing is the failure mode that
// preceded the outage. Green runs are not the health signal — new rows are.
//
// The window must exceed the real gap between runs or it reports zero simply
// because the last run fell outside it. At a 3h window this fired at 03:24 on
// 2026-07-31 with the pipeline perfectly healthy: the previous run was at 00:02,
// 3h21m earlier, so of course nothing had been ingested in the last 3 hours.
// 6h covers the observed cadence with margin.
const MIN_ARTICLES_PER_WINDOW = parseInt(process.env.WATCHDOG_MIN_ARTICLES || '1', 10);
const ARTICLE_WINDOW_HOURS    = parseInt(process.env.WATCHDOG_ARTICLE_HOURS || '6', 10);

// Well under the hard retention threshold, so the alert arrives while there is
// still room to act. At 100% there is no reactive fix — see retainer.js.
const DISK_ALERT_PCT = parseInt(process.env.WATCHDOG_DISK_PCT || '80', 10);

// During the outage every page burned ~2.9s against a dying database before
// 503-ing. Anything approaching that is already a broken experience.
const SITE_URL            = process.env.SITE_URL || 'https://logosia.com.au';
const SITE_TIMEOUT_MS     = parseInt(process.env.WATCHDOG_SITE_TIMEOUT_MS || '8000', 10);
const SITE_SLOW_MS        = parseInt(process.env.WATCHDOG_SITE_SLOW_MS || '5000', 10);

const MS_PER_MINUTE = 60 * 1000;

// ── Check helpers ──────────────────────────────────────────────────────────
// A check returns { name, ok, severity, actionable, detail }.
//   severity   'critical' (site is broken) | 'warning' (degrading)
//   actionable true when an agent could plausibly fix it with a code change
function check(name, ok, { severity = 'warning', actionable = false, detail = '' } = {}) {
    return { name, ok, severity, actionable, detail };
}

function minutesSince(iso) {
    return (Date.now() - new Date(iso).getTime()) / MS_PER_MINUTE;
}

// Reachability first. Everything downstream reads this database, so a failure
// here makes every other DB check meaningless rather than independently false —
// reporting six red checks for one root cause is how alert fatigue starts.
async function checkDatabase() {
    try {
        const { error } = await db.from('worker_runs').select('id').limit(1);
        if (error) throw new Error(error.message);
        return check('database', true, { severity: 'critical' });
    } catch (e) {
        return check('database', false, {
            severity: 'critical',
            // Not actionable: on 2026-07-20 the database refused every connection
            // with FATAL 57P03. No code change reaches a database that will not
            // accept a connection.
            actionable: false,
            detail: `Supabase unreachable: ${e.message}. Check the project dashboard — ` +
                    `note the control plane reported ACTIVE_HEALTHY during the 2026-07-20 outage ` +
                    `while the database was dead, so trust the health API, not the status badge.`,
        });
    }
}

async function checkLastSuccess() {
    const { data, error } = await db
        .from('worker_runs')
        .select('started_at, finished_at, run_url')
        .eq('ok', true)
        .order('started_at', { ascending: false })
        .limit(1);

    if (error) return check('last_success', false, { detail: `query failed: ${error.message}` });

    if (!data.length) {
        return check('last_success', false, {
            severity: 'critical',
            actionable: true,
            detail: 'No successful run has EVER been recorded. Either the pipeline has never ' +
                    'fully succeeded since worker_runs was added, or run recording is broken.',
        });
    }

    const mins = minutesSince(data[0].started_at);
    return check('last_success', mins <= MAX_MINUTES_SINCE_SUCCESS, {
        severity: 'critical',
        actionable: true,
        detail: `Last fully-successful run was ${mins.toFixed(0)} min ago ` +
                `(threshold ${MAX_MINUTES_SINCE_SUCCESS}). ${data[0].run_url || ''}`,
    });
}

// Scheduler liveness — see MAX_MINUTES_SINCE_ANY_RUN.
async function checkScheduler() {
    const { data, error } = await db
        .from('worker_runs')
        .select('started_at, job')
        .order('started_at', { ascending: false })
        .limit(1);

    if (error) return check('scheduler', false, { detail: `query failed: ${error.message}` });
    if (!data.length) return check('scheduler', false, { severity: 'critical', detail: 'worker_runs is empty.' });

    const mins = minutesSince(data[0].started_at);
    return check('scheduler', mins <= MAX_MINUTES_SINCE_ANY_RUN, {
        severity: 'critical',
        // Not a code fault. If GitHub disabled the schedule, the fix is clicking
        // "Enable workflow" in the Actions tab — no PR can do that.
        actionable: false,
        detail: `No pipeline run of ANY kind has started for ${mins.toFixed(0)} min ` +
                `(threshold ${MAX_MINUTES_SINCE_ANY_RUN}). The scheduler itself may be dead — ` +
                `check whether GitHub auto-disabled the scheduled workflows for repository inactivity ` +
                `(Actions tab → the workflow → "Enable workflow" if it is greyed out).`,
    });
}

async function checkIngest() {
    const since = new Date(Date.now() - ARTICLE_WINDOW_HOURS * 60 * MS_PER_MINUTE).toISOString();
    const { count, error } = await db
        .from('articles')
        .select('id', { count: 'exact', head: true })
        .gte('ingested_at', since);

    if (error) return check('ingest', false, { detail: `query failed: ${error.message}` });

    return check('ingest', (count || 0) >= MIN_ARTICLES_PER_WINDOW, {
        severity: 'critical',
        actionable: true,
        detail: `${count || 0} articles ingested in the last ${ARTICLE_WINDOW_HOURS}h ` +
                `(minimum ${MIN_ARTICLES_PER_WINDOW}). Green runs that ingest nothing are the ` +
                `failure mode that preceded the 2026-07-20 outage.`,
    });
}

async function checkDisk() {
    const used = await dbSizeBytes();
    if (used === null) {
        return check('disk', false, {
            actionable: true,
            detail: 'Could not read db_size_bytes(). The RPC may be missing — apply ' +
                    'db/migrations/20260728_self_maintenance.sql. Until it returns, the retainer ' +
                    'is running blind on fixed windows and cannot see the disk filling.',
        });
    }

    const pct = (used / DISK_LIMIT_BYTES) * 100;
    return check('disk', pct < DISK_ALERT_PCT, {
        severity: 'critical',
        // The retainer already auto-tightens. If it is still climbing past 80%,
        // retention is not the lever any more — ingest volume or the plan is.
        actionable: false,
        detail: `Database at ${formatBytes(used)} / ${formatBytes(DISK_LIMIT_BYTES)} ` +
                `(${pct.toFixed(1)}%, alert at ${DISK_ALERT_PCT}%). The retainer tightens ` +
                `automatically above ${process.env.DISK_SOFT_PCT || 70}%; if usage is still ` +
                `climbing, reduce feeds or upgrade the plan. Postgres cannot recover from a ` +
                `full volume — it wedges in a recovery loop where no SQL runs at all.`,
    });
}

// Runs from GitHub's network against the public site, so it stays valid even when
// Supabase is unreachable — it measures what a reader actually experiences.
async function checkSite() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SITE_TIMEOUT_MS);
    const t0 = Date.now();
    try {
        const res = await fetch(SITE_URL, { signal: controller.signal, redirect: 'follow' });
        const ms = Date.now() - t0;

        if (!res.ok) {
            return check('site', false, {
                severity: 'critical',
                actionable: true,
                detail: `${SITE_URL} returned HTTP ${res.status} in ${ms}ms.`,
            });
        }
        return check('site', ms < SITE_SLOW_MS, {
            severity: 'warning',
            actionable: true,
            detail: `${SITE_URL} responded ${res.status} in ${ms}ms (slow above ${SITE_SLOW_MS}ms).`,
        });
    } catch (e) {
        return check('site', false, {
            severity: 'critical',
            actionable: true,
            detail: `${SITE_URL} did not respond within ${SITE_TIMEOUT_MS}ms: ${e.message}`,
        });
    } finally {
        clearTimeout(timer);
    }
}

// Premium and tier-1 feeds are never auto-disabled (see lib/source-health.js), so
// nothing else in the system will ever surface them dying. Silently losing Reuters
// changes what the site IS, and it would otherwise pass unnoticed forever.
async function checkProtectedSources() {
    const { data, error } = await db
        .from('sources')
        .select('name, consecutive_failures, last_error')
        .eq('enabled', true)
        .or('is_premium.eq.true,tier.eq.1')
        .gte('consecutive_failures', 8)
        .order('consecutive_failures', { ascending: false })
        .limit(20);

    if (error) return check('protected_sources', false, { detail: `query failed: ${error.message}` });

    if (!data.length) return check('protected_sources', true);

    const list = data.map(s => `  - ${s.name} (${s.consecutive_failures} runs): ${s.last_error || 'no error recorded'}`).join('\n');
    return check('protected_sources', false, {
        severity: 'warning',
        // Feed URLs move. That is a data fix in worker/data/feeds.json — the one
        // change class narrow enough to auto-merge.
        actionable: true,
        detail: `${data.length} protected source(s) failing persistently and NOT auto-disabled:\n${list}`,
    });
}

// Catches stages that fail every run without ever failing the whole pipeline —
// how the categorizer left 98.9% of articles uncategorized while CI stayed green.
async function checkStageFailures() {
    const { data, error } = await db
        .from('worker_runs')
        .select('stages, started_at, run_url')
        .order('started_at', { ascending: false })
        .limit(5);

    if (error) return check('stages', false, { detail: `query failed: ${error.message}` });
    if (data.length < 3) return check('stages', true, { detail: 'not enough history yet' });

    const failureCounts = {};
    const lastError = {};
    for (const row of data) {
        for (const [stage, outcome] of Object.entries(row.stages || {})) {
            if (outcome && outcome.ok === false) {
                failureCounts[stage] = (failureCounts[stage] || 0) + 1;
                lastError[stage] = lastError[stage] || outcome.error;
            }
        }
    }

    const persistent = Object.entries(failureCounts).filter(([, n]) => n >= 3);
    if (!persistent.length) return check('stages', true);

    const list = persistent
        .map(([stage, n]) => `  - ${stage}: failed ${n}/${data.length} recent runs — ${lastError[stage]}`)
        .join('\n');

    return check('stages', false, {
        severity: 'warning',
        actionable: true,
        detail: `Stage(s) failing persistently while the pipeline still reports success:\n${list}\n` +
                `Most recent run: ${data[0].run_url || 'local'}`,
    });
}

// ── GitHub escalation ──────────────────────────────────────────────────────
const GITHUB_API   = 'https://api.github.com';
const REPO         = process.env.GITHUB_REPOSITORY;
const TOKEN        = process.env.GITHUB_TOKEN;
const ISSUE_LABEL  = 'watchdog';

async function github(path, init = {}) {
    const res = await fetch(`${GITHUB_API}${path}`, {
        ...init,
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${TOKEN}`,
            'x-github-api-version': '2022-11-28',
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            ...init.headers,
        },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
}

// A stable signature over WHICH checks are failing, not their detail text. Detail
// contains timings and counts that change every run; keying on it would open a
// fresh issue every 15 minutes and, because each issue triggers claude.yml, would
// spawn a PR storm and a token bill during precisely the hour you are least able
// to notice it. Grouping by failing-check-set means one incident, one issue.
function signatureFor(failures) {
    return failures.map(f => f.name).sort().join('+');
}

async function findOpenIssue(signature) {
    const issues = await github(`/repos/${REPO}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`);
    const marker = `<!-- watchdog-signature: ${signature} -->`;
    return issues.find(issue => (issue.body || '').includes(marker)) || null;
}

async function ensureLabel() {
    try {
        await github(`/repos/${REPO}/labels`, {
            method: 'POST',
            body: JSON.stringify({ name: ISSUE_LABEL, color: 'b60205', description: 'Opened automatically by the watchdog' }),
        });
    } catch {
        // Already exists (422) is the normal path — labels are created once.
    }
}

function issueBody(signature, failures, allChecks, actionable) {
    const table = allChecks
        .map(c => `| ${c.ok ? '✅' : '❌'} | \`${c.name}\` | ${c.severity} | ${(c.detail || 'ok').replace(/\n/g, '<br>')} |`)
        .join('\n');

    // The @claude mention is what triggers claude.yml, so it is added only when
    // something here is fixable in code. A full disk or a dead scheduler still
    // gets an issue — a human needs to know, and the open issue is what stops
    // this condition re-alerting every 15 minutes — but no agent is summoned to
    // write a PR it cannot possibly make work.
    const header = actionable
        ? '@claude The Logosia watchdog detected a persistent failure. Investigate and open a PR if there is a code-level fix.'
        : '**No agent has been summoned.** This condition is infrastructure, not code — a pull request cannot fix it. It needs a human.';

    return `<!-- watchdog-signature: ${signature} -->
${header}

## Failing checks

${failures.map(f => `### \`${f.name}\` (${f.severity})\n${f.detail}`).join('\n\n')}

## Full check results

| | check | severity | detail |
|---|---|---|---|
${table}

## Scope and constraints

Read \`AGENTS.md\` first. Then, specifically:

- **Do not touch retention windows** (\`PRUNE_AFTER_DAYS\`, \`DELETE_AFTER_DAYS\`, the thresholds in
  \`worker/agents/retainer.js\`) or the \`retainer\` stage's position as first in \`STAGES\`. A missing
  retention policy is what destroyed the database on 2026-07-20. Widening a window to make a symptom
  go away recreates that outage.
- **Do not widen per-stage \`limit\` values** to clear a backlog. Those limits bound how much this run
  can write to a 500MB volume.
- **Do not change the source policy** (\`worker/data/feeds.json\` premium/tier-1 membership, or the
  per-country cap). Which outlets Logosia carries is an editorial decision, not a bug fix. Correcting a
  *broken feed URL* for a source already on the list is in scope; adding or removing outlets is not.
- **Do not commit secrets** or add new external dependencies.
- If the root cause is infrastructure (database unreachable, disk full, scheduler disabled) rather than
  code, say so in a comment and open **no PR**. A PR that cannot fix the problem is worse than none —
  it makes the incident look handled.

Close this issue when the underlying condition clears; the watchdog will open a new one if it recurs.`;
}

// Returns { issue, alreadyOpen }.
//
// Every distinct failure signature gets an issue, actionable or not. The issue is
// what makes a condition *acknowledged*, and acknowledgement is what stops it
// re-alerting. Before this, `protected_sources` — a true finding, 99 dead tier-1
// feeds — re-alerted and failed the run every 15 minutes for three days, because
// nobody can fix 99 feeds between two watchdog ticks. A monitor that keeps
// shouting about something you already know gets muted, and then it is not a
// monitor any more.
async function escalateToGitHub(failures, allChecks) {
    if (!REPO || !TOKEN) {
        console.log('[watchdog] no GITHUB_REPOSITORY/GITHUB_TOKEN — skipping issue escalation');
        return { issue: null, alreadyOpen: false };
    }

    const signature  = signatureFor(failures);
    const actionable = failures.some(f => f.actionable);

    const existing = await findOpenIssue(signature);
    if (existing) {
        console.log(`[watchdog] issue #${existing.number} already open for "${signature}" — acknowledged, staying quiet`);
        return { issue: existing, alreadyOpen: true };
    }

    await ensureLabel();

    const issue = await github(`/repos/${REPO}/issues`, {
        method: 'POST',
        body: JSON.stringify({
            title: `[watchdog] ${failures.map(f => f.name).join(', ')} failing`,
            body: issueBody(signature, failures, allChecks, actionable),
            labels: [ISSUE_LABEL],
        }),
    });

    console.log(`[watchdog] opened issue #${issue.number} — ${issue.html_url}`);
    return { issue, alreadyOpen: false };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
    console.log(`[watchdog] ===== ${new Date().toISOString()} =====`);

    const dbCheck = await checkDatabase();

    // The site check does not touch Supabase, so it still runs and still reports
    // when the database is gone. That combination — DB down, site down — is the
    // exact 2026-07-20 signature, and stating both is what makes the alert
    // diagnostic rather than merely noisy.
    let checks;
    if (!dbCheck.ok) {
        checks = [dbCheck, await checkSite()];
    } else {
        checks = [dbCheck, ...await Promise.all([
            checkScheduler(),
            checkLastSuccess(),
            checkIngest(),
            checkDisk(),
            checkSite(),
            checkProtectedSources(),
            checkStageFailures(),
        ])];
    }

    for (const c of checks) {
        console.log(`[watchdog] ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail.split('\n')[0] : ''}`);
    }

    const failures = checks.filter(c => !c.ok);
    if (!failures.length) {
        console.log('[watchdog] ✓ all checks passed');
        return 0;
    }

    // Escalate BEFORE alerting, because whether an issue is already open decides
    // whether this is news. The ordering costs one GitHub round trip; the previous
    // ordering cost three days of 15-minute pages.
    let alreadyOpen = false;
    let issueNumber = null;
    try {
        const result = await escalateToGitHub(failures, checks);
        alreadyOpen = result.alreadyOpen;
        issueNumber = result.issue?.number ?? null;
    } catch (e) {
        // If GitHub is unreachable we cannot tell "known" from "new", so fall
        // through and alert. A duplicate page beats a silent outage.
        console.error('[watchdog] issue escalation failed:', e.message);
    }

    if (alreadyOpen) {
        console.log(
            `[watchdog] condition already tracked in issue #${issueNumber} — no alert, exiting 0.\n` +
            `[watchdog] close the issue to re-arm; it reopens automatically if the condition recurs.`
        );
        // Exit 0 deliberately. A red run every 15 minutes for an acknowledged
        // condition trains you to ignore red runs, which is the state this whole
        // system exists to prevent.
        return 0;
    }

    const critical = failures.some(f => f.severity === 'critical');
    const title = `${critical ? '🔴' : '🟠'} Logosia: ${failures.map(f => f.name).join(', ')}`;
    const message = failures.map(f => `[${f.severity}] ${f.name}\n${f.detail}`).join('\n\n')
        + (issueNumber ? `\n\nTracked in issue #${issueNumber}.` : '');

    await alert(title, message, { priority: critical ? 'critical' : 'warning' });

    // Non-zero so a NEW condition goes red in the Actions list. That is the
    // last-resort signal for the case where every alert channel is misconfigured.
    return 1;
}

main()
    .then(code => process.exit(code))
    .catch(e => {
        console.error('[watchdog] fatal:', e);
        process.exit(1);
    });
