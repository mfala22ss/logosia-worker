# logosia-worker

News ingestion and scoring pipeline for [logosia.com.au](https://logosia.com.au).

Runs on GitHub Actions, writes to Supabase. The website that reads this data lives
in a separate repository — the two share nothing but the database.

## Pipeline

```
feeds.json ──seed-sources.js──► sources table
                                     │
                                     ▼
                                 scraper.js          fetch RSS, dedupe, insert
                                     │
                                     ▼
                                articles table
                                     │
   curator ──► clusterer ──► categorizer ──► translator ──► summarizer
   (score)     (corroborate)  (tag)          (to English)   (Groq)
```

`worker/index.js` orchestrates the stages in that order. Each stage is wrapped in
its own try/catch, so one failing stage degrades the run rather than killing it.

## Schedules

| Workflow | Cadence | Does |
|----------|---------|------|
| `worker.yml` | hourly | Full pipeline — all enabled sources |
| `premium-scraper.yml` | every 15 min | `PREMIUM_ONLY=1` — wires only, for freshness |

## Setup

```bash
npm install
cp .env.example .env.local   # fill in real values
npm run db:seed-sources      # push feeds.json → Supabase
npm run worker:once          # one full pass
```

## Scripts

| Command | Does |
|---------|------|
| `npm run worker:once` | Full pipeline once, then exit (what CI runs) |
| `npm run worker:scrape` | Full pipeline on a loop every `SCRAPE_INTERVAL_MIN` |
| `npm run scrape` | Scraper only |
| `npm run curate` | Curator only |
| `npm run cluster` | Clusterer only |
| `npm run categorize` | Categorizer only |
| `npm run db:seed-sources` | Sync `feeds.json` + `source-ratings.json` → Supabase |
| `npm run watchdog` | Health checks → alert + `@claude` issue (runs every 15 min in CI) |
| `npm run smoke` | Load every module; assert the stage order. The CI gate on PRs |

## Self-maintenance

The 2026-07-20 outage lasted eight days not because it was hard to fix, but because
nothing noticed. Postgres wedged in a crash-recovery loop, Supabase's control plane
kept reporting the project `ACTIVE_HEALTHY`, and the site served no news until a
human happened to look. Everything below exists to make that impossible to repeat.

### What runs on its own

| Workflow | Cadence | Does |
|----------|---------|------|
| `worker.yml` | hourly | The pipeline |
| `premium-scraper.yml` | every 15 min | Premium feeds only |
| `watchdog.yml` | every 15 min | Health checks, alerts, opens issues |
| `claude.yml` | on `@claude` | Investigates an issue, opens a PR |
| `ci.yml` | on PR | Syntax + JSON + import smoke + stage-order assertion |
| `automerge.yml` | on PR | Auto-merges data-only PRs — **off unless enabled** |

The loop: watchdog detects → alerts you → opens an issue tagging `@claude` →
Claude investigates and opens a PR → CI gates it → you merge (or auto-merge does,
for `worker/data/*.json` only).

### What it will not do

Escalation splits on whether an agent can actually act. A failing stage or a dead
feed URL is code, and Claude can fix it. A full disk or an unreachable database is
not — on 2026-07-20 no SQL could run at all, so an agent would have been as locked
out as a human. Those alert you and stop there, because a PR that cannot fix the
problem is worse than no PR: it makes the incident look handled.

Auto-merge is limited to `worker/data/*.json` and off by default. This pipeline's
dangerous changes are subtractions — removing the retainer, widening a retention
window, raising a stage limit — and they are dangerous precisely because they pass
every test and only show up a week later as a full disk. No test catches "safe
today, fatal in six days", so code waits for a human.

### Setup

1. Apply `db/migrations/20260728_self_maintenance.sql` from the site repo (adds
   `worker_runs`, the source-health columns, and the `db_size_bytes()` RPC).
2. Add at least one alert channel secret — `NTFY_TOPIC`, `TELEGRAM_BOT_TOKEN` +
   `TELEGRAM_CHAT_ID`, or `DISCORD_WEBHOOK_URL`. **Without one the watchdog can
   detect an outage and have nowhere to report it.** See `.env.example`.
3. Add `CLAUDE_CODE_OAUTH_TOKEN` for `claude.yml`.
4. Protect `main`: require the `verify` check from `ci.yml`. Auto-merge uses
   `--auto`, which queues behind *required* checks — with no branch protection
   GitHub merges immediately and the CI gate is decorative.
5. Verify locally: `npm run watchdog`.

Optional: `gh variable set AUTO_MERGE_ENABLED --body true` to close the loop on
data-only fixes.

### The one failure this cannot see

The watchdog runs on GitHub Actions, so a GitHub-wide incident takes down the
watcher and the watched together. Add one external check (UptimeRobot, BetterStack
— free tiers suffice) hitting `https://logosia.com.au`. It is the only layer that
survives GitHub being the thing that is broken.

## Secrets

This repository is public. Credentials live in GitHub Actions secrets, which are
encrypted, masked in logs, and never exposed to forks. Nothing secret is committed.

Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_KEY`, `GROQ_KEY_2`,
`GROQ_KEY_3`, `GROQ_MODEL`.

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security. It belongs here (the
worker writes) and nowhere near a browser bundle.

## Data files

| File | Contents |
|------|----------|
| `worker/data/feeds.json` | Master source list — name, RSS url, country, tier, focus |
| `worker/data/source-ratings.json` | Bias / factual / credibility ratings, MBFC-aligned methodology |
| `worker/data/diplomacy-keywords.json` | Keyword weights used by the categorizer |

After editing either of the first two, run `npm run db:seed-sources`.

## Legal

The scraper reads RSS feed data only. It never fetches full article HTML. That line
matters — see the terms of the site repository. Article content remains the property
of the respective publishers.
