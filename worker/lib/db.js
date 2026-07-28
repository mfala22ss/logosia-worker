require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
    console.error('[db] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
}

const db = createClient(url, key, {
    auth: { persistSession: false },
});

// Free-tier volume. Supabase exposes no disk-quota endpoint on the free plan, so
// the ceiling is a constant here and must be updated by hand if the project is
// ever upgraded. Overridable via env so a plan change needs no code change.
const DISK_LIMIT_BYTES = parseInt(process.env.DISK_LIMIT_BYTES || String(500 * 1024 * 1024), 10);

// Current database size in bytes, via the db_size_bytes() RPC.
//
// supabase-js speaks PostgREST, which cannot run arbitrary SQL, so
// `select pg_database_size(...)` is only reachable through a SECURITY DEFINER
// function — see db/migrations/20260728_self_maintenance.sql in the site repo.
//
// Returns null rather than throwing. Every caller treats "size unknown" as
// "carry on with the configured defaults": a failure to read the gauge must not
// take down the pipeline the gauge exists to protect.
async function dbSizeBytes() {
    try {
        const { data, error } = await db.rpc('db_size_bytes');
        if (error) {
            console.warn('[db] db_size_bytes RPC failed:', error.message);
            return null;
        }
        const bytes = Number(data);
        return Number.isFinite(bytes) ? bytes : null;
    } catch (e) {
        console.warn('[db] db_size_bytes threw:', e.message);
        return null;
    }
}

function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return 'unknown';
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

module.exports = { db, dbSizeBytes, formatBytes, DISK_LIMIT_BYTES };
