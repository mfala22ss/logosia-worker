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

**Known gap:** `seed-sources.js` upserts with `enabled: true` and never disables
anything. Removing a feed from `feeds.json` does NOT stop the scraper fetching it —
the row stays enabled in Supabase. Any trim must also disable the orphaned rows.

**Known gap:** `scraper.js` selects sources without `.range()`. PostgREST caps
results at 1,000 rows. With 1,753 enabled sources, 753 are silently never fetched.

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
