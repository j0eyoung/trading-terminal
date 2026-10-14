/* Trading Terminal front end: hash router, command bar, live quotes, every screen. No dependencies. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = v => v != null && v !== "" && isFinite(v);
  const f2 = (v, d = 2) => num(v) ? Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–";
  const money = (v, d = 2) => num(v) ? (v < 0 ? "-$" : "$") + f2(Math.abs(v), d) : "–";
  const pct = (v, d = 2) => num(v) ? (v > 0 ? "+" : "") + f2(v, d) + "%" : "–";
  const sgn = v => num(v) ? (v > 0 ? "up" : v < 0 ? "dn" : "") : "";
  const big = v => num(v) ? window.bigNum(v) : "–";
  const px = v => num(v) ? f2(v, Math.abs(v) < 1 ? 4 : 2) : "–";
  const title = s => String(s).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase());

  const S = { boot: null, fn: "PORT", sym: localStorage.getItem("sym") || "", token: 0, charts: [], timers: [], quotes: {}, broker: null, chat: [] };
  // Per-screen settings (ranges, tabs, filters) kept in this browser between visits.
  function pref(k, def) { try { const v = localStorage.getItem("pref:" + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
  function setPref(k, v) { try { localStorage.setItem("pref:" + k, JSON.stringify(v)); } catch (e) { } }
  // Recently viewed tickers, newest first.
  const recent = () => pref("recent", []);
  function remember(sym) { if (sym) setPref("recent", [sym, ...recent().filter(s => s !== sym)].slice(0, 12)); }
  const FN_GROUP = {};
  const STOCK = new Set(["DES", "GP", "N", "FA", "VAL", "ANR", "ERN", "SEC", "OMON", "BT"]);

  // ---------- network ----------
  async function api(path, params, body) {
    const q = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")) : "";
    const opt = body !== undefined ? { method: "POST", headers: { "X-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
    const r = await fetch("api/" + path + q, opt);
    const j = await r.json().catch(() => ({ error: "Bad response" }));
    if (!r.ok || j.error) throw new Error(j.error || r.statusText);
    return j;
  }
  const post = (path, body) => api(path, null, body || {});
  function toast(text, kind = "", ms = 7000) {
    const d = document.createElement("div");
    d.className = "toast " + kind; d.textContent = text; d.title = "Click to close";
    d.onclick = () => d.remove();
    $("#toasts").append(d); setTimeout(() => d.remove(), ms);
  }

  // ---------- html pieces ----------
  const panel = (name, body, right = "", cls = "") => `<section class="panel ${cls}"><div class="ph"><h2>${esc(name)}</h2><div class="r">${right}</div></div>${body}</section>`;
  const seg = (items, cur, attr) => `<div class="seg">${items.map(i => { const v = Array.isArray(i) ? i[0] : i, l = Array.isArray(i) ? i[1] : i; return `<button data-${attr}="${esc(v)}" class="${v == cur ? "on" : ""}">${esc(l)}</button>`; }).join("")}</div>`;
  const note = (t, cls = "note") => `<div class="${cls}">${t}</div>`;
  const needs = r => note(`This screen needs a free <b>${esc(r.needs_key)}</b> (get one at ${esc(r.where)}). Add it on the add-on's Configuration tab.`, "note box");
  const qspan = (s, f = "last") => `<span class="q" data-s="${esc(s)}" data-f="${f}"></span>`;
  const symLink = s => `<a href="#/DES/${encodeURIComponent(s)}"><b>${esc(s)}</b></a>`;

  function fmtCell(k, v) {
    if (v == null || v === "") return "–";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v === "number") {
      if (/pct|percent|chg|change|from_high|growth|yield|margin|rate$/i.test(k)) return `<span class="${sgn(v)}">${pct(v)}</span>`;
      if (/cap|volume|revenue|value|market|assets|cash|debt|shares/i.test(k) && Math.abs(v) >= 1e5) return big(v);
      if (/^(pl|unrealized|realized|day_pl|amount|total|profit)/i.test(k) || /_pl$/i.test(k)) return `<span class="${sgn(v)}">${money(v)}</span>`;
      return Number.isInteger(v) && Math.abs(v) >= 1000 ? v.toLocaleString() : f2(v, Number.isInteger(v) ? 0 : (Math.abs(v) < 1 ? 4 : 2));
    }
    if (/^https?:/.test(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener">open</a>`;
    if (/^[A-Z.\-^=]{1,8}$/.test(v) && /symbol|ticker/i.test(k)) return symLink(v);
    return esc(v);
  }
  // Table from rows. cols: array of keys or {k,h,f(row)->html}. Click on a row with a symbol goes to it.
  function table(rows, cols, opt = {}) {
    if (!rows || !rows.length) return note(opt.empty || "Nothing to show.");
    if (!cols) cols = Object.keys(rows[0]).filter(k => rows[0][k] == null || typeof rows[0][k] !== "object").slice(0, opt.max || 14);
    cols = cols.map(c => typeof c === "string" ? { k: c, h: title(c) } : { h: title(c.k), ...c });
    const head = cols.map((c, i) => `<th class="sort" data-i="${i}">${esc(c.h)}</th>`).join("");
    const body = rows.map(r => `<tr${r.symbol && !opt.nogo ? ` class="go" data-go="${esc(r.symbol)}"` : ""}>${cols.map(c => `<td${c.cls ? ` class="${c.cls}"` : ""} data-v="${esc(c.f ? "" : r[c.k] ?? "")}">${c.f ? c.f(r) : fmtCell(c.k, r[c.k])}</td>`).join("")}</tr>`).join("");
    return `<div class="tw ${opt.tall ? "tall" : ""}"><table class="t ${opt.compact ? "compact" : ""}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  function kv(obj, keys) {
    const rows = (keys || Object.keys(obj)).filter(k => obj[k] != null && obj[k] !== "" && typeof obj[k] !== "object");
    return `<div class="kvg pb">${rows.map(k => `<div><span>${esc(title(k))}</span><b>${fmtCell(k, obj[k])}</b></div>`).join("")}</div>`;
  }
  const tiles = items => `<div class="tiles">${items.filter(i => i).map(([l, v, sub]) => `<div class="tile"><span>${esc(l)}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`).join("")}</div>`;
  function md(src) {  // small safe markdown
    const inline = t => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = []; let list = null, tbl = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } if (tbl) { out.push("</tbody></table>"); tbl = null; } };
    for (const line of String(src).split("\n")) {
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
      else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
      else if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
        const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
        if (!tbl) { close(); out.push("<table><thead><tr>" + cells.map(c => `<th>${c}</th>`).join("") + "</tr></thead><tbody>"); tbl = 1; }
        else out.push("<tr>" + cells.map(c => `<td>${c}</td>`).join("") + "</tr>");
      } else if (!line.trim()) close();
      else { close(); out.push(`<p>${inline(line)}</p>`); }
    }
    close(); return out.join("");
  }

  // ---------- router ----------
  const routeFn = () => { const [, fn, sym] = location.hash.match(/^#\/([A-Z0-9]+)(?:\/(.+))?/i) || []; return [(fn || "PORT").toUpperCase(), sym ? decodeURIComponent(sym).toUpperCase() : ""]; };
  const go = (fn, sym) => { location.hash = "#/" + fn + (sym ? "/" + encodeURIComponent(sym) : ""); };
  function cleanup() {
    S.charts.forEach(c => c.destroy && c.destroy()); S.charts = [];
    S.timers.forEach(clearInterval); S.timers = [];
  }
  async function render() {
    const [fn, sym] = routeFn();
    const screen = SCREENS[fn];
    cleanup();
    S.fn = fn; if (sym) { S.sym = sym; try { localStorage.setItem("sym", sym); } catch (e) { } }
    if (STOCK.has(fn) && S.sym && !S.noRemember) remember(S.sym);
    S.noRemember = false;
    buildNav(); paintRecent();
    const main = $("#main"); main.scrollTop = 0;
    const token = ++S.token;
    if (!screen) { main.innerHTML = note(`Unknown function <b>${esc(fn)}</b>. Try the list on the left.`); return; }
    if (STOCK.has(fn) && !S.sym) { main.innerHTML = subnav() + note("Type a ticker in the command bar, e.g. <b>NVDA</b>.", "note box"); return; }
    main.innerHTML = subnav() + (STOCK.has(fn) ? `<div id="sec"></div>` : "") + `<div id="screen"><div class="loading">Loading</div></div>`;
    if (STOCK.has(fn)) secHeader(token);
    const el = $("#screen");
    const ctx = { el, sym: S.sym, ok: () => token === S.token, chart: c => { S.charts.push(c); return c; }, every: (fnc, ms) => S.timers.push(setInterval(() => token === S.token && fnc(), ms)) };
    try { await screen(ctx); }
    catch (e) { if (token === S.token) el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    bindTables(main); pollQuotes();
  }
  function subnav() {
    const g = FN_GROUP[S.fn]; if (!g) return "";
    return `<div class="subnav">${Object.entries(S.boot.functions[g]).map(([k, n]) => `<a href="#/${k}${STOCK.has(k) && S.sym ? "/" + S.sym : ""}" class="${k === S.fn ? "on" : ""}">${esc(n)}</a>`).join("")}</div>`;
  }
  const ICONS = { Home: "M3 11l9-8 9 8v10H3z", Stock: "M3 17l5-6 4 4 8-9", Market: "M4 20V10M10 20V4M16 20v-8M22 20H2", Trade: "M7 7h13l-4-4M17 17H4l4 4", AI: "M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" };
  function buildNav() {
    const F = S.boot.functions;
    $("#rail").innerHTML = Object.entries(F).map(([g, items]) => `<h6>${g.toUpperCase()}</h6>` + Object.entries(items).map(([k, n]) =>
      `<a href="#/${k}${STOCK.has(k) && S.sym ? "/" + S.sym : ""}" class="${k === S.fn ? "on" : ""}"><b>${k}</b><span>${esc(n)}</span></a>`).join("")).join("");
    const cur = FN_GROUP[S.fn] || "Home";
    const tabs = [["Home", "PORT"], ["Stock", S.sym ? "DES" : "DES"], ["Market", "WEI"], ["Trade", "ORD"], ["AI", "AI"]];
    $("#tabs").innerHTML = tabs.map(([l, k]) => `<a href="#/${k}${STOCK.has(k) && S.sym ? "/" + S.sym : ""}" class="${(l === cur && !(l === "Home" && S.fn === "ORD")) || (l === "Trade" && S.fn === "ORD") ? "on" : ""}"><svg viewBox="0 0 24 24"><path d="${ICONS[l]}"/></svg>${l}</a>`).join("");
  }
  async function secHeader(token) {
    try {
      const o = await api("overview", { s: S.sym });
      if (token !== S.token) return;
      const i = o.info || {}, q = o.quote || {};
      $("#sec").innerHTML = `<div class="sec"><div class="id"><b>${esc(S.sym)}</b><span>${esc(i.longName || i.shortName || "")}</span></div>
        <div><span class="px">${qspan(S.sym)}</span> <span class="chg">${qspan(S.sym, "chg")}</span></div>
        <div class="kv hide-sm"><span>Open<b>${px(q.open)}</b></span><span>High<b>${qspan(S.sym, "hi")}</b></span><span>Low<b>${qspan(S.sym, "lo")}</b></span><span>Volume<b>${big(q.volume)}</b></span><span>Mkt cap<b>${big(i.marketCap)}</b></span></div>
        <div class="acts"><button class="btn" id="watch">${o.watching ? "★ Watching" : "☆ Watch"}</button><button class="btn buy" id="buy">Buy</button><button class="btn sell" id="sell">Sell</button></div></div>`;
      $("#watch").onclick = async () => { await post("watchlists", { action: o.watching ? "remove" : "add", symbol: S.sym }); toast(o.watching ? "Removed from watchlist" : "Added to watchlist", "good"); secHeader(S.token); sideWatch(); };
      $("#buy").onclick = () => { S.ticket = { symbol: S.sym, side: "buy" }; go("ORD", S.sym); };
      $("#sell").onclick = () => { S.ticket = { symbol: S.sym, side: "sell" }; go("ORD", S.sym); };
      pollQuotes();
    } catch (e) { $("#sec") && ($("#sec").innerHTML = `<div class="err">${esc(e.message)}</div>`); }
  }
  function bindTables(root) {
    $$("tr.go", root).forEach(tr => tr.onclick = e => { if (e.target.closest("a,button,input")) return; go("DES", tr.dataset.go); });
    $$("table.t", root).forEach(t => $$("th.sort", t).forEach(th => th.onclick = () => {
      const i = +th.dataset.i, dir = th.dataset.dir === "1" ? -1 : 1; th.dataset.dir = dir;
      const rows = $$("tbody tr", t);
      const val = r => { const td = r.children[i], raw = td.dataset.v, n = parseFloat(raw); return raw !== "" && !isNaN(n) && /^-?[\d.e+]+$/i.test(raw) ? n : (td.textContent || "").toLowerCase(); };
      rows.sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
      rows.forEach(r => r.parentNode.append(r));
    }));
  }

  // ---------- live quotes ----------
  let polling = false;
  async function pollQuotes() {
    if (polling || document.hidden) return;
    const spans = $$(".q[data-s]");
    const syms = [...new Set(spans.map(s => s.dataset.s))].slice(0, 80);
    if (!syms.length) return;
    polling = true;
    try {
      const r = await api("quotes", { s: syms.join(",") });
      Object.assign(S.quotes, r.quotes);
      $$(".q[data-s]").forEach(el => paintQuote(el));
    } catch (e) { /* keep last values */ }
    polling = false;
    liveSync();
  }
  // Live quotes pushed by the server (api/live, server-sent events) for whatever symbols are on screen.
  const live = { es: null, key: "", on: false, fails: 0 };
  function liveSync(force) {
    if (document.hidden || live.fails > 5) return;
    const syms = [...new Set($$(".q[data-s]").map(s => s.dataset.s))].sort().slice(0, 80);
    const key = syms.join(",");
    if (!force && key === live.key && live.es) return;
    liveStop(); live.key = key;
    if (!syms.length) return;
    const es = live.es = new EventSource("api/live?s=" + encodeURIComponent(key));
    es.onopen = () => { live.on = true; live.fails = 0; };
    es.onmessage = e => {
      const d = JSON.parse(e.data);
      for (const [s, q] of Object.entries(d.quotes)) S.quotes[s] = { ...(S.quotes[s] || {}), ...q };
      $$(".q[data-s]").forEach(el => d.quotes[el.dataset.s] && paintQuote(el));
      $("#mode").title = d.stream === "live" ? "Prices: live stream" : "Prices: every few seconds";
    };
    es.onerror = () => { live.on = false; if (es.readyState === 2) { live.fails++; live.es = null; } };
  }
  function liveStop() { if (live.es) { live.es.close(); live.es = null; } live.on = false; }
  function paintQuote(el) {
    const q = S.quotes[el.dataset.s]; if (!q) return;
    const f = el.dataset.f; let txt, cls = "";
    if (f === "last") txt = px(q.last);
    else if (f === "chg") { txt = `${q.change >= 0 ? "+" : ""}${f2(q.change)} (${pct(q.change_pct)})`; cls = sgn(q.change); }
    else if (f === "pct") { txt = pct(q.change_pct); cls = sgn(q.change_pct); }
    else if (f === "hi") txt = px(q.day_high); else if (f === "lo") txt = px(q.day_low);
    else if (f === "val") { const pos = +el.dataset.qty; txt = money(q.last * pos); }
    else txt = px(q[f]);
    if (el.textContent !== txt) {
      const prev = parseFloat(el.dataset.p);
      el.textContent = txt; el.className = "q " + cls;
      if (f === "last" && num(q.last)) {
        if (!isNaN(prev) && prev !== q.last) { el.classList.add(q.last > prev ? "flash-up" : "flash-dn"); setTimeout(() => el.classList.remove("flash-up", "flash-dn"), 900); }
        el.dataset.p = q.last;
      }
    }
  }

  // ---------- side watchlist ----------
  async function sideWatch() {
    try {
      const w = await post("watchlists", {}).catch(() => api("watchlists"));
      const syms = w.lists[w.active] || [];
      let sparks = {};
      try { sparks = (await api("quotes", { s: syms.join(","), spark: 1 })).quotes; Object.assign(S.quotes, sparks); } catch (e) { }
      const rows = syms.map(s => { const q = S.quotes[s] || {}; return `<tr class="go" data-go="${esc(s)}"><td><b>${esc(s)}</b></td><td class="spark">${q.spark ? window.spark(q.spark, q.prev_close) : ""}</td><td>${qspan(s)}</td><td>${qspan(s, "pct")}</td></tr>`; }).join("");
      const html = `<section class="panel"><div class="ph"><h2>${esc(w.active)}</h2><div class="r"><a class="btn sm" href="#/MON">Edit</a></div></div>
        <div class="tw"><table class="t compact"><tbody>${rows || `<tr><td class="s">Empty. Add a ticker from its page.</td></tr>`}</tbody></table></div></section>`;
      $("#side").innerHTML = html + `<div id="recent"></div>`;
      paintRecent();
      $$("#side tr.go").forEach(tr => tr.onclick = () => go("DES", tr.dataset.go));
      $$(".q", $("#side")).forEach(paintQuote); pollQuotes();
    } catch (e) { $("#side").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  function paintRecent() {
    const el = $("#recent"), rc = recent(); if (!el) return;
    el.innerHTML = rc.length ? `<section class="panel"><div class="ph"><h2>Recent</h2><div class="r"><small>[ ] steps through</small></div></div><div class="pb">${rc.map(s =>
      `<a class="chip ${s === S.sym ? "pos" : ""}" href="#/${STOCK.has(S.fn) ? S.fn : "DES"}/${encodeURIComponent(s)}">${esc(s)}</a>`).join("")}</div></section>` : "";
  }

  // ---------- command bar ----------
  const cmd = $("#cmd"), sug = $("#suggest");
  let sugItems = [], sugAt = -1, sugSeq = 0;
  function allFns() { return Object.entries(S.boot.functions).flatMap(([g, items]) => Object.entries(items).map(([k, n]) => ({ kind: "fn", k, n, g }))); }
  async function suggest() {
    const raw = cmd.value.trim().toUpperCase(); const seq = ++sugSeq;
    if (!raw) {  // empty box: offer the recent tickers
      sugItems = recent().slice(0, 8).map(s => ({ kind: "sym", k: s, n: "Recent" }));
      paintSug(); return;
    }
    const parts = raw.split(/\s+/), last = parts[parts.length - 1];
    const fns = allFns().filter(f => f.k.startsWith(last) || (last.length > 1 && f.n.toUpperCase().includes(last))).slice(0, 6);
    sugItems = parts.length > 1 ? fns.map(f => ({ ...f, sym: parts[0] })) : fns;
    paintSug();
    if (parts.length === 1) {
      try {
        const r = await api("search", { q: raw });
        if (seq !== sugSeq) return;
        sugItems = [...r.results.slice(0, 8).map(x => ({ kind: "sym", k: x.symbol, n: x.name })), ...fns]; paintSug();
      } catch (e) { }
    }
  }
  function paintSug() {
    sugAt = sugItems.length ? 0 : -1; sug.hidden = !sugItems.length;
    sug.innerHTML = sugItems.map((s, i) => `<div data-i="${i}" class="${i === 0 ? "on" : ""}"><b>${esc(s.k)}</b><span>${esc(s.n)}</span><small>${s.kind === "fn" ? "function" : "ticker"}</small></div>`).join("");
    $$("div", sug).forEach(d => d.onmousedown = e => { e.preventDefault(); pick(sugItems[+d.dataset.i]); });
  }
  function pick(it) {
    sug.hidden = true; cmd.value = ""; cmd.blur();
    if (it.kind === "fn") go(it.k, STOCK.has(it.k) ? it.sym || S.sym : "");
    else go(STOCK.has(S.fn) ? S.fn : "DES", it.k);
  }
  function run(text) {
    const parts = text.trim().toUpperCase().split(/\s+/).filter(Boolean); if (!parts.length) return;
    const fnNames = allFns().map(f => f.k);
    if (parts.length >= 2) { const [a, b] = fnNames.includes(parts[0]) ? [parts[1], parts[0]] : [parts[0], parts[1]]; if (fnNames.includes(b)) return go(b, a); }
    if (fnNames.includes(parts[0])) return go(parts[0], STOCK.has(parts[0]) ? S.sym : "");
    go(STOCK.has(S.fn) ? S.fn : "DES", parts[0].replace(/[^A-Z0-9.\-^=]/g, ""));
  }
  cmd.addEventListener("input", suggest);
  cmd.addEventListener("focus", () => { if (!cmd.value) suggest(); });
  cmd.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!sugItems.length) return; e.preventDefault();
      sugAt = (sugAt + (e.key === "ArrowDown" ? 1 : -1) + sugItems.length) % sugItems.length;
      $$("div", sug).forEach((d, i) => d.classList.toggle("on", i === sugAt));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const raw = cmd.value.trim().toUpperCase();
      if (!sug.hidden && sugItems[sugAt] && !/\s/.test(raw) && !allFns().some(f => f.k === raw)) pick(sugItems[sugAt]);
      else { sug.hidden = true; cmd.value = ""; cmd.blur(); run(raw); }
    } else if (e.key === "Escape") { sug.hidden = true; cmd.blur(); }
  });
  cmd.addEventListener("blur", () => setTimeout(() => sug.hidden = true, 120));
  // Keyboard shortcuts (ignored while typing in a box). The list is shown with "?" and on the HELP screen.
  const KEYS = [["/", "Command bar"], ["[ ]", "Previous / next recent ticker"], ["D", "Overview"], ["G", "Chart"], ["N", "News"], ["F", "Financials"],
    ["A", "Analysts"], ["E", "Earnings"], ["O", "Options"], ["B", "Buy ticket"], ["S", "Sell ticket"], ["P", "Portfolio"], ["W", "Watchlists"],
    ["M", "World markets"], ["I", "Ask AI"], ["?", "This list"]];
  const HOT = { d: "DES", g: "GP", n: "N", f: "FA", a: "ANR", e: "ERN", o: "OMON", p: "PORT", w: "MON", m: "WEI", i: "AI" };
  const keyList = () => `<div class="kvg">${KEYS.map(([k, n]) => `<div><span>${esc(n)}</span><b>${esc(k)}</b></div>`).join("")}</div>`;
  document.addEventListener("keydown", e => {
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const k = e.key;
    if (k === "/" || k === "`") { e.preventDefault(); cmd.focus(); cmd.select(); return; }
    if (k === "[" || k === "]") {
      const r = recent(); if (r.length < 2) return;
      const i = r.indexOf(S.sym), next = r[((i < 0 ? 0 : i) + (k === "]" ? -1 : 1) + r.length) % r.length];
      // moving through history shouldn't reorder it, so the route change skips remember() via a flag
      S.noRemember = true; go(STOCK.has(S.fn) ? S.fn : "DES", next); return;
    }
    if (k === "?") { const d = document.createElement("div"); d.className = "toast"; d.innerHTML = `<b class="amber">SHORTCUTS</b>${keyList()}`; $("#toasts").append(d); setTimeout(() => d.remove(), 9000); return; }
    const lk = k.toLowerCase();
    if (lk === "b" || lk === "s") { if (S.sym) { S.ticket = { symbol: S.sym, side: lk === "b" ? "buy" : "sell" }; go("ORD", S.sym); } return; }
    if (HOT[lk]) go(HOT[lk], STOCK.has(HOT[lk]) ? S.sym : "");
  });

  // ---------- chart helpers ----------
  const COL = { "SMA 20": "#ffa62b", "SMA 50": "#5aa9ff", "SMA 200": "#c58bff", "BB upper": "#6f767f", "BB mid": "#888", "BB lower": "#6f767f" };
  function chartCfg(d, o = {}) {
    return { t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, intraday: d.intraday, name: d.symbol, ...o };
  }

  // ---------- screens ----------
  const SCREENS = {};

  // Portfolio
  SCREENS.PORT = async ({ el, chart, ok, every }) => {
    let range = pref("port.range", "1D"), cur = S.broker, eq = null;
    const draw = async () => {
      const p = await api("portfolio", { broker: cur, range });
      if (!ok()) return;
      if (!p.brokers.length) { el.innerHTML = note((S.boot.pending ? "Connecting to your broker… " : "No broker connected. ") + Object.values(p.errors || {}).map(esc).join(" "), S.boot.pending ? "note box" : "err"); return; }
      cur = S.broker = p.broker;
      const a = p.account || {}, pos = p.positions || [];
      const dayPl = pos.reduce((t, x) => t + (x.day_pl || 0), 0), unreal = pos.reduce((t, x) => t + (x.unrealized_pl || 0), 0);
      const errs = Object.entries(p.errors || {}).map(([k, v]) => `<div class="note warn">${esc(k)}: ${esc(v)}</div>`).join("");
      el.innerHTML = errs + `<div class="grid g2"><div class="col">
        ${panel("Account " + p.mode, tiles([["Equity", money(a.equity)], ["Cash", money(a.cash)], ["Buying power", money(a.buying_power)], ["Day P/L", `<span class="${sgn(dayPl)}">${money(dayPl)}</span>`], ["Open P/L", `<span class="${sgn(unreal)}">${money(unreal)}</span>`]]).replace('class="tiles"', 'class="tiles pb"'),
          p.brokers.length > 1 ? seg(p.brokers, cur, "br") : "")}
        ${panel("Equity vs S&P 500", `<div class="pb"><div id="eq" class="chart"></div><div class="cap" id="eq-vs" style="padding-left:0"></div></div>`, seg(["1D", "1W", "1M", "3M", "1Y", "ALL"], range, "rg"))}
        ${panel("Positions", table(pos.map(x => ({ ...x })), [{ k: "symbol", h: "Symbol", f: r => symLink(r.symbol) }, "qty", { k: "avg_cost", h: "Avg cost", f: r => px(r.avg_cost) },
          { k: "last", h: "Last", f: r => /^[A-Z.\-]{1,6}$/.test(r.symbol) ? qspan(r.symbol) : "–" }, { k: "market_value", h: "Value", f: r => money(r.market_value) },
          { k: "day_pl", h: "Day P/L", f: r => `<span class="${sgn(r.day_pl)}">${money(r.day_pl)}</span>` }, { k: "unrealized_pl", h: "Open P/L", f: r => `<span class="${sgn(r.unrealized_pl)}">${money(r.unrealized_pl)}</span>` }], { empty: "No open positions." }), "", "")}
        </div><div class="col">${pos.length ? panel("Open P/L by position", `<div class="pb bars">${plBars(pos.map(x => [x.symbol, x.unrealized_pl]))}</div>`) : ""}
        ${panel("Allocation", `<div id="alloc" class="pb bars"><div class="loading">Loading</div></div>`)}
        <div id="bytag"></div>
        ${panel("Recent orders", `<div id="ords"><div class="loading">Loading</div></div>`, `<a class="btn sm" href="#/ORD">Trade</a>`)}</div></div>`;
      const h = p.history || { t: [], v: [] };
      const spy = p.spy && p.spy.some(v => v != null) ? [{ name: "Same money in SPY", v: p.spy, color: "#5aa9ff", dash: [4, 3] }] : [];
      if (eq) eq.destroy();
      eq = new window.TChart($("#eq"), { t: h.t, c: h.v, kind: "area", intraday: range === "1D" || range === "1W", baseline: h.v[0], yfmt: v => "$" + f2(v, 0), name: "Equity", overlays: spy });
      const ret = arr => { const v = (arr || []).filter(x => x != null); return v.length > 1 ? (v[v.length - 1] / v[0] - 1) * 100 : null; };
      const mine = ret(h.v), bench = ret(p.spy);
      $("#eq-vs").innerHTML = mine != null && bench != null ? `Over this range: you <span class="${sgn(mine)}">${pct(mine)}</span>, SPY <span class="${sgn(bench)}">${pct(bench)}</span> → <b class="${sgn(mine - bench)}">${mine - bench >= 0 ? "ahead" : "behind"} by ${f2(Math.abs(mine - bench))} pts</b>` : "";
      api("journal").then(j => { if (!ok() || !j.by_tag.length) return;
        $("#bytag").innerHTML = panel("Closed P/L by tag", `<div class="pb bars">${plBars(j.by_tag.map(t => [t.tag + ` (${t.trades}, ${f2(t.win_rate, 0)}% won)`, t.total]))}</div>`, `<a class="btn sm" href="#/JRNL">Journal</a>`);
      }).catch(() => { });
      $$("[data-rg]", el).forEach(b => b.onclick = () => { range = b.dataset.rg; setPref("port.range", range); draw(); });
      $$("[data-br]", el).forEach(b => b.onclick = () => { cur = S.broker = b.dataset.br; draw(); });
      bindTables(el);
      api("allocation", { broker: cur }).then(r => { if (!ok()) return; const tot = r.allocation.reduce((t, [, v]) => t + v, 0) || 1;
        $("#alloc").innerHTML = r.allocation.length ? r.allocation.map(([n, v]) => `<div class="b"><span>${esc(n)}</span><div class="tr"><div class="fl" style="width:${v / tot * 100}%"></div></div><em>${f2(v / tot * 100, 1)}%</em></div>`).join("") : note("No positions.");
      }).catch(e => $("#alloc") && ($("#alloc").innerHTML = note(esc(e.message), "err")));
      api("orders").then(r => { if (!ok()) return; const rows = (r.brokers[cur] || []).slice(0, 6);
        $("#ords").innerHTML = table(rows, [{ k: "symbol", h: "Symbol", f: r => symLink(r.symbol) }, "side", "qty", "type", { k: "status_label", h: "Status" }], { nogo: true, empty: "No orders yet." });
      }).catch(() => { });
      pollQuotes();
    };
    await draw();
    S.charts.push({ destroy: () => eq && eq.destroy() });
    every(() => { if (!document.hidden) draw(); }, 30000);
  };
  // Horizontal profit/loss bars: [[label, value], ...], green right of zero, red left.
  function plBars(rows) {
    rows = rows.filter(([, v]) => num(v)).sort((a, b) => b[1] - a[1]);
    const mx = Math.max(...rows.map(([, v]) => Math.abs(v)), 1);
    return rows.map(([n, v]) => `<div class="b"><span>${esc(n)}</span><div class="tr"><div class="fl" style="width:${Math.abs(v) / mx * 100}%;background:${v >= 0 ? "var(--up)" : "var(--dn)"}"></div></div><em class="${sgn(v)}">${money(v, 0)}</em></div>`).join("") || note("Nothing yet.");
  }

  // Trade ticket
  SCREENS.ORD = async ({ el, ok, sym, every }) => {
    const brokers = S.boot.brokers; if (!brokers.length) { el.innerHTML = S.boot.pending ? note("Connecting to your broker…", "note box") : note("No broker connected.", "err"); return; }
    const t = { symbol: sym || S.sym || "", side: "buy", type: "market", tif: "day", qty: 1, price: "", broker: S.broker || brokers[0], ...(S.ticket || {}) }; S.ticket = null;
    el.innerHTML = `<div class="grid g2"><div class="col">${panel("Order ticket " + S.boot.mode, `<form class="pb ticket" id="tk" autocomplete="off">
      <div class="two"><label class="f">Symbol<input class="in num" id="t-sym" value="${esc(t.symbol)}" style="text-transform:uppercase"></label>
      <label class="f">Account<select class="in" id="t-br">${brokers.map(b => `<option ${b === t.broker ? "selected" : ""}>${esc(b)}</option>`).join("")}</select></label></div>
      <div class="side"><button type="button" class="b ${t.side === "buy" ? "on" : ""}" data-side="buy">BUY</button><button type="button" class="s ${t.side === "sell" ? "on" : ""}" data-side="sell">SELL</button></div>
      <div class="two"><label class="f">Quantity<input class="in num" id="t-qty" type="number" min="0" step="any" value="${t.qty}"></label>
      <label class="f">Order type<select class="in" id="t-type">${["market", "limit", "stop"].map(x => `<option ${x === t.type ? "selected" : ""}>${x}</option>`).join("")}</select></label></div>
      <div class="two"><label class="f" id="px-l">Price<input class="in num" id="t-px" type="number" step="any" value="${t.price}"></label>
      <label class="f">Time in force<select class="in" id="t-tif">${["day", "gtc"].map(x => `<option ${x === t.tif ? "selected" : ""}>${x}</option>`).join("")}</select></label></div>
      <details id="sz-d" ${pref("ord.size", false) ? "open" : ""}><summary>SIZE BY RISK</summary><div class="two"><label class="f" title="What you'd lose if the stop is hit">Risk ($)<input class="in num" id="sz-risk" type="number" min="0" step="any"></label>
        <label class="f">Stop price<input class="in num" id="sz-stop" type="number" step="any"></label></div>
        <div class="row" style="margin-top:6px"><button type="button" class="btn" id="sz-go">Set quantity</button><span class="muted" id="sz-out"></span></div></details>
      <details><summary>BRACKET (optional)</summary><div class="two"><label class="f">Take profit<input class="in num" id="t-tp" type="number" step="any"></label><label class="f">Stop loss<input class="in num" id="t-sl" type="number" step="any"></label></div></details>
      <label class="f">Note for journal<input class="in" id="t-note" maxlength="200"></label>
      <div class="est"><span>Last <span id="t-last" class="dim">–</span></span><span id="t-est"></span></div>
      <button class="btn pri wide" id="t-prev">Review order</button><div id="t-out"></div></form>`)}</div>
      <div class="col">${panel("Orders", `<div id="ol"><div class="loading">Loading</div></div>`)}</div></div>`;
    const g = id => $("#" + id, el);
    const upd = () => { g("px-l").style.display = g("t-type").value === "market" ? "none" : ""; const q = S.quotes[g("t-sym").value.trim().toUpperCase()];
      g("t-last").textContent = q ? px(q.last) : "–"; const unit = +g("t-px").value || (q && q.last); g("t-est").textContent = unit ? "Est. " + money(unit * (+g("t-qty").value || 0)) : ""; };
    $$("[data-side]", el).forEach(b => b.onclick = () => { t.side = b.dataset.side; $$("[data-side]", el).forEach(x => x.classList.toggle("on", x === b)); });
    ["t-type", "t-qty", "t-px"].forEach(i => g(i).oninput = upd);
    g("t-sym").onchange = async () => { const s = g("t-sym").value.trim().toUpperCase(); if (!s) return; try { Object.assign(S.quotes, (await api("quotes", { s })).quotes); } catch (e) { } upd(); };
    g("t-sym").onchange(); upd();
    // Position sizing: shares = risk / (entry - stop), capped by the plan's max position size.
    let acct = null;
    const loadAcct = async () => { try { acct = await api("account", { broker: g("t-br").value }); } catch (e) { acct = null; }
      const pl = acct && acct.plan, eqv = acct && acct.account && acct.account.equity;
      if (pl && eqv && pl.risk_per_trade && !g("sz-risk").value) g("sz-risk").value = Math.round(eqv * pl.risk_per_trade / 100);
      g("sz-out").textContent = pl && pl.risk_per_trade ? `Plan: risk ${pl.risk_per_trade}% of ${money(eqv, 0)}` : "Set a risk % in My trading plan (PLAN) to prefill this."; };
    g("t-br").onchange = () => { g("sz-risk").value = ""; loadAcct(); };
    g("sz-d").ontoggle = () => setPref("ord.size", g("sz-d").open);
    loadAcct();
    g("sz-go").onclick = () => {
      const s = g("t-sym").value.trim().toUpperCase(), q = S.quotes[s] || {};
      const entry = g("t-type").value !== "market" && +g("t-px").value ? +g("t-px").value : q.last;
      const risk = +g("sz-risk").value, stop = +g("sz-stop").value, out = g("sz-out");
      if (!entry || !risk || !stop) { out.innerHTML = `<span class="warn">Need a price, a risk amount and a stop.</span>`; return; }
      const per = t.side === "buy" ? entry - stop : stop - entry;
      if (per <= 0) { out.innerHTML = `<span class="warn">For a ${t.side}, the stop must be ${t.side === "buy" ? "below" : "above"} ${px(entry)}.</span>`; return; }
      let qty = Math.floor(risk / per), why = `${money(risk, 0)} ÷ ${px(per)} risk per share`;
      const eqv = acct && acct.account && acct.account.equity, mp = acct && acct.plan && acct.plan.max_position;
      if (eqv && mp && qty * entry > eqv * mp / 100) { qty = Math.floor(eqv * mp / 100 / entry); why += `, capped at your ${mp}% max position`; }
      g("t-qty").value = qty; g("t-sl").value = stop; g("t-sl").closest("details").open = true; upd();
      out.innerHTML = `<b>${qty} shares</b> (${why}). Stop loss filled in below.`;
    };
    const body = () => ({ broker: g("t-br").value, symbol: g("t-sym").value.trim().toUpperCase(), side: t.side, qty: g("t-qty").value, type: g("t-type").value, price: g("t-px").value, tif: g("t-tif").value,
      take_profit: g("t-tp").value, stop_loss: g("t-sl").value, ref: (S.quotes[g("t-sym").value.trim().toUpperCase()] || {}).last, note: g("t-note").value });
    $("#tk").onsubmit = async e => {
      e.preventDefault(); const out = g("t-out"), b = body(); out.innerHTML = `<div class="loading">Checking</div>`;
      try {
        const p = await post("orders/preview", b);
        out.innerHTML = `<div class="confirm"><div class="d">${esc(p.describe)}</div>${p.value ? `<div>Estimated value ${money(p.value)} on ${esc(p.broker)} (${esc(p.mode)})</div>` : ""}${(p.warnings || []).map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
          <div class="row"><button type="button" class="btn ${t.side === "buy" ? "buy" : "sell"}" id="t-go">Confirm ${t.side.toUpperCase()}</button><button type="button" class="btn" id="t-no">Cancel</button></div></div>`;
        g("t-no").onclick = () => out.innerHTML = "";
        g("t-go").onclick = async ev => { ev.target.disabled = true;
          try { const r = await post("orders/submit", { ...b, confirm: true }); out.innerHTML = note(`Sent: ${esc(r.describe)}${r.note ? " " + esc(r.note) : ""}`, "note up"); toast("Order sent", "good"); loadOrders(); }
          catch (er) { out.innerHTML = `<div class="err">${esc(er.message)}</div>`; } };
      } catch (er) { out.innerHTML = `<div class="err">${esc(er.message)}</div>`; }
    };
    async function loadOrders() {
      try {
        const r = await api("orders"); if (!ok()) return;
        const rows = Object.entries(r.brokers).flatMap(([b, os]) => os.map(o => ({ ...o, broker: b })));
        $("#ol").innerHTML = (Object.entries(r.errors || {}).map(([k, v]) => `<div class="note warn">${esc(k)}: ${esc(v)}</div>`).join("")) +
          table(rows, [{ k: "symbol", h: "Symbol", f: r => symLink(r.symbol) }, "side", "qty", "type", { k: "limit_price", h: "Price", f: r => px(r.limit_price) }, { k: "status_label", h: "Status" }, { k: "submitted", h: "Submitted", f: r => esc(String(r.submitted || "").slice(0, 16).replace("T", " ")) },
            { k: "x", h: "", f: r => r.state === "open" ? `<button class="btn sm" data-cx="${esc(r.id)}" data-b="${esc(r.broker)}">Cancel</button>` : "" }], { nogo: true, empty: "No orders yet." });
        $$("[data-cx]", el).forEach(b => b.onclick = async () => { b.disabled = true; try { await post("orders/cancel", { id: b.dataset.cx, broker: b.dataset.b }); toast("Cancel sent", "good"); loadOrders(); } catch (e) { toast(e.message, "bad"); b.disabled = false; } });
      } catch (e) { $("#ol").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    }
    await loadOrders(); every(loadOrders, 15000);
  };

  // Journal
  SCREENS.JRNL = async ({ el }) => {
    const j = await api("journal"), s = j.summary || {};
    const stats = s.trades ? tiles(Object.entries(s).map(([k, v]) => [title(k), /pl|profit|loss|avg|best|worst|total/i.test(k) ? `<span class="${sgn(v)}">${money(v)}</span>` : /rate|pct/i.test(k) ? f2(v, 1) + "%" : f2(v, Number.isInteger(v) ? 0 : 2)])) : note("No closed trades yet.");
    el.innerHTML = `<div class="grid">${panel("Track record", `<div class="pb">${stats}</div>`)}
      ${j.by_tag.length ? panel("Results by tag", table(j.by_tag, ["tag", "trades", { k: "win_rate", h: "Win rate", f: r => f2(r.win_rate, 0) + "%" }, { k: "total", h: "Total P/L", f: r => `<span class="${sgn(r.total)}">${money(r.total)}</span>` }], { nogo: true })) : ""}
      ${panel("Entries", table(j.entries, [{ k: "time", h: "When", f: r => esc(new Date(r.time * 1000).toLocaleString()) }, { k: "symbol", h: "Symbol", f: r => symLink(r.symbol) }, "side", "qty", { k: "price", h: "Price", f: r => px(r.price) },
        { k: "tags", h: "Tags", cls: "l", f: r => (r.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join("") }, { k: "note", h: "Note", cls: "l s" }, { k: "review", h: "Review", cls: "l s", f: r => esc(r.review || "") },
        { k: "x", h: "", f: r => `<button class="btn sm" data-rv="${esc(r.id)}">Review</button> <button class="btn sm" data-del="${esc(r.id)}">Delete</button>` }], { nogo: true, empty: "Orders you place here are logged automatically." }))}</div>`;
    $$("[data-rv]", el).forEach(b => b.onclick = async () => { const t = prompt("How did this trade go? What would you do differently?"); if (t == null) return; await post("journal/update", { id: b.dataset.rv, review: t }); render(); });
    $$("[data-del]", el).forEach(b => b.onclick = async () => { if (confirm("Delete this journal entry?")) { await post("journal/update", { id: b.dataset.del, delete: true }); render(); } });
  };

  // Gains
  SCREENS.GAIN = async ({ el }) => {
    const g = await api("gains");
    const closed = Array.isArray(g.closed) ? g.closed : [];
    const tot = closed.reduce((t, r) => t + (r.pl || 0), 0), dv = (g.dividends || []).reduce((t, r) => t + (r.amount || 0), 0);
    el.innerHTML = Object.entries(g.errors || {}).map(([k, v]) => `<div class="note warn">${esc(k)}: ${esc(v)}</div>`).join("") + `<div class="grid">${panel("Totals", `<div class="pb">${tiles([["Realized P/L", `<span class="${sgn(tot)}">${money(tot)}</span>`], ["Dividends received", money(dv)], ["Closed trades", closed.length]])}</div>`)}
      ${panel("Closed trades", table(closed, null, { tall: true, empty: "No closed trades yet." }))}
      ${panel("Dividends received", table(g.dividends || [], null, { nogo: true, empty: "No dividends yet." }))}
      ${panel("Upcoming dividends on what you hold", table(g.upcoming || [], null, { empty: "None of your holdings pay a dividend." }))}</div>`;
  };

  // Alerts
  SCREENS.ALRT = async ({ el, sym }) => {
    const draw = async (r) => {
      r = r || await api("alerts");
      el.innerHTML = `<div class="grid g2e">${panel("New price alert", `<form class="pb row" id="af"><input class="in num" id="a-s" placeholder="Ticker" size="8" value="${esc(sym || S.sym)}" style="text-transform:uppercase">
        <select class="in" id="a-d"><option value="above">goes above</option><option value="below">falls below</option></select><input class="in num" id="a-p" type="number" step="any" placeholder="Price" size="10"><button class="btn pri">Add</button></form>
        ${note("Checked every 15 seconds on the server, even when this page is closed. When one hits, the AI adds a two-sentence explanation from the latest headlines and earnings dates.", "cap")}`)}
        ${panel("Active alerts", table(r.alerts.map((a, i) => ({ ...a, i })), [{ k: "symbol", h: "Symbol", f: x => symLink(x.symbol) }, "direction", { k: "price", h: "Price", f: x => px(x.price) }, { k: "now", h: "Now", f: x => qspan(x.symbol) },
          { k: "triggered", h: "Status", cls: "l s", f: x => x.triggered != null ? `<span class="chip pos">Hit at ${px(x.triggered)}</span>${x.why ? `<div class="dim" style="max-width:420px;margin-top:3px">${esc(x.why)}</div>` : ""}` : `<span class="chip">Watching</span>` },
          { k: "x", h: "", f: x => `<button class="btn sm" data-rm="${x.i}">Remove</button>` }], { nogo: true, empty: "No alerts set." }))}</div>`;
      $("#af").onsubmit = async e => { e.preventDefault(); try { draw(await post("alerts", { action: "add", symbol: $("#a-s").value.trim().toUpperCase(), direction: $("#a-d").value, price: $("#a-p").value })); } catch (er) { toast(er.message, "bad"); } };
      $$("[data-rm]", el).forEach(b => b.onclick = async () => draw(await post("alerts", { action: "remove", index: b.dataset.rm })));
      pollQuotes();
    };
    await draw();
  };

  // Overview
  SCREENS.DES = async ({ el, sym, chart, ok }) => {
    const o = await api("overview", { s: sym }); if (!ok()) return;
    const i = o.info || {};
    el.innerHTML = `<div class="grid g2"><div class="col">${panel("Price", `<div class="pb"><div id="mini" class="chart"></div></div>`, seg(["1D", "1M", "1Y", "5Y"], pref("des.range", "1Y"), "rg"))}
      ${i.longBusinessSummary ? panel("About", `<div class="pb about">${esc(i.longBusinessSummary)}</div>`) : ""}</div>
      <div class="col">${panel("Key facts", kv(i, Object.keys(i).filter(k => k !== "longBusinessSummary" && k !== "website")) + (i.website ? `<div class="pb"><a href="${esc(i.website)}" target="_blank" rel="noopener">${esc(i.website)}</a></div>` : ""))}
      ${panel("Headlines", `<div id="hl" class="news"><div class="loading">Loading</div></div>`, `<a class="btn sm" href="#/N/${esc(sym)}">All news</a>`)}</div></div>`;
    let c = null; const load = async rg => { const h = await api("history", { s: sym, range: rg }); if (!ok()) return; const cfg = { t: h.t, c: h.c, intraday: h.intraday, kind: "area", baseline: h.prev_close, name: sym }; if (c) c.set(cfg); else c = chart(new window.TChart($("#mini"), cfg)); };
    $$("[data-rg]", el).forEach(b => b.onclick = () => { $$("[data-rg]", el).forEach(x => x.classList.toggle("on", x === b)); setPref("des.range", b.dataset.rg); load(b.dataset.rg); });
    load(pref("des.range", "1Y"));
    api("news", { s: sym, n: 6 }).then(n => ok() && ($("#hl").innerHTML = newsList(n.items))).catch(e => $("#hl") && ($("#hl").innerHTML = note(esc(e.message), "err")));
  };
  const newsList = items => items.length ? items.map(n => `<a href="${esc(n.url)}" target="_blank" rel="noopener"><div><div class="meta"><b>${esc(n.publisher)}</b> · ${esc(n.published)}</div><div class="tt">${esc(n.title)}</div></div>${n.thumb ? `<img loading="lazy" src="${esc(n.thumb)}" alt="">` : ""}</a>`).join("") : note("No headlines.");

  // Chart
  SCREENS.GP = async ({ el, sym, chart, ok }) => {
    const st = { range: "1Y", kind: "candle", ind: new Set(["sma50", "sma200"]), vs: false };
    try { Object.assign(st, JSON.parse(localStorage.getItem("gp") || "{}"), {}); st.ind = new Set(JSON.parse(localStorage.getItem("gp-ind") || '["sma50","sma200"]')); } catch (e) { }
    const INDS = [["sma20", "SMA 20"], ["sma50", "SMA 50"], ["sma200", "SMA 200"], ["bb", "Bollinger"], ["rsi", "RSI"], ["macd", "MACD"]];
    el.innerHTML = panel("Chart", `<div class="pb"><div id="gp" class="chart tall"></div></div>`,
      `<span id="gp-rg"></span><span id="gp-kd"></span>`) + `<div class="row" id="gp-in" style="margin-top:8px">${INDS.map(([k, n]) => `<label class="chk"><input type="checkbox" data-ind="${k}" ${st.ind.has(k) ? "checked" : ""}>${n}</label>`).join("")}<label class="chk"><input type="checkbox" id="gp-vs" ${st.vs ? "checked" : ""}>vs SPY</label></div>`;
    let c = null, loading = false;
    const draw = async () => {
      $("#gp-rg").innerHTML = seg(["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "MAX"], st.range, "rg");
      $("#gp-kd").innerHTML = seg([["candle", "Candle"], ["line", "Line"], ["area", "Area"]], st.kind, "kd");
      $$("[data-rg]", el).forEach(b => b.onclick = () => { st.range = b.dataset.rg; save(); draw(); });
      $$("[data-kd]", el).forEach(b => b.onclick = () => { st.kind = b.dataset.kd; save(); draw(); });
      if (loading) return; loading = true;
      try {
        const d = await api("chart", { s: sym, range: st.range, ind: [...st.ind].join(","), vs: st.vs ? 1 : "" }); if (!ok()) return;
        const overlays = Object.entries(d.ind || {}).map(([name, v]) => ({ name, v, color: COL[name] || "#fff", dash: name.startsWith("BB") ? [3, 3] : null }));
        if (d.vs) { const base = d.c.find(v => v != null), sb = d.vs.c.find(v => v != null); overlays.push({ name: "SPY (rebased)", v: d.vs.c.map(v => v == null ? null : v / sb * base), color: "#8aa", dash: [2, 3] }); }
        const panes = [];
        if (d.rsi) panes.push({ name: "RSI", min: 0, max: 100, levels: [30, 70], series: [{ name: "RSI", v: d.rsi, color: "#ffa62b" }] });
        if (d.macd) panes.push({ name: "MACD", series: [{ type: "hist", name: "Hist", v: d.macd.hist }, { name: "MACD", v: d.macd.macd, color: "#5aa9ff" }, { name: "Signal", v: d.macd.signal, color: "#ffa62b" }] });
        const cfg = chartCfg(d, { kind: st.kind, overlays, panes, volume: true, name: sym });
        if (c) c.set(cfg); else c = chart(new window.TChart($("#gp"), cfg));
      } catch (e) { $("#gp").innerHTML = `<div class="err">${esc(e.message)}</div>`; c = null; } finally { loading = false; }
    };
    const save = () => { try { localStorage.setItem("gp", JSON.stringify({ range: st.range, kind: st.kind, vs: st.vs })); localStorage.setItem("gp-ind", JSON.stringify([...st.ind])); } catch (e) { } };
    $$("[data-ind]", el).forEach(i => i.onchange = () => { i.checked ? st.ind.add(i.dataset.ind) : st.ind.delete(i.dataset.ind); save(); draw(); });
    $("#gp-vs").onchange = e => { st.vs = e.target.checked; save(); draw(); };
    await draw();
  };

  // News
  SCREENS.N = async ({ el, sym, ok }) => {
    let sent = pref("n.sent", false);
    const draw = async () => {
      const n = await api("news", { s: sym, n: 30, sent: sent ? 1 : "" }); if (!ok()) return;
      const sc = n.sentiment;
      const items = n.items.map((x, i) => { const s = Array.isArray(sc) ? sc[i] : sc && sc[x.title]; return { ...x, s }; });
      el.innerHTML = panel("Headlines for " + sym, `<div class="news">${items.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener"><div><div class="meta"><b>${esc(x.publisher)}</b> · ${esc(x.published)}${x.s != null && typeof x.s !== "object" ? ` · <span class="${sgn(+x.s)}">${/^-?[\d.]+$/.test(x.s) ? (x.s > 0 ? "+" : "") + x.s : esc(x.s)}</span>` : ""}</div><div class="tt">${esc(x.title)}</div></div>${x.thumb ? `<img loading="lazy" src="${esc(x.thumb)}" alt="">` : ""}</a>`).join("") || note("No headlines.")}</div>`,
        `<label class="chk"><input type="checkbox" id="sent" ${sent ? "checked" : ""}>Rate with AI</label>`) +
        (n.sentiment_pending ? note("AI is rating the headlines… this refreshes in a moment.") : "") + (n.sentiment_error ? note(esc(n.sentiment_error), "err") : "");
      $("#sent").onchange = e => { sent = e.target.checked; setPref("n.sent", sent); draw(); };
      if (n.sentiment_pending) setTimeout(() => ok() && draw(), 6000);
    };
    await draw();
  };

  // Financials
  SCREENS.FA = async ({ el, sym, chart, ok }) => {
    const st = { stmt: "income", q: false, row: 0, ...pref("fa", {}) };
    const draw = async () => {
      const d = await api("financials", { s: sym, stmt: st.stmt, q: st.q ? 1 : 0 }); if (!ok()) return;
      const cols = d.columns.slice(0, 8), rows = d.rows;
      el.innerHTML = panel("Financials", `<div class="pb"><div id="fc" class="chart sm"></div></div>` + (rows.length ? `<div class="tw tall"><table class="t compact"><thead><tr><th>Item</th>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r, i) => `<tr class="go" data-r="${i}"><td class="l" style="font-family:var(--sans)">${esc(r.name)}</td>${r.values.slice(0, 8).map(v => `<td>${v == null ? "–" : big(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : note("No data for this statement.")) + (d.source ? `<div class="cap">Source: ${esc(d.source)}. Click a row to chart it.</div>` : ""),
        seg([["income", "Income"], ["balance", "Balance sheet"], ["cashflow", "Cash flow"]], st.stmt, "sm") + `<label class="chk"><input type="checkbox" id="fq" ${st.q ? "checked" : ""}>Quarterly</label>`);
      $$("[data-sm]", el).forEach(b => b.onclick = () => { st.stmt = b.dataset.sm; st.row = 0; keep(); draw(); }); $("#fq").onchange = e => { st.q = e.target.checked; keep(); draw(); };
      const show = i => { const r = rows[i]; if (!r) return; const labels = cols.slice().reverse(), v = r.values.slice(0, 8).reverse();
        chart(new window.BarChart($("#fc"), { labels, series: [{ name: r.name, v, color: (x) => x >= 0 ? "#ffa62b" : "#ff4f4f" }] })).draw(); };
      $$("tr[data-r]", el).forEach(tr => tr.onclick = () => { show(+tr.dataset.r); $("#fc").scrollIntoView({ block: "nearest" }); });
      const first = rows.findIndex(r => /revenue|total assets|operating cash/i.test(r.name)); show(first < 0 ? 0 : first);
    };
    await draw();
  };

  // Valuation
  SCREENS.VAL = async ({ el, sym }) => {
    const d = await api("valuation", { s: sym });
    if (d.needs_key) { el.innerHTML = needs(d); return; }
    const sect = (n, o) => !o ? "" : panel(n, o.error ? note(esc(o.error), "err") : kv(Array.isArray(o) ? (o[0] || {}) : o));
    el.innerHTML = `<div class="grid g2e">${sect("Discounted cash flow", d.dcf)}${sect("Rating", d.rating)}${sect("Price target", d.target)}${sect("Financial scores", d.scores)}${sect("Ratios", d.ratios)}${sect("Key metrics", d.metrics)}</div>`;
  };

  // Analysts
  SCREENS.ANR = async ({ el, sym, chart }) => {
    const d = await api("analysts", { s: sym }), r = d.recs || [];
    const up = d.target_mean && d.last ? (d.target_mean / d.last - 1) * 100 : null;
    el.innerHTML = `<div class="grid g2e">${panel("Consensus", `<div class="pb">${tiles([["Rating", esc(title(d.consensus || "–"))], ["Analysts", d.analysts ?? "–"], ["Target (mean)", money(d.target_mean), up != null ? pct(up) + " vs last" : ""], ["Target low", money(d.target_low)], ["Target high", money(d.target_high)]])}</div>`)}
      ${panel("Recommendation trend", Array.isArray(r) && r.length ? table(r, null, { nogo: true }) : note("No recommendation data."))}</div>`;
  };

  // Earnings
  SCREENS.ERN = async ({ el, sym, chart }) => {
    const d = await api("earnings", { s: sym, days: 14 });
    if (d.needs_key) { el.innerHTML = needs(d); return; }
    const h = d.history || [];
    el.innerHTML = `<div class="grid">${panel("Earnings history (EPS actual vs estimate)", h.length ? `<div class="pb"><div id="eh" class="chart sm"></div></div>${table(h, null, { nogo: true, compact: true })}` : note(esc(d.history_error || "No history.")))}
      ${panel("Reporting in the next 14 days", d.calendar && d.calendar.length ? table(d.calendar, ["symbol", "date", "hour", "epsEstimate", "revenueEstimate"], { tall: true }) : note(esc(d.calendar_error || "Nothing scheduled.")))}</div>`;
    if (h.length && $("#eh")) { const rows = h.slice().sort((a, b) => String(a.period).localeCompare(String(b.period))).slice(-12);
      chart(new window.BarChart($("#eh"), { labels: rows.map(r => String(r.period || "").slice(0, 7)), fmt: v => f2(v), series: [{ name: "Estimate", v: rows.map(r => r.estimate), color: "#6f767f" }, { name: "Actual", v: rows.map(r => r.actual), color: v => v >= 0 ? "#2fd36b" : "#ff4f4f" }] })).draw(); }
  };

  // Filings & insiders
  SCREENS.SEC = async ({ el, sym }) => {
    const d = await api("filings", { s: sym });
    const f = (d.filings || []).map(r => ({ ...r }));
    el.innerHTML = `<div class="grid">${panel("SEC filings", f.length ? table(f, null, { nogo: true, tall: true }) : note(esc(d.filings_error || "No filings.")))}
      ${panel("Insider trades", d.insiders && d.insiders.length ? table(d.insiders, null, { nogo: true, tall: true }) : note(esc(d.insiders_error || "No insider trades.")))}</div>`;
  };

  // Options
  SCREENS.OMON = async ({ el, sym, ok }) => {
    let expiry = "";
    const draw = async () => {
      const d = await api("options", { s: sym, expiry }); if (!ok()) return;
      if (!d.expiries.length) { el.innerHTML = note("No options for this symbol."); return; }
      expiry = d.expiry; const sm = d.summary || {}, last = sm.underlying_price;
      const strikes = [...new Set([...d.calls, ...d.puts].map(r => r.strike))].sort((a, b) => a - b);
      const near = strikes.filter(s => last && Math.abs(s / last - 1) < 0.18);
      const by = (arr) => Object.fromEntries(arr.map(r => [r.strike, r]));
      const C = by(d.calls), P = by(d.puts), atm = sm.atm_strike;
      const cell = (r, k, f = px) => r && r[k] != null ? f(r[k]) : "–";
      const rows = near.map(s => `<tr class="${s === atm ? "atm" : ""}"><td>${cell(C[s], "bid")}</td><td>${cell(C[s], "ask")}</td><td>${cell(C[s], "volume", v => v.toLocaleString())}</td><td>${cell(C[s], "openInterest", v => v.toLocaleString())}</td><td>${cell(C[s], "impliedVolatility", v => f2(v * 100, 0) + "%")}</td>
        <td class="strike">${f2(s)}</td><td>${cell(P[s], "bid")}</td><td>${cell(P[s], "ask")}</td><td>${cell(P[s], "volume", v => v.toLocaleString())}</td><td>${cell(P[s], "openInterest", v => v.toLocaleString())}</td><td>${cell(P[s], "impliedVolatility", v => f2(v * 100, 0) + "%")}</td></tr>`).join("");
      el.innerHTML = `<div class="grid">${panel("Expected move", `<div class="pb">${tiles([["Underlying", px(last)], ["Days to expiry", sm.days_to_expiry], ["ATM call IV", num(sm.atm_call_iv) ? f2(sm.atm_call_iv * 100, 1) + "%" : "–"], ["ATM put IV", num(sm.atm_put_iv) ? f2(sm.atm_put_iv * 100, 1) + "%" : "–"],
        ["Expected move", num(sm.expected_move_from_straddle) ? "±" + f2(sm.expected_move_from_straddle) : "–", num(sm.expected_move_pct) ? "±" + f2(sm.expected_move_pct) + "%" : ""], ["Put/call volume", f2(sm.put_call_volume_ratio)], ["Put/call open int.", f2(sm.put_call_open_interest_ratio)]])}</div>`,
        `<select class="in" id="ex">${d.expiries.map(e => `<option ${e === expiry ? "selected" : ""}>${e}</option>`).join("")}</select>`)}
        ${panel("Chain (strikes within 18% of price)", `<div class="tw tall"><table class="t compact"><thead><tr><th>Call bid</th><th>Ask</th><th>Vol</th><th>OI</th><th>IV</th><th style="text-align:center">Strike</th><th>Put bid</th><th>Ask</th><th>Vol</th><th>OI</th><th>IV</th></tr></thead><tbody>${rows}</tbody></table></div>`)}</div>`;
      $("#ex").onchange = e => { expiry = e.target.value; draw(); };
    };
    await draw();
  };

  // Backtest
  SCREENS.BT = async ({ el, sym, chart, ok }) => {
    const q = { strategy: "", period: "5y", capital: 10000, ...pref("bt", {}) };
    const draw = async () => {
      const d = await api("backtest", { s: sym, ...q }); if (!ok()) return;
      q.strategy = d.strategy;
      const st = d.stats || {};
      el.innerHTML = `<div class="grid">${panel("Strategy", `<form class="pb row" id="bf"><select class="in" id="b-s">${Object.entries(d.strategies).map(([k]) => `<option ${k === d.strategy ? "selected" : ""}>${esc(k)}</option>`).join("")}</select>
        ${Object.entries(d.strategies[d.strategy].params).map(([k, spec]) => `<label class="f">${esc(title(k))}<input class="in num" data-p="${esc(k)}" type="number" step="any" size="6" value="${esc(d.params[k])}"></label>`).join("")}
        <label class="f">Period<select class="in" id="b-p">${["1y", "2y", "5y", "10y", "max"].map(p => `<option ${p === d.period ? "selected" : ""}>${p}</option>`).join("")}</select></label>
        <label class="f">Start money<input class="in num" id="b-c" type="number" value="${q.capital}"></label><button class="btn pri">Run</button></form>${d.rule ? `<div class="cap">${esc(d.rule)}</div>` : ""}`)}
        ${d.error ? note(esc(d.error), "err") : `${panel("Results", `<div class="pb">${tiles(Object.entries(st).map(([k, v]) => [title(k), /pct|return|drawdown|rate|cagr/i.test(k) ? `<span class="${sgn(v)}">${pct(v)}</span>` : /capital|value|equity|profit|final|start/i.test(k) ? money(v) : fmtCell(k, v)]))}</div>`)}
        ${panel("Equity vs buy & hold", `<div class="pb"><div id="be" class="chart"></div></div>`)}
        ${panel("Trades", table(d.trades || [], null, { nogo: true, tall: true, empty: "No trades." }))}`}</div>`;
      $("#bf").onsubmit = e => { e.preventDefault(); const strat = $("#b-s").value; if (strat !== d.strategy) { q.strategy = strat; Object.keys(q).filter(k => !["strategy", "period", "capital"].includes(k)).forEach(k => delete q[k]); } else $$("[data-p]", el).forEach(i => q[i.dataset.p] = i.value);
        q.period = $("#b-p").value; q.capital = $("#b-c").value; setPref("bt", q); draw(); };
      if (d.equity && $("#be")) chart(new window.TChart($("#be"), { t: d.equity.t, c: d.equity.v, kind: "line", color: "#ffa62b", name: "Strategy", yfmt: v => "$" + f2(v, 0), overlays: [{ name: "Buy & hold", v: d.benchmark.v, color: "#5aa9ff" }] }));
    };
    await draw();
  };

  // World markets
  SCREENS.WEI = async ({ el, ok, every }) => {
    const draw = async () => {
      const w = await api("world"), f = await api("futures").catch(() => ({ futures: [] })); if (!ok()) return;
      const NAMES = { "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "^DJI": "Dow", "^RUT": "Russell 2000", "^VIX": "VIX", "^IRX": "3-mo T-bill", "^FVX": "5-yr yield", "^TNX": "10-yr yield", "^TYX": "30-yr yield", "ES=F": "S&P futures", "NQ=F": "Nasdaq futures", "YM=F": "Dow futures", "RTY=F": "Russell futures", "DX-Y.NYB": "US dollar", "EURUSD=X": "EUR/USD", "USDJPY=X": "USD/JPY", "GBPUSD=X": "GBP/USD" };
      const grp = (n, rows) => rows && rows.length ? panel(n, table(rows.map(r => ({ ...r, nm: NAMES[r.symbol] || r.name || r.symbol })), [{ k: "nm", h: "Name", cls: "l", f: r => esc(r.nm) }, { k: "last", h: "Last", f: r => px(r.last) }, { k: "change_pct", h: "Chg %", f: r => `<span class="${sgn(r.change_pct)}">${pct(r.change_pct)}</span>` }], { nogo: true, compact: true })) : "";
      const sec = w.sectors || [];
      el.innerHTML = `<div class="grid g3">${grp("US indexes", w.indexes)}${grp("Index futures", w.index_futures)}${grp("Rates", w.rates)}${grp("Dollar & FX", w.dollar_fx)}${grp("Commodities", w.commodities)}${grp("Crypto", w.crypto)}</div>
        ${sec.length ? `<div style="margin-top:10px">${panel("Sectors today", `<div class="pb"><div id="sec-bars" class="bars"></div></div>`)}</div>` : ""}${w.note ? note(esc(w.note), "cap") : ""}`;
      if (sec.length) { const mx = Math.max(...sec.map(s => Math.abs(s.change_pct || 0)), 0.1); $("#sec-bars").innerHTML = sec.slice().sort((a, b) => b.change_pct - a.change_pct).map(s => `<div class="b"><span>${esc(s.name || NAMES[s.symbol] || s.symbol)}</span><div class="tr"><div class="fl" style="width:${Math.abs(s.change_pct) / mx * 100}%;background:${s.change_pct >= 0 ? "var(--up)" : "var(--dn)"}"></div></div><em class="${sgn(s.change_pct)}">${pct(s.change_pct)}</em></div>`).join(""); }
    };
    await draw(); every(draw, 60000);
  };

  // Watchlists
  SCREENS.MON = async ({ el, ok }) => {
    const draw = async w => {
      w = w || await post("watchlists", {}); if (!ok()) return;
      const act = w.active, syms = w.lists[act] || [];
      let q = {}; try { q = (await api("quotes", { s: syms.join(","), spark: 1 })).quotes; Object.assign(S.quotes, q); } catch (e) { }
      el.innerHTML = `<div class="grid">${panel("Lists", `<div class="pb row">${seg(w.names, act, "ls")}<button class="btn sm" id="l-new">New</button><button class="btn sm" id="l-ren">Rename</button><button class="btn sm" id="l-del">Delete</button></div>`)}
        ${panel(act, `<form class="pb row" id="af"><input class="in num" id="w-s" placeholder="Add tickers (e.g. NVDA MSFT)" size="30" style="text-transform:uppercase"><button class="btn pri">Add</button></form>` +
          table(syms.map(s => ({ symbol: s, ...(q[s] || {}) })), [{ k: "symbol", h: "Symbol", f: r => symLink(r.symbol) }, { k: "spark", h: "", cls: "spark hide-sm", f: r => window.spark(r.spark, r.prev_close) }, { k: "last", h: "Last", f: r => qspan(r.symbol) }, { k: "chg", h: "Chg", f: r => qspan(r.symbol, "chg") },
            { k: "volume", h: "Volume", cls: "hide-sm", f: r => big(r.volume) }, { k: "x", h: "", f: r => `<button class="btn sm" data-up="${esc(r.symbol)}">↑</button> <button class="btn sm" data-dn="${esc(r.symbol)}">↓</button> <button class="btn sm" data-rm="${esc(r.symbol)}">✕</button>` }], { empty: "This list is empty." }))}</div>`;
      const act2 = async b => { try { const r = await post("watchlists", { list: act, ...b }); draw(r); sideWatch(); } catch (e) { toast(e.message, "bad"); } };
      $("#af").onsubmit = e => { e.preventDefault(); act2({ action: "add", symbol: $("#w-s").value }); };
      $$("[data-ls]", el).forEach(b => b.onclick = async () => { draw(await post("watchlists", { action: "activate", name: b.dataset.ls })); sideWatch(); });
      $$("[data-rm]", el).forEach(b => b.onclick = () => act2({ action: "remove", symbol: b.dataset.rm }));
      $$("[data-up]", el).forEach(b => b.onclick = () => act2({ action: "move", symbol: b.dataset.up, step: -1 }));
      $$("[data-dn]", el).forEach(b => b.onclick = () => act2({ action: "move", symbol: b.dataset.dn, step: 1 }));
      $("#l-new").onclick = () => { const n = prompt("Name for the new list"); if (n) act2({ action: "create", name: n }); };
      $("#l-ren").onclick = () => { const n = prompt("New name", act); if (n) act2({ action: "rename", old: act, name: n }); };
      $("#l-del").onclick = () => { if (w.names.length > 1 && confirm(`Delete "${act}"?`)) act2({ action: "delete", name: act }); };
      bindTables(el); pollQuotes();
    };
    await draw();
  };

  // S&P 500
  SCREENS.SPX = async ({ el, chart, ok }) => {
    const draw = async () => {
      const d = await api("sp500"); if (!ok()) return;
      if (!d.rows) { el.innerHTML = note(d.error ? esc(d.error) : "Scanning the S&P 500 for the first time… this takes a minute.", d.error ? "err" : "note box"); if (!d.error) setTimeout(() => ok() && draw(), 8000); return; }
      const bySec = {}; d.rows.forEach(r => (bySec[r.sector || "Other"] ||= []).push({ label: r.symbol, sub: pct(r.chg_1d, 1), size: r.market_cap || 1, value: r.chg_1d || 0 }));
      el.innerHTML = `<div class="grid">${panel("Market map (today)", `<div id="tm" class="tmap"></div>`, `<small>${Math.round(d.age / 60)} min old${d.refreshing ? " · refreshing" : ""}</small>`)}
        ${panel("Stocks", `<div class="pb"><input class="in" id="flt" placeholder="Filter by name, ticker or sector" size="34"></div><div id="spt"></div>`)}</div>`;
      const colr = v => { const a = Math.min(Math.abs(v) / 3, 1); return v >= 0 ? `rgb(${Math.round(20 - 0 * a)},${Math.round(60 + 110 * a)},${Math.round(35 + 40 * a)})` : `rgb(${Math.round(70 + 150 * a)},${Math.round(30 + 10 * a)},${Math.round(30 + 10 * a)})`; };
      window.treemap($("#tm"), Object.entries(bySec).map(([name, items]) => ({ name, items })), colr, it => go("DES", it.label));
      const rowsHtml = f => table(d.rows.filter(r => !f || (r.symbol + " " + r.name + " " + r.sector).toLowerCase().includes(f)), ["symbol", "name", "sector", "last", "chg_1d", "chg_1m", "chg_3m", "chg_1y", "from_high", "rsi", "market_cap", "pe", "div_yield", "analyst_rating"], { tall: true });
      const put = f => { $("#spt").innerHTML = rowsHtml(f); bindTables($("#spt")); };
      put(""); $("#flt").oninput = e => put(e.target.value.toLowerCase());
    };
    await draw();
  };

  // Ideas
  SCREENS.IDEA = async ({ el, ok }) => {
    let list = pref("idea", "");
    const draw = async () => {
      const d = await api("ideas", { list }); if (!ok()) return;
      if (d.pending || d.error) { el.innerHTML = note(d.error ? esc(d.error) : "Scanning the S&P 500 first… this takes a minute.", d.error ? "err" : "note box"); if (!d.error) setTimeout(() => ok() && draw(), 8000); return; }
      list = d.list;
      el.innerHTML = `<div class="grid">${panel("Idea lists", `<div class="pb row">${seg(Object.entries(d.lists), list, "il")}</div><div class="cap">${esc(d.desc)} ${d.passed} of ${d.universe} stocks pass the quick checks.</div>`)}
        ${panel("Matches", table(d.rows, [{ k: "symbol", h: "Symbol", f: r => symLink(r.symbol) }, { k: "name", h: "Name", cls: "l s" }, { k: "last", h: "Last", f: r => px(r.last) }, { k: "chg_1d", h: "Day", f: r => `<span class="${sgn(r.chg_1d)}">${pct(r.chg_1d)}</span>` },
          { k: "passed", h: "Score", f: r => `${r.passed}/${r.total}` }, { k: "checks", h: "Checks", cls: "l s", f: r => r.checks.map(c => `<span class="chip ${c.state ? "y" : "n"}">${esc(c.label)}${c.pending ? "…" : ""}</span>`).join("") }]))}
        ${d.deep_pending ? note("Running the deeper checks in the background… refreshing.") : ""}
        ${panel("What the checks mean", `<div class="pb list">${d.explain.map(([a, b]) => `<div class="it"><b class="amber">${esc(a)}</b> <span class="dim">${esc(b)}</span></div>`).join("")}</div>`)}</div>`;
      $$("[data-il]", el).forEach(b => b.onclick = () => { list = b.dataset.il; setPref("idea", list); draw(); });
      if (d.deep_pending) setTimeout(() => ok() && draw(), 8000);
    };
    await draw();
  };

  // Earnings calendar
  SCREENS.CAL = async ({ el }) => {
    const d = await api("calendar");
    if (d.needs_key) { el.innerHTML = needs(d); return; }
    el.innerHTML = panel(`Earnings for your ${d.held} holdings and ${d.watch} watchlist stocks`, table(d.rows.map(r => ({ ...r, holding: r.holding ? "Held" : "" })), [{ k: "symbol", h: "Symbol", f: r => symLink(r.symbol) }, "date", { k: "hour", h: "When", f: r => ({ bmo: "Before open", amc: "After close", dmh: "During hours" }[r.hour] || esc(r.hour || "–")) }, { k: "eps", h: "EPS est", f: r => px(r.eps) }, { k: "revenue", h: "Revenue est", f: r => big(r.revenue) }, { k: "record", h: "Track record", cls: "l s" }, "holding"], { empty: "Nothing reports soon." }));
  };

  // Predictions
  SCREENS.PRED = async ({ el, ok }) => {
    let topic = pref("pred", "Fed & rates"), qtext = "";
    const draw = async () => {
      const d = await api("predictions", { topic, q: qtext }); if (!ok()) return;
      topic = d.topic;
      const ev = e => `<div class="pred"><a href="${esc(e.url || "#")}" target="_blank" rel="noopener">${esc(e.title)}</a><div class="muted" style="font-size:11px">${esc(e.source || "")}${e.ends ? " · ends " + esc(String(e.ends).slice(0, 10)) : ""}</div>${(e.outcomes || []).slice(0, 5).map(([n, p], i) => `<div class="o"><span>${esc(n)}</span><div class="tr"><div class="fl ${i === 0 ? "top" : ""}" style="width:${(p * 100).toFixed(0)}%"></div></div><em>${f2(p * 100, 0)}%</em></div>`).join("")}</div>`;
      el.innerHTML = `<div class="grid">${panel("Prediction markets", `<div class="pb row">${seg(d.topics, topic, "tp")}<input class="in" id="pq" placeholder="Search" size="18" value="${esc(qtext)}"></div>`)}
        ${d.blocked ? note("This network blocks the public prediction sites (the connection is cut during the secure handshake).", "note box") : ""}
        ${d.events.length ? `<div class="grid gauto">${d.events.map(ev).join("")}</div>` : (d.blocked ? "" : note("No matching markets."))}
        ${Object.entries(d.errors || {}).filter(() => !d.blocked).map(([k, v]) => note(`${esc(k)}: ${esc(v)}`, "cap")).join("")}
        ${d.ibkr ? panel("ForecastEx products", `<form class="pb row" id="pf"><input class="in" id="pc" size="30" value="${esc((d.codes || []).join(" "))}"><button class="btn">Save codes</button></form>`) : ""}</div>`;
      $$("[data-tp]", el).forEach(b => b.onclick = () => { topic = b.dataset.tp; setPref("pred", topic); draw(); });
      $("#pq").onchange = e => { qtext = e.target.value; draw(); };
      if ($("#pf")) $("#pf").onsubmit = async e => { e.preventDefault(); await post("predictions", { codes: $("#pc").value }); draw(); };
    };
    await draw();
  };

  // Screens
  SCREENS.SCR = async ({ el, ok }) => {
    let name = pref("scr", "");
    const draw = async () => {
      const d = await api("screens", { name }); if (!ok()) return; name = d.name;
      el.innerHTML = panel("Screens", `<div class="pb row">${seg(d.names, name, "sc")}</div>` + table(d.rows, null, { tall: true, empty: "No results right now." }));
      $$("[data-sc]", el).forEach(b => b.onclick = () => { name = b.dataset.sc; setPref("scr", name); draw(); }); bindTables(el);
    };
    await draw();
  };

  // Economy
  SCREENS.ECO = async ({ el, chart }) => {
    const d = await api("economy");
    if (d.needs_key) { el.innerHTML = needs(d); return; }
    el.innerHTML = (d.fed && d.fed.length ? panel("Fed odds (prediction markets)", `<div class="pb">${d.fed.map(e => `<div><b>${esc(e.title)}</b> ${(e.outcomes || []).slice(0, 4).map(([n, p]) => `<span class="chip">${esc(n)} ${f2(p * 100, 0)}%</span>`).join("")}</div>`).join("")}</div>`) : "") +
      `<div class="grid gauto" style="margin-top:10px">${d.series.map((s, i) => panel(s.name, s.error ? note(esc(s.error), "err") : `<div class="pb"><span class="big">${f2(s.last)}</span> <span class="${sgn(s.last - s.prev)}">${s.last - s.prev >= 0 ? "+" : ""}${f2(s.last - s.prev)}</span><div class="cap" style="padding-left:0">as of ${esc(s.as_of)}</div><div id="eco${i}" class="chart xs"></div></div>`)).join("")}</div>`;
    d.series.forEach((s, i) => { if (!s.error && $("#eco" + i)) chart(new window.TChart($("#eco" + i), { t: s.t, c: s.v, kind: "line", intraday: false, legend: false, axes: false })); });
  };

  // Ask AI
  SCREENS.AI = async ({ el, sym }) => {
    const ai = S.boot.ai;
    const EX = ["What's moving the market today?", "Summarise my portfolio and its biggest risks", sym ? `Is ${sym} a good value right now?` : "Which of my holdings reports earnings soon?", "Explain what a covered call is"];
    el.innerHTML = `<div class="chat"><div class="msgs" id="msgs"></div>${ai.provider ? "" : note("No AI is set up. Sign in under <a href='#/CLD'>CLD</a> or add a Gemini key on the add-on's Configuration tab.", "note box")}
      <form id="cf"><textarea class="in" id="cq" placeholder="Ask about ${sym || "markets, your holdings, anything"}…" rows="1"></textarea><button class="btn pri" id="cs">Ask</button></form></div>`;
    const box = $("#msgs");
    const add = (role, text) => { const d = document.createElement("div"); d.className = "msg " + role; d.innerHTML = `<div class="who">${role === "user" ? "YOU" : "AI"}</div><div class="status"></div><div class="body md">${role === "user" ? esc(text) : md(text)}</div>`; box.append(d); box.scrollTop = box.scrollHeight; return d; };
    S.chat.forEach(m => add(m.role, m.content));
    if (!S.chat.length) box.innerHTML = `<div class="examples">${EX.map(x => `<button class="btn" data-ex="${esc(x)}">${esc(x)}</button>`).join("")}</div>`;
    $$("[data-ex]", box).forEach(b => b.onclick = () => { $("#cq").value = b.dataset.ex; $("#cf").requestSubmit(); });
    $("#cq").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#cf").requestSubmit(); } };
    $("#cf").onsubmit = async e => {
      e.preventDefault(); const q = $("#cq").value.trim(); if (!q) return; $("#cq").value = "";
      if (!S.chat.length) box.innerHTML = "";
      S.chat.push({ role: "user", content: q }); add("user", q);
      const m = add("assistant", ""), body = $(".body", m), status = $(".status", m); let text = ""; $("#cs").disabled = true;
      try {
        const r = await fetch("api/ask", { method: "POST", headers: { "X-Terminal": "1", "Content-Type": "application/json" }, body: JSON.stringify({ messages: S.chat, screen: S.fn, symbol: S.sym }) });
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { done, value } = await rd.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); const parts = buf.split("\n\n"); buf = parts.pop();
          for (const p of parts) {
            const line = p.split("\n").find(l => l.startsWith("data: ")); if (!line) continue;
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "text") { text += ev.text; body.innerHTML = md(text); status.textContent = ""; }
            else if (ev.type === "tool") status.textContent = "Looking up " + ev.name.replace(/_/g, " ") + "…";
            else if (ev.type === "status") status.textContent = ev.text;
            else if (ev.type === "error") { body.innerHTML = `<span class="dn">${esc(ev.text)}</span>`; status.textContent = ""; }
            box.scrollTop = box.scrollHeight;
          }
        }
        if (text) S.chat.push({ role: "assistant", content: text }); else S.chat.pop();
      } catch (er) { body.innerHTML = `<span class="dn">${esc(er.message)}</span>`; S.chat.pop(); }
      status.textContent = ""; $("#cs").disabled = false;
    };
  };

  // Morning brief
  SCREENS.BRF = async ({ el, ok, every }) => {
    const draw = async (b = {}) => {
      const d = await post("brief", b); if (!ok()) return;
      if (d.no_ai) { el.innerHTML = note("No AI is set up yet. Connect Claude (CLD) or add a Gemini key.", "note box"); return; }
      if (d.error) { el.innerHTML = panel("Morning brief", note(esc(d.error), "err") + `<div class="pb"><button class="btn" id="rt">Try again</button></div>`); $("#rt").onclick = () => draw({ retry: 1 }); return; }
      if (d.running) { el.innerHTML = note(`Writing today's brief with ${esc(d.provider)}… ${d.seconds}s`, "note box"); setTimeout(() => ok() && draw(), 4000); return; }
      el.innerHTML = panel(`Morning brief ${esc(d.date)}`, `<div class="pb md" style="max-width:900px">${md(d.text)}</div>`, `<small>Written ${esc(d.written)} by ${esc(d.provider || "AI")}</small><button class="btn sm" id="rw">Rewrite</button>`);
      $("#rw").onclick = () => draw({ rewrite: 1 });
    };
    await draw();
  };

  // Trading plan
  SCREENS.PLAN = async ({ el }) => {
    const d = await api("plan");
    el.innerHTML = panel("My trading plan", `<form class="pb ticket" id="pf" style="max-width:640px">${Object.entries(d.fields).map(([k, [label, hint, type, def]]) => {
      const v = d.values[k] ?? def, ch = String(type).startsWith("choice:") ? type.slice(7).split("|") : null;
      return `<label class="f">${esc(label)}${ch ? `<select class="in" name="${k}">${ch.map(c => `<option ${c === v ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>` : type === "area" ? `<textarea class="in" name="${k}" rows="2">${esc(v)}</textarea>` : `<input class="in num" name="${k}" type="number" step="any" value="${esc(v)}">`}${hint ? `<span class="muted">${esc(hint)}</span>` : ""}</label>`; }).join("")}
      <button class="btn pri">Save plan</button></form>${note("The AI reads this to tailor its answers, and the order ticket warns when a trade breaks your size limit.", "cap")}`);
    $("#pf").onsubmit = async e => { e.preventDefault(); const v = {}; $$("[name]", el).forEach(i => v[i.name] = i.type === "number" ? parseFloat(i.value) || 0 : i.value); await post("plan", { values: v }); toast("Plan saved", "good"); };
  };

  // Connect Claude
  SCREENS.CLD = async ({ el, ok }) => {
    const draw = async (b = {}) => {
      const d = await post("claude", b); if (!ok()) return;
      if (!d.installed) { el.innerHTML = note("Claude Code isn't installed in this environment, so sign-in isn't available. Use a Gemini key instead.", "note box"); return; }
      const L = d.login;
      el.innerHTML = panel("Connect Claude", `<div class="pb col">
        <div>${d.signed_in ? `<span class="chip pos">Signed in</span> ${esc(d.email || "")} ${esc(d.plan || "")}` : d.expired ? `<span class="chip neg">Sign-in expired</span>` : `<span class="chip">Not signed in</span>`} · AI in use: <b>${esc(d.provider || "none")}</b></div>
        ${L && !L.done ? `<div>1. Open <a href="${esc(L.url || "#")}" target="_blank" rel="noopener">the Claude sign-in page</a>, approve, and copy the code.<br>2. Paste it here:</div><form class="row" id="cc"><input class="in num" id="code" size="40"><button class="btn pri">Submit code</button><button type="button" class="btn" id="cn">Cancel</button></form>` : ""}
        ${L && L.done ? note(esc(L.result || "Done"), "note") : ""}
        <div class="row">${d.signed_in ? `<button class="btn" id="ct">Test</button><button class="btn" id="co">Sign out</button>` : `<button class="btn pri" id="cs2">Sign in with Claude</button>`}</div><div id="cr"></div></div>`);
      if ($("#cs2")) $("#cs2").onclick = () => draw({ action: "start" });
      if ($("#co")) $("#co").onclick = () => draw({ action: "logout" });
      if ($("#cn")) $("#cn").onclick = () => draw({ action: "cancel" });
      if ($("#cc")) $("#cc").onsubmit = e => { e.preventDefault(); draw({ action: "code", code: $("#code").value }); };
      if ($("#ct")) $("#ct").onclick = async () => { $("#cr").innerHTML = `<div class="loading">Testing</div>`; try { $("#cr").innerHTML = note(esc((await post("claude", { action: "test" })).answer), "note up"); } catch (e) { $("#cr").innerHTML = note(esc(e.message), "err"); } };
      if (L && !L.done) setTimeout(() => ok() && draw(), 5000);
    };
    await draw();
  };

  // Data collection
  SCREENS.DATA = async ({ el }) => {
    const draw = async (b = {}) => {
      const d = await post("data", b);
      if (d.test) toast(d.test, d.test_ok ? "good" : "bad");
      if (d.enabled === false) { el.innerHTML = note(`Data collection is off. ${esc(d.why || "")}`, "note box"); return; }
      el.innerHTML = `<div class="grid">${panel("Data collection", kv({ where: d.where, symbols_tracked: d.own, minute_backfill_days: d.minute_days, ...(d.usage || {}) }) + `<div class="pb row"><button class="btn pri" id="dr">Run now</button><button class="btn" id="dt">Test storage</button></div>${d.error ? note(esc(d.error), "err") : ""}`)}
        ${panel("Recent runs", table(Array.isArray(d.runs) ? d.runs : [], null, { nogo: true, empty: "No runs yet." }))}</div>`;
      $("#dr").onclick = () => { draw({ action: "run" }); toast("Collection started"); }; $("#dt").onclick = () => draw({ action: "test" });
    };
    await draw();
  };

  // Help
  SCREENS.HELP = async ({ el }) => {
    el.innerHTML = panel("How to use the terminal", `<div class="pb about md" style="max-width:760px">
      <p>Type in the bar at the top (press <code>/</code> to jump to it).</p>
      <ul><li><b>A ticker</b> opens its overview: <code>NVDA</code></li><li><b>Ticker + function</b> goes straight to a screen: <code>NVDA GP</code> (chart), <code>AAPL N</code> (news), <code>TSLA OMON</code> (options)</li>
      <li><b>A function code</b> opens that screen: <code>PORT</code>, <code>WEI</code>, <code>IDEA</code>, <code>AI</code></li></ul>
      <p>On a phone, use the bottom tabs and the row of chips under the top bar. Click any column heading in a table to sort it. Prices on screen update every few seconds.</p>
      <h3>Keyboard shortcuts</h3>${keyList()}
      <p class="dim">Each screen remembers its settings (chart range and indicators, statement, screen, idea list) in this browser, and the box at the top lists your recent tickers when it's empty.</p>
      <h3>Functions</h3>${Object.entries(S.boot.functions).map(([g, items]) => `<p><b>${g}</b>: ${Object.entries(items).map(([k, n]) => `<a href="#/${k}"><code>${k}</code></a> ${esc(n)}`).join(" · ")}</p>`).join("")}
      <p class="dim">Version ${esc(S.boot.version)}. This tool shows data and places orders you confirm; it does not give investment advice.</p></div>`);
  };

  // ---------- boot ----------
  function clock() {
    const d = new Date(), t = z => d.toLocaleTimeString("en-US", { timeZone: z, hour: "2-digit", minute: "2-digit", hour12: false });
    $("#clock").innerHTML = `NY <b>${t("America/New_York")}</b> · LON <b>${t("Europe/London")}</b> · TYO <b>${t("Asia/Tokyo")}</b>`;
  }
  async function events() {
    let since = 0;
    let first = true;
    const tick = async () => {
      try {
        const r = await api("events", { since });
        if (!first) r.events.forEach(e => toast(e.kind === "alert-why" ? "Why: " + e.text : e.text, e.kind === "alert" ? "good" : "", e.kind === "alert-why" ? 20000 : 7000));
        since = r.last; first = false;  // the first call only learns where the list is, so old events don't replay on every page load
        if (r.events.some(e => e.kind.startsWith("alert")) && S.fn === "ALRT") render();
      } catch (e) { }
    };
    await tick(); setInterval(tick, 20000);
  }
  // Broker connections and the AI check finish in the background on the server; until then boot says
  // `pending` and we ask again, then redraw the screens that needed them.
  async function bootFollowUp() {
    for (let i = 0; i < 60 && S.boot.pending; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const b = await api("boot");
        const changed = JSON.stringify(b.brokers) !== JSON.stringify(S.boot.brokers) || JSON.stringify(b.ai) !== JSON.stringify(S.boot.ai);
        S.boot = b;
        if (!S.broker) S.broker = b.brokers[0] || null;
        if (!b.pending) Object.entries(b.broker_errors || {}).forEach(([k, v]) => toast(`${k}: ${v}`, "bad"));
        if (changed && NEEDS_BOOT.has(S.fn)) render();
      } catch (e) { }
    }
  }
  const NEEDS_BOOT = new Set(["PORT", "ORD", "AI", "GAIN", "JRNL"]);
  async function start() {
    try { S.boot = await api("boot"); }
    catch (e) { $("#main").innerHTML = `<div class="err">Couldn't start: ${esc(e.message)}</div>`; return; }
    Object.entries(S.boot.functions).forEach(([g, items]) => Object.keys(items).forEach(k => FN_GROUP[k] = g));
    const m = $("#mode"); m.textContent = S.boot.mode; m.className = "mode " + (S.boot.live ? "live" : "paper");
    S.broker = S.boot.brokers[0] || null;
    if (!S.boot.pending) Object.entries(S.boot.broker_errors || {}).forEach(([k, v]) => toast(`${k}: ${v}`, "bad"));
    clock(); setInterval(clock, 30000);
    window.addEventListener("hashchange", render);
    if (!location.hash) location.hash = pref("last", "#/PORT"); else render();
    sideWatch(); events(); bootFollowUp();
    setInterval(() => { if (!live.on) pollQuotes(); }, 5000);  // backup when the live stream can't connect
    setInterval(() => !document.hidden && sideWatch(), 120000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollQuotes(); liveSync(true); } else liveStop(); });
  }
  start();
})();
