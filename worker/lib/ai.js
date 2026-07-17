require('dotenv').config({ path: '.env.local' });
const Groq = require('groq-sdk').default || require('groq-sdk');

const groqKeys = [
    process.env.GROQ_KEY,
    process.env.GROQ_KEY_2,
    process.env.GROQ_KEY_3,
].filter(Boolean);

let groqClients = groqKeys.map(k => new Groq({ apiKey: k }));
let keyIdx = 0;

function nextClient() {
    if (groqClients.length === 0) return null;
    const c = groqClients[keyIdx % groqClients.length];
    keyIdx++;
    return c;
}

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

async function callGroq(messages, opts = {}) {
    const client = nextClient();
    if (!client) {
        console.warn('[ai] No GROQ_KEY set — skipping AI call');
        return null;
    }
    try {
        const res = await client.chat.completions.create({
            model: opts.model || DEFAULT_MODEL,
            messages,
            max_tokens: opts.max_tokens || 400,
            temperature: opts.temperature ?? 0.2,
            ...(opts.response_format ? { response_format: opts.response_format } : {}),
        });
        return res.choices?.[0]?.message?.content || null;
    } catch (e) {
        console.error('[ai] Groq call failed:', e.message);
        return null;
    }
}

module.exports = { callGroq };
