// rss-parser returns CDATA fields as {_: 'text', $: {type:'html'}} objects on some feeds
function toStr(v) {
    if (!v) return '';
    return typeof v === 'string' ? v : (v._ || '');
}

function normalizeUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
         'ref', 'source', 's', 'fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid']
            .forEach(p => u.searchParams.delete(p));
        u.hash = '';
        const hostname = u.hostname.replace(/^www\./, '').toLowerCase();
        const pathname = u.pathname
            .replace(/\/amp\/?$/i, '/')
            .replace(/index\.html?$/i, '')
            .replace(/\/+$/, '');
        return `${hostname}${pathname}${u.search}`.toLowerCase();
    } catch {
        return (url || '').trim().toLowerCase();
    }
}

const IMAGE_EXT_RE   = /\.(jpe?g|png|webp|gif|avif|svg)(\?|#|$)/i;
const TRACKING_RE    = /\b(pixel|tracking|beacon|spacer|1x1|transparent)\b/i;
const MIN_IMG_LEN    = 12;

function looksLikeImage(url) {
    if (!url || url.length < MIN_IMG_LEN) return false;
    if (TRACKING_RE.test(url)) return false;
    return true;
}

function urlFromMediaNode(node) {
    if (!node) return null;
    const candidates = Array.isArray(node) ? node : [node];
    for (const m of candidates) {
        const url = (m && m.$ && m.$.url) || (m && m.url);
        if (url && looksLikeImage(url)) return url;
    }
    return null;
}

function extractImage(item, content) {
    // 1. media:content — may be array
    const mcUrl = urlFromMediaNode(item.mediaContent || item['media:content']);
    if (mcUrl) return mcUrl;

    // 2. media:thumbnail — may be array
    const mtUrl = urlFromMediaNode(item.mediaThumbnail || item['media:thumbnail']);
    if (mtUrl) return mtUrl;

    // 3. enclosure
    if (item.enclosure && item.enclosure.url) {
        const { url, type } = item.enclosure;
        if ((type && type.startsWith('image/')) || IMAGE_EXT_RE.test(url)) {
            if (looksLikeImage(url)) return url;
        }
    }

    // 4. Scan HTML: content:encoded first, then description fallback
    const html = toStr(content) || toStr(item.description) || item.contentSnippet || '';
    if (html) {
        // OG image meta tag embedded in feed HTML
        const og = html.match(/property=["']og:image["'][^>]*content=["']([^"']{12,})["']/i)
                || html.match(/content=["']([^"']{12,})["'][^>]*property=["']og:image["']/i);
        if (og && looksLikeImage(og[1])) return og[1];

        // All img tags — prefer src, fall back to data-src (lazy-load)
        const tags = [...html.matchAll(/<img[^>]+>/gi)];
        for (const [tag] of tags) {
            const src = tag.match(/\bsrc=["']([^"']{12,})["']/i)
                     || tag.match(/\bdata-src=["']([^"']{12,})["']/i)
                     || tag.match(/\bdata-lazy-src=["']([^"']{12,})["']/i);
            if (src && looksLikeImage(src[1])) return src[1];
        }
    }

    return null;
}

function decodeHtmlEntities(s) {
    s = toStr(s);
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanSnippet(raw) {
    if (!raw) return '';
    const decoded = decodeHtmlEntities(raw);
    const cleaned = decoded.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length > 400 ? cleaned.slice(0, 397) + '...' : cleaned;
}

function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return ''; }
}

module.exports = { normalizeUrl, extractImage, cleanSnippet, domainOf, toStr };
