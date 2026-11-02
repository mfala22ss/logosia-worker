# Agent & AI Rules for logosia-worker

These rules apply to Claude Code, GitHub Copilot, and any AI agent working in this repo.

This repo is the ingestion pipeline for logosia.com.au. The website is a separate,
private repo (`mfala22ss/logosia-web`). The two share nothing but the Supabase
database — this repo writes it, the site reads it.

---

## Absolute Rules

### Never touch USA sources
`worker/data/feeds.json` has a USA country block (`"origin": "[USA]"`). **Do not
modify it.** Any source expansion, trim, or cleanup must skip USA entirely. This
was stated explicitly by the owner.

### This repo is public — never commit secrets
`.env.local` is gitignored. Credentials live in GitHub Actions secrets, which are
encrypted and never exposed to forks. Never put a real key in a tracked file.

### The scraper reads RSS only
It must never fetch full article HTML. That is the legal line the whole project
depends on — see the terms of service in the site repo.

### Never weaken retention
`worker/agents/retainer.js` must stay the **first** entry in `STAGES`, and its
windows (`PRUNE_AFTER_DAYS`, `DELETE_AFTER_DAYS`, `DISK_SOFT_PCT`, `DISK_HARD_PCT`)
must not be widened. On 2026-07-20 the 500MB volume filled, Postgres wedged in a
crash-recovery loop, and the site was down for **eight days**. The retainer is the
only thing preventing a repeat.

This is the single most dangerous class of change in this repo, because it does not
fail. Widening a window to clear a symptom leaves everything green for about a week
before the disk fills — and once it is full there is no reactive fix: the database
refuses every connection with `FATAL 57P03`, so `TRUNCATE`, `DROP INDEX` and the
dashboard SQL editor are all equally impossible. `worker/scripts/smoke.js` asserts
the stage order in CI, but nothing can assert the windows are large enough.

The same reasoning covers per-stage `limit` values: they bound how much a single
run can write. Do not raise them to clear a backlog.

### Do not change source policy to fix a bug
Which outlets Logosia carries is an editorial decision: premium/tier-1 plus roughly
the top five per country, never the full list. Fixing a **broken feed URL** for a
source already on the list is in scope. Adding or removing outlets is not — that is
the owner's call, whatever a failing check seems to suggest.

---

## feeds.json entry format

```json
{
  "name": "Source Name",
  "url": "https://example.com/rss",
  "origin": "[AUS]",
  "language": "en",
  "bias": 0,
  "factual": 7,
  "credibility": 70,
  "tier": 2,
  "focus": ["political", "geopolitical"]
}
```

- `url` must be globally unique — it is the upsert key in `seed-sources.js`
- `name` must be unique per country
- `origin` is a bracketed ISO-3 code; `seed-sources.js` strips the brackets
- `tier`: 1=wire/govt, 2=major national, 3=specialist/state, 4=aggregator
- `bias`: -10 far-left → 0 centre → +10 far-right, 99=state media

Note: bias/factual/credibility in `feeds.json` are **ignored** by `seed-sources.js`.
It reads those from `source-ratings.json`, matched by domain, and falls back to
`bias 0 / factual 5 / credibility 50` when no rating exists.

---

## After changing feeds.json or source-ratings.json

Run `npm run db:seed-sources`.

Both of the gaps once documented here are now fixed — `seed-sources.js` disables
rows removed from `feeds.json` (commit `0f2f005`) and `scraper.js` pages past the
1,000-row PostgREST cap (commit `6399f21`). Do not reintroduce either.

**Careful:** the seeder and the auto-disable logic both write `sources.enabled`.
`worker/lib/source-health.js` disables a feed after 8 consecutive failures; a later
`npm run db:seed-sources` re-enables it, because the seeder upserts from
`feeds.json` and knows nothing about runtime health. That is currently intended —
re-seeding is an explicit "reset to the declared list" action — but it means a feed
that is genuinely dead comes back and takes another ~16 hours to retire itself.
Remove it from `feeds.json` if it is dead for good.

---

## Self-maintenance

`worker/scripts/watchdog.js` runs every 15 minutes and can open an issue tagging
`@claude`, which triggers `.github/workflows/claude.yml`. If you are reading this
because such an issue summoned you:

- Read the failing checks before touching anything. The check names map to specific
  causes; `detail` carries the numbers.
- **If the root cause is infrastructure — database unreachable, disk full, scheduler
  disabled — comment saying so and open no PR.** No code change reaches a database
  that will not accept a connection. A PR that cannot fix the problem is worse than
  none: it makes the incident look handled.
- Verify with `npm run smoke` (no credentials needed) before opening a PR.
  `smoke.js` sets placeholder credentials itself, so this holds on a runner with no secrets.
- You get no Supabase credentials, by design. To see live health, read the watchdog's own
  run logs, which do run with them: `gh run list --workflow watchdog.yml --limit 3`, then
  `gh run view <id> --log`. Do not ask for the service-role key; on a public repo an agent
  holding it is one prompt injection away from deleting the database.
- `workflows_enabled` failing means GitHub disabled a scheduled workflow for inactivity. The
  watchdog has already re-enabled it. Comment, open no PR.
- Only `worker/data/*.json` changes are eligible for auto-merge, and only when
  `AUTO_MERGE_ENABLED` is set. Everything else waits for a human. See the
  "Self-maintenance" section of `README.md` for why.

---

## Supabase queries (CommonJS)

```javascript
const { db } = require('./lib/db');
const { data, error } = await db.from('articles').select('...');
```

### Upsert articles — include all NOT NULL columns

```javascript
// title, url, url_normalized are NOT NULL with no default.
// Always include them in upsert payloads or the INSERT fails, because
// Supabase validates NOT NULL on INSERT before the conflict check.
await db.from('articles').upsert(
  { id, url, url_normalized, title, importance_score, quality_score },
  { onConflict: 'id' }
);
```

The schema itself lives in the site repo at `db/schema.sql`. This repo depends on
it but does not own it — check there before writing DB-touching code.

---

## Testing

```bash
npm run worker:once   # full pipeline (what CI runs) — needs .env.local
npm run scrape        # scraper only
PREMIUM_ONLY=1 npm run scrape   # wires only, ~25 feeds, faster
```
