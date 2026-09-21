'use strict';
/*
 * Tindahan Manager — local store server
 * No installs needed except Node.js. Run:  node server.js
 * Any phone/tablet/PC on the same Wi-Fi/router can open the address it prints.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_MS = 30 * 24 * 3600 * 1000;
const KEEP_BACKUPS = 14;

/* ---------------- errors & small helpers ---------------- */
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg, code = 400) => new HttpError(code, msg);
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function localDay() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }

/* ---------------- storage (one JSON file, written atomically) ---------------- */
const DEFAULT_CATS = {
  'Food': ['Rice & Grains', 'Instant Noodles', 'Canned Goods', 'Snacks', 'Biscuits', 'Bread', 'Beverages', 'Coffee', 'Milk', 'Condiments', 'Frozen Products', 'Cooking Ingredients', 'Candy & Chocolates', 'Other Food'],
  'Non-Food': ['Personal Care', 'Laundry', 'Cleaning Products', 'Household Items', 'School Supplies', 'Batteries', 'Toiletries', 'Pet Supplies', 'Other Non-Food']
};
let db;

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function fresh() {
  return {
    version: 1,
    seq: { user: 3, product: 1, move: 1, price: 1 },
    users: [
      { id: 1, username: 'admin', pass: hashPw('admin123'), role: 'admin', mustChange: true, created: nowIso() },
      { id: 2, username: 'staff', pass: hashPw('staff123'), role: 'staff', mustChange: true, created: nowIso() }
    ],
    cats: JSON.parse(JSON.stringify(DEFAULT_CATS)),
    products: [], priceHistory: [], movements: [], sessions: {}
  };
}

function save() {
  const tmp = DB_FILE + '.tmp';
  const text = JSON.stringify(db);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    fs.writeFileSync(DB_FILE, text); // fallback (e.g. antivirus locking the rename on Windows)
  }
}

function load() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) {
      console.error('\nThe data file is damaged: ' + DB_FILE);
      console.error('Restore a copy from ' + BACKUP_DIR + ' and start again.\n');
      process.exit(1);
    }
  } else { db = fresh(); save(); }
}

function backupDaily() {
  try {
    const f = path.join(BACKUP_DIR, 'store-' + localDay() + '.json');
    if (!fs.existsSync(f) && fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, f);
    const all = fs.readdirSync(BACKUP_DIR).filter(n => /^store-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    all.slice(0, Math.max(0, all.length - KEEP_BACKUPS)).forEach(n => fs.unlinkSync(path.join(BACKUP_DIR, n)));
  } catch (e) { console.error('Backup failed:', e.message); }
}

/* ---------------- validation ---------------- */
function str(v, label, { min = 0, max = 100 } = {}) {
  const s = String(v ?? '').trim();
  if (s.length < min) throw bad('Enter ' + label + '.');
  if (s.length > max) throw bad(label[0].toUpperCase() + label.slice(1) + ' is too long.');
  return s;
}
function money(v, label, { allowZero = false } = {}) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > 10000000) throw bad('Enter the ' + label + '.');
  return Math.round(n * 100) / 100;
}
function whole(v, label, { min = 0 } = {}) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isInteger(n) || n < min || n > 1000000) throw bad('Enter ' + label + ' as a whole number' + (min > 0 ? ' of ' + min + ' or more.' : '.'));
  return n;
}
const findProduct = id => {
  const p = db.products.find(x => x.id === Number(id));
  if (!p) throw bad('That product no longer exists.', 404);
  return p;
};
function checkCategory(cat, sub) {
  if (!db.cats[cat] || !db.cats[cat].includes(sub)) throw bad('Pick a valid category and subcategory.');
}
function validPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) throw bad('Use a password of at least 6 characters.');
  if (pw.length > 100) throw bad('That password is too long.');
  return pw;
}
function requireAdmin(u) { if (u.role !== 'admin') throw bad('Only an Administrator can do this.', 403); }

/* ---------------- sessions ---------------- */
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function getUser(req) {
  const tok = parseCookies(req).sid;
  if (!tok) return null;
  const s = db.sessions[sha(tok)];
  if (!s || s.exp < Date.now()) return null;
  return db.users.find(u => u.id === s.uid) || null;
}
function startSession(res, user) {
  const now = Date.now();
  Object.keys(db.sessions).forEach(k => { if (db.sessions[k].exp < now) delete db.sessions[k]; });
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(tok)] = { uid: user.id, exp: now + SESSION_MS };
  res.setHeader('Set-Cookie', 'sid=' + tok + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_MS / 1000));
}
function dropSessionsOf(uid) {
  Object.keys(db.sessions).forEach(k => { if (db.sessions[k].uid === uid) delete db.sessions[k]; });
}

