"use strict";
/* ================= Connection to the store database ================= */
// All data lives in a Google Sheet; js/db.js reads and writes it (no server needed).
const CFG = window.TINDAHAN_CONFIG || {};
let S = null;          // latest state from the database
let online = true;
let lastSig = "";
const api = (action, body) => DB.api(action, body);
function applyState(d){ S = d; lastSig = JSON.stringify(d); }

/* ================= Helpers ================= */
const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const peso = n => "₱" + Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});
const fdate = iso => new Date(iso).toLocaleDateString("en-PH",{month:"short",day:"numeric",year:"numeric"});
const ldate = iso => { const d = new Date(iso); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
const byId = id => S.products.find(p => p.id === String(id));
const isAdmin = () => S.user.role === "admin";
const byName = (a,b) => a.name.localeCompare(b.name);

// Search: every word must match, accents are ignored, and store slang works ("coke" finds Coca-Cola)
const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const ALIASES = {coke:["coca-cola","coca cola"],kape:["coffee"],sabon:["soap"],bigas:["rice"],gatas:["milk"],suka:["vinegar"],toyo:["soy sauce"],sardinas:["sardines"],tinapay:["bread"],mantika:["cooking oil","oil"],asin:["salt"],asukal:["sugar"],itlog:["egg"]};
function matches(p, q){
  const toks = norm(q).split(/\s+/).filter(Boolean);
  if(!toks.length) return true;
  const hay = norm([p.name,p.brand,p.category,p.sub,p.unit].join(" "));
  return toks.every(t => [t].concat(ALIASES[t]||[]).some(a => hay.includes(a)));
}
function statusOf(p){
  if(!p.active) return "off";
  if(p.stock <= 0) return "out";
  if(p.stock <= p.min) return "low";
  return "ok";
}
function stockPill(p){
  const st = statusOf(p);
  const txt = st==="off" ? "Inactive" : st==="out" ? "Out of stock" : st==="low" ? p.stock+" left · Low" : p.stock+" in stock";
  return `<span class="pill ${st}">${txt}</span>`;
}
function sub(p){ return [p.brand, p.category+" › "+p.sub, p.unit].filter(Boolean).join(" · "); }

let toastTimer;
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2400);
}
const ICON = {
  home:'<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  products:'<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  prices:'<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  stock:'<path d="M7 4v14M7 18l-3-3M7 18l3-3M17 20V6M17 6l-3 3M17 6l3 3"/>',
  reports:'<path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5M8 13h8M8 17h8"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'
};
const svg = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

/* ================= UI state ================= */
const ui = { tab:"home", q:"", cat:"All", sub:"", stockTab:"low", rep:"products", from:"", to:"", pq:"" };
const TABS = [
  ["home","Home","Store overview"],
  ["products","Products","Search and manage items"],
  ["prices","Prices","Quick price list"],
  ["stock","Stock","Restock and movements"],
  ["reports","Reports","Lists and totals"]
];
function counts(){
  const a = S.products.filter(p => p.active);
  return {
    total:a.length,
    food:a.filter(p => p.category==="Food").length,
    non:a.filter(p => p.category!=="Food").length,
    low:a.filter(p => statusOf(p)==="low").length,
    out:a.filter(p => statusOf(p)==="out").length
  };
}

/* ================= Rendering ================= */
function renderChrome(){
  const meta = TABS.find(t => t[0]===ui.tab);
  $("#title").textContent = ui.tab==="home" ? "Tindahan Manager" : meta[1];
  const sm = $("#sub");
  sm.textContent = online ? meta[2] : "Can't reach the database";
  sm.classList.toggle("offline", !online);
  $("#whoTxt").textContent = S.user.username;
  $("#who").classList.toggle("staff", !isAdmin());
  const c = counts();
  $("#nav").innerHTML = TABS.map(t => `<button data-act="tab" data-tab="${t[0]}" ${ui.tab===t[0]?'aria-current="page"':""}>${svg(t[0])}<span>${t[1]}</span>${t[0]==="stock" && (c.low+c.out)>0 ? `<i class="badge">${c.low+c.out}</i>`:""}</button>`).join("");
  $("#fab").hidden = !(ui.tab==="products" && isAdmin());
}
function render(){
  $("#gate").hidden = true;
  if(!S){ $("#shell").hidden = true; $("#login").hidden = false; return; }
  $("#login").hidden = true; $("#shell").hidden = false;
  renderChrome();
  ({home:viewHome,products:viewProducts,prices:viewPrices,stock:viewStock,reports:viewReports})[ui.tab]();
}
function softRender(){       // used by auto-refresh; keeps what you are typing
  if(!S) return render();
  renderChrome();
  if(ui.tab==="products") fillProducts();
  else if(ui.tab==="prices") fillPrices();
  else if(ui.tab==="reports") fillReport();
  else ({home:viewHome,stock:viewStock})[ui.tab]();
}

function rowBtn(p){
  return `<button class="card row ${p.active?"":"dim"}" data-act="open" data-id="${p.id}">
    <div class="l"><div class="n">${esc(p.name)}</div><div class="s">${esc(sub(p))}</div></div>
    <div class="r"><span class="tag">${peso(p.price)}</span>${stockPill(p)}</div></button>`;
}
function emptyBox(title, hint, btn=""){ return `<div class="card empty"><b>${esc(title)}</b>${esc(hint)}${btn}</div>`; }
const seedBtn = () => S.products.length===0 && isAdmin() ? `<div><button class="btn" data-act="seed">Load sample products</button></div>` : "";

