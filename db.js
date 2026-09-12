// db.js — SQLite persistence layer
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'mella.db');
// Ensure directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---- Schema ----
db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nominees (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT,
  base_votes INTEGER DEFAULT 0,
  paid_votes INTEGER DEFAULT 0,
  ordinal INTEGER DEFAULT 0,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  checkout_id TEXT UNIQUE,
  user_id TEXT,
  device_id TEXT,
  nominee_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  amount INTEGER NOT NULL,
  votes INTEGER NOT NULL,
  status TEXT NOT NULL,        -- pending | success | failed
  mpesa_receipt TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (nominee_id) REFERENCES nominees(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS device_votes (
  device_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  nominee_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, category_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Resilience floor: the frontend pushes the highest vote total it has ever
-- seen for each nominee. The backend keeps MAX(existing, incoming) forever.
-- On free-tier Render (no persistent disk), if the DB is wiped on cold-start,
-- the very first browser that reconnects re-teaches the backend the floor,
-- so vote totals NEVER go backwards for any visitor.
CREATE TABLE IF NOT EXISTS vote_baseline (
  nominee_id TEXT PRIMARY KEY,
  base INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_nom_cat ON nominees(category_id);
`);

// ---- Lightweight migration for older DBs that already have `transactions` without device_id ----
try {
  const cols = db.prepare(`PRAGMA table_info(transactions)`).all();
  if (!cols.some(c => c.name === 'device_id')) {
    db.exec(`ALTER TABLE transactions ADD COLUMN device_id TEXT`);
  }
} catch (e) { /* ignore */ }

// ---- Migration: device_votes now keyed by (device_id, category_id) so a device can vote once PER CATEGORY ----
try {
  const dvCols = db.prepare(`PRAGMA table_info(device_votes)`).all();
  const hasCategory = dvCols.some(c => c.name === 'category_id');
  if (dvCols.length > 0 && !hasCategory) {
    // Old schema had device_id as PRIMARY KEY. Rebuild the table.
    db.exec(`
      BEGIN;
      CREATE TABLE device_votes_new (
        device_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        nominee_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, category_id)
      );
      INSERT INTO device_votes_new (device_id, category_id, nominee_id, created_at)
        SELECT dv.device_id,
               COALESCE(n.category_id, 'legacy') AS category_id,
               dv.nominee_id,
               dv.created_at
        FROM device_votes dv
        LEFT JOIN nominees n ON n.id = dv.nominee_id;
      DROP TABLE device_votes;
      ALTER TABLE device_votes_new RENAME TO device_votes;
      COMMIT;
    `);
    console.log('[db] Migrated device_votes to per-category schema.');
  }
} catch (e) { console.error('[db] device_votes migration error:', e); }

// ---- Seed data (Creatives Award 2026 — Influencers of the Year) ----
const SEED_VERSION = 'v1-2026-creatives-award';

const seedCategories = [
  { id: 'influencers-of-the-year', title: 'Influencers of the Year', nominees: [
    
    ['Saint_millan', ''],
    ['who.ismishy', ''],
    ['I.t.s.f.a.b.i.a.n_', ''],
    ['Mr_mombasa', ''],
    ['Lavoofoxy', ''],
    ['anyango__', ''],
    ['darius.mboya', ''],
    ['O.yugi._', ''],
    ['___j__zilster___', ''],
    ['I_am_kamasho', ''],
    
  ]},
];

const { v4: uuid } = require('uuid');
const crypto = require('crypto');

// Deterministic nominee id: same category+name always produces the same id,
// even after a full DB wipe on Render free-tier cold-start. This is what lets
// the frontend's persisted vote floor (keyed by nominee id) re-attach itself
// after the backend loses its SQLite file. Without this, a wipe would rename
// every nominee and the floor would go orphan.
function deterministicNomineeId(categoryId, name) {
  const h = crypto.createHash('sha1').update('creatives-nominee|' + categoryId + '|' + name).digest('hex');
  // Format the sha1 hex as a UUID-shaped string for backwards compatibility
  // with any previously-generated ids from the current live DB.
  return (
    h.slice(0, 8) + '-' +
    h.slice(8, 12) + '-' +
    h.slice(12, 16) + '-' +
    h.slice(16, 20) + '-' +
    h.slice(20, 32)
  );
}

function seedAll() {
  const insertCat = db.prepare('INSERT INTO categories (id, title, ordinal) VALUES (?, ?, ?)');
  const insertNom = db.prepare('INSERT INTO nominees (id, category_id, name, detail, ordinal) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction(() => {
    seedCategories.forEach((cat, ci) => {
      insertCat.run(cat.id, cat.title, ci + 1);
      cat.nominees.forEach((n, ni) => {
        insertNom.run(deterministicNomineeId(cat.id, n[0]), cat.id, n[0], n[1] || '', ni + 1);
      });
    });
  });
  tx();
}

const catCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
const wasFreshSeed = catCount === 0;
const seedRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('seed_version');
const currentSeed = seedRow ? seedRow.value : null;

if (catCount === 0) {
  seedAll();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('seed_version', SEED_VERSION);
  console.log('[db] Seeded Creatives Award 2026 categories and nominees.');
} else if (currentSeed !== SEED_VERSION) {
  // Existing DB from an older seed — replace category/nominee catalogue but keep votes/transactions history intact.
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM nominees').run();
    db.prepare('DELETE FROM categories').run();
  });
  wipe();
  seedAll();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('seed_version', SEED_VERSION);
  console.log('[db] Re-seeded categories/nominees to ' + SEED_VERSION);
}

// ============================================================
//  Catalogue healer — guarantees the Influencers of the Year
//  category ALWAYS contains exactly the 10 official nominees,
//  with stable deterministic ids, exact spelling, and every
//  historical vote / transaction / floor carried over.
//  Runs on every boot and after every Neon restore/reconcile,
//  so stale backups can never resurrect old/duplicate rows
//  (this was the root cause of names disappearing/reappearing).
// ============================================================
const CANONICAL_CATEGORY_ID = 'influencers-of-the-year';
const CANONICAL_ROSTER = [
  { name: 'Saint_millan',       aliases: [] },
  { name: 'who.ismishy',        aliases: [] },
  { name: 'I.t.s.f.a.b.i.a.n_', aliases: [] },
  { name: 'Mr_mombasa',         aliases: [] },
  { name: 'Lavoofoxy',          aliases: ['Lavoofoxy.'] },
  { name: 'anyango__',          aliases: [] },
  { name: 'darius.mboya',       aliases: [] },
  { name: 'O.yugi._',           aliases: [] },
  { name: '___j__zilster___',   aliases: ['j__zilster', '_j__zilster_', '__j__zilster__'] },
  { name: 'I_am_kamasho',       aliases: [] },
];

function canonicaliseCatalogue() {
  try {
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(CANONICAL_CATEGORY_ID);
    if (!cat) return false;
    let changed = false;
    const upsertFloor = db.prepare(`
      INSERT INTO vote_baseline (nominee_id, base, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(nominee_id) DO UPDATE SET
        base = MAX(vote_baseline.base, excluded.base),
        updated_at = excluded.updated_at
    `);
    const tx = db.transaction(() => {
      CANONICAL_ROSTER.forEach((entry, idx) => {
        const canonId = deterministicNomineeId(CANONICAL_CATEGORY_ID, entry.name);
        const names = [entry.name, ...entry.aliases];
        const rows = db.prepare(
          `SELECT * FROM nominees WHERE category_id = ? AND name IN (${names.map(() => '?').join(',')})`
        ).all(CANONICAL_CATEGORY_ID, ...names);

        let base = 0, paid = 0, detail = '';
        rows.forEach(r => {
          base = Math.max(base, r.base_votes || 0);
          paid = Math.max(paid, r.paid_votes || 0);
          if (!detail && r.detail) detail = r.detail;
        });

        const canonRow = rows.find(r => r.id === canonId);
        if (!canonRow) {
          db.prepare('INSERT INTO nominees (id, category_id, name, detail, base_votes, paid_votes, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(canonId, CANONICAL_CATEGORY_ID, entry.name, detail, base, paid, idx + 1);
          changed = true;
        } else if (canonRow.name !== entry.name || (canonRow.base_votes || 0) !== base || (canonRow.paid_votes || 0) !== paid || canonRow.ordinal !== idx + 1) {
          db.prepare("UPDATE nominees SET name = ?, detail = COALESCE(NULLIF(detail, ''), ?), base_votes = ?, paid_votes = ?, ordinal = ? WHERE id = ?")
            .run(entry.name, detail, base, paid, idx + 1, canonId);
          changed = true;
        }

        // Fold every legacy/alias row into the canonical one: re-point its
        // transactions, carry over its vote floor, then remove the row.
        rows.forEach(r => {
          if (r.id === canonId) return;
          db.prepare('UPDATE transactions SET nominee_id = ? WHERE nominee_id = ?').run(canonId, r.id);
          db.prepare('DELETE FROM device_votes WHERE nominee_id = ?').run(r.id);
          const lb = db.prepare('SELECT base FROM vote_baseline WHERE nominee_id = ?').get(r.id);
          if (lb) upsertFloor.run(canonId, lb.base, Date.now());
          db.prepare('DELETE FROM vote_baseline WHERE nominee_id = ?').run(r.id);
          db.prepare('DELETE FROM nominees WHERE id = ?').run(r.id);
          changed = true;
        });
      });

      // Remove any row in this category that is NOT one of the official 10
      // (stale rows re-inserted by old Neon backups). Rows that still have
      // payment transactions attached are kept so history is never lost.
      const canonIds = CANONICAL_ROSTER.map(e => deterministicNomineeId(CANONICAL_CATEGORY_ID, e.name));
      const placeholders = canonIds.map(() => '?').join(',');
      const strays = db.prepare(`SELECT id FROM nominees WHERE category_id = ? AND id NOT IN (${placeholders})`).all(CANONICAL_CATEGORY_ID, ...canonIds);
      strays.forEach(r => {
        const txCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE nominee_id = ?').get(r.id).n;
        if (txCount === 0) {
          db.prepare('DELETE FROM device_votes WHERE nominee_id = ?').run(r.id);
          db.prepare('DELETE FROM vote_baseline WHERE nominee_id = ?').run(r.id);
          db.prepare('DELETE FROM nominees WHERE id = ?').run(r.id);
          changed = true;
        }
      });

      // Drop orphaned floors pointing at nominees that no longer exist.
      db.prepare('DELETE FROM vote_baseline WHERE nominee_id NOT IN (SELECT id FROM nominees)').run();
    });
    tx();
    if (changed) console.log('[db] Catalogue canonicalised — exact 10-nominee roster enforced.');
    return changed;
  } catch (e) {
    console.error('[db] canonicaliseCatalogue error:', e.message);
    return false;
  }
}

// ---- Snapshot auto-restore (snapshot.json shipped with the code) ----
// Applies the organiser-provided data snapshot exactly once (keyed by content
// hash) using monotonic merge rules: votes/floors only rise, transactions are
// only added when missing, and the countdown only moves forward.
function applySnapshotFile() {
  try {
    const snapPath = path.join(__dirname, 'snapshot.json');
    if (!fs.existsSync(snapPath)) return;
    const data = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    if (!data || !Array.isArray(data.nominees)) return;
    const hash = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
    const key = 'snapshot_applied_' + hash;
    if (db.prepare('SELECT value FROM settings WHERE key = ?').get(key)) return;
    const now = Date.now();
    const tx = db.transaction(() => {
      const insCat = db.prepare('INSERT OR IGNORE INTO categories (id, title, ordinal) VALUES (?, ?, ?)');
      (data.categories || []).forEach(c => insCat.run(c.id, c.title, c.ordinal || 0));

      const getNom = db.prepare('SELECT base_votes, paid_votes FROM nominees WHERE id = ?');
      const insNom = db.prepare('INSERT OR IGNORE INTO nominees (id, category_id, name, detail, base_votes, paid_votes, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const updNom = db.prepare('UPDATE nominees SET base_votes = ?, paid_votes = ? WHERE id = ?');
      (data.nominees || []).forEach(n => {
        const local = getNom.get(n.id);
        if (!local) { insNom.run(n.id, n.category_id, n.name, n.detail || '', n.base_votes || 0, n.paid_votes || 0, n.ordinal || 0); return; }
        const nb = Math.max(local.base_votes || 0, n.base_votes || 0);
        const np = Math.max(local.paid_votes || 0, n.paid_votes || 0);
        if (nb !== local.base_votes || np !== local.paid_votes) updNom.run(nb, np, n.id);
      });

      const insU = db.prepare('INSERT OR IGNORE INTO users (id, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
      (data.users || []).forEach(u => insU.run(u.id, u.name, u.phone, u.password_hash, u.created_at));

      const insT = db.prepare('INSERT OR IGNORE INTO transactions (id, checkout_id, user_id, device_id, nominee_id, phone, amount, votes, status, mpesa_receipt, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      (data.transactions || []).forEach(t => insT.run(t.id, t.checkout_id, t.user_id, t.device_id, t.nominee_id, t.phone, t.amount, t.votes, t.status, t.mpesa_receipt, t.created_at, t.completed_at));

      const insD = db.prepare('INSERT OR IGNORE INTO device_votes (device_id, category_id, nominee_id, created_at) VALUES (?, ?, ?, ?)');
      (data.device_votes || []).forEach(d => insD.run(d.device_id, d.category_id, d.nominee_id, d.created_at));

      const upBase = db.prepare(`INSERT INTO vote_baseline (nominee_id, base, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(nominee_id) DO UPDATE SET base = MAX(vote_baseline.base, excluded.base), updated_at = excluded.updated_at`);
      (data.vote_baseline || []).forEach(v => upBase.run(v.nominee_id, v.base || 0, now));

      (data.settings || []).forEach(s => {
        if (!s || !s.key) return;
        if (s.key === 'countdown_end') {
          const cur = db.prepare('SELECT value FROM settings WHERE key = ?').get('countdown_end');
          const incoming = parseInt(s.value, 10) || 0;
          if (incoming > (cur ? (parseInt(cur.value, 10) || 0) : 0)) {
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(s.key, String(incoming));
          }
        }
      });

      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(now));
    });
    tx();
    console.log('[db] snapshot.json applied (monotonic merge).');
  } catch (e) {
    console.error('[db] snapshot apply failed:', e.message);
  }
}

applySnapshotFile();
canonicaliseCatalogue();

// Countdown init
const cdRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('countdown_end');
if (!cdRow) {
  const days = parseInt(process.env.COUNTDOWN_DAYS || '20', 10);
  const end = Date.now() + days * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('countdown_end', String(end));
}

// ---- Neon PostgreSQL mirror (optional) ----
// When DATABASE_URL is set, the SQLite store is mirrored to Neon Postgres and
// automatically restored if the local DB is wiped/re-seeded (e.g. Render cold
// start). Votes, transactions, users and settings all survive data loss.
if (process.env.DATABASE_URL) {
  const neon = require('./neon');
  neon.init(db, { freshSeed: wasFreshSeed }).catch(e => {
    console.error('[neon] init error:', e.message);
  });
}

module.exports = db;
module.exports.canonicaliseCatalogue = canonicaliseCatalogue;
module.exports.applySnapshotFile = applySnapshotFile;
