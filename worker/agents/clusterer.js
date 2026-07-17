// Clusterer — groups recent articles into "stories" by multilingual semantic similarity,
// then sets importance_score from how many INDEPENDENT sources cover each story.
//
// Rationale: the strongest real importance signal is corroboration — a story carried by
// 12 outlets matters more than one carried by 1. Clustering on multilingual embeddings
// makes this language-agnostic, so foreign-language coverage of a big event inherits the
// story's importance (fixes the English-keyword bias in curator.js).
//
// Runs AFTER curator: curator sets quality_score + a keyword baseline importance; this
// overwrites importance for the recent window with the better cluster-based score.

const { db } = require('../lib/db');
const { embed } = require('../lib/embed');
const { IMPORTANCE_KEYWORDS } = require('./curator');

const WINDOW_HOURS = 72;        // only the relevance window needs clustering
const MAX_ARTICLES = 2000;      // bound the O(n²) clustering + embedding cost
const SIM_THRESHOLD = 0.78;     // cosine; tune against real data after first runs
const SOURCE_WEIGHT = 14;       // importance points per distinct corroborating source
const UPSERT_CHUNK = 500;

// Vectors are L2-normalized, so cosine similarity is just the dot product.
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function keywordBonus(text) {
  const t = text.toLowerCase();
  let bonus = 0;
  for (const list of Object.values(IMPORTANCE_KEYWORDS)) {
    for (const kw of list) if (t.includes(kw)) bonus += 4;
  }
  return Math.min(bonus, 20);
}

// Greedy single-pass clustering: assign each article to the nearest existing centroid
// above threshold, else start a new cluster. Centroids are running means, renormalized.
function cluster(vectors) {
  const clusters = []; // { centroid: Float32Array, count, members: number[] }
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    let best = -1;
    let bestSim = SIM_THRESHOLD;
    for (let c = 0; c < clusters.length; c++) {
      const sim = cosine(v, clusters[c].centroid);
      if (sim >= bestSim) { bestSim = sim; best = c; }
    }
    if (best === -1) {
      clusters.push({ centroid: Float32Array.from(v), count: 1, members: [i] });
      continue;
    }
    const cl = clusters[best];
    const n = cl.count;
    for (let d = 0; d < cl.centroid.length; d++) {
      cl.centroid[d] = (cl.centroid[d] * n + v[d]) / (n + 1);
    }
    let norm = 0;
    for (let d = 0; d < cl.centroid.length; d++) norm += cl.centroid[d] * cl.centroid[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < cl.centroid.length; d++) cl.centroid[d] /= norm;
    cl.count++;
    cl.members.push(i);
  }
  return clusters;
}

function scoreCluster(members, articles) {
  const sourceSet = new Set();
  let bestTier = 5;
  let newestMs = 0;
  let kw = 0;
  let minId = Infinity;
  for (const idx of members) {
    const a = articles[idx];
    if (a.source_id != null) sourceSet.add(a.source_id);
    if (a.tier && a.tier < bestTier) bestTier = a.tier;
    const ms = a.published_at ? new Date(a.published_at).getTime() : 0;
    if (ms > newestMs) newestMs = ms;
    kw = Math.max(kw, keywordBonus((a.title_original || a.title || '') + ' ' + (a.snippet || '')));
    if (a.id < minId) minId = a.id;
  }

  const distinctSources = sourceSet.size;
  const tierBonus = bestTier === 1 ? 15 : bestTier === 2 ? 6 : 0;
  const ageHours = (Date.now() - newestMs) / 3_600_000;
  const recencyBonus = ageHours < 6 ? 10 : ageHours < 24 ? 5 : 0;
  const importance = Math.max(
    0,
    Math.min(100, distinctSources * SOURCE_WEIGHT + tierBonus + recencyBonus + kw),
  );

  return {
    importance,
    distinctSources,
    clusterId: minId, // smallest member id = stable grouping anchor
    status: distinctSources >= 2 ? 'multi_source' : 'single_source',
  };
}

async function run({ windowHours = WINDOW_HOURS, maxArticles = MAX_ARTICLES } = {}) {
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const { data: articles, error } = await db
    .from('articles')
    // url + url_normalized + title are NOT NULL — required in the upsert payload (see CLAUDE.md).
    .select('id, url, url_normalized, title, title_original, snippet, source_id, tier, published_at')
    .gte('published_at', cutoff)
    .eq('pruned', false)
    .order('published_at', { ascending: false })
    .limit(maxArticles + 1);

  if (error) throw new Error('[clusterer] fetch failed: ' + error.message);
  if (!articles?.length) { console.log('[clusterer] No recent articles.'); return { clusters: 0, processed: 0 }; }

  if (articles.length > maxArticles) {
    console.warn(`[clusterer] window has >${maxArticles} articles; clustering newest ${maxArticles}, older skipped this run.`);
    articles.length = maxArticles;
  }

  const texts = articles.map(a => (a.title_original || a.title || '').slice(0, 256));
  const vectors = await embed(texts);
  const clusters = cluster(vectors);

  const updates = [];
  let multiSource = 0;
  for (const cl of clusters) {
    const score = scoreCluster(cl.members, articles);
    if (score.distinctSources >= 2) multiSource++;
    for (const idx of cl.members) {
      const a = articles[idx];
      updates.push({
        id: a.id,
        url: a.url,
        url_normalized: a.url_normalized,
        title: a.title,
        importance_score: score.importance,
        cluster_id: score.clusterId,
        verification_count: score.distinctSources,
        verification_status: score.status,
      });
    }
  }

  for (let i = 0; i < updates.length; i += UPSERT_CHUNK) {
    const chunk = updates.slice(i, i + UPSERT_CHUNK);
    const { error: upsertErr } = await db.from('articles').upsert(chunk, { onConflict: 'id' });
    if (upsertErr) throw new Error('[clusterer] batch upsert failed: ' + upsertErr.message);
  }

  console.log(`[clusterer] ✓ ${articles.length} articles → ${clusters.length} stories (${multiSource} multi-source).`);
  return { clusters: clusters.length, processed: updates.length, multiSource };
}

module.exports = { run, cluster, scoreCluster };
