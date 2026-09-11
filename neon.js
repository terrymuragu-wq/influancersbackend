// neon.js — Neon PostgreSQL mirror for the Creatives Award 2026 backend
//
// The live backend keeps using its local SQLite store (better-sqlite3) so the
// entire voting / STK-push flow stays byte-for-byte identical. Neon Postgres is
// used as a resilient MIRROR:
//   1. on boot (and every 15 min) the SQLite store is dumped into Neon;
//   2. if the local DB was wiped and re-seeded (Render free-tier cold start),
//      the store is restored from the latest Neon backup automatically;
//   3. admin data (votes, transactions, users, settings) therefore never gets
//      permanently lost — it is restored to the admin panel automatically.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';
const BACKUP_INTERVAL_MS = 15 * 60 * 1000;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

let backupTimer = null;
let sqliteDb = null;   // reference to the local store, set once init succeeds
let enabled = false;   // true only when DATABASE_URL is configured and reachable

// Safe fire-and-forget wrapper used by server.js after every confirmed vote /
// admin adjustment, so the mirror is near real-time (no 15-min wait).
async function backupNow() {
  if (!enabled || !sqliteDb) return;
  await pushBackup(sqliteDb);
}

// ---- Mirror table (idempotent) ----
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS neon_mirror (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    )`);
}

// ---- Snapshot the whole SQLite store ----
function dump(db) {
  const all = (sql) => db.prepare(sql).all();
  return {
    ts: Date.now(),
    categories: all('SELECT * FROM categories'),
    nominees: all('SELECT * FROM nominees'),
    users: all('SELECT * FROM users'),
    transactions: all('SELECT * FROM transactions'),
    device_votes: all('SELECT * FROM device_votes'),
    settings: all('SELECT * FROM settings'),
    vote_baseline: all('SELECT * FROM vote_baseline'),
  };
}

async function pushBackup(db) {
  const data = JSON.stringify(dump(db));
  await pool.query(
    `INSERT INTO neon_mirror (key, data, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    ['full_backup', data, Date.now()]
  );
}

async function readBackup() {
  const r = await pool.query(
    `SELECT data, updated_at FROM neon_mirror WHERE key = $1 ORDER BY updated_at DESC LIMIT 1`,
    ['full_backup']
  );
  if (!r.rows.length) return null;
  return JSON.parse(r.rows[0].data);
}

// ---- Apply a backup onto a freshly seeded (empty) store ----
function restore(db, data) {
  if (!data || !Array.isArray(data.nominees) || data.nominees.length === 0) return false;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM device_votes').run();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM vote_baseline').run();
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM nominees').run();
    db.prepare('DELETE FROM categories').run();

    const insCat = db.prepare('INSERT INTO categories (id, title, ordinal) VALUES (?, ?, ?)');
    (data.categories || []).forEach(c => insCat.run(c.id, c.title, c.ordinal || 0));

    const insNom = db.prepare('INSERT INTO nominees (id, category_id, name, detail, base_votes, paid_votes, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)');
    (data.nominees || []).forEach(n => insNom.run(n.id, n.category_id, n.name, n.detail || '', n.base_votes || 0, n.paid_votes || 0, n.ordinal || 0));

    const insU = db.prepare('INSERT INTO users (id, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
    (data.users || []).forEach(u => insU.run(u.id, u.name, u.phone, u.password_hash, u.created_at));

    const insT = db.prepare('INSERT INTO transactions (id, checkout_id, user_id, device_id, nominee_id, phone, amount, votes, status, mpesa_receipt, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    (data.transactions || []).forEach(t => insT.run(t.id, t.checkout_id, t.user_id, t.device_id, t.nominee_id, t.phone, t.amount, t.votes, t.status, t.mpesa_receipt, t.created_at, t.completed_at));

    const insD = db.prepare('INSERT OR IGNORE INTO device_votes (device_id, category_id, nominee_id, created_at) VALUES (?, ?, ?, ?)');
    (data.device_votes || []).forEach(d => insD.run(d.device_id, d.category_id, d.nominee_id, d.created_at));

    const insS = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    (data.settings || []).forEach(s => insS.run(s.key, s.value));

    const insV = db.prepare('INSERT OR REPLACE INTO vote_baseline (nominee_id, base, updated_at) VALUES (?, ?, ?)');
    (data.vote_baseline || []).forEach(v => insV.run(v.nominee_id, v.base, v.updated_at));
  });
  tx();
  return true;
}

async function init(db, opts = {}) {
  if (!DATABASE_URL) return;
  try {
    await pool.query('SELECT 1');
    await initTables();
    sqliteDb = db;
    enabled = true;

    if (opts.freshSeed) {
      const backup = await readBackup();
      if (backup && restore(db, backup)) {
        console.log(`[neon] Restored ${backup.nominees.length} nominees from Neon backup (${new Date(backup.ts).toISOString()}).`);
        // Re-apply the countdown default only if the backup had none.
        const cd = db.prepare("SELECT value FROM settings WHERE key = 'countdown_end'").get();
        if (!cd) {
          const days = parseInt(process.env.COUNTDOWN_DAYS || '20', 10);
          db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('countdown_end', ?)")
            .run(String(Date.now() + days * 24 * 60 * 60 * 1000));
        }
      } else {
        console.log('[neon] No usable backup found — keeping fresh seed.');
      }
    }

    // Always push the current store up right after boot.
    await pushBackup(db);
    console.log('[neon] Backup pushed to Neon PostgreSQL.');

    // Periodic backup so recent transactions survive a wipe.
    backupTimer = setInterval(() => {
      pushBackup(db).catch(e => console.error('[neon] periodic backup failed:', e.message));
    }, BACKUP_INTERVAL_MS);
    if (backupTimer.unref) backupTimer.unref();
  } catch (e) {
    console.error('[neon] Neon mirror unavailable — continuing on local store only:', e.message);
  }
}

process.on('SIGTERM', () => { if (backupTimer) clearInterval(backupTimer); });
process.on('SIGINT', () => { if (backupTimer) clearInterval(backupTimer); });

module.exports = { init, backupNow, pushBackup, readBackup, restore, pool, enabled };
