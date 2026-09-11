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
    ['Lavoofoxy.', ''],
    ['Saint_millan', ''],
    ['who.ismishy', ''],
    ['I.t.s.f.a.b.i.a.n_', ''],
    ['Mr_mombasa', ''],
    ['anyango__', ''],
    ['darius.mboya', ''],
    ['O.yugi._', ''],
    ['j__zilster', ''],
    ['I_am_kamasho', ''],
    ['Lavoofoxy', ''],
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
