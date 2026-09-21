"use strict";
/* =====================================================================
   Tindahan Manager: data layer

   Google Sheets is the database (through the Stein API). There is no
   server: everything below runs in the phone's browser, so the site can
   be hosted for free on GitHub Pages.

   The app calls DB.api(action, body). Each action does what the old
   server.js did (validate, check the role, write) and then returns the
   fresh state for the screen.

   Google Sheet tabs (row 1 = column names, exactly as written):
     Users        id, username, pass, role, mustChange, created
     Products     id, name, brand, category, sub, unit, cost, price, stock, min, active, added, priceUpdated
     Categories   group, name
     PriceHistory id, pid, date, prev, next, reason, by
     Movements    id, pid, date, type, qty, note, by, after
   ===================================================================== */
window.DB = (function () {
  const CFG = window.TINDAHAN_CONFIG || {};
  const KEY_URL = "tindahan.dburl";
  const KEY_SESSION = "tindahan.session";
  const TAB = { users: "Users", products: "Products", cats: "Categories", prices: "PriceHistory", moves: "Movements" };
  const PBKDF2_ITER = 100000;
  const FULL_MS = (Number(CFG.FULL_REFRESH_SECONDS) || 300) * 1000;
  const SESSION_MS = (Number(CFG.SESSION_DAYS) || 30) * 24 * 3600 * 1000;

  const DEFAULT_CATS = {
    "Food": ["Rice & Grains", "Instant Noodles", "Canned Goods", "Snacks", "Biscuits", "Bread", "Beverages", "Coffee", "Milk", "Condiments", "Frozen Products", "Cooking Ingredients", "Candy & Chocolates", "Other Food"],
    "Non-Food": ["Personal Care", "Laundry", "Cleaning Products", "Household Items", "School Supplies", "Batteries", "Toiletries", "Pet Supplies", "Other Non-Food"]
  };

  /* ---------------- small helpers ---------------- */
  const bad = (message, code) => ({ message: message, code: code || 400 });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };
  let idCounter = 0;
  // Ids start with a letter so Google Sheets never mistakes them for numbers or dates.
  const uid = prefix => prefix + "_" + Date.now().toString(36) + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 5);
  const ls = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { window.localStorage.removeItem(k); } catch (e) {} }
  };

  // Google Sheets hands everything back as text, so read defensively.
  const T = v => String(v === null || v === undefined ? "" : v).trim();
  const N = v => { const x = parseFloat(T(v).replace(/[^0-9.+\-eE]/g, "")); return Number.isFinite(x) ? x : 0; };
  const yes = v => /^(true|yes|1)$/i.test(T(v));
  function D(v) {
    const t = T(v);
    let ms = /^\d{11,}$/.test(t) ? Number(t) : Date.parse(t);
    if (!Number.isFinite(ms)) ms = 0;
    return new Date(ms).toISOString();
  }
  // A text starting with = + - @ could be run as a formula by Google Sheets. Keep it plain text.
  const safe = v => { const t = T(v); return /^[=+\-@]/.test(t) ? " " + t : t; };

  /* ---------------- validation (same rules as the old server) ---------------- */
  function str(v, label, o) {
    o = o || {};
    const min = o.min || 0, max = o.max || 100;
    const s = T(v);
    if (s.length < min) throw bad("Enter " + label + ".");
    if (s.length > max) throw bad(label.charAt(0).toUpperCase() + label.slice(1) + " is too long.");
    return s;
  }
  function money(v, label, o) {
    const allowZero = !!(o && o.allowZero);
    const n = Number(v);
    if (v === "" || v === null || v === undefined || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > 10000000) throw bad("Enter the " + label + ".");
    return Math.round(n * 100) / 100;
  }
  function whole(v, label, o) {
    const min = (o && o.min) || 0;
    const n = Number(v);
    if (v === "" || v === null || v === undefined || !Number.isInteger(n) || n < min || n > 1000000) throw bad("Enter " + label + " as a whole number" + (min > 0 ? " of " + min + " or more." : "."));
    return n;
  }
  function validPassword(pw) {
    if (typeof pw !== "string" || pw.length < 6) throw bad("Use a password of at least 6 characters.");
    if (pw.length > 100) throw bad("That password is too long.");
    return pw;
  }
  function validUsername(name) {
    const username = T(name);
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw bad("Username must be 3–30 letters, numbers, dots or dashes.");
    return username;
  }

  /* ---------------- passwords (hashed in the browser, PBKDF2) ---------------- */
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  const unhex = h => new Uint8Array((String(h).match(/../g) || []).map(x => parseInt(x, 16)));
  async function derive(pw, salt, iter) {
    const wc = window.crypto;
    if (!wc || !wc.subtle) throw bad("This browser cannot protect passwords here. Open the site with https:// (the GitHub Pages address).");
    const key = await wc.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    return wc.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: iter, hash: "SHA-256" }, key, 256);
  }
  async function hashPw(pw) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    return "pbkdf2$" + PBKDF2_ITER + "$" + hex(salt) + "$" + hex(await derive(pw, salt, PBKDF2_ITER));
  }
  async function checkPw(pw, stored) {
    const parts = String(stored).split("$");
    if (parts[0] !== "pbkdf2" || !parts[2] || !parts[3]) return false;
    return hex(await derive(pw, unhex(parts[2]), Number(parts[1]) || PBKDF2_ITER)) === parts[3];
  }

  /* ---------------- talking to Stein ---------------- */
  function baseUrl() {
    return String(CFG.STEIN_URL || ls.get(KEY_URL) || "").trim().replace(/\/+$/, "");
  }
  function urlFromDevice() { return !CFG.STEIN_URL && !!ls.get(KEY_URL); }

  async function http(method, tab, opts) {
    opts = opts || {};
    const base = baseUrl();
    if (!base) throw bad("No database address is set.");
    let url = base + "/" + encodeURIComponent(tab);
    if (opts.query) url += "?" + new URLSearchParams(opts.query).toString();
    const init = { method: method, cache: "no-store" };
    if (opts.body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(url, init); }
    catch (e) { throw { offline: true, message: "Can't reach the database. Check your internet connection." }; }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      if (res.status === 429) throw bad("The database is busy. Wait a few seconds and try again.", 429);
      const msg = data && (data.error || data.message);
      throw { message: msg ? String(msg) : "The database returned an error (" + res.status + ").", code: res.status };
    }
    return data;
  }
  const read = (tab, query) => http("GET", tab, { query: query }).then(d => {
    if (!Array.isArray(d)) throw bad("The database sent an unexpected reply.", 502);
    return d;
  });
  const append = (tab, rows) => http("POST", tab, { body: rows });
  const update = (tab, condition, set) => http("PUT", tab, { body: { condition: condition, set: set, limit: 1 } });
  const remove = (tab, condition) => http("DELETE", tab, { body: { condition: condition, limit: 1 } });
  const byId = (tab, id) => read(tab, { search: JSON.stringify({ id: String(id) }), limit: 1 });

  /* ---------------- rows <-> objects ---------------- */
  const dec = {
    user: r => ({ id: T(r.id), username: T(r.username), pass: T(r.pass), role: T(r.role).toLowerCase() === "admin" ? "admin" : "staff", mustChange: yes(r.mustChange), created: D(r.created) }),
    product: r => ({
      id: T(r.id), name: T(r.name), brand: T(r.brand), category: T(r.category), sub: T(r.sub), unit: T(r.unit) || "Piece",
      cost: N(r.cost), price: N(r.price), stock: Math.round(N(r.stock)), min: Math.round(N(r.min)),
      active: T(r.active) === "" ? true : yes(r.active), added: D(r.added), priceUpdated: D(r.priceUpdated || r.added)
    }),
    price: r => ({ id: T(r.id), pid: T(r.pid), date: D(r.date), prev: N(r.prev), next: N(r.next), reason: T(r.reason), by: T(r.by) }),
    move: r => ({ id: T(r.id), pid: T(r.pid), date: D(r.date), type: T(r.type), qty: N(r.qty), note: T(r.note), by: T(r.by), after: Math.round(N(r.after)) }),
    cat: r => ({ group: T(r.group), name: T(r.name) })
  };
  const enc = {
    user: u => ({ id: u.id, username: u.username, pass: u.pass, role: u.role, mustChange: u.mustChange ? "TRUE" : "FALSE", created: u.created }),
    product: p => ({ id: p.id, name: safe(p.name), brand: safe(p.brand), category: p.category, sub: p.sub, unit: safe(p.unit), cost: p.cost, price: p.price, stock: p.stock, min: p.min, active: p.active ? "TRUE" : "FALSE", added: p.added, priceUpdated: p.priceUpdated }),
    price: h => ({ id: h.id, pid: h.pid, date: h.date, prev: h.prev, next: h.next, reason: safe(h.reason), by: h.by }),
    move: m => ({ id: m.id, pid: m.pid, date: m.date, type: m.type, qty: m.qty, note: safe(m.note), by: m.by, after: m.after }),
    cat: c => ({ group: safe(c.group), name: safe(c.name) })
  };
  // Keep the row order of the sheet, and skip blank or half-deleted rows.
  const rowsOf = (rows, keep, decoder) => rows.filter(keep).map((r, i) => Object.assign(decoder(r), { _i: i }));
  const hasId = r => T(r.id) !== "";
  const hasCat = r => T(r.group) !== "" && T(r.name) !== "";

  /* ---------------- cache of the sheet data ---------------- */
  let C = { users: [], products: [], cats: [], prices: [], moves: [] };
  let loaded = false, fullAt = 0;

  async function loadAll() {
    const keys = ["users", "products", "cats", "prices", "moves"];
    const res = await Promise.allSettled(keys.map(k => read(TAB[k])));
    const failed = [];
    res.forEach((r, i) => { if (r.status === "rejected") failed.push({ tab: TAB[keys[i]], err: r.reason || {} }); });
    if (failed.length) {
      if (failed.some(f => f.err.offline)) throw failed.find(f => f.err.offline).err;
      throw { problem: true, missing: failed.map(f => f.tab), message: failed[0].err.message || "The Google Sheet could not be read." };
    }
    const v = res.map(r => r.value);
    C = {
      users: rowsOf(v[0], hasId, dec.user),
      products: rowsOf(v[1], hasId, dec.product),
      cats: rowsOf(v[2], hasCat, dec.cat),
      prices: rowsOf(v[3], hasId, dec.price),
      moves: rowsOf(v[4], hasId, dec.move)
    };
    loaded = true; fullAt = Date.now();
  }
  async function loadProducts() {
    C.products = rowsOf(await read(TAB.products), hasId, dec.product);
  }
  function mergeProduct(p) {
    const i = C.products.findIndex(x => x.id === p.id);
    if (i >= 0) C.products[i] = Object.assign({}, p, { _i: C.products[i]._i });
    else C.products.push(Object.assign({}, p, { _i: C.products.length }));
  }
  async function freshProduct(id) {
    const p = (await byId(TAB.products, id)).filter(hasId).map(dec.product).find(x => x.id === String(id));
    if (!p) throw bad("That product no longer exists.", 404);
    return p;
  }
  async function freshUser(id) {
    return (await byId(TAB.users, id)).filter(hasId).map(dec.user).find(x => x.id === String(id)) || null;
  }
  const catsObj = () => {
    const o = {};
    C.cats.forEach(c => { (o[c.group] = o[c.group] || []).push(c.name); });
    return o;
  };
  function defaultCatRows() {
    const rows = [];
    Object.keys(DEFAULT_CATS).forEach(g => DEFAULT_CATS[g].forEach(n => rows.push({ group: g, name: n })));
    return rows;
  }

  /* ---------------- sessions (kept on the phone) ---------------- */
  function saveSession(u) {
    ls.set(KEY_SESSION, JSON.stringify({ uid: u.id, pv: u.pass.slice(-16), exp: Date.now() + SESSION_MS }));
  }
  function currentUser() {
    let s = null;
    try { s = JSON.parse(ls.get(KEY_SESSION) || "null"); } catch (e) {}
    if (!s || !s.uid || !(s.exp > Date.now())) return null;
    const u = C.users.find(x => x.id === s.uid);
    // If the password was reset, or the user was deleted, this session stops working.
    return u && u.pass.slice(-16) === s.pv ? u : null;
  }
  function requireUser() {
    const u = currentUser();
    if (!u) throw { auth: true, message: "Please sign in." };
    return u;
  }
  function requireAdmin(u) { if (u.role !== "admin") throw bad("Only an Administrator can do this.", 403); }

  function stateFor(u) {
    const admin = u.role === "admin";
    return {
      user: { id: u.id, username: u.username, role: u.role, mustChange: !!u.mustChange },
      products: C.products.map(p => admin ? p : Object.assign({}, p, { cost: null })),
      cats: catsObj(),
      priceHistory: C.prices.slice(-1000),
      movements: C.moves.slice(-500),
      users: admin ? C.users.map(x => ({ id: x.id, username: x.username, role: x.role, mustChange: !!x.mustChange })) : undefined,
      sheetUrl: String(CFG.SHEET_URL || "")
    };
  }

  async function ensureDefaults(u) {
    if (u.role === "admin" && C.cats.length === 0) {
      const rows = defaultCatRows();
      await append(TAB.cats, rows.map(enc.cat));
      C.cats = rows.map((c, i) => Object.assign({ _i: i }, c));
    }
  }

  /* ---------------- sample data ---------------- */
  async function seedSamples(by) {
    const products = [], prices = [], moves = [];
    const P = (name, brand, category, sub, unit, cost, price, stock, min, age) => {
      const p = { id: uid("p"), name: name, brand: brand, category: category, sub: sub, unit: unit, cost: cost, price: price, stock: stock, min: min, active: true, added: daysAgo(age), priceUpdated: daysAgo(age) };
      products.push(p);
      return p;
    };
    const noodles = P("Lucky Me Pancit Canton", "Lucky Me", "Food", "Instant Noodles", "Pack", 12, 15, 25, 10, 60);
    P("Nescafé 3-in-1 Original", "Nescafé", "Food", "Coffee", "Sachet", 6.5, 8, 5, 10, 60);
    P("Ligo Sardines 155g", "Ligo", "Food", "Canned Goods", "Can", 20, 25, 3, 10, 45);
    const coke = P("Coca-Cola 290ml", "Coca-Cola", "Food", "Beverages", "Bottle", 16, 20, 24, 12, 60);
    const cola15 = P("Coca-Cola 1.5L", "Coca-Cola", "Food", "Beverages", "Bottle", 70, 85, 8, 6, 60);
    P("Coca-Cola Zero 1.5L", "Coca-Cola", "Food", "Beverages", "Bottle", 75, 90, 5, 6, 30);
    P("Pepsi 290ml", "Pepsi", "Food", "Beverages", "Bottle", 16, 20, 18, 12, 60);
    P("Sprite 290ml", "Sprite", "Food", "Beverages", "Bottle", 16, 20, 10, 12, 60);
    P("Mountain Dew 290ml", "Mountain Dew", "Food", "Beverages", "Bottle", 16, 20, 0, 12, 60);
    P("Well-milled Rice", "", "Food", "Rice & Grains", "Kilo", 46, 52, 40, 20, 60);
    P("SkyFlakes Crackers", "Monde", "Food", "Biscuits", "Pack", 7, 9, 30, 10, 50);
    P("Piattos 40g", "Jack 'n Jill", "Food", "Snacks", "Pack", 14, 18, 16, 8, 40);
    P("Chippy 27g", "Jack 'n Jill", "Food", "Snacks", "Pack", 8, 10, 22, 10, 40);
    P("Datu Puti Vinegar 385ml", "Datu Puti", "Food", "Condiments", "Bottle", 15, 20, 9, 5, 35);
    P("Choc-Nut", "Ricoa", "Food", "Candy & Chocolates", "Piece", 1.5, 2, 60, 30, 35);
    P("Safeguard Soap 90g", "Safeguard", "Non-Food", "Personal Care", "Piece", 20, 25, 15, 8, 50);
    P("Shampoo Sachet", "Clear", "Non-Food", "Personal Care", "Sachet", 8, 10, 7, 15, 50);
    const surf = P("Surf Powder Sachet", "Surf", "Non-Food", "Laundry", "Sachet", 8, 10, 30, 15, 50);
    P("Zonrox Bleach 250ml", "Zonrox", "Non-Food", "Cleaning Products", "Bottle", 18, 23, 12, 6, 30);
    P("Colgate Toothpaste 50ml", "Colgate", "Non-Food", "Toiletries", "Tube", 28, 35, 10, 5, 30);
    P("AA Batteries (2pcs)", "Eveready", "Non-Food", "Batteries", "Pack", 25, 32, 10, 5, 25);
    P("Notebook", "", "Non-Food", "School Supplies", "Piece", 12, 18, 14, 6, 25);
    P("Lighter", "", "Non-Food", "Household Items", "Piece", 10, 15, 20, 8, 20);

    const ph = (p, age, prev, next) => {
      prices.push({ id: uid("h"), pid: p.id, date: daysAgo(age), prev: prev, next: next, reason: "Supplier price increase", by: by });
      p.price = next; p.priceUpdated = daysAgo(age);
    };
    ph(noodles, 20, 13, 14); ph(noodles, 6, 14, 15); ph(cola15, 3, 82, 85); ph(surf, 1, 9, 10);
    products.slice(0, 10).forEach((p, i) => moves.push({ id: uid("m"), pid: p.id, date: daysAgo(10 - (i % 5)), type: "in", qty: p.stock + 2, note: "ABC Distributor", by: by, after: p.stock + 2 }));
    moves.push({ id: uid("m"), pid: coke.id, date: daysAgo(1), type: "out", qty: 2, note: "Sold", by: by, after: 24 });

    await append(TAB.products, products.map(enc.product));
    await append(TAB.prices, prices.map(enc.price));
    await append(TAB.moves, moves.map(enc.move));
  }

  /* ---------------- the actions the app can call ---------------- */
  const ACT = {
    async login(b) {
      await loadAll();
      const name = T(b.username).toLowerCase();
      const user = C.users.find(u => u.username.toLowerCase() === name);
      if (!user || !(await checkPw(String(b.password || ""), user.pass))) {
        await sleep(400);
        throw bad("Wrong username or password.", 422);
      }
      saveSession(user);
      await ensureDefaults(user);
      return stateFor(user);
    },

    // First run only: create the owner account in an empty Users tab.
    async setup(b) {
      const existing = (await read(TAB.users)).filter(hasId);
      if (existing.length) throw bad("This store is already set up. Sign in instead.");
      const username = validUsername(b.username);
      const pass = await hashPw(validPassword(b.password));
      const user = { id: uid("u"), username: username, pass: pass, role: "admin", mustChange: false, created: nowIso() };
      await append(TAB.users, [enc.user(user)]);
      await loadAll();
      const me = C.users.find(u => u.id === user.id) || Object.assign({ _i: 0 }, user);
      saveSession(me);
      await ensureDefaults(me);
      return stateFor(me);
    },

    async state(b) {
      if (!loaded || (b && b.full) || Date.now() - fullAt > FULL_MS) await loadAll();
      else await loadProducts();
      return stateFor(requireUser());
    },

    async logout() { ls.del(KEY_SESSION); return { ok: true }; },

    async backup() {
      const u = requireUser(); requireAdmin(u);
      await loadAll();
      return {
        version: 2, exportedAt: nowIso(),
        users: C.users.map(x => ({ id: x.id, username: x.username, role: x.role, created: x.created })),
        categories: C.cats.map(c => ({ group: c.group, name: c.name })),
        products: C.products, priceHistory: C.prices, movements: C.moves
      };
    },

    async password(b) {
      const u = requireUser();
      const row = await freshUser(u.id);
      if (!row || !(await checkPw(String(b.current || ""), row.pass))) throw bad("Your current password is not correct.", 422);
      const pass = await hashPw(validPassword(b.next));
      await update(TAB.users, { id: u.id }, { pass: pass, mustChange: "FALSE" });
      u.pass = pass; u.mustChange = false;
      saveSession(u);
      return stateFor(u);
    },

    async product(b) {
      const u = requireUser(); requireAdmin(u);
      const name = str(b.name, "the product name", { min: 1, max: 120 });
      const brand = str(b.brand, "the brand", { max: 60 });
      const category = String(b.category || ""), sub = String(b.sub || "");
      if (!(catsObj()[category] || []).includes(sub)) throw bad("Pick a valid category and subcategory.");
      const unit = str(b.unit || "Piece", "the unit", { min: 1, max: 20 });
      const cost = money(b.cost, "cost price", { allowZero: true });
      const min = whole(b.min, "the minimum stock");
      if (b.id) {
        const p = await freshProduct(b.id);
        const next = Object.assign({}, p, { name: name, brand: brand, category: category, sub: sub, unit: unit, cost: cost, min: min });
        await update(TAB.products, { id: p.id }, { name: safe(name), brand: safe(brand), category: category, sub: sub, unit: safe(unit), cost: cost, min: min });
        mergeProduct(next);
      } else {
        const price = money(b.price, "selling price");
        const stock = whole(b.stock, "the starting stock");
        const t = nowIso();
        const p = { id: uid("p"), name: name, brand: brand, category: category, sub: sub, unit: unit, cost: cost, price: price, stock: stock, min: min, active: true, added: t, priceUpdated: t };
        await append(TAB.products, [enc.product(p)]);
        mergeProduct(p);
        if (stock > 0) {
          const m = { id: uid("m"), pid: p.id, date: t, type: "in", qty: stock, note: "Opening stock", by: u.username, after: stock };
          try { await append(TAB.moves, [enc.move(m)]); C.moves.push(Object.assign({ _i: C.moves.length }, m)); }
          catch (e) { throw bad("The product was added, but its opening stock entry could not be saved.", 500); }
        }
      }
      return stateFor(u);
    },

    async "product/active"(b) {
      const u = requireUser(); requireAdmin(u);
      const p = await freshProduct(b.id);
      const active = !!b.active;
      await update(TAB.products, { id: p.id }, { active: active ? "TRUE" : "FALSE" });
      mergeProduct(Object.assign({}, p, { active: active }));
      return stateFor(u);
    },

    async price(b) {
      const u = requireUser(); requireAdmin(u);
      const p = await freshProduct(b.pid);
      const next = money(b.price, "new price");
      if (next === p.price) throw bad("That is already the current price.");
      const reason = str(b.reason || "Other", "the reason", { min: 1, max: 60 });
      const now = nowIso();
      await update(TAB.products, { id: p.id }, { price: next, priceUpdated: now });
      mergeProduct(Object.assign({}, p, { price: next, priceUpdated: now }));
      const h = { id: uid("h"), pid: p.id, date: now, prev: p.price, next: next, reason: reason, by: u.username };
      try { await append(TAB.prices, [enc.price(h)]); C.prices.push(Object.assign({ _i: C.prices.length }, h)); }
      catch (e) { throw bad("The price was changed, but the history entry could not be saved. Check your connection.", 500); }
      return stateFor(u);
    },

    async stock(b) {
      const u = requireUser();
      const p = await freshProduct(b.pid);   // always start from the latest count in the sheet
      if (!p.active) throw bad("This product is inactive. Reactivate it first.");
      const type = b.type;
      const note = str(b.note, "the note", { max: 80 });
      let delta, qty, stock = p.stock;
      if (type === "in") {
        qty = whole(b.qty, "the quantity", { min: 1 }); stock += qty; delta = qty;
      } else if (type === "out") {
        qty = whole(b.qty, "the quantity", { min: 1 });
        if (qty > p.stock) throw bad("Only " + p.stock + " left. Enter " + p.stock + " or less.", 409);
        stock -= qty; delta = qty;
      } else if (type === "adjust") {
        requireAdmin(u);
        const count = whole(b.qty, "the actual count");
        if (count === p.stock) throw bad("The count is the same as the system.");
        delta = count - p.stock; stock = count;
      } else throw bad("Bad request.");
      await update(TAB.products, { id: p.id }, { stock: stock });
      mergeProduct(Object.assign({}, p, { stock: stock }));
      const m = { id: uid("m"), pid: p.id, date: nowIso(), type: type, qty: delta, note: note, by: u.username, after: stock };
      try { await append(TAB.moves, [enc.move(m)]); C.moves.push(Object.assign({ _i: C.moves.length }, m)); }
      catch (e) { throw bad("The stock was updated, but the history entry could not be saved. Check your connection.", 500); }
      return stateFor(u);
    },

    async category(b) {
      const u = requireUser(); requireAdmin(u);
      const group = str(b.group, "the group name", { min: 1, max: 30 });
      const name = str(b.name, "the subcategory name", { min: 1, max: 40 });
      const fresh = rowsOf(await read(TAB.cats), hasCat, dec.cat);
      if (fresh.some(c => c.group === group && c.name.toLowerCase() === name.toLowerCase())) throw bad("That subcategory already exists.");
      await append(TAB.cats, [enc.cat({ group: group, name: name })]);
      C.cats = fresh.concat([{ group: group, name: name, _i: fresh.length }]);
      return stateFor(u);
    },

    async "users/add"(b) {
      const u = requireUser(); requireAdmin(u);
      const username = validUsername(b.username);
      const fresh = rowsOf(await read(TAB.users), hasId, dec.user);
      if (fresh.some(x => x.username.toLowerCase() === username.toLowerCase())) throw bad("That username is taken.");
      const role = b.role === "admin" ? "admin" : "staff";
      const row = { id: uid("u"), username: username, pass: await hashPw(validPassword(b.password)), role: role, mustChange: true, created: nowIso() };
      await append(TAB.users, [enc.user(row)]);
      C.users = fresh.concat([Object.assign({ _i: fresh.length }, row)]);
      return stateFor(C.users.find(x => x.id === u.id) || u);
    },

    async "users/reset"(b) {
      const u = requireUser(); requireAdmin(u);
      const t = await freshUser(b.id);
      if (!t) throw bad("That user no longer exists.", 404);
      const pass = await hashPw(validPassword(b.password));
      await update(TAB.users, { id: t.id }, { pass: pass, mustChange: "TRUE" });
      const inCache = C.users.find(x => x.id === t.id);
      if (inCache) { inCache.pass = pass; inCache.mustChange = true; }
      if (t.id === u.id) saveSession(u);   // resetting your own password keeps you signed in
      return stateFor(u);
    },

    async "users/delete"(b) {
      const u = requireUser(); requireAdmin(u);
      const t = await freshUser(b.id);
      if (!t) throw bad("That user no longer exists.", 404);
      if (t.id === u.id) throw bad("You cannot delete your own account.");
      await remove(TAB.users, { id: t.id });
      C.users = C.users.filter(x => x.id !== t.id);
      return stateFor(u);
    },

    async seed() {
      const u = requireUser(); requireAdmin(u);
      const existing = (await read(TAB.products)).filter(hasId);
      if (existing.length) throw bad("Sample products can only be loaded into an empty store.");
      await seedSamples(u.username);
      await loadAll();
      return stateFor(requireUser());
    }
  };

  const WRITES = new Set(["setup", "password", "product", "product/active", "price", "stock", "category", "users/add", "users/reset", "users/delete", "seed"]);
  let queue = Promise.resolve();   // one change at a time on this phone

  function api(action, body) {
    const fn = ACT[action];
    if (!fn) return Promise.reject(bad("Not found.", 404));
    const run = () => fn(body || {}).catch(e => {
      if (e instanceof Error) { if (window.console) console.error(e); throw bad("Something went wrong. Try again."); }
      throw e;
    });
    if (!WRITES.has(action)) return run();
    const p = queue.then(run);
    queue = p.catch(() => {});
    return p;
  }

  /* ---------------- start-up ---------------- */
  // A link like  https://you.github.io/tindahan/#db=<address>  connects a new phone without typing.
  function readLinkHash() {
    try {
      const m = /[#&]db=([^&]+)/.exec(window.location.hash || "");
      if (!m) return;
      const url = decodeURIComponent(m[1]);
      if (/^https:\/\/[^\s]+$/i.test(url)) ls.set(KEY_URL, url);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (e) {}
  }

  async function boot() {
    readLinkHash();
    if (!baseUrl()) return { gate: "connect" };
    try { await loadAll(); }
    catch (e) { return { gate: "problem", error: e }; }
    if (!C.users.length) return { gate: "setup" };
    const u = currentUser();
    if (!u) return { gate: "login" };
    try { await ensureDefaults(u); } catch (e) {}
    return { state: stateFor(u) };
  }

  function setUrl(url) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^\s]+$/i.test(u)) throw bad("Paste the full address, starting with https://");
    ls.set(KEY_URL, u);
  }
  function clearUrl() { ls.del(KEY_URL); loaded = false; }
  function connectLink() {
    if (!urlFromDevice()) return "";
    return window.location.origin + window.location.pathname.replace(/index\.html$/, "") + "#db=" + encodeURIComponent(baseUrl());
  }

  return { boot: boot, api: api, setUrl: setUrl, clearUrl: clearUrl, connectLink: connectLink, urlFromDevice: urlFromDevice };
})();