/* ---------------- state sent to phones ---------------- */
function lanAddresses() {
  const list = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(n => (ifs[n] || []).forEach(i => {
    if (i.family === 'IPv4' && !i.internal) list.push('http://' + i.address + ':' + PORT);
  }));
  return list;
}
function stateFor(u) {
  const admin = u.role === 'admin';
  return {
    user: { id: u.id, username: u.username, role: u.role, mustChange: !!u.mustChange },
    products: db.products.map(p => admin ? p : Object.assign({}, p, { cost: null })),
    cats: db.cats,
    priceHistory: db.priceHistory.slice(-1000),
    movements: db.movements.slice(-500),
    users: admin ? db.users.map(x => ({ id: x.id, username: x.username, role: x.role, mustChange: !!x.mustChange })) : undefined,
    lan: lanAddresses()
  };
}

/* ---------------- sample data ---------------- */
function seedSamples(by) {
  const P = (name, brand, category, sub, unit, cost, price, stock, min, age) => {
    const p = { id: db.seq.product++, name, brand, category, sub, unit, cost, price, stock, min, active: true, added: daysAgo(age), priceUpdated: daysAgo(age) };
    db.products.push(p);
    return p;
  };
  const noodles = P('Lucky Me Pancit Canton', 'Lucky Me', 'Food', 'Instant Noodles', 'Pack', 12, 15, 25, 10, 60);
  P('Nescafé 3-in-1 Original', 'Nescafé', 'Food', 'Coffee', 'Sachet', 6.5, 8, 5, 10, 60);
  P('Ligo Sardines 155g', 'Ligo', 'Food', 'Canned Goods', 'Can', 20, 25, 3, 10, 45);
  const coke = P('Coca-Cola 290ml', 'Coca-Cola', 'Food', 'Beverages', 'Bottle', 16, 20, 24, 12, 60);
  const cola15 = P('Coca-Cola 1.5L', 'Coca-Cola', 'Food', 'Beverages', 'Bottle', 70, 85, 8, 6, 60);
  P('Coca-Cola Zero 1.5L', 'Coca-Cola', 'Food', 'Beverages', 'Bottle', 75, 90, 5, 6, 30);
  P('Pepsi 290ml', 'Pepsi', 'Food', 'Beverages', 'Bottle', 16, 20, 18, 12, 60);
  P('Sprite 290ml', 'Sprite', 'Food', 'Beverages', 'Bottle', 16, 20, 10, 12, 60);
  P('Mountain Dew 290ml', 'Mountain Dew', 'Food', 'Beverages', 'Bottle', 16, 20, 0, 12, 60);
  P('Well-milled Rice', '', 'Food', 'Rice & Grains', 'Kilo', 46, 52, 40, 20, 60);
  P('SkyFlakes Crackers', 'Monde', 'Food', 'Biscuits', 'Pack', 7, 9, 30, 10, 50);
  P('Piattos 40g', "Jack 'n Jill", 'Food', 'Snacks', 'Pack', 14, 18, 16, 8, 40);
  P('Chippy 27g', "Jack 'n Jill", 'Food', 'Snacks', 'Pack', 8, 10, 22, 10, 40);
  P('Datu Puti Vinegar 385ml', 'Datu Puti', 'Food', 'Condiments', 'Bottle', 15, 20, 9, 5, 35);
  P('Choc-Nut', 'Ricoa', 'Food', 'Candy & Chocolates', 'Piece', 1.5, 2, 60, 30, 35);
  P('Safeguard Soap 90g', 'Safeguard', 'Non-Food', 'Personal Care', 'Piece', 20, 25, 15, 8, 50);
  P('Shampoo Sachet', 'Clear', 'Non-Food', 'Personal Care', 'Sachet', 8, 10, 7, 15, 50);
  const surf = P('Surf Powder Sachet', 'Surf', 'Non-Food', 'Laundry', 'Sachet', 8, 10, 30, 15, 50);
  P('Zonrox Bleach 250ml', 'Zonrox', 'Non-Food', 'Cleaning Products', 'Bottle', 18, 23, 12, 6, 30);
  P('Colgate Toothpaste 50ml', 'Colgate', 'Non-Food', 'Toiletries', 'Tube', 28, 35, 10, 5, 30);
  P('AA Batteries (2pcs)', 'Eveready', 'Non-Food', 'Batteries', 'Pack', 25, 32, 10, 5, 25);
  P('Notebook', '', 'Non-Food', 'School Supplies', 'Piece', 12, 18, 14, 6, 25);
  P('Lighter', '', 'Non-Food', 'Household Items', 'Piece', 10, 15, 20, 8, 20);

  const ph = (p, age, prev, next) => {
    db.priceHistory.push({ id: db.seq.price++, pid: p.id, date: daysAgo(age), prev, next, reason: 'Supplier price increase', by });
    p.price = next; p.priceUpdated = daysAgo(age);
  };
  ph(noodles, 20, 13, 14); ph(noodles, 6, 14, 15); ph(cola15, 3, 82, 85); ph(surf, 1, 9, 10);
  db.products.slice(0, 10).forEach((p, i) => db.movements.push({ id: db.seq.move++, pid: p.id, date: daysAgo(10 - (i % 5)), type: 'in', qty: p.stock + 2, note: 'ABC Distributor', by, after: p.stock + 2 }));
  db.movements.push({ id: db.seq.move++, pid: coke.id, date: daysAgo(1), type: 'out', qty: 2, note: 'Sold', by, after: 24 });
}

