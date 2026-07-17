// Categorizer agent — assigns one or more categories to each article.
// Heuristic keyword scoring (free, fast). Writes all matching categories
// to the `categories` array column so articles appear in multiple tabs.
// Primary `category` = highest-scoring match (for backward compat).

const { db } = require('../lib/db');

const CATEGORIES = {
    geopolitical: [
        'war', 'conflict', 'nato', 'ceasefire', 'invasion', 'airstrike', 'sanctions', 'treaty',
        'diplomacy', 'missile', 'russia', 'ukraine', 'israel', 'gaza', 'taiwan', 'iran',
        'north korea', 'coup', 'hamas', 'hezbollah', 'houthi', 'syria', 'lebanon', 'palestine',
        'netanyahu', 'putin', 'zelensky', 'military', 'troops', 'offensive', 'frontline',
        'peacekeeping', 'un security council', 'security council', 'bilateral', 'summit',
        'geopolitical', 'territorial', 'sovereignty', 'occupation', 'blockade',
    ],
    political: [
        'election', 'parliament', 'congress', 'senate', 'impeachment', 'executive order',
        'president', 'vote', 'trump', 'biden', 'harris', 'democrat', 'republican', 'prime minister',
        'cabinet', 'minister', 'white house', 'kremlin', 'downing street', 'campaign', 'veto',
        'legislation', 'referendum', 'polling', 'political party', 'coalition', 'opposition',
        'government', 'administration', 'policy', 'regulation', 'reform', 'ruling party',
    ],
    financial: [
        'stock market', 'stock exchange', 'wall street', 'federal reserve', 'central bank',
        's&p 500', 'nasdaq', 'dow jones', 'ftse', 'nikkei', 'dax', 'hang seng',
        'bitcoin', 'crypto', 'ethereum', 'blockchain', 'hedge fund', 'private equity',
        'venture capital', 'forex', 'currency', 'exchange rate', 'dollar', 'euro', 'yen',
        'stocks', 'equities', 'bonds', 'gilts', 'trading', 'yield', 'treasury',
        'dividend', 'earnings', 'ipo', 'spac', 'valuation', 'investment fund',
        'asset management', 'portfolio', 'capital markets', 'financial markets',
        'interest rate', 'rate decision', 'rate cut', 'rate hike', 'bank of england',
        'european central bank', 'bank of japan', 'fed ', 'fed rate', 'basis points',
        'quantitative easing', 'quantitative tightening', 'bond market', 'credit rating',
        'financial results', 'quarterly results', 'profit warning', 'revenue growth',
        'market rally', 'market crash', 'bull market', 'bear market', 'short selling',
    ],
    economic: [
        'inflation', 'gdp', 'unemployment', 'recession', 'cpi', 'ppi', 'monetary policy',
        'fiscal policy', 'trade deficit', 'trade surplus', 'cost of living', 'housing market',
        'imf', 'world bank', 'oecd', 'tariff', 'mortgage', 'wage growth', 'wage inflation',
        'economic growth', 'economic slowdown', 'economic output', 'supply chain',
        'trade war', 'trade deal', 'export', 'import', 'consumer spending', 'retail sales',
        'manufacturing output', 'industrial production', 'labour market', 'labor market',
        'poverty', 'inequality', 'living standards', 'austerity', 'stimulus', 'budget deficit',
    ],
    technology: [
        'artificial intelligence', 'machine learning', 'quantum computing', 'cybersecurity',
        'data breach', 'ransomware', 'semiconductor', 'ai ', 'openai', 'nvidia', 'apple',
        'microsoft', 'google', 'meta', 'amazon', 'spacex', 'tiktok', 'autonomous',
        'robotics', 'automation', 'cloud computing', 'data center', 'chip', 'microchip',
        'software', 'algorithm', 'deepfake', 'surveillance', 'tech giant', 'startup',
        'generative ai', 'large language model', 'llm', 'chatgpt', 'gpt', 'gemini',
        'social media', 'platform', 'app store', 'streaming', 'broadband', '5g',
    ],
    energy: [
        'oil price', 'gas price', 'opec', 'crude oil', 'energy crisis', 'renewable energy',
        'fossil fuel', 'power grid', 'lng', 'natural gas', 'solar', 'wind power', 'battery',
        'electric vehicle', 'emissions', 'climate', 'refinery', 'drilling', 'pipeline',
        'coal', 'nuclear power', 'hydropower', 'energy transition', 'net zero', 'carbon',
        'carbon credit', 'greenhouse gas', 'cop30', 'paris agreement', 'energy security',
        'petrol', 'diesel', 'brent crude', 'wti', 'energy storage',
    ],
    health: [
        'pandemic', 'clinical trial', 'drug approval', 'vaccine', 'outbreak', 'epidemic',
        'fda', 'pharma', 'covid', 'cancer', 'hospital', 'biotech', 'genetics', 'who ',
        'mpox', 'ebola', 'ozempic', 'mental health', 'public health', 'health system',
        'nhs', 'medicare', 'medicaid', 'drug pricing', 'healthcare', 'surgery',
        'antibiotic', 'pathogen', 'virus', 'mortality', 'life expectancy',
    ],
    corporate: [
        'merger', 'acquisition', 'bankruptcy', 'layoffs', 'chapter 11', 'restructuring',
        'ceo', 'lawsuit', 'shareholder', 'buyback', 'antitrust', 'recall', 'whistleblower',
        'board', 'executive', 'corporate governance', 'supply contract', 'joint venture',
        'spinoff', 'demerger', 'takeover', 'hostile bid', 'class action', 'settlement',
        'fine', 'penalty', 'investigation', 'regulatory probe', 'sec ', 'ofcom',
    ],
};

