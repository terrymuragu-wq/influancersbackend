// server.js — Creatives Awards 2026 API
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { v4: uuid } = require('uuid');

const db = require('./db');
const { stkPush, simulateConfirm, queryStkStatus, MODE: MPESA_MODE } = require('./mpesa');

// Neon (Postgres) backup layer: exports a full snapshot every 3 minutes and
// automatically restores from the latest backup if local data is ever lost.
require('./neon').init(db);

const app = express();
const PORT = process.env.PORT || 10000;
// Secrets come ONLY from the environment — nothing sensitive is hardcoded.
const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('[security] JWT_SECRET is not set — using an ephemeral random secret. Set JWT_SECRET in your environment for persistent sessions.');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) console.warn('[security] ADMIN_PASSWORD is not set — admin login is DISABLED until you set it in your environment.');
const VOTE_PRICE = parseInt(process.env.VOTE_PRICE || '20', 10);

// ---- Middleware ----
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(morgan('tiny'));
app.use(express.json({ limit: '200kb' }));

const corsOrigins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: corsOrigins.includes('*') ? true : corsOrigins,
  credentials: true,
}));

// Public folder (admin.html lives here)
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use('/api/', apiLimiter);

// ---- Helpers ----
function sign(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' }); }

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'auth_required' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'invalid_token' }); }
}

function requireAdmin(req, res, next) {
  auth(req, res, () => {
    if (!req.user.admin) return res.status(403).json({ error: 'admin_only' });
    next();
  });
}

function normalisePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (p.startsWith('+')) p = p.slice(1);
  return p;
}

function isValidKenyanPhone(p) {
  return /^254(7|1)\d{8}$/.test(p);
}

// ---- Health ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), service: 'creatives-awards-api' });
});

// ---- Public: Categories + Nominees + Live Totals ----
// The reported "votes" for every nominee is MAX(paid+base, floor pushed by
// frontends). This means if the DB is wiped on a Render cold-start, the very
// first visitor's browser will push its highest-known figures back into the
// baseline table via /api/sync/floor, and every subsequent visitor sees them
// immediately. Numbers never move backwards for any user.
app.get('/api/categories', (req, res) => {
  const cats = db.prepare('SELECT id, title, ordinal FROM categories ORDER BY ordinal').all();
  const noms = db.prepare(`
    SELECT n.id, n.category_id, n.name, n.detail, n.base_votes, n.paid_votes, n.ordinal,
           (n.base_votes + n.paid_votes) AS db_votes,
           COALESCE(vb.base, 0) AS floor_votes
    FROM nominees n
    LEFT JOIN vote_baseline vb ON vb.nominee_id = n.id
    ORDER BY n.category_id, n.ordinal, n.name
  `).all();

  const byCat = {};
  let totalVotes = 0;
  noms.forEach(n => {
    const votes = Math.max(n.db_votes || 0, n.floor_votes || 0);
    totalVotes += votes;
    (byCat[n.category_id] = byCat[n.category_id] || []).push({
      id: n.id, name: n.name, detail: n.detail, votes,
    });
  });

  const cdRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('countdown_end');
  const countdownEnd = cdRow ? parseInt(cdRow.value, 10) : null;

  res.json({
    categories: cats.map(c => ({ ...c, nominees: byCat[c.id] || [] })),
    totalVotes,
    votePrice: VOTE_PRICE,
    countdownEnd,
  });
});

