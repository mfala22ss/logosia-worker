// Headline deduplication — Jaccard token similarity.
//
// Replaces the 8-word fingerprint approach with token-set Jaccard to catch
// paraphrased same-story duplicates ("X killed in Y" / "Y attack kills X").
// Wire-suffix stripping removes attribution noise before comparison.
//
// URL-level dedup (onConflict: 'url') still happens at DB level; this catches
// cross-source semantic duplicates before the upsert.

const STOP_WORDS = new Set([
    'a','an','the','in','on','at','to','for','of','and','or','but',
    'is','are','was','were','be','been','being','have','has','had',
    'do','does','did','will','would','could','should','may','might',
    'not','no','its','it','this','that','with','as','by','from',
    'up','about','into','over','after','said','says','new','how',
]);

const WIRE_SUFFIX_RE = /\s*[-|–—]\s*(reuters|ap|afp|bbc|bloomberg|the guardian|associated press|financial times|washington post|new york times|cnn|nbc|abc|cbs|fox news|axios|politico)\s*$/i;

function tokenize(title) {
    if (!title) return new Set();
    const norm = title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(WIRE_SUFFIX_RE, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const words = [];
    for (const w of norm.split(' ')) {
        if (w.length > 2 && !STOP_WORDS.has(w)) words.push(w);
    }
    return new Set(words);
}

function jaccard(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let inter = 0;
    for (const w of setA) { if (setB.has(w)) inter++; }
    return inter / (setA.size + setB.size - inter);
}

// Score a candidate: higher = prefer keeping this one.
function credibilityScore(c) {
    const factual = c.factual_score ?? 5;
    const bias    = Math.abs(c.bias_score ?? 0);
    const state   = c.is_state_media ? -5 : 0;
    return factual - bias * 0.3 + state;
}

const JACCARD_THRESHOLD = 0.55;

/**
 * Dedup an array of candidate article objects by headline Jaccard similarity.
 * Returns a new array with at most one article per story, keeping the
 * highest-credibility source per group.
 *
 * @param {Array} candidates
 * @returns {Array}
 */
function dedupCandidates(candidates) {
    const groups = [];  // [{rep: Set<string>, items: [...]}]

    for (const c of candidates) {
        const tokens = tokenize(c.title);
        let matched = -1;
        for (let i = 0; i < groups.length; i++) {
            if (jaccard(tokens, groups[i].rep) >= JACCARD_THRESHOLD) {
                matched = i;
                break;
            }
        }
        if (matched >= 0) {
            groups[matched].items.push(c);
        } else {
            groups.push({ rep: tokens, items: [c] });
        }
    }

    const result = [];
    for (const g of groups) {
        if (g.items.length === 1) { result.push(g.items[0]); continue; }
        g.items.sort((a, b) => credibilityScore(b) - credibilityScore(a));
        result.push(g.items[0]);
    }
    return result;
}

module.exports = { dedupCandidates, tokenize };