/* ---- Home ---- */
function viewHome(){
  const c = counts();
  const restock = S.products.filter(p => ["low","out"].includes(statusOf(p))).sort((a,b) => a.stock-b.stock).slice(0,5);
  const recentPrice = [...S.priceHistory].sort((a,b) => b.date.localeCompare(a.date)).slice(0,4);
  const recentAdd = S.products.filter(p => p.active).sort((a,b) => b.added.localeCompare(a.added) || b._i-a._i).slice(0,3);
  $("#main").innerHTML = `
    ${S.user.mustChange ? `<div class="card notice"><span>You are using a temporary password.</span><button data-act="pwForm">Change it</button></div>` : ""}
    <div class="stats">
      <button class="card stat wide" data-act="tab" data-tab="products"><span>Products in your store</span><b>${c.total}</b></button>
      <div class="card stat"><b>${c.food}</b><span>Food</span></div>
      <div class="card stat"><b>${c.non}</b><span>Non-Food</span></div>
      <button class="card stat warn" data-act="stockTab" data-t="low"><b>${c.low}</b><span>Low stock</span></button>
      <button class="card stat bad" data-act="stockTab" data-t="out"><b>${c.out}</b><span>Out of stock</span></button>
    </div>
    ${S.products.length===0 ? `<div style="margin-top:16px">${emptyBox("Your store is empty", isAdmin() ? "Add products from the Products tab, or load sample products to try things out." : "Ask the owner to add products.", seedBtn())}</div>` : `
    <div class="section-title">Needs restocking <button class="link" data-act="stockTab" data-t="low">See all</button></div>
    <div class="list">${restock.length ? restock.map(rowBtn).join("") : emptyBox("Everything is stocked","No item is at or below its minimum.")}</div>
    <div class="section-title">Recent price changes ${isAdmin()?`<button class="link" data-act="repTab" data-r="prices">Report</button>`:""}</div>
    <div class="card" style="padding:4px 14px">
      ${recentPrice.length ? `<ul class="hist">${recentPrice.map(h => { const p = byId(h.pid); return p ? `<li><div><b>${esc(p.name)}</b><div class="d">${fdate(h.date)} · ${esc(h.reason)}</div></div><div style="text-align:right">${peso(h.prev)} → <b>${peso(h.next)}</b></div></li>` : ""; }).join("")}</ul>` : `<div class="empty">No price changes yet.</div>`}
    </div>
    <div class="section-title">Recently added</div>
    <div class="list">${recentAdd.map(rowBtn).join("")}</div>`}`;
}

