// neon.js — Neon (PostgreSQL) backup & auto-restore layer
//
// How it works:
//  1. On boot, connects to Neon using DATABASE_URL (environment only — the
//     connection string is NEVER hardcoded in this file).
//  2. If the local SQLite data is missing (e.g. Render free-tier cold-start
//     wiped the disk), the latest snapshot is pulled back from Neon and
//     merged in a strictly MONOTONIC way (vote counts can only go UP).
//  3. Every 3 minutes a full snapshot (categories, nominees, users,
//     transactions, device_votes, settings, vote_baseline) is exported to
//     Neon. On each tick, if data loss is detected, a restore runs instead.
//
// The layer is fully fail-safe: any error is logged and swallowed, so the
// API keeps working even if Neon is unreachable.

const EXPORT_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const TABLE = 'creatives_awards_backup';
const TABLES = ['categories', 'nominees', 'users', 'transactions', 'device_votes', 'settings', 'vote_baseline'];

let Pool = null;
try { ({ Pool } = require('pg')); }
catch { console.warn('[neon] "pg" module not installed — Neon backup disabled. Run: npm install'); }

let pool = null;
let dbRef = null;
let ticking = false;

function snapshot() {
  const snap = { takenAt: Date.now(), tables: {} };
  for (const t of TABLES) {
    try { snap.tables[t] = dbRef.prepare(`SELECT * FROM ${t}`).all(); }
    catch { snap.tables[t] = []; }
  }
  return snap;
}

async function ensureTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       key TEXT PRIMARY KEY,
       value JSONB NOT NULL,
       updated_at BIGINT NOT NULL
     )`
  );
}

// Export the full local state to Neon (single-row upsert).
async function exportNow() {
  const snap = snapshot();
  await pool.query(
    `INSERT INTO ${TABLE} (key, value, updated_at) VALUES ('latest', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(snap), snap.takenAt]
  );
  console.log(`[neon] backup exported @ ${new Date(snap.takenAt).toISOString()}`);
}

// Data is considered "lost" when the local DB has no transactions and no
// users at all while a Neon backup exists that DOES have data.
function localDataLost(backupHasData) {
  if (!backupHasData) return false;
  try {
    const tx = dbRef.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
    const us = dbRef.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    return tx === 0 && us === 0;
  } catch { return false; }
}

// Merge a Neon snapshot back into SQLite — MONOTONIC (numbers never go down).
function applySnapshot(tables) {
  const t = tables || {};
  dbRef.pragma('foreign_keys = OFF');
  try {
    const run = dbRef.transaction(() => {
      const insCat = dbRef.prepare('INSERT OR IGNORE INTO categories (id, title, ordinal) VALUES (?, ?, ?)');
      (t.categories || []).forEach(c => insCat.run(c.id, c.title, c.ordinal));

      // Nominees: insert missing rows; for existing rows only ever RAISE votes.
      const insNom = dbRef.prepare('INSERT OR IGNORE INTO nominees (id, category_id, name, detail, base_votes, paid_votes, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const bumpNom = dbRef.prepare('UPDATE nominees SET base_votes = MAX(base_votes, ?), paid_votes = MAX(paid_votes, ?) WHERE id = ?');
      (t.nominees || []).forEach(n => {
        insNom.run(n.id, n.category_id, n.name, n.detail, n.base_votes || 0, n.paid_votes || 0, n.ordinal || 0);
        bumpNom.run(n.base_votes || 0, n.paid_votes || 0, n.id);
      });

      const insUser = dbRef.prepare('INSERT OR IGNORE INTO users (id, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
      (t.users || []).forEach(u => insUser.run(u.id, u.name, u.phone, u.password_hash, u.created_at));

      const insTx = dbRef.prepare(`INSERT OR IGNORE INTO transactions
        (id, checkout_id, user_id, device_id, nominee_id, phone, amount, votes, status, mpesa_receipt, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      (t.transactions || []).forEach(x => insTx.run(
        x.id, x.checkout_id, x.user_id, x.device_id, x.nominee_id, x.phone,
        x.amount, x.votes, x.status, x.mpesa_receipt, x.created_at, x.completed_at
      ));

      const insDv = dbRef.prepare('INSERT OR IGNORE INTO device_votes (device_id, category_id, nominee_id, created_at) VALUES (?, ?, ?, ?)');
      (t.device_votes || []).forEach(d => insDv.run(d.device_id, d.category_id, d.nominee_id, d.created_at));

      // Settings: never overwrite seed_version; other keys only fill gaps.
      const insSet = dbRef.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      (t.settings || []).forEach(s => { if (s.key !== 'seed_version') insSet.run(s.key, s.value); });

      // Vote floor: strictly monotonic MAX merge.
      const getFloor = dbRef.prepare('SELECT base FROM vote_baseline WHERE nominee_id = ?');
      const upFloor = dbRef.prepare(`INSERT INTO vote_baseline (nominee_id, base, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(nominee_id) DO UPDATE SET base = MAX(vote_baseline.base, excluded.base), updated_at = excluded.updated_at`);
      (t.vote_baseline || []).forEach(v => {
        const cur = getFloor.get(v.nominee_id);
        upFloor.run(v.nominee_id, Math.max(v.base || 0, (cur && cur.base) || 0), v.updated_at || Date.now());
      });
    });
    run();
  } finally {
    dbRef.pragma('foreign_keys = ON');
  }
}

async function fetchLatestSnapshot() {
  const r = await pool.query(`SELECT value FROM ${TABLE} WHERE key = 'latest'`);
  if (!r.rows.length) return null;
  const v = r.rows[0].value;
  return (v && v.tables) ? v : null;
}

async function restoreIfLost() {
  const snap = await fetchLatestSnapshot();
  if (!snap) return false;
  const backupHasData = (snap.tables.transactions || []).length > 0 || (snap.tables.users || []).length > 0;
  if (!localDataLost(backupHasData)) return false;
  applySnapshot(snap.tables);
  console.log('[neon] local data loss detected — restored latest backup from Neon.');
  return true;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const restored = await restoreIfLost();
    if (!restored) await exportNow();
  } catch (e) {
    console.warn('[neon] sync tick failed (will retry in 3 min):', e.message);
  } finally {
    ticking = false;
  }
}

async function init(db) {
  dbRef = db;
  const url = process.env.DATABASE_URL;
  if (!Pool || !url) {
    if (!url) console.warn('[neon] DATABASE_URL not set — Neon backup disabled. Set it in your environment.');
    return;
  }
  try {
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
    await ensureTable();
    // On boot: if the local DB was wiped, immediately pull the backup back.
    await restoreIfLost();
    // Then keep exporting every 3 minutes (and re-checking for data loss).
    setInterval(tick, EXPORT_INTERVAL_MS);
    // Export once shortly after boot so a fresh deploy seeds Neon quickly.
    setTimeout(() => { tick().catch(() => {}); }, 5000);
    console.log('[neon] connected — backup every 3 min, auto-restore on data loss.');
  } catch (e) {
    console.warn('[neon] initial connection failed (will keep retrying every 3 min):', e.message);
    // Keep the interval alive even if the first connect failed.
    setInterval(tick, EXPORT_INTERVAL_MS);
  }
}

module.exports = { init };
