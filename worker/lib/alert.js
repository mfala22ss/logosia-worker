// Alert fan-out — ntfy, Telegram, Discord.
//
// Three channels because the 2026-07-20 outage was not missed for lack of signal;
// it was missed for lack of a signal anyone SAW. GitHub Actions failure email is
// off by default on scheduled runs and buried when on. An alert that lands
// somewhere you do not look is indistinguishable from no alert.
//
// Every channel is optional and configured purely by the presence of its env var,
// so adding one is a secret, not a deploy. All are best-effort: a dead webhook
// must never fail the watchdog, because the watchdog failing silently is the exact
// class of bug this whole system exists to prevent.

const HTTP_TIMEOUT_MS = 10_000;

async function postJson(url, body, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } finally {
        clearTimeout(timer);
    }
}

// ntfy.sh — no account, no API key. NTFY_TOPIC is the whole configuration.
// Note the tradeoff: a public ntfy topic is readable by anyone who guesses the
// name, so the topic must be unguessable and messages must carry no secrets.
async function sendNtfy(title, message, priority) {
    const topic = process.env.NTFY_TOPIC;
    if (!topic) return null;

    const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(`${server}/${topic}`, {
            method: 'POST',
            headers: {
                Title: title,
                Priority: priority === 'critical' ? 'urgent' : 'high',
                Tags: priority === 'critical' ? 'rotating_light' : 'warning',
            },
            body: message,
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return 'ntfy';
    } finally {
        clearTimeout(timer);
    }
}

async function sendTelegram(title, message) {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return null;

    await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: `*${title}*\n\n${message}`,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
    });
    return 'telegram';
}

async function sendDiscord(title, message, priority) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return null;

    await postJson(url, {
        embeds: [{
            title,
            description: message.slice(0, 4000),
            color: priority === 'critical' ? 0xdc2626 : 0xd97706,
        }],
    });
    return 'discord';
}

// Fires every configured channel concurrently. Returns which ones landed, so the
// caller can report "0 channels configured" instead of appearing to have alerted.
async function alert(title, message, { priority = 'warning' } = {}) {
    const results = await Promise.allSettled([
        sendNtfy(title, message, priority),
        sendTelegram(title, message),
        sendDiscord(title, message, priority),
    ]);

    const delivered = [];
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value) delivered.push(r.value);
        else if (r.status === 'rejected') console.warn('[alert] channel failed:', r.reason?.message || r.reason);
    }

    if (!delivered.length) {
        console.warn('[alert] NO CHANNEL DELIVERED — set NTFY_TOPIC, TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID, or DISCORD_WEBHOOK_URL');
    } else {
        console.log(`[alert] delivered via ${delivered.join(', ')}`);
    }

    return delivered;
}

module.exports = { alert };
