// Translator agent — translates non-English article titles to English.
// Strategy: free MyMemory API first (no key), Groq fallback for failures.

const { db } = require('../lib/db');
const { callGroq } = require('../lib/ai');

const LANG_MAP = {
    es: 'es', fr: 'fr', de: 'de', pt: 'pt', it: 'it', zh: 'zh-CN', ja: 'ja',
    ko: 'ko', ar: 'ar', ru: 'ru', hi: 'hi', nl: 'nl', pl: 'pl', tr: 'tr',
    vi: 'vi', id: 'id', th: 'th', sv: 'sv', uk: 'uk', he: 'he',
};

async function translateMyMemory(text, sourceLang) {
    try {
        const src = LANG_MAP[sourceLang] || sourceLang;
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${src}|en`;
        const r = await fetch(url).then(x => x.json()).catch(() => null);
        if (r?.responseStatus === 200 && r?.responseData?.translatedText) {
            const translated = (r.responseData.translatedText || '').split(' // ')[0];
            return translated && translated !== text ? translated : null;
        }
    } catch { /* ignore */ }
    return null;
}

async function translateGroq(text, sourceLang) {
    const sys = `You are a translation API. Output ONLY the English translation of the input. No commentary, no quotes, no formatting. If the input is already English, repeat it verbatim.`;
    const result = await callGroq([
        { role: 'system', content: sys },
        { role: 'user',   content: text.slice(0, 800) },
    ], { max_tokens: 200, temperature: 0.1 });
    return result?.trim() || null;
}

async function run({ limit = 150 } = {}) {
    // Find non-English articles whose title hasn't been translated yet
    const { data: articles, error } = await db
        .from('articles')
        .select('id, title, title_original, language')
        .eq('was_translated', false)
        .neq('language', 'en')
        .order('ingested_at', { ascending: false })
        .limit(limit);

    if (error) throw new Error('[translator] fetch failed: ' + error.message);
    if (!articles?.length) { console.log('[translator] No untranslated articles.'); return { processed: 0 }; }

    // Pure-ASCII titles are already English (or mis-tagged language) and will
    // always translate back to themselves. Mark them done so they leave the
    // queue instead of consuming a slot + Groq call every run forever.
    const isPureAscii = (s) => /^[\x00-\x7F]*$/.test(s);

    let processed = 0;
    let skipped = 0;
    for (const a of articles) {
        const original = a.title_original || a.title;

        if (isPureAscii(original)) {
            await db.from('articles').update({ was_translated: true }).eq('id', a.id);
            skipped++;
            continue;
        }

        let translated = await translateMyMemory(original, a.language);
        let usedGroq = false;
        if (!translated) {
            translated = await translateGroq(original, a.language);
            usedGroq = true;
        }

        if (translated && translated !== original) {
            await db.from('articles').update({
                title:          translated.slice(0, 500),
                was_translated: true,
            }).eq('id', a.id);
            processed++;
        }
        // On failure: leave was_translated = false so it retries next run.
        // Both providers can fail transiently (MyMemory daily cap, Groq rate limit).

        // Rate-limit guard for Groq free tier (15 req/min)
        if (usedGroq) await new Promise(r => setTimeout(r, 4200));
    }
    console.log(`[translator] ✓ Translated ${processed}/${articles.length} articles (${skipped} ASCII-skipped).`);
    return { processed, skipped };
}

module.exports = { run };