/* ---------------- login throttle ---------------- */
const fails = new Map();
function throttled(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now();
}
function noteFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 8) { f.until = Date.now() + 5 * 60 * 1000; f.n = 0; }
  fails.set(ip, f);
}

/* ---------------- request plumbing ---------------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 200 * 1024) { reject(bad('Request too large.', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(bad('Bad request.')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  if (req.method === 'POST' && req.headers['x-requested-with'] !== 'tindahan') throw bad('Bad request.');
  if (route === 'GET /api/ping') return send(res, 200, { ok: true });

  if (route === 'POST /api/login') {
    const ip = req.socket.remoteAddress || 'x';
    if (throttled(ip)) throw bad('Too many wrong tries. Wait 5 minutes and try again.', 429);
    const b = await readBody(req);
    const user = db.users.find(u => u.username.toLowerCase() === String(b.username || '').trim().toLowerCase());
    if (!user || !checkPw(String(b.password || ''), user.pass)) {
      noteFail(ip); await sleep(400);
      throw bad('Wrong username or password.', 422);
    }
    fails.delete(ip);
    startSession(res, user); save();
    return send(res, 200, stateFor(user));
  }

  const user = getUser(req);
  if (!user) throw bad('Please sign in.', 401);
  const b = req.method === 'POST' ? await readBody(req) : {};
  const ok = () => send(res, 200, stateFor(db.users.find(u => u.id === user.id) || user));

  switch (route) {
    case 'GET /api/state': return ok();

    case 'GET /api/backup': {
      requireAdmin(user);
      const copy = Object.assign({}, db, { sessions: {} });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="tindahan-backup-' + localDay() + '.json"', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(copy, null, 1));
    }

    case 'POST /api/logout': {
      delete db.sessions[sha(parseCookies(req).sid || '')];
      save();
      res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }

    case 'POST /api/password': {
      if (!checkPw(String(b.current || ''), user.pass)) throw bad('Your current password is not correct.', 422);
      user.pass = hashPw(validPassword(b.next));
      user.mustChange = false;
      save(); return ok();
    }

    case 'POST /api/product': {
      requireAdmin(user);
      const name = str(b.name, 'the product name', { min: 1, max: 120 });
      const brand = str(b.brand, 'the brand', { max: 60 });
      const category = String(b.category || ''), sub = String(b.sub || '');
      checkCategory(category, sub);
      const unit = str(b.unit || 'Piece', 'the unit', { min: 1, max: 20 });
      const cost = money(b.cost, 'cost price', { allowZero: true });
      const min = whole(b.min, 'the minimum stock');
      if (b.id) {
        Object.assign(findProduct(b.id), { name, brand, category, sub, unit, cost, min });
      } else {
        const price = money(b.price, 'selling price');
        const stock = whole(b.stock, 'the starting stock');
        const t = nowIso();
        const p = { id: db.seq.product++, name, brand, category, sub, unit, cost, price, stock, min, active: true, added: t, priceUpdated: t };
        db.products.push(p);
        if (stock > 0) db.movements.push({ id: db.seq.move++, pid: p.id, date: t, type: 'in', qty: stock, note: 'Opening stock', by: user.username, after: stock });
      }
      save(); return ok();
    }

    case 'POST /api/product/active': {
      requireAdmin(user);
      findProduct(b.id).active = !!b.active;
      save(); return ok();
    }

    case 'POST /api/price': {
      requireAdmin(user);
      const p = findProduct(b.pid);
      const next = money(b.price, 'new price');
      if (next === p.price) throw bad('That is already the current price.');
      const reason = str(b.reason || 'Other', 'the reason', { min: 1, max: 60 });
      db.priceHistory.push({ id: db.seq.price++, pid: p.id, date: nowIso(), prev: p.price, next, reason, by: user.username });
      p.price = next; p.priceUpdated = nowIso();
      save(); return ok();
    }

    case 'POST /api/stock': {
      const p = findProduct(b.pid);
      if (!p.active) throw bad('This product is inactive. Reactivate it first.');
      const type = b.type;
      const note = str(b.note, 'the note', { max: 80 });
      let delta, qty;
      if (type === 'in') {
        qty = whole(b.qty, 'the quantity', { min: 1 }); p.stock += qty; delta = qty;
      } else if (type === 'out') {
        qty = whole(b.qty, 'the quantity', { min: 1 });
        if (qty > p.stock) throw bad('Only ' + p.stock + ' left. Enter ' + p.stock + ' or less.', 409);
        p.stock -= qty; delta = qty;
      } else if (type === 'adjust') {
        requireAdmin(user);
        const count = whole(b.qty, 'the actual count');
        if (count === p.stock) throw bad('The count is the same as the system.');
        delta = count - p.stock; p.stock = count;
      } else throw bad('Bad request.');
      db.movements.push({ id: db.seq.move++, pid: p.id, date: nowIso(), type, qty: delta, note, by: user.username, after: p.stock });
      save(); return ok();
    }

    case 'POST /api/category': {
      requireAdmin(user);
      const group = str(b.group, 'the group name', { min: 1, max: 30 });
      const name = str(b.name, 'the subcategory name', { min: 1, max: 40 });
      if (!db.cats[group]) db.cats[group] = [];
      if (db.cats[group].some(s => s.toLowerCase() === name.toLowerCase())) throw bad('That subcategory already exists.');
      db.cats[group].push(name);
      save(); return ok();
    }

    case 'POST /api/users/add': {
      requireAdmin(user);
      const username = String(b.username || '').trim();
      if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw bad('Username must be 3–30 letters, numbers, dots or dashes.');
      if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw bad('That username is taken.');
      const role = b.role === 'admin' ? 'admin' : 'staff';
      db.users.push({ id: db.seq.user++, username, pass: hashPw(validPassword(b.password)), role, mustChange: true, created: nowIso() });
      save(); return ok();
    }

    case 'POST /api/users/reset': {
      requireAdmin(user);
      const t = db.users.find(u => u.id === Number(b.id));
      if (!t) throw bad('That user no longer exists.', 404);
      t.pass = hashPw(validPassword(b.password)); t.mustChange = true;
      if (t.id !== user.id) dropSessionsOf(t.id);
      save(); return ok();
    }

    case 'POST /api/users/delete': {
      requireAdmin(user);
      const t = db.users.find(u => u.id === Number(b.id));
      if (!t) throw bad('That user no longer exists.', 404);
      if (t.id === user.id) throw bad('You cannot delete your own account.');
      db.users = db.users.filter(u => u.id !== t.id);
      dropSessionsOf(t.id);
      save(); return ok();
    }

    case 'POST /api/seed': {
      requireAdmin(user);
      if (db.products.length) throw bad('Sample products can only be loaded into an empty store.');
      seedSamples(user.username);
      save(); return ok();
    }
  }
  throw bad('Not found.', 404);
}

/* ---------------- static files ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw bad('Not allowed.', 405);
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { throw bad('Bad request.'); }
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw bad('Forbidden.', 403);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ---------------- start ---------------- */
load();
backupDaily();
setInterval(backupDaily, 3600 * 1000).unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error. Try again.' });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('\nPort ' + PORT + ' is already in use. Close the other copy of this program, or run with another port:  PORT=3001 node server.js\n');
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddresses();
  console.log('\n  Tindahan Manager is running.\n');
  console.log('  On this computer:      http://localhost:' + PORT);
  if (lan.length) lan.forEach(a => console.log('  On phones (same Wi-Fi): ' + a));
  else console.log('  No network address found. Connect this computer to your router first.');
  console.log('\n  First login:  admin / admin123   (you will be asked to change it)');
  console.log('  Keep this window open. Press Ctrl+C to stop.\n');
});
