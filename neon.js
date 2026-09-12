// neon.js — Neon PostgreSQL mirror for the Creatives Award 2026 backend
//
// The live backend keeps using its local SQLite store (better-sqlite3) so the
// entire voting / STK-push flow stays byte-for-byte identical. Neon Postgres is
// used as a resilient MIRROR:
//   1. on boot (and every 5 min) the SQLite store is dumped into Neon;
//   2. every 2 min the latest Neon backup is reconciled back INTO the local
//      store (monotonic merge — numbers only ever go UP, nothing is deleted),
//      so the admin panel keeps reflecting the database continuously;
//   3. if the local DB was wiped and re-seeded (Render free-tier cold start /
//      re-deploy), the full store is restored from the latest Neon backup
//      automatically on boot;
//   4. admin data (votes, transactions, users, settings) therefore never gets
//      permanently lost — it is restored to the admin panel automatically
//      after every deploy.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;   // DB -> admin/Neon export every 5 minutes
const RESTORE_INTERVAL_MS = 2 * 60 * 1000;  // Neon -> DB restore/reconcile every 2 minutes

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

let backupTimer = null;
let restoreTimer = null;
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

// ---- Monotonic reconcile: merge a Neon backup INTO the live local store ----
// SAFETY RULES (never violated):
//   * a nominee's base_votes / paid_votes can only be RAISED, never lowered;
//   * vote_baseline floors can only be RAISED (MAX merge);
//   * transactions are only INSERTED when missing locally — never overwritten;
//   * the countdown end can only move FORWARD, never backward;
//   * categories/nominees/users rows are only inserted if missing locally;
//   * NOTHING is ever deleted here.
// This runs every 2 minutes so that after any deploy/restart the admin panel
// always converges back to the true backed-up figures, even mid-session.
function reconcile(db, data) {
  if (!data || typeof data !== 'object') return false;
  let changed = false;
  const now = Date.now();
  const tx = db.transaction(() => {
    // Categories / nominees / users: insert any rows that exist in the backup
    // but are missing locally (e.g. added by admin right before a wipe).
    const insCat = db.prepare('INSERT OR IGNORE INTO categories (id, title, ordinal) VALUES (?, ?, ?)');
    (data.categories || []).forEach(c => insCat.run(c.id, c.title, c.ordinal || 0));

    const getNom = db.prepare('SELECT base_votes, paid_votes FROM nominees WHERE id = ?');
    const insNom = db.prepare('INSERT OR IGNORE INTO nominees (id, category_id, name, detail, base_votes, paid_votes, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const updNom = db.prepare('UPDATE nominees SET base_votes = ?, paid_votes = ? WHERE id = ?');
    (data.nominees || []).forEach(n => {
      const local = getNom.get(n.id);
      if (!local) {
        const info = insNom.run(n.id, n.category_id, n.name, n.detail || '', n.base_votes || 0, n.paid_votes || 0, n.ordinal || 0);
        if (info.changes > 0) changed = true;
        return;
      }
      const nb = Math.max(local.base_votes || 0, n.base_votes || 0);
      const np = Math.max(local.paid_votes || 0, n.paid_votes || 0);
      if (nb !== local.base_votes || np !== local.paid_votes) { updNom.run(nb, np, n.id); changed = true; }
    });

    const insU = db.prepare('INSERT OR IGNORE INTO users (id, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
    (data.users || []).forEach(u => { if (insU.run(u.id, u.name, u.phone, u.password_hash, u.created_at).changes > 0) changed = true; });

    // Transactions: insert missing ones only. Their votes are already covered
    // by the MAX-merge on paid_votes above, so no double counting.
    const insT = db.prepare('INSERT OR IGNORE INTO transactions (id, checkout_id, user_id, device_id, nominee_id, phone, amount, votes, status, mpesa_receipt, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    (data.transactions || []).forEach(t => {
      if (insT.run(t.id, t.checkout_id, t.user_id, t.device_id, t.nominee_id, t.phone, t.amount, t.votes, t.status, t.mpesa_receipt, t.created_at, t.completed_at).changes > 0) changed = true;
    });

    // Vote baseline floors: MAX merge only.
    const getBase = db.prepare('SELECT base FROM vote_baseline WHERE nominee_id = ?');
    const upBase = db.prepare(`INSERT INTO vote_baseline (nominee_id, base, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(nominee_id) DO UPDATE SET base = MAX(vote_baseline.base, excluded.base), updated_at = excluded.updated_at`);
    (data.vote_baseline || []).forEach(v => {
      const local = getBase.get(v.nominee_id);
      if (!local || (v.base || 0) > (local.base || 0)) { upBase.run(v.nominee_id, v.base || 0, now); changed = true; }
    });

    // Settings: countdown end only ever moves FORWARD; other keys fill in if missing.
    const getSet = db.prepare('SELECT value FROM settings WHERE key = ?');
    const putSet = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    (data.settings || []).forEach(s => {
      if (!s || !s.key) return;
      const local = getSet.get(s.key);
      if (s.key === 'countdown_end') {
        const incoming = parseInt(s.value, 10) || 0;
        const cur = local ? (parseInt(local.value, 10) || 0) : 0;
        if (incoming > cur) { putSet.run(s.key, String(incoming)); changed = true; }
      } else if (!local) {
        putSet.run(s.key, s.value); changed = true;
      }
    });
  });
  tx();
  return changed;
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
      // Heal the catalogue after any restore so a stale backup can never
      // resurrect old/duplicate/misspelled nominee rows.
      if (typeof db.canonicaliseCatalogue === 'function') db.canonicaliseCatalogue();
    }

    // Always push the current store up right after boot.
    await pushBackup(db);
    console.log('[neon] Backup pushed to Neon PostgreSQL.');

    // Periodic backup every 5 minutes so recent transactions survive a wipe.
    backupTimer = setInterval(() => {
      pushBackup(db).catch(e => console.error('[neon] periodic backup failed:', e.message));
    }, BACKUP_INTERVAL_MS);
    if (backupTimer.unref) backupTimer.unref();

    // Periodic restore/reconcile every 2 minutes: pull the latest Neon backup
    // and monotonically merge it into the live store, so the admin panel and
    // the public site always converge back to the backed-up figures (this is
    // what guarantees data is restored to the admin after every deploy).
    restoreTimer = setInterval(() => {
      readBackup()
        .then(backup => {
          if (backup && reconcile(db, backup)) {
            if (typeof db.canonicaliseCatalogue === 'function') db.canonicaliseCatalogue();
            console.log('[neon] Reconciled newer data from Neon backup into local store.');
          }
        })
        .catch(e => console.error('[neon] periodic restore failed:', e.message));
    }, RESTORE_INTERVAL_MS);
    if (restoreTimer.unref) restoreTimer.unref();
  } catch (e) {
    console.error('[neon] Neon mirror unavailable — continuing on local store only:', e.message);
  }
}

process.on('SIGTERM', () => { if (backupTimer) clearInterval(backupTimer); if (restoreTimer) clearInterval(restoreTimer); });
process.on('SIGINT', () => { if (backupTimer) clearInterval(backupTimer); if (restoreTimer) clearInterval(restoreTimer); });

module.exports = { init, backupNow, pushBackup, readBackup, restore, reconcile, pool, enabled };