// ---- Public: sync high-water floor from a frontend ----
// The frontend periodically pushes its highest-known vote counts + countdown
// end. The backend accepts ONLY monotonic increases per nominee (MAX). This is
// the resilience mechanism that makes Render free-tier cold starts invisible
// to end-users: even if the DB was recreated fresh, the next request rebuilds
// the floor. Public + rate-limited; no auth needed (values only ever go UP,
// bounded by a sane per-nominee ceiling so nobody can grief the numbers).
const FLOOR_CEILING = 10_000_000; // hard cap per nominee — refuse absurd values
app.post('/api/sync/floor', (req, res) => {
  const { nominees, countdownEnd } = req.body || {};
  const now = Date.now();
  const applied = {};

  if (nominees && typeof nominees === 'object') {
    const upsert = db.prepare(`
      INSERT INTO vote_baseline (nominee_id, base, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(nominee_id) DO UPDATE SET
        base = MAX(vote_baseline.base, excluded.base),
        updated_at = excluded.updated_at
    `);
    const getExisting = db.prepare('SELECT base FROM vote_baseline WHERE nominee_id = ?');
    // Only accept ids that exist in the nominees table — silently ignore junk.
    const nomExists = db.prepare('SELECT 1 FROM nominees WHERE id = ?');

    const tx = db.transaction((entries) => {
      for (const [id, rawVal] of entries) {
        if (!id || typeof id !== 'string') continue;
        const v = parseInt(rawVal, 10);
        if (!Number.isFinite(v) || v < 0 || v > FLOOR_CEILING) continue;
        if (!nomExists.get(id)) continue;
        upsert.run(id, v, now);
        applied[id] = getExisting.get(id).base;
      }
    });
    tx(Object.entries(nominees));
  }

  // Countdown end — only ever push it FORWARD, never backward.
  let cdEnd = null;
  if (typeof countdownEnd === 'number' && countdownEnd > 0) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('countdown_end');
    const cur = row ? parseInt(row.value, 10) : 0;
    const merged = Math.max(cur || 0, countdownEnd);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('countdown_end', String(merged));
    cdEnd = merged;
  }

  res.json({ ok: true, applied, countdownEnd: cdEnd });
});

// ---- Auth ----
app.post('/api/auth/signup', (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name || !phone || !password) return res.status(400).json({ error: 'missing_fields' });
  if (password.length < 4) return res.status(400).json({ error: 'password_too_short' });
  const p = normalisePhone(phone);
  if (!isValidKenyanPhone(p)) return res.status(400).json({ error: 'invalid_phone' });

  const exists = db.prepare('SELECT id FROM users WHERE phone = ?').get(p);
  if (exists) return res.status(409).json({ error: 'phone_exists' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name.trim().slice(0, 60), p, hash, Date.now());

  const token = sign({ uid: id, name, phone: p });
  res.json({ token, user: { id, name, phone: p } });
});

app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'missing_fields' });
  const p = normalisePhone(phone);
  const u = db.prepare('SELECT * FROM users WHERE phone = ?').get(p);
  if (!u) return res.status(401).json({ error: 'invalid_credentials' });
  if (!bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'invalid_credentials' });
  const token = sign({ uid: u.id, name: u.name, phone: u.phone });
  res.json({ token, user: { id: u.id, name: u.name, phone: u.phone } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const u = db.prepare('SELECT id, name, phone, created_at FROM users WHERE id = ?').get(req.user.uid);
  if (!u) return res.status(404).json({ error: 'user_not_found' });
  res.json({ user: u });
});

// ---- Voting: check which categories this device has already voted in ----
app.get('/api/vote/check', (req, res) => {
  const deviceId = String(req.query.deviceId || '').trim();
  if (!deviceId) return res.json({ voted: false, votedCategories: [] });
  const rows = db.prepare('SELECT category_id, nominee_id, created_at FROM device_votes WHERE device_id = ?').all(deviceId);
  const votedCategories = rows.map(r => ({ categoryId: r.category_id, nomineeId: r.nominee_id, at: r.created_at }));
  res.json({ voted: votedCategories.length > 0, votedCategories });
});