const EXCLUSIONS = {
    geopolitical: ['app store', 'software update', 'tv show', 'movie', 'recipe', 'fashion'],
    technology:   ['apple harvest', 'apple pie', 'amazon river', 'amazon rainforest'],
    energy:       ['nuclear weapons', 'nuclear doctrine'],
    financial:    ['apple harvest', 'amazon river'],
};

const INFLECTION_SUFFIXES = new Set([
    's', 'es', 'ian', 'ians', 'ean', 'eans', 'an', 'ans', 'n', 'ns', 'i',
    'ish', 'ese', 'ers', 'er', 'ing', 'ed', 'ly', 'al', 'tion', 'ations',
]);
const MIN_STEM_LEN = 4;

function tokenize(text) {
    const words = new Set();
    for (const raw of text.toLowerCase().split(/\s+/)) {
        const w = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
        if (w) words.add(w);
    }
    return words;
}

function stemMatch(token, kw) {
    if (token === kw) return true;
    if (kw.length < MIN_STEM_LEN) return false;
    if (token.startsWith(kw)) {
        const suffix = token.slice(kw.length);
        if (INFLECTION_SUFFIXES.has(suffix)) return true;
    }
    if (kw.endsWith('e')) {
        const stem = kw.slice(0, -1);
        if (stem.length >= MIN_STEM_LEN && token.startsWith(stem)) {
            const suffix = token.slice(stem.length);
            if (INFLECTION_SUFFIXES.has(suffix)) return true;
        }
    }
    return false;
}

function kwHits(words, ordered, kwPhrase) {
    const parts = kwPhrase.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1) {
        for (const w of words) if (stemMatch(w, parts[0])) return true;
        return false;
    }
    for (let i = 0; i <= ordered.length - parts.length; i++) {
        let match = true;
        for (let j = 0; j < parts.length; j++) {
            if (!stemMatch(ordered[i + j], parts[j])) { match = false; break; }
        }
        if (match) return true;
    }
    return false;
}

// Returns sorted array of all matching categories (score >= 1).
// Empty array means no match → 'general'.
function categorize(article) {
    const raw = ((article.title || '') + ' ' + (article.snippet || '')).toLowerCase();
    const words = tokenize(raw);
    const ordered = raw.split(/\s+/).map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter(Boolean);

    const scored = [];
    for (const [cat, kws] of Object.entries(CATEGORIES)) {
        const excl = EXCLUSIONS[cat] || [];
        if (excl.some(e => raw.includes(e))) continue;
        let score = 0;
        for (const kw of kws) if (kwHits(words, ordered, kw)) score += 1;
        if (score >= 1) scored.push({ cat, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.cat);
}

// PostgREST caps any response at 1000 rows, so asking for more is silently truncated.
const SELECT_PAGE = 1000;
// Large upserts time out on the Supabase free tier — same batch size the scraper uses.
const UPSERT_BATCH = 200;

// An article matching no keyword gets ['general'] rather than []. An empty array is
// '{}' in Postgres, which is the very filter this agent selects on — writing [] back
// would leave the row eligible forever and the paging loop below would re-read the
// same rows until it burned its whole budget.
const NO_MATCH = ['general'];

function toUpdate(article) {
    const cats = categorize(article);
    return {
        id:             article.id,
        url:            article.url,
        url_normalized: article.url_normalized,
        title:          article.title,
        category:       cats[0] || 'general',
        categories:     cats.length ? cats : NO_MATCH,
    };
}

async function upsertBatched(updates) {
    for (let i = 0; i < updates.length; i += UPSERT_BATCH) {
        const chunk = updates.slice(i, i + UPSERT_BATCH);
        const { error } = await db.from('articles').upsert(chunk, { onConflict: 'id' });
        if (error) throw new Error('[categorizer] batch upsert failed: ' + error.message);
    }
}

// Process articles that haven't been multi-categorized yet (categories = '{}').
// Newest first: the site only ever filters on recent articles, so fresh rows matter
// more than the historical backlog. Each pass re-queries the '{}' filter, and rows
// written by the previous pass drop out of it — that is what advances the loop.
//
// Ordered by id, not ingested_at. id is the bigserial primary key, so it is already
// indexed and monotonic with insertion — Postgres walks the index backwards and stops
// at the limit. Ordering by ingested_at has no usable index and forces a sort over
// half a million rows, which exceeds the 8s statement timeout (measured: 8.8s vs 0.97s).
async function run({ limit = 5000 } = {}) {
    let processed = 0;
    let multiCategory = 0;

    while (processed < limit) {
        const pageSize = Math.min(SELECT_PAGE, limit - processed);
        const { data: articles, error } = await db
            .from('articles')
            .select('id, title, snippet, url, url_normalized')
            .eq('categories', '{}')
            .order('id', { ascending: false })
            .limit(pageSize);

        if (error) throw new Error('[categorizer] fetch failed: ' + error.message);
        if (!articles?.length) break;

        const updates = articles.map(toUpdate);
        await upsertBatched(updates);

        processed     += updates.length;
        multiCategory += updates.filter(u => u.categories.length > 1).length;

        if (articles.length < pageSize) break;
    }

    console.log(`[categorizer] ✓ Categorized ${processed} articles (${multiCategory} multi-category).`);
    return { processed };
}

module.exports = { run, categorize };
