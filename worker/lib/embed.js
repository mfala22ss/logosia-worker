// Embedding helper — multilingual sentence embeddings via transformers.js (ONNX, no Python).
// Used by the clusterer to group the same story across languages. The model aligns
// translations in a shared vector space, so an Arabic headline and its English
// counterpart land close together — this is what makes importance language-agnostic.

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

let extractorPromise = null;

async function getExtractor() {
  if (!extractorPromise) {
    // transformers.js v4 is ESM-only — load via dynamic import from CommonJS.
    const { pipeline, env } = await import('@huggingface/transformers');
    // Fixed cache dir so CI (actions/cache) can persist the ~110MB model between runs.
    env.cacheDir = process.env.HF_CACHE_DIR || './.cache/transformers';
    extractorPromise = pipeline('feature-extraction', MODEL);
  }
  return extractorPromise;
}

// Embed an array of strings → array of L2-normalized Float32Array vectors (one per input).
// Normalized vectors mean cosine similarity reduces to a dot product downstream.
async function embed(texts) {
  if (!texts.length) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });

  const [count, dim] = output.dims;
  const flat = output.data;
  const vectors = [];
  for (let i = 0; i < count; i++) {
    vectors.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return vectors;
}

module.exports = { embed, MODEL };