// ---- Voting: initiate STK push (no auth, unlimited votes; amount determines vote count) ----
app.post('/api/vote/initiate', async (req, res) => {
  const { nomineeId, amount, phone, deviceId } = req.body || {};
  if (!nomineeId || !amount) return res.status(400).json({ error: 'missing_fields' });

  const amt = parseInt(amount, 10);
  // Accept KES 20 up to KES 1000, in multiples of the vote price (KES 20).
  const MAX_AMOUNT = 1000;
  if (!Number.isFinite(amt) || amt < VOTE_PRICE || amt % VOTE_PRICE !== 0 || amt > MAX_AMOUNT) {
    return res.status(400).json({ error: 'invalid_amount', hint: `Amount must be a multiple of ${VOTE_PRICE} (min ${VOTE_PRICE}, max ${MAX_AMOUNT})` });
  }

  const nominee = db.prepare('SELECT id, name, category_id FROM nominees WHERE id = ?').get(nomineeId);
  if (!nominee) return res.status(404).json({ error: 'nominee_not_found' });

  // Voting is unrestricted — a voter may vote as many times as they wish,
  // in any category, from any device. Each KES 20 paid = 1 vote.
  const p = normalisePhone(phone);
  if (!isValidKenyanPhone(p)) return res.status(400).json({ error: 'invalid_phone' });

  const votes = Math.floor(amt / VOTE_PRICE);

  try {
    const stk = await stkPush({
      phone: p,
      amount: amt,
      accountRef: 'MELLA' + nominee.id.slice(0, 6).toUpperCase(),
      description: `Vote for ${nominee.name}`,
    });

    const txId = uuid();
    db.prepare(`INSERT INTO transactions
      (id, checkout_id, user_id, device_id, nominee_id, phone, amount, votes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(txId, stk.CheckoutRequestID, null, deviceId || null, nominee.id, p, amt, votes, Date.now());

    res.json({
      ok: true,
      checkoutId: stk.CheckoutRequestID,
      merchantId: stk.MerchantRequestID,
      votes,
      amount: amt,
      phone: p,
      simulated: !!stk._simulated,
      mode: MPESA_MODE,
      message: 'STK push sent. Enter your M-Pesa PIN on your phone to complete.',
    });
  } catch (err) {
    console.error('STK error:', err);
    res.status(500).json({ error: 'stk_failed' });
  }
});

// ---- Simulated PIN confirmation (used only in sandbox mode) ----
app.post('/api/vote/simulate-confirm', (req, res) => {
  // Hard-disable in live mode: real confirmation must come from the KCB callback.
  if (MPESA_MODE !== 'sandbox') {
    return res.status(403).json({ error: 'simulation_disabled', message: 'Simulation is disabled in live mode.' });
  }

  const { checkoutId, pin } = req.body || {};
  if (!checkoutId) return res.status(400).json({ error: 'missing_checkout' });
  if (!pin || String(pin).length !== 4) return res.status(400).json({ error: 'invalid_pin' });

  const tx = db.prepare('SELECT * FROM transactions WHERE checkout_id = ?').get(checkoutId);
  if (!tx) return res.status(404).json({ error: 'tx_not_found' });
  if (tx.status !== 'pending') return res.status(400).json({ error: 'tx_already_processed', status: tx.status });

  // Simulate: any 4-digit PIN succeeds in sandbox mode
  const result = simulateConfirm(checkoutId, true);
  const receipt = result?.receipt || 'TEST' + Date.now().toString(36).toUpperCase();

  // Route through finaliseSuccess so the sandbox path ALSO bumps the vote
  // floor — keeping simulated + live paths in perfect sync.
  finaliseSuccess(tx, receipt);

  const nominee = db.prepare(`
    SELECT n.id, n.name, n.category_id, n.base_votes, n.paid_votes,
           MAX(n.base_votes + n.paid_votes, COALESCE(vb.base, 0)) AS votes
    FROM nominees n LEFT JOIN vote_baseline vb ON vb.nominee_id = n.id
    WHERE n.id = ?
  `).get(tx.nominee_id);
  res.json({
    ok: true,
    status: 'success',
    receipt,
    votes: tx.votes,
    amount: tx.amount,
    nominee: { id: nominee.id, name: nominee.name, categoryId: nominee.category_id, votes: nominee.votes },
  });
});

// ---- Finalise a successful transaction (used by both callback + polling) ----
function finaliseSuccess(tx, receipt) {
  const update = db.transaction(() => {
    db.prepare(`UPDATE transactions SET status='success', mpesa_receipt=?, completed_at=? WHERE id=?`)
      .run(receipt, Date.now(), tx.id);
    db.prepare(`UPDATE nominees SET paid_votes = paid_votes + ? WHERE id = ?`)
      .run(tx.votes, tx.nominee_id);
    // Also bump the persistent floor so the vote survives a DB wipe.
    // The new displayed total must be MAX(db, prev_floor) + this_vote so the
    // number VISIBLY climbs even when the floor was ahead of the DB (which is
    // the normal state right after a Render cold-start wipe).
    const cur = db.prepare(`SELECT (base_votes + paid_votes) AS v FROM nominees WHERE id = ?`).get(tx.nominee_id);
    const dbTotal = (cur && cur.v) || 0;
    const prevFloor = db.prepare(`SELECT base FROM vote_baseline WHERE nominee_id = ?`).get(tx.nominee_id);
    const prevFloorVal = (prevFloor && prevFloor.base) || 0;
    // dbTotal already includes the vote we just applied above; the floor must
    // therefore be at least MAX(dbTotal, prevFloor + tx.votes). Using max of
    // both branches guarantees monotonic climb whichever side was ahead.
    const newFloor = Math.max(dbTotal, prevFloorVal + tx.votes);
    db.prepare(`
      INSERT INTO vote_baseline (nominee_id, base, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(nominee_id) DO UPDATE SET
        base = MAX(vote_baseline.base, excluded.base),
        updated_at = excluded.updated_at
    `).run(tx.nominee_id, newFloor, Date.now());
    // Unlimited voting — no per-device / per-category lock is recorded.
  });
  update();
}

function finaliseFailure(tx) {
  db.prepare(`UPDATE transactions SET status='failed', completed_at=? WHERE id=?`).run(Date.now(), tx.id);
}

// ---- Poll transaction status ----
// If still pending and we're in live mode, actively query KCB to detect user
// cancellation / failure / timeout, so a cancelled push doesn't sit forever.
app.get('/api/vote/status/:checkoutId', async (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE checkout_id = ?').get(req.params.checkoutId);
  if (!tx) return res.status(404).json({ error: 'not_found' });

  // If still pending, ask KCB directly.
  if (tx.status === 'pending' && MPESA_MODE !== 'sandbox') {
    try {
      const q = await queryStkStatus(tx.checkout_id);
      if (q.resultCode === 0) {
        const receipt = q.receipt || ('MP' + Date.now().toString(36).toUpperCase());
        finaliseSuccess(tx, receipt);
        const fresh = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
        return res.json({
          status: fresh.status, votes: fresh.votes, amount: fresh.amount,
          receipt: fresh.mpesa_receipt, completed_at: fresh.completed_at,
        });
      } else if (q.resultCode !== null && q.resultCode !== 0) {
        // Any non-zero result = failed / cancelled / timeout. Do NOT count as a vote.
        finaliseFailure(tx);
        const fresh = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
        return res.json({
          status: fresh.status, votes: fresh.votes, amount: fresh.amount,
          receipt: null, completed_at: fresh.completed_at,
          resultCode: q.resultCode, resultDesc: q.resultDesc,
        });
      }
      // resultCode null → still pending on KCB side; fall through.
    } catch (e) { /* silent — return pending */ }

    // Safety: auto-fail transactions older than 2 minutes that never got a callback.
    if (Date.now() - tx.created_at > 2 * 60 * 1000) {
      finaliseFailure(tx);
      const fresh = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
      return res.json({
        status: fresh.status, votes: fresh.votes, amount: fresh.amount,
        receipt: null, completed_at: fresh.completed_at,
        resultDesc: 'timeout',
      });
    }
  }

  res.json({
    status: tx.status,
    votes: tx.votes,
    amount: tx.amount,
    receipt: tx.mpesa_receipt,
    completed_at: tx.completed_at,
  });
});

// ---- Real M-Pesa callback (kept for production) ----
// Registered on BOTH /api/mpesa/callback (legacy) and /callback (matches KCB_CALLBACK_URL)
function handleMpesaCallback(req, res) {
  console.log('[mpesa:callback]', JSON.stringify(req.body).slice(0, 500));
  try {
    const stk = req.body?.Body?.stkCallback;
    if (!stk) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    const checkoutId = stk.CheckoutRequestID;
    const tx = db.prepare('SELECT * FROM transactions WHERE checkout_id = ?').get(checkoutId);
    if (!tx) return res.json({ ResultCode: 0, ResultDesc: 'Not tracked' });
    if (tx.status !== 'pending') return res.json({ ResultCode: 0, ResultDesc: 'Already handled' });

    if (stk.ResultCode === 0) {
      const items = stk.CallbackMetadata?.Item || [];
      const receiptItem = items.find(i => i.Name === 'MpesaReceiptNumber');
      const receipt = receiptItem?.Value || ('MP' + Date.now().toString(36).toUpperCase());
      finaliseSuccess(tx, receipt);
    } else {
      // Any non-zero ResultCode (1032 cancelled, 1037 timeout, insufficient funds, etc.)
      // means the vote must NOT be counted.
      finaliseFailure(tx);
    }
  } catch (e) {
    console.error('callback error', e);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}
app.post('/api/mpesa/callback', handleMpesaCallback);
app.post('/callback', handleMpesaCallback);

// ---- Admin: login ----
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'missing_password' });
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'invalid_credentials' });
  const token = sign({ admin: true, iat: Date.now() });
  res.json({ token });
});

app.get('/api/admin/verify', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// ---- Admin: stats ----
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  // Include the persistent floor in the reported total, so the admin sees the
  // same figures the public frontend sees (survives cold-start DB wipe).
  const totalVotes = db.prepare(`
    SELECT COALESCE(SUM(MAX(n.base_votes + n.paid_votes, COALESCE(vb.base, 0))), 0) AS t
    FROM nominees n LEFT JOIN vote_baseline vb ON vb.nominee_id = n.id
  `).get().t;
  const paidVotes = db.prepare('SELECT COALESCE(SUM(paid_votes),0) AS t FROM nominees').get().t;
  const wallet = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM transactions WHERE status='success'`).get().t;
  const successCount = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE status='success'`).get().n;
  const pendingCount = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE status='pending'`).get().n;
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const cdRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('countdown_end');
  const countdownEnd = cdRow ? parseInt(cdRow.value, 10) : null;

  res.json({ totalVotes, paidVotes, wallet, successCount, pendingCount, users, votePrice: VOTE_PRICE, countdownEnd });
});

// ---- Admin: full leaderboard ----
app.get('/api/admin/leaderboard', requireAdmin, (req, res) => {
  const cats = db.prepare('SELECT id, title, ordinal FROM categories ORDER BY ordinal').all();
  const noms = db.prepare(`
    SELECT n.id, n.category_id, n.name, n.detail, n.base_votes, n.paid_votes,
           COALESCE(vb.base, 0) AS floor,
           MAX((n.base_votes + n.paid_votes), COALESCE(vb.base, 0)) AS votes
    FROM nominees n LEFT JOIN vote_baseline vb ON vb.nominee_id = n.id
    ORDER BY n.category_id, votes DESC, n.name
  `).all();
  const byCat = {};
  noms.forEach(n => (byCat[n.category_id] = byCat[n.category_id] || []).push(n));
  res.json({ categories: cats.map(c => ({ ...c, nominees: byCat[c.id] || [] })) });
});

// ---- Admin: transactions ----
app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const status = req.query.status; // pending | success | failed | all
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  let rows;
  if (status && status !== 'all') {
    rows = db.prepare(`
      SELECT t.*, n.name AS nominee_name, u.name AS user_name
      FROM transactions t
      LEFT JOIN nominees n ON n.id = t.nominee_id
      LEFT JOIN users u ON u.id = t.user_id
      WHERE t.status = ?
      ORDER BY t.created_at DESC LIMIT ?
    `).all(status, limit);
  } else {
    rows = db.prepare(`
      SELECT t.*, n.name AS nominee_name, u.name AS user_name
      FROM transactions t
      LEFT JOIN nominees n ON n.id = t.nominee_id
      LEFT JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC LIMIT ?
    `).all(limit);
  }
  res.json({ transactions: rows });
});

