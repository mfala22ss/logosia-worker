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