/* ---- Products ---- */
function filtered(){
  return S.products.filter(p => {
    if(ui.cat==="Inactive"){ if(p.active) return false; }
    else if(!p.active) return false;
    if(S.cats[ui.cat]){ if(p.category!==ui.cat) return false; }
    if(ui.sub && p.sub!==ui.sub) return false;
    return matches(p, ui.q);
  }).sort(byName);
}
function subOptions(){
  if(!S.cats[ui.cat]) return "";
  return `<select class="input" id="subSel" aria-label="Subcategory" style="margin-top:8px"><option value="">All ${esc(ui.cat)}</option>${S.cats[ui.cat].map(s => `<option ${ui.sub===s?"selected":""}>${esc(s)}</option>`).join("")}</select>`;
}
function viewProducts(){
  const chips = Object.keys(S.cats).length>2 ? ["All"].concat(Object.keys(S.cats)) : ["All","Food","Non-Food"];
  if(isAdmin()) chips.push("Inactive");
  $("#main").innerHTML = `
    <div class="search">
      <div class="field">${svg("search")}<input class="input" id="q" type="search" inputmode="search" placeholder="Search name, brand, category" value="${esc(ui.q)}" autocomplete="off"></div>
      <div class="chips" role="group" aria-label="Category">${chips.map(c => `<button class="chip" aria-pressed="${ui.cat===c}" data-act="cat" data-c="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <div id="subWrap">${subOptions()}</div>
    </div>
    <div class="list" id="plist"></div>`;
  fillProducts();
}
function fillProducts(){
  const items = filtered();
  $("#plist").innerHTML = items.length ? items.map(rowBtn).join("") :
    emptyBox("No products found", S.products.length===0 ? (isAdmin() ? "Tap + to add your first product." : "Ask the owner to add products.") : "Try a shorter name or clear the filters.", seedBtn());
}

/* ---- Price list ---- */
function viewPrices(){
  $("#main").innerHTML = `<div class="search"><div class="field">${svg("search")}<input class="input" id="pq" type="search" placeholder="Check a price" value="${esc(ui.pq)}" autocomplete="off"></div></div><div id="plWrap"></div>`;
  fillPrices();
}
function fillPrices(){
  const items = S.products.filter(p => p.active && matches(p, ui.pq)).sort(byName);
  if(!items.length){ $("#plWrap").innerHTML = emptyBox("No matching price", S.products.length ? "Check the spelling or search by brand." : "No products yet."); return; }
  let out = "";
  Object.keys(S.cats).forEach(cat => {
    const inCat = items.filter(p => p.category===cat);
    if(!inCat.length) return;
    out += `<h2 class="cat-h">${esc(cat)}</h2>`;
    S.cats[cat].forEach(sc => {
      const g = inCat.filter(p => p.sub===sc);
      if(!g.length) return;
      out += `<details class="card grp" open><summary>${esc(sc)}<span>${g.length} item${g.length>1?"s":""}</span></summary><div class="pl">${g.map(p => `<div class="${p.stock<=0?"o":""}"><button data-act="open" data-id="${p.id}" style="text-align:left;flex:1;min-width:0"><span style="font-weight:600">${esc(p.name)}</span>${p.stock<=0?'<span class="pill out" style="margin-left:6px">Out</span>':""}</button><span class="tag">${peso(p.price)}</span></div>`).join("")}</div></details>`;
    });
  });
  $("#plWrap").innerHTML = out;
}

/* ---- Stock ---- */
function moveLabel(t){ return t==="in" ? "Stock in" : t==="out" ? "Stock out" : "Adjustment"; }
function signOf(m){ return m.type==="in" ? "+"+m.qty : m.type==="out" ? "−"+m.qty : (m.qty>=0?"+":"−")+Math.abs(m.qty); }
function viewStock(){
  const seg = [["low","Low"],["out","Out"],["history","History"]];
  let body = "";
  if(ui.stockTab==="history"){
    const mv = [...S.movements].sort((a,b) => b.date.localeCompare(a.date) || b._i-a._i).slice(0,60);
    body = mv.length ? `<div class="card" style="padding:4px 14px"><ul class="hist">${mv.map(m => { const p = byId(m.pid); if(!p) return ""; const sg = signOf(m);
      return `<li><div><b>${esc(p.name)}</b><div class="d">${fdate(m.date)} · ${moveLabel(m.type)}${m.note?" · "+esc(m.note):""} · by ${esc(m.by)}</div></div><div style="text-align:right"><span class="${sg.startsWith("+")?"plus":"minus"}">${sg}</span><div class="d">now ${m.after}</div></div></li>`; }).join("")}</ul></div>` : emptyBox("No stock movements yet","Open a product and tap Stock in or Stock out.");
  } else {
    const items = S.products.filter(p => statusOf(p)===ui.stockTab).sort((a,b) => a.stock-b.stock || byName(a,b));
    body = items.length ? `<div class="list">${items.map(p => `<button class="card row" data-act="open" data-id="${p.id}"><div class="l"><div class="n">${esc(p.name)}</div><div class="s">Minimum ${p.min} ${esc(p.unit.toLowerCase())}</div></div><div class="r">${stockPill(p)}</div></button>`).join("")}</div>` :
      emptyBox(ui.stockTab==="low"?"No low-stock items":"Nothing is out of stock", "Products will show here when they reach their minimum.");
  }
  $("#main").innerHTML = `<div class="seg" role="group" aria-label="Stock view">${seg.map(s => `<button data-act="stockTab" data-t="${s[0]}" aria-pressed="${ui.stockTab===s[0]}">${s[1]}</button>`).join("")}</div>${body}`;
}

/* ---- Reports ---- */
function reportData(){
  const act = S.products.filter(p => p.active).sort(byName);
  if(ui.rep==="products") return {cols:["Product","Category","Unit","Price","Stock"],num:[3,4],
    rows:act.map(p => [p.name,p.category+" › "+p.sub,p.unit,peso(p.price),p.stock])};
  if(ui.rep==="low") return {cols:["Product","Stock","Minimum"],num:[1,2],
    rows:act.filter(p => ["low","out"].includes(statusOf(p))).sort((a,b) => a.stock-b.stock).map(p => [p.name,p.stock,p.min])};
  if(ui.rep==="prices"){
    const rows = S.priceHistory.filter(h => (!ui.from || ldate(h.date)>=ui.from) && (!ui.to || ldate(h.date)<=ui.to))
      .sort((a,b) => b.date.localeCompare(a.date)).map(h => { const p = byId(h.pid); return p ? [fdate(h.date),p.name,peso(h.prev),peso(h.next),h.reason] : null; }).filter(Boolean);
    return {cols:["Date","Product","Previous","New","Reason"],num:[2,3],rows};
  }
  const rows = act.map(p => [p.name,p.stock,peso(p.cost),peso(p.stock*p.cost)]);
  const total = act.reduce((s,p) => s+p.stock*p.cost,0);
  return {cols:["Product","Stock","Cost","Est. value"],num:[1,2,3],rows,foot:["Total","","",peso(total)]};
}
function viewReports(){
  const R = [["products","Products"],["low","Low stock"]].concat(isAdmin() ? [["prices","Price changes"],["inventory","Inventory"]] : []);
  if(!R.some(r => r[0]===ui.rep)) ui.rep = "products";
  if(ui.rep==="prices" && !ui.from){ const d = new Date(); d.setDate(d.getDate()-30); ui.from = ldate(d.toISOString()); ui.to = ldate(new Date().toISOString()); }
  $("#main").innerHTML = `
    <div class="chips" role="group" aria-label="Report">${R.map(r => `<button class="chip" aria-pressed="${ui.rep===r[0]}" data-act="repTab" data-r="${r[0]}">${r[1]}</button>`).join("")}</div>
    ${ui.rep==="prices" ? `<div class="two-col" style="margin-top:10px"><div><label class="lbl" style="margin-top:0" for="from">From</label><input class="input" id="from" type="date" value="${ui.from}"></div><div><label class="lbl" style="margin-top:0" for="to">To</label><input class="input" id="to" type="date" value="${ui.to}"></div></div>`:""}
    <div id="repBody" style="margin-top:12px"></div>`;
  fillReport();
}
function fillReport(){
  const d = reportData();
  $("#repBody").innerHTML = d.rows.length ? `<div class="tbl-wrap"><table><thead><tr>${d.cols.map((c,i) => `<th class="${d.num.includes(i)?"num":""}">${c}</th>`).join("")}</tr></thead><tbody>${d.rows.map(r => `<tr>${r.map((v,i) => `<td class="${d.num.includes(i)?"num":""}">${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody>${d.foot?`<tfoot><tr>${d.foot.map((v,i) => `<td class="${d.num.includes(i)?"num":""}">${esc(v)}</td>`).join("")}</tr></tfoot>`:""}</table></div>
    <button class="btn block" style="margin-top:12px" data-act="copyCsv">Copy report as CSV</button>` : emptyBox("Nothing to show","No records match this report.");
}

/* ================= Sheets ================= */
function openSheet(html){
  $("#sheet").innerHTML = html;
  $("#sheetWrap").hidden = false; document.body.classList.add("lock");
  $(".sheet").scrollTop = 0;
}
function closeSheet(){ $("#sheetWrap").hidden = true; document.body.classList.remove("lock"); $("#sheet").innerHTML = ""; }
function setErr(m){ const e = $("#err"); if(e) e.textContent = m; else toast(m); }
const val = id => (($("#"+id)||{}).value || "");

function sheetProduct(id){
  const p = byId(id); if(!p){ closeSheet(); return; }
  const hist = S.priceHistory.filter(h => h.pid===p.id).sort((a,b) => b.date.localeCompare(a.date)).slice(0,5);
  const mv = S.movements.filter(m => m.pid===p.id).sort((a,b) => b.date.localeCompare(a.date) || b._i-a._i).slice(0,5);
  const admin = isAdmin();
  openSheet(`
    <div class="sh-head"><div><h2>${esc(p.name)}</h2><div class="muted" style="font-size:.85rem;margin-top:4px">${esc(sub(p))}</div></div><span class="tag big">${peso(p.price)}</span></div>
    <div class="mini"><div><b>${p.stock}</b><span>In stock</span></div><div><b>${p.min}</b><span>Minimum</span></div><div><b>${admin?peso(p.cost):"—"}</b><span>Cost</span></div></div>
    <div style="margin-bottom:12px">${stockPill(p)}</div>
    ${p.active ? `<div class="btns">
      <button class="btn primary" data-act="stockForm" data-id="${p.id}" data-type="in">Stock in</button>
      <button class="btn" data-act="stockForm" data-id="${p.id}" data-type="out">Stock out</button>
      <button class="btn" data-act="stockForm" data-id="${p.id}" data-type="adjust" ${admin?"":"disabled"}>Adjust</button></div>` : `<p class="muted">This product is inactive. Reactivate it to record stock.</p>`}
    ${admin ? `<div class="btns two" style="margin-top:8px">
      <button class="btn" data-act="priceForm" data-id="${p.id}">Change price</button>
      <button class="btn" data-act="editForm" data-id="${p.id}">Edit details</button></div>
      <button class="btn block ${p.active?"danger":""}" style="margin-top:8px" data-act="toggleActive" data-id="${p.id}">${p.active?"Deactivate product":"Reactivate product"}</button>` :
      `<p class="muted" style="font-size:.85rem;margin:10px 0 0">Price changes, adjustments and edits need an Administrator.</p>`}
    <div class="section-title" style="margin-top:20px">Price history</div>
    ${hist.length ? `<ul class="hist">${hist.map(h => `<li><div>${fdate(h.date)}<div class="d">${esc(h.reason)} · ${esc(h.by)}</div></div><div>${peso(h.prev)} → <b>${peso(h.next)}</b></div></li>`).join("")}</ul>` : `<p class="muted">No price changes recorded.</p>`}
    <div class="section-title">Recent stock movement</div>
    ${mv.length ? `<ul class="hist">${mv.map(m => { const sg = signOf(m); return `<li><div>${fdate(m.date)}<div class="d">${moveLabel(m.type)}${m.note?" · "+esc(m.note):""} · ${esc(m.by)}</div></div><span class="${sg.startsWith("+")?"plus":"minus"}">${sg}</span></li>`; }).join("")}</ul>` : `<p class="muted">No movements yet.</p>`}
    <button class="btn block" style="margin-top:18px" data-act="close">Close</button>`);
}

function sheetStock(id,type){
  const p = byId(id);
  const title = moveLabel(type) === "Adjustment" ? "Adjust stock" : moveLabel(type);
  const reasons = ["Sold","Damaged","Expired","Own use","Other"];
  openSheet(`
    <h2>${title}</h2><p class="muted" style="margin:4px 0 0">${esc(p.name)} · now ${p.stock} ${esc(p.unit.toLowerCase())}</p>
    <label class="lbl" for="qty">${type==="adjust"?"Actual count on the shelf":"Quantity"}</label>
    <input class="input" id="qty" type="number" inputmode="numeric" min="0" step="1" placeholder="0">
    ${type==="out" ? `<label class="lbl" for="note">Reason</label><select class="input" id="note">${reasons.map(r => `<option>${r}</option>`).join("")}</select>` :
      `<label class="lbl" for="note">${type==="in"?"Supplier (optional)":"Note (optional)"}</label><input class="input" id="note" type="text" maxlength="80" placeholder="${type==="in"?"e.g. ABC Distributor":"e.g. Recount"}">`}
    <div class="err" id="err" role="alert"></div>
    <div class="btns two" style="margin-top:10px"><button class="btn" data-act="open" data-id="${p.id}">Back</button><button class="btn primary" data-act="saveStock" data-id="${p.id}" data-type="${type}">Save ${type==="in"?"stock in":type==="out"?"stock out":"adjustment"}</button></div>`);
  setTimeout(() => { const q = $("#qty"); if(q) q.focus(); }, 60);
}

function sheetPrice(id){
  const p = byId(id);
  openSheet(`
    <h2>Change price</h2><p class="muted" style="margin:4px 0 0">${esc(p.name)}</p>
    <div class="mini" style="grid-template-columns:1fr 1fr"><div><b>${peso(p.price)}</b><span>Current price</span></div><div><b>${peso(p.cost)}</b><span>Cost</span></div></div>
    <label class="lbl" for="np">New selling price (₱)</label>
    <input class="input" id="np" type="number" inputmode="decimal" min="0" step="0.25" placeholder="${p.price}">
    <label class="lbl" for="rs">Reason</label>
    <select class="input" id="rs"><option>Supplier price increase</option><option>Supplier price decrease</option><option>Promo</option><option>Correction</option><option>Other</option></select>
    <div class="err" id="err" role="alert"></div>
    <div class="btns two" style="margin-top:10px"><button class="btn" data-act="open" data-id="${p.id}">Back</button><button class="btn primary" data-act="savePrice" data-id="${p.id}">Save price</button></div>`);
  setTimeout(() => { const q = $("#np"); if(q) q.focus(); }, 60);
}

const catOptions = cat => Object.keys(S.cats).map(c => `<option ${c===cat?"selected":""}>${esc(c)}</option>`).join("");
const subOpts = (cat, cur) => (S.cats[cat]||[]).map(s => `<option ${s===cur?"selected":""}>${esc(s)}</option>`).join("");

function sheetProductForm(id){
  const p = id ? byId(id) : {name:"",brand:"",category:"Food",sub:S.cats.Food ? S.cats.Food[0] : "",unit:"Piece",cost:"",price:"",stock:0,min:5};
  const units = ["Piece","Pack","Bottle","Can","Sachet","Kilo","Tube","Box","Bundle"];
  if(!units.includes(p.unit)) units.push(p.unit);
  openSheet(`
    <h2>${id?"Edit product":"Add product"}</h2>
    <label class="lbl" for="f_name">Product name</label><input class="input" id="f_name" maxlength="120" value="${esc(p.name)}" placeholder="e.g. Lucky Me Pancit Canton">
    <label class="lbl" for="f_brand">Brand (optional)</label><input class="input" id="f_brand" maxlength="60" value="${esc(p.brand)}">
    <div class="two-col">
      <div><label class="lbl" for="f_cat">Category</label><select class="input" id="f_cat">${catOptions(p.category)}</select></div>
      <div><label class="lbl" for="f_unit">Unit</label><select class="input" id="f_unit">${units.map(u => `<option ${u===p.unit?"selected":""}>${esc(u)}</option>`).join("")}</select></div>
    </div>
    <label class="lbl" for="f_sub">Subcategory</label><select class="input" id="f_sub">${subOpts(p.category,p.sub)}</select>
    <div class="two-col">
      <div><label class="lbl" for="f_cost">Cost price (₱)</label><input class="input" id="f_cost" type="number" inputmode="decimal" min="0" step="0.25" value="${p.cost}"></div>
      <div><label class="lbl" for="f_price">Selling price (₱)</label><input class="input" id="f_price" type="number" inputmode="decimal" min="0" step="0.25" value="${p.price}" ${id?"disabled":""}></div>
    </div>
    <div class="two-col">
      ${id ? "" : `<div><label class="lbl" for="f_stock">Starting stock</label><input class="input" id="f_stock" type="number" inputmode="numeric" min="0" step="1" value="${p.stock}"></div>`}
      <div><label class="lbl" for="f_min">Minimum stock</label><input class="input" id="f_min" type="number" inputmode="numeric" min="0" step="1" value="${p.min}"></div>
    </div>
    ${id ? `<p class="muted" style="font-size:.82rem;margin:10px 0 0">To change the selling price and keep a history, use Change price.</p>` : ""}
    <div class="err" id="err" role="alert"></div>
    <div class="btns two" style="margin-top:10px"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="saveProduct" data-id="${id||""}">${id?"Save changes":"Add product"}</button></div>`);
}

function sheetAccount(){
  const site = location.origin + location.pathname.replace(/index\.html$/, "");
  const link = DB.connectLink();
  openSheet(`
    <h2>Account</h2>
    <p class="muted" style="margin:4px 0 14px">Signed in as <b>${esc(S.user.username)}</b> · ${isAdmin()?"Administrator":"Staff"}</p>
    <div class="stack">
      <button class="btn block" data-act="pwForm">Change password</button>
      ${isAdmin() ? `<button class="btn block" data-act="usersSheet">Manage users</button>
      <button class="btn block" data-act="catForm">Add category</button>
      <button class="btn block" data-act="backup">Download backup</button>
      ${S.sheetUrl ? `<a class="btn block" href="${esc(S.sheetUrl)}" target="_blank" rel="noopener">Open Google Sheet</a>` : ""}` : ""}
    </div>
    <div class="section-title" style="margin-top:22px">Open on other devices</div>
    <p class="muted" style="margin:0 0 8px;font-size:.88rem">Any phone or tablet with internet can open:</p>
    <div class="addr">${esc(site)}</div>
    ${isAdmin() && link ? `<button class="btn block" style="margin-top:8px" data-act="copyLink">Copy link that also sets the database address</button>` : ""}
    <button class="btn block danger" style="margin-top:22px" data-act="logout">Sign out</button>
    <button class="btn block" style="margin-top:8px" data-act="close">Close</button>`);
}

function sheetPw(){
  openSheet(`
    <h2>Change password</h2>
    <label class="lbl" for="pw0">Current password</label><input class="input" id="pw0" type="password" autocomplete="current-password">
    <label class="lbl" for="pw1">New password (6+ characters)</label><input class="input" id="pw1" type="password" autocomplete="new-password">
    <label class="lbl" for="pw2">Repeat new password</label><input class="input" id="pw2" type="password" autocomplete="new-password">
    <div class="err" id="err" role="alert"></div>
    <div class="btns two" style="margin-top:10px"><button class="btn" data-act="close">Later</button><button class="btn primary" data-act="savePw">Save password</button></div>`);
}

function sheetUsers(){
  openSheet(`
    <h2>Users</h2>
    <ul class="hist" style="margin-top:8px">${(S.users||[]).map(u => `<li><div><b>${esc(u.username)}</b><div class="d">${u.role==="admin"?"Administrator":"Staff"}${u.mustChange?" · temporary password":""}</div></div>
      <div style="display:flex;gap:6px;flex:none"><button class="btn" style="min-height:40px;padding:0 12px" data-act="resetForm" data-id="${u.id}" data-name="${esc(u.username)}">Reset</button>${u.id===S.user.id?"":`<button class="btn danger" style="min-height:40px;padding:0 12px" data-act="delUser" data-id="${u.id}" data-name="${esc(u.username)}">Delete</button>`}</div></li>`).join("")}</ul>
    <div class="section-title">Add a user</div>
    <label class="lbl" for="u_name" style="margin-top:0">Username</label><input class="input" id="u_name" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="30">
    <div class="two-col">
      <div><label class="lbl" for="u_pw">Temporary password</label><input class="input" id="u_pw" type="text" autocapitalize="none" autocomplete="off"></div>
      <div><label class="lbl" for="u_role">Role</label><select class="input" id="u_role"><option value="staff">Staff</option><option value="admin">Administrator</option></select></div>
    </div>
    <div class="err" id="err" role="alert"></div>
    <div class="btns two" style="margin-top:10px"><button class="btn" data-act="account">Back</button><button class="btn primary" data-act="addUser">Add user</button></div>`);
}
function sheetReset(id,name){
  openSheet(`
    <h2>Reset password</h2><p class="muted" style="margin:4px 0 0">For <b>${esc(name)}</b>. They must change it after signing in.</p>
    <label class="lbl" for="r_pw">New temporary password</label><input class="input" id="r_pw" type="text" autocapitalize="none" autocomplete="off">
    <div class="err" id="err" role="alert"></div>
    <div class="btns two" style="margin-top:10px"><button class="btn" data-act="usersSheet">Back</button><button class="btn primary" data-act="saveReset" data-id="${id}">Reset password</button></div>`);
}
function sheetCat(){
  openSheet(`
    <h2>Add category</h2>
    <label class="lbl" for="c_parent">Group</label>
    <select class="input" id="c_parent">${catOptions("")}<option value="__new">New group…</option></select>
    <div id="newGroup" hidden><label class="lbl" for="c_group">New group name</label><input class="input" id="c_group" maxlength="30" placeholder="e.g. Services"></div>
    <label class="lbl" for="c_name">Subcategory name</label><input class="input" id="c_name" maxlength="40" placeholder="e.g. Ice Candy">
    <div class="err" id="err" role="alert"></div>
    <div class="btns two" style="margin-top:10px"><button class="btn" data-act="account">Back</button><button class="btn primary" data-act="saveCat">Add category</button></div>`);
}

/* ================= Actions ================= */
function csvOf(d){
  const q = v => '"'+String(v).replace(/"/g,'""')+'"';
  return [d.cols].concat(d.rows).concat(d.foot?[d.foot]:[]).map(r => r.map(q).join(",")).join("\n");
}
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); return true; }catch(e){}
  try{ const a = document.createElement("textarea"); a.value = t; a.style.position="fixed"; a.style.opacity="0"; document.body.appendChild(a); a.select(); const ok = document.execCommand("copy"); a.remove(); return ok; }catch(e){ return false; }
}

function handleFail(e){
  if(e.auth){ S = null; closeSheet(); render(); $("#lerr").textContent = "Your session ended. Sign in again."; return; }
  if(e.offline) { online = false; if(S) renderChrome(); }
  if(!$("#sheetWrap").hidden) setErr(e.message); else toast(e.message);
}
// Send a change to the server, then show the fresh shared data
async function mutate(el, action, body, msg, before, reopen){
  const label = el ? el.textContent : "";
  if(el){ el.disabled = true; el.textContent = "Saving…"; }
  try{
    const d = await api(action, body);
    online = true; applyState(d);
    if(before) before();
    closeSheet(); render(); if(reopen) reopen(); toast(msg);
  }catch(e){ if(el){ el.disabled = false; el.textContent = label; } handleFail(e); }
}

const ACT = {
  tab(el){ ui.tab = el.dataset.tab; render(); window.scrollTo(0,0); },
  stockTab(el){ ui.tab = "stock"; ui.stockTab = el.dataset.t; render(); window.scrollTo(0,0); },
  repTab(el){ ui.tab = "reports"; ui.rep = el.dataset.r; render(); window.scrollTo(0,0); },
  cat(el){ ui.cat = el.dataset.c; ui.sub = ""; viewProducts(); },
  open(el){ sheetProduct(el.dataset.id); },
  close(){ closeSheet(); },
  account(){ sheetAccount(); },
  pwForm(){ sheetPw(); },
  usersSheet(){ sheetUsers(); },
  resetForm(el){ sheetReset(el.dataset.id, el.dataset.name); },
  addProduct(){ if(isAdmin()) sheetProductForm(null); },
  editForm(el){ sheetProductForm(el.dataset.id); },
  priceForm(el){ sheetPrice(el.dataset.id); },
  stockForm(el){ sheetStock(el.dataset.id, el.dataset.type); },
  catForm(){ sheetCat(); },

  async login(el){
    const username = val("lu").trim(), password = val("lp");
    $("#lerr").textContent = "";
    if(!username || !password){ $("#lerr").textContent = "Enter your username and password."; return; }
    el.disabled = true; el.textContent = "Signing in…";
    try{
      const d = await api("login", {username, password});
      applyState(d); online = true; $("#lp").value = ""; ui.tab = "home"; ui.cat = "All";
      render();
      if(S.user.mustChange) sheetPw();
    }catch(e){ $("#lerr").textContent = e.message; }
    el.disabled = false; el.textContent = "Sign in";
  },
  async logout(){
    try{ await api("logout", {}); }catch(e){}
    S = null; closeSheet(); render();
  },

  saveStock(el){
    const type = el.dataset.type, q = Number(val("qty"));
    if(val("qty")==="" || !Number.isInteger(q) || q < 0 || (type!=="adjust" && q===0)) return setErr(type==="adjust" ? "Enter the actual count." : "Enter a quantity of 1 or more.");
    mutate(el, "stock", {pid:el.dataset.id, type, qty:q, note:val("note")}, type==="in"?"Stock in saved":type==="out"?"Stock out saved":"Adjustment saved");
  },
  savePrice(el){
    if(val("np")==="") return setErr("Enter the new price.");
    mutate(el, "price", {pid:el.dataset.id, price:Number(val("np")), reason:val("rs")}, "Price saved");
  },
  saveProduct(el){
    const id = el.dataset.id;
    const body = {name:val("f_name"), brand:val("f_brand"), category:val("f_cat"), sub:val("f_sub"), unit:val("f_unit"), cost:val("f_cost"), min:val("f_min")};
    if(!body.name.trim()) return setErr("Enter the product name.");
    if(id) body.id = id; else { body.price = val("f_price"); body.stock = val("f_stock"); }
    mutate(el, "product", body, id ? "Changes saved" : "Product added", id ? null : () => { ui.tab = "products"; ui.q = ""; ui.cat = "All"; ui.sub = ""; });
  },
  toggleActive(el){
    const p = byId(el.dataset.id);
    mutate(el, "product/active", {id:p.id, active:!p.active}, p.active ? "Product deactivated" : "Product reactivated");
  },
  savePw(el){
    if(val("pw1") !== val("pw2")) return setErr("The new passwords do not match.");
    mutate(el, "password", {current:val("pw0"), next:val("pw1")}, "Password changed");
  },
  addUser(el){
    mutate(el, "users/add", {username:val("u_name"), password:val("u_pw"), role:val("u_role")}, "User added", null, sheetUsers);
  },
  saveReset(el){
    mutate(el, "users/reset", {id:el.dataset.id, password:val("r_pw")}, "Password reset", null, sheetUsers);
  },
  delUser(el){
    if(!confirm("Delete user " + el.dataset.name + "?")) return;
    mutate(el, "users/delete", {id:el.dataset.id}, "User deleted", null, sheetUsers);
  },
  saveCat(el){
    let group = val("c_parent");
    if(group==="__new") group = val("c_group");
    mutate(el, "category", {group, name:val("c_name")}, "Category added");
  },
  seed(el){ mutate(el, "seed", {}, "Sample products loaded"); },

  async backup(){
    try{
      const d = await api("backup");
      const blob = new Blob([JSON.stringify(d, null, 1)], {type:"application/json"});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "tindahan-backup-" + ldate(new Date().toISOString()) + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("Backup downloaded");
    }catch(e){ handleFail(e); }
  },
  async copyLink(){ toast(await copyText(DB.connectLink()) ? "Link copied" : "Could not copy the link"); },

  // start-up screens
  retry(){ boot(); },
  changeDb(){ DB.clearUrl(); boot(); },
  doConnect(){
    try{ DB.setUrl(val("g_url")); }catch(e){ $("#gerr").textContent = e.message; return; }
    boot();
  },
  async doSetup(el){
    const username = val("g_user").trim(), p1 = val("g_pw1"), p2 = val("g_pw2");
    const err = $("#gerr"); err.textContent = "";
    if(!username || !p1){ err.textContent = "Enter a username and a password."; return; }
    if(p1 !== p2){ err.textContent = "The two passwords do not match."; return; }
    el.disabled = true; el.textContent = "Creating…";
    try{
      const d = await api("setup", {username, password:p1});
      applyState(d); online = true; ui.tab = "home"; ui.cat = "All"; render();
      toast("Store is ready. Welcome!");
    }catch(e){ err.textContent = e.message || "Could not set up the store."; el.disabled = false; el.textContent = "Create owner account"; }
  },
  async copyCsv(){ toast(await copyText(csvOf(reportData())) ? "Report copied" : "Could not copy. Select the table text instead."); }
};

document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if(!el || el.disabled) return;
  const fn = ACT[el.dataset.act]; if(fn) fn(el);
});
document.addEventListener("input", e => {
  const id = e.target.id;
  if(id==="q"){ ui.q = e.target.value; fillProducts(); }
  else if(id==="pq"){ ui.pq = e.target.value; fillPrices(); }
});
document.addEventListener("change", e => {
  const id = e.target.id;
  if(id==="subSel"){ ui.sub = e.target.value; fillProducts(); }
  else if(id==="f_cat"){ $("#f_sub").innerHTML = subOpts(e.target.value,""); }
  else if(id==="c_parent"){ $("#newGroup").hidden = e.target.value !== "__new"; }
  else if(id==="from"){ ui.from = e.target.value; fillReport(); }
  else if(id==="to"){ ui.to = e.target.value; fillReport(); }
});
document.addEventListener("keydown", e => {
  if(e.key==="Escape" && !$("#sheetWrap").hidden) closeSheet();
  if(e.key==="Enter" && (e.target.id==="lu" || e.target.id==="lp")) $("#lbtn").click();
  if(e.key==="Enter" && e.target.id==="g_url") ACT.doConnect();
  if(e.key==="Enter" && e.target.id==="g_pw2") { const b = $("#gsetup"); if(b) b.click(); }
});

/* ================= Start-up screens (connect, first-time setup, problems) ================= */
function gate(kind, info){
  $("#login").hidden = true; $("#shell").hidden = true; $("#gate").hidden = false;
  const box = $("#gateBody");
  const head = t => `<span class="tag big">Tindahan</span><h1>${t}</h1>`;
  if(kind === "loading"){
    box.innerHTML = head("Connecting…") + `<p class="muted">Opening your store database.</p>`;
  } else if(kind === "connect"){
    box.innerHTML = head("Connect your database") +
      `<p class="muted" style="margin:0 0 6px">Paste the Stein API address of your Google Sheet. You only need to do this once on this phone.</p>
       <label class="lbl" for="g_url">Database address</label>
       <input class="input" id="g_url" type="url" inputmode="url" placeholder="https://api.steinhq.com/v1/storages/…" autocapitalize="none" autocorrect="off" spellcheck="false">
       <div class="err" id="gerr" role="alert"></div>
       <button class="btn primary block" data-act="doConnect">Connect</button>`;
  } else if(kind === "setup"){
    box.innerHTML = head("Set up your store") +
      `<p class="muted" style="margin:0 0 6px">This is the first time the store is opened. Create the owner (Administrator) account. Staff accounts can be added later under Account › Manage users.</p>
       <label class="lbl" for="g_user">Owner username</label>
       <input class="input" id="g_user" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="30" placeholder="e.g. owner">
       <label class="lbl" for="g_pw1">Password (6+ characters)</label>
       <input class="input" id="g_pw1" type="password" autocomplete="new-password">
       <label class="lbl" for="g_pw2">Repeat password</label>
       <input class="input" id="g_pw2" type="password" autocomplete="new-password">
       <div class="err" id="gerr" role="alert"></div>
       <button class="btn primary block" id="gsetup" data-act="doSetup">Create owner account</button>`;
  } else {
    const e = info || {};
    const title = e.offline ? "No connection" : e.problem ? "The Google Sheet isn't ready" : "Something went wrong";
    let html = head(title) + `<p class="muted" style="margin:0 0 10px">${esc(e.message || "Try again in a moment.")}</p>`;
    if(e.missing && e.missing.length){
      html += `<p>These tabs could not be read: <b>${e.missing.map(esc).join(", ")}</b></p>
        <p class="muted">The Google Sheet needs five tabs named exactly <b>Users, Products, Categories, PriceHistory, Movements</b>, each with its column names in row 1. Import <b>tindahan-database-template.xlsx</b> (see the README).</p>`;
    }
    html += `<button class="btn primary block" style="margin-top:12px" data-act="retry">Try again</button>`;
    if(DB.urlFromDevice()) html += `<button class="btn block" style="margin-top:8px" data-act="changeDb">Change database address</button>`;
    box.innerHTML = html;
  }
}

async function boot(){
  gate("loading");
  let r;
  try{ r = await DB.boot(); }catch(e){ r = {gate:"problem", error:e}; }
  if(r.state){
    applyState(r.state); online = true; render();
    if(S.user.mustChange) sheetPw();
  } else if(r.gate === "login"){
    S = null; render();
  } else {
    gate(r.gate, r.error);
  }
}

/* ================= Live refresh: see changes made on other phones ================= */
let refreshing = false, hiddenAt = 0;
async function refresh(full){
  if(!S || document.hidden || !$("#sheetWrap").hidden || refreshing) return;
  refreshing = true;
  try{
    const d = await api("state", full ? {full:true} : {});
    const wasOffline = !online; online = true;
    const sig = JSON.stringify(d);
    if(sig !== lastSig){ applyState(d); softRender(); }
    else if(wasOffline) renderChrome();
  }catch(e){
    if(e.auth){ S = null; render(); $("#lerr").textContent = "Your session ended. Sign in again."; }
    else if(e.offline && online){ online = false; renderChrome(); }
  }
  refreshing = false;
}
// Every check is a request to Google Sheets, so keep the pace gentle (see config.js).
setInterval(() => refresh(false), Math.max(10, Number(CFG.REFRESH_SECONDS) || 30) * 1000);
document.addEventListener("visibilitychange", () => {
  if(document.hidden){ hiddenAt = Date.now(); return; }
  refresh(Date.now() - hiddenAt > 120000);   // away for a while: re-read everything
});
window.addEventListener("online", () => refresh(true));

/* ================= Start ================= */
boot();