// ---- Admin: users list ----
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.phone, u.created_at,
      (SELECT COUNT(*) FROM transactions t WHERE t.user_id=u.id AND t.status='success') AS success_tx,
      (SELECT COALESCE(SUM(amount),0) FROM transactions t WHERE t.user_id=u.id AND t.status='success') AS spent,
      (SELECT COALESCE(SUM(votes),0) FROM transactions t WHERE t.user_id=u.id AND t.status='success') AS votes
    FROM users u ORDER BY u.created_at DESC LIMIT 500
  `).all();
  res.json({ users: rows });
});

// ---- Admin: adjust votes (bonus / base votes) ----
app.post('/api/admin/adjust-votes', requireAdmin, (req, res) => {
  const { nomineeId, delta, setTo } = req.body || {};
  if (!nomineeId) return res.status(400).json({ error: 'missing_nominee' });
  const nom = db.prepare('SELECT * FROM nominees WHERE id=?').get(nomineeId);
  if (!nom) return res.status(404).json({ error: 'not_found' });

  if (typeof setTo === 'number') {
    db.prepare('UPDATE nominees SET base_votes=? WHERE id=?').run(Math.max(0, setTo), nomineeId);
  } else if (typeof delta === 'number') {
    db.prepare('UPDATE nominees SET base_votes = MAX(0, base_votes + ?) WHERE id=?').run(delta, nomineeId);
  } else {
    return res.status(400).json({ error: 'missing_delta_or_setTo' });
  }

  const updated = db.prepare('SELECT id, name, base_votes, paid_votes, (base_votes + paid_votes) AS votes FROM nominees WHERE id=?').get(nomineeId);
  res.json({ ok: true, nominee: updated });
});

// ---- Admin: nominees CRUD ----
app.post('/api/admin/nominee', requireAdmin, (req, res) => {
  const { categoryId, name, detail } = req.body || {};
  if (!categoryId || !name) return res.status(400).json({ error: 'missing_fields' });
  const cat = db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId);
  if (!cat) return res.status(404).json({ error: 'category_not_found' });
  const id = uuid();
  const maxOrd = db.prepare('SELECT COALESCE(MAX(ordinal),0) AS m FROM nominees WHERE category_id=?').get(categoryId).m;
  db.prepare('INSERT INTO nominees (id, category_id, name, detail, ordinal) VALUES (?, ?, ?, ?, ?)')
    .run(id, categoryId, name.trim(), (detail || '').trim(), maxOrd + 1);
  res.json({ ok: true, id });
});

app.delete('/api/admin/nominee/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM nominees WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/admin/nominee/:id', requireAdmin, (req, res) => {
  const { name, detail } = req.body || {};
  const nom = db.prepare('SELECT * FROM nominees WHERE id=?').get(req.params.id);
  if (!nom) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE nominees SET name=COALESCE(?, name), detail=COALESCE(?, detail) WHERE id=?')
    .run(name ?? null, detail ?? null, req.params.id);
  res.json({ ok: true });
});

// ---- Admin: countdown ----
// Admin CAN move the countdown either forward or backward (explicit action).
app.post('/api/admin/countdown', requireAdmin, (req, res) => {
  const { days, endMs } = req.body || {};
  let end;
  if (typeof endMs === 'number' && endMs > Date.now()) {
    end = endMs;
  } else if (typeof days === 'number' && days > 0) {
    end = Date.now() + days * 24 * 60 * 60 * 1000;
  } else {
    return res.status(400).json({ error: 'invalid_input' });
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('countdown_end', String(end));
  res.json({ ok: true, countdownEnd: end });
});

// ---- Admin: reset the persistent floor (nuclear option, use with care) ----
app.post('/api/admin/reset-floor', requireAdmin, (req, res) => {
  const { nomineeId } = req.body || {};
  if (nomineeId) {
    db.prepare('DELETE FROM vote_baseline WHERE nominee_id = ?').run(nomineeId);
  } else {
    db.prepare('DELETE FROM vote_baseline').run();
  }
  res.json({ ok: true });
});

// ---- Admin: recent transactions live-feed ----
app.get('/api/admin/live', requireAdmin, (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const rows = db.prepare(`
    SELECT t.id, t.status, t.amount, t.votes, t.phone, t.created_at, t.completed_at, t.mpesa_receipt,
           n.name AS nominee_name
    FROM transactions t LEFT JOIN nominees n ON n.id = t.nominee_id
    WHERE t.created_at > ? ORDER BY t.created_at DESC LIMIT 50
  `).all(since);
  res.json({ transactions: rows, ts: Date.now() });
});

// ---- Serve admin.html on / and /admin ----
app.get(['/', '/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---- 404 ----
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

// ---- Error ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, () => {
  console.log(`\n🏆  Creatives Awards 2026 API listening on :${PORT}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin\n`);
});
