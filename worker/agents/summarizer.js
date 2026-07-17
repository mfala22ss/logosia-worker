// Summarizer agent — generates a 3-bullet TL;DR per article.
// Runs only on quality_score >= 4 to conserve AI quota.

const { db } = require('../lib/db');
const { callGroq } = require('../lib/ai');

const SYS = `You are a news summarizer. Given a headline and snippet, output EXACTLY 3 bullet points summarizing the key facts. Each bullet starts with "• ". No preamble, no commentary, no opinion. Maximum 100 chars per bullet. Plain text only.`;

function buildPrompt(article) {
    return `Headline: ${article.title}\n\nSnippet: ${(article.snippet || '').slice(0, 600)}`;
}

async function summarize(article) {
    const raw = await callGroq([
        { role: 'system', content: SYS },
        { role: 'user',   content: buildPrompt(article) },
    ], { max_tokens: 200, temperature: 0.2 });

    if (!raw) return null;
    // Keep only lines starting with bullet; cap at 3
    const bullets = raw.split('\n').filter(l => l.trim().startsWith('•')).slice(0, 3).join('\n');
    return bullets || raw.slice(0, 400);
}

async function run({ limit = 30 } = {}) {
    const { data: articles, error } = await db
        .from('articles')
        .select('id, title, snippet, quality_score')
        .is('summary', null)
        .gte('quality_score', 4)
        .not('snippet', 'is', null)
        .order('importance_score', { ascending: false })
        .limit(limit);

    if (error) throw new Error('[summarizer] fetch failed: ' + error.message);
    if (!articles?.length) return { processed: 0 };

    let processed = 0;
    for (const a of articles) {
        if (!a.snippet || a.snippet.trim().length < 50) continue;
        const summary = await summarize(a);
        if (summary) {
            await db.from('articles').update({ summary }).eq('id', a.id);
            processed++;
        }
        // Crude rate-limit guard for Groq free tier (15 req/min)
        await new Promise(r => setTimeout(r, 4500));
    }
    console.log(`[summarizer] ✓ Summarized ${processed}/${articles.length} articles.`);
    return { processed };
}

module.exports = { run };
