(function () {
  "use strict";
  const CFG = window.BUDGET_CONFIG;
  const RULES_TAB = CFG.RULES_TAB || "Règles";
  const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
  const API = "https://sheets.googleapis.com/v4/spreadsheets/" + CFG.SHEET_ID;
  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
  const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

  let token = null, tokenClient = null;
  let ops = [], soldes = [], rules = [];
  const state = { period: "all", q: "", cat: "", sub: "", type: "", sort: "date", dir: -1, page: 0 };
  const PAGE = 50;
  const charts = {};
  let pendingImport = null;

  // ---------- Auth ----------
  function saveToken(t, expiresIn) {
    token = t;
    try { sessionStorage.setItem("br_token", JSON.stringify({ t, exp: Date.now() + (expiresIn - 60) * 1000 })); } catch (e) {}
  }
  function loadToken() {
    try {
      const s = JSON.parse(sessionStorage.getItem("br_token") || "null");
      if (s && s.exp > Date.now()) token = s.t;
    } catch (e) {}
  }
  function clearToken() {
    token = null;
    try { sessionStorage.removeItem("br_token"); } catch (e) {}
  }
  function initGis() {
    if (tokenClient || !window.google || !google.accounts || !google.accounts.oauth2) return !!tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { $("signin-error").textContent = "Connexion refusée : " + resp.error; return; }
        saveToken(resp.access_token, Number(resp.expires_in) || 3600);
        start();
      }
    });
    return true;
  }
  function signIn() {
    $("signin-error").textContent = "";
    if (!CFG.GOOGLE_CLIENT_ID) { $("signin-error").textContent = "Renseigne d'abord GOOGLE_CLIENT_ID dans config.js."; return; }
    if (!initGis()) { $("signin-error").textContent = "Le service de connexion Google n'est pas encore chargé, réessaie dans un instant."; return; }
    tokenClient.requestAccessToken({ prompt: token ? "" : "consent" });
  }

  async function api(path, opts) {
    const res = await fetch(API + path, Object.assign({}, opts, {
      headers: Object.assign({ Authorization: "Bearer " + token, "Content-Type": "application/json" }, (opts || {}).headers)
    }));
    if (res.status === 401) { clearToken(); showSignin("Ta session Google a expiré, reconnecte-toi."); throw new Error("401"); }
    if (!res.ok) throw new Error("Erreur Google Sheets " + res.status + " : " + (await res.text()).slice(0, 300));
    return res.json();
  }

  // ---------- Data ----------
  function serialToISO(v) {
    if (typeof v === "number") {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return d.toISOString().slice(0, 10);
    }
    return parseDateStr(String(v || ""));
  }
  function parseDateStr(s) {
    s = s.trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + "-" + m[2] + "-" + m[3];
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (m) {
      const y = m[3].length === 2 ? "20" + m[3] : m[3];
      return y + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
    }
    return "";
  }
  function toNum(v) {
    if (typeof v === "number") return v;
    const n = parseFloat(String(v || "").replace(/\s|€/g, "").replace(",", "."));
    return isNaN(n) ? 0 : n;
  }
  const keyOf = (o) => o.date + "|" + o.lib.trim() + "|" + o.amount.toFixed(2);

  async function loadData() {
    const r = encodeURIComponent;
    const data = await api("/values:batchGet?ranges=" + r(CFG.OPS_TAB + "!A2:H") + "&ranges=" + r(CFG.SOLDES_TAB + "!A2:D") + "&ranges=" + r(RULES_TAB + "!A2:C") +
      "&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER");
    const [o, s, ru] = data.valueRanges.map((v) => v.values || []);
    rules = (ru || []).map((row) => ({ text: String(row[0] || "").trim(), cat: String(row[1] || "").trim(), sub: String(row[2] || "").trim() }))
      .filter((x) => x.text && x.cat);
    ops = o.map((row, i) => ({
      i,
      row: i + 2,
      date: row[0] === undefined || row[0] === "" ? "" : serialToISO(row[0]),
      bankCat: String(row[1] || "Sans catégorie"),
      bankSub: String(row[2] || ""),
      lib: String(row[3] || ""),
      amount: toNum(row[4]),
      ovCat: String(row[8] || "").trim(),
      ovSub: String(row[9] || "").trim()
    })).filter((x) => x.date);
    ops.forEach(applyRules);
    soldes = s.filter((row) => row[0] !== undefined && row[0] !== "").map((row) => ({ date: serialToISO(row[0]), solde: toNum(row[1]) }))
      .filter((x) => x.date).sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---------- Catégories : manuel > règle > banque ----------
  function ruleFor(lib) {
    const L = lib.toUpperCase();
    return rules.find((r) => {
      const t = r.text.toUpperCase();
      return t[0] === "^" ? L.startsWith(t.slice(1)) : L.includes(t);
    });
  }
  function applyRules(o) {
    const r = ruleFor(o.lib);
    if (o.ovCat) { o.cat = o.ovCat; o.sub = o.ovSub; o.src = "manuel"; }
    else if (r) { o.cat = r.cat; o.sub = r.sub; o.src = "règle"; o.rule = r.text; }
    else { o.cat = o.bankCat; o.sub = o.bankSub; o.src = "banque"; }
  }

  // ---------- Period ----------
  function months() { return [...new Set(ops.map((o) => o.date.slice(0, 7)))].sort(); }
  function buildPeriods() {
    const sel = $("period"), prev = state.period;
    const ms = months(), years = [...new Set(ms.map((m) => m.slice(0, 4)))].sort().reverse();
    let html = '<option value="all">Tout l\'historique</option><option value="12m">12 derniers mois</option><option value="3m">3 derniers mois</option>';
    years.forEach((y) => { html += '<option value="y' + y + '">Année ' + y + "</option>"; });
    ms.slice().reverse().forEach((m) => { html += '<option value="m' + m + '">' + monthLabel(m, true) + "</option>"; });
    sel.innerHTML = html;
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "all";
    state.period = sel.value;
  }
  function monthLabel(m, long) {
    const [y, mm] = m.split("-");
    return (long ? MONTHS_LONG : MONTHS)[Number(mm) - 1] + " " + y;
  }
  function periodRange() {
    const p = state.period, ms = months();
    if (!ms.length) return ["0000-00-00", "9999-99-99"];
    const last = ms[ms.length - 1];
    const back = (n) => { const d = new Date(last + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - (n - 1)); return d.toISOString().slice(0, 7); };
    if (p === "12m") return [back(12) + "-01", "9999-99-99"];
    if (p === "3m") return [back(3) + "-01", "9999-99-99"];
    if (p[0] === "y") return [p.slice(1) + "-01-01", p.slice(1) + "-12-31"];
    if (p[0] === "m") return [p.slice(1) + "-01", p.slice(1) + "-31"];
    return ["0000-00-00", "9999-99-99"];
  }
  const inPeriod = (o, [a, b]) => o.date >= a && o.date <= b;

  // ---------- Balance ----------
  function balanceSeries() {
    if (!soldes.length || !ops.length) return [];
    const ref = soldes[soldes.length - 1];
    const days = [...new Set(ops.map((o) => o.date).concat([ref.date]))].sort();
    const byDay = {};
    ops.forEach((o) => { byDay[o.date] = (byDay[o.date] || 0) + o.amount; });
    // solde(d) = solde_ref - somme des opérations après d jusqu'à la date de référence ; au-delà, on ajoute.
    const out = [];
    let after = 0;
    const before = days.filter((d) => d <= ref.date).reverse();
    before.forEach((d) => { out.push({ date: d, v: ref.solde - after }); after += byDay[d] || 0; });
    out.reverse();
    let run = ref.solde;
    days.filter((d) => d > ref.date).forEach((d) => { run += byDay[d] || 0; out.push({ date: d, v: run }); });
    return out;
  }

  // ---------- Render ----------
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function chart(id, cfg) {
    if (charts[id]) charts[id].destroy();
    const c = css("--muted"), g = css("--border");
    Chart.defaults.color = c;
    Chart.defaults.borderColor = g;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    charts[id] = new Chart($(id), cfg);
  }
  const money = (v) => fmt.format(v);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function render() {
    const range = periodRange();
    const P = ops.filter((o) => inPeriod(o, range));
    const inc = P.filter((o) => o.amount > 0).reduce((s, o) => s + o.amount, 0);
    const out = P.filter((o) => o.amount < 0).reduce((s, o) => s + o.amount, 0);
    const bal = balanceSeries();
    const balIn = bal.filter((b) => b.date >= range[0] && b.date <= range[1]);
    const lastBal = balIn.length ? balIn[balIn.length - 1] : bal[bal.length - 1];
    $("k-solde").textContent = lastBal ? money(lastBal.v) : "–";
    $("k-solde-date").textContent = lastBal ? lastBal.date.split("-").reverse().join("/") : "";
    $("k-in").textContent = money(inc);
    $("k-out").textContent = money(-out);
    $("k-net").textContent = money(inc + out);
    $("k-net").className = "value " + (inc + out >= 0 ? "pos" : "neg");
    $("period-info").textContent = P.length ? P.length + " opérations du " + fr(P[0].date) + " au " + fr(P[P.length - 1].date) : "Aucune opération";

    // Mois
    const ms = [...new Set(P.map((o) => o.date.slice(0, 7)))].sort();
    const mi = ms.map((m) => P.filter((o) => o.date.startsWith(m) && o.amount > 0).reduce((s, o) => s + o.amount, 0));
    const mo = ms.map((m) => -P.filter((o) => o.date.startsWith(m) && o.amount < 0).reduce((s, o) => s + o.amount, 0));
    chart("ch-month", {
      type: "bar",
      data: { labels: ms.map((m) => monthLabel(m)), datasets: [
        { label: "Revenus", data: mi, backgroundColor: css("--c2"), borderRadius: 4 },
        { label: "Dépenses", data: mo, backgroundColor: css("--c3"), borderRadius: 4 }] },
      options: { maintainAspectRatio: false, plugins: { tooltip: { callbacks: { label: (c) => c.dataset.label + " : " + money(c.raw) } } },
        scales: { y: { ticks: { callback: (v) => fmt.format(v).replace(",00", "") } } } }
    });

    // Solde
    chart("ch-balance", {
      type: "line",
      data: { labels: balIn.map((b) => fr(b.date)), datasets: [{ label: "Solde", data: balIn.map((b) => b.v), borderColor: css("--c1"),
        backgroundColor: css("--c1") + "22", fill: true, pointRadius: 0, tension: 0.15, borderWidth: 2 }] },
      options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => money(c.raw) } } }, scales: { x: { ticks: { maxTicksLimit: 8 } } } }
    });

    // Catégories (dépenses)
    const catSum = {};
    P.filter((o) => o.amount < 0).forEach((o) => { catSum[o.cat] = (catSum[o.cat] || 0) - o.amount; });
    const cats = Object.entries(catSum).sort((a, b) => b[1] - a[1]);
    $("cat-box").style.height = Math.max(200, cats.length * 30 + 40) + "px";
    chart("ch-cat", {
      type: "bar",
      data: { labels: cats.map((c) => c[0]), datasets: [{ data: cats.map((c) => c[1]),
        backgroundColor: cats.map((c) => (state.cat && state.cat !== c[0]) ? css("--c1") + "55" : css("--c1")), borderRadius: 4 }] },
      options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => money(c.raw) } } },
        onClick: (e, els) => { if (els.length) { const c = cats[els[0].index][0]; setCat(state.cat === c ? "" : c); } } }
    });

    // Sous-catégories
    if (state.cat) {
      const subSum = {};
      P.filter((o) => o.amount < 0 && o.cat === state.cat).forEach((o) => { subSum[o.sub || "–"] = (subSum[o.sub || "–"] || 0) - o.amount; });
      const subs = Object.entries(subSum).sort((a, b) => b[1] - a[1]);
      $("sub-hint").textContent = state.cat + " : " + money(subs.reduce((s, x) => s + x[1], 0));
      $("sub-box").style.height = Math.max(160, subs.length * 30 + 40) + "px";
      chart("ch-sub", {
        type: "bar",
        data: { labels: subs.map((c) => c[0]), datasets: [{ data: subs.map((c) => c[1]), backgroundColor: css("--c1"), borderRadius: 4 }] },
        options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.raw) } } },
          onClick: (e, els) => { if (els.length) { state.sub = subs[els[0].index][0]; $("f-sub").value = state.sub; state.page = 0; renderTable(); } } }
      });
    } else {
      if (charts["ch-sub"]) { charts["ch-sub"].destroy(); delete charts["ch-sub"]; }
      $("sub-box").style.height = "0px";
      $("sub-hint").textContent = "Choisis une catégorie pour voir ses sous-catégories.";
    }
    renderFilters();
    renderTable();
  }
  const fr = (iso) => iso.split("-").reverse().join("/");

  function renderFilters() {
    const cats = [...new Set(ops.map((o) => o.cat))].sort((a, b) => a.localeCompare(b, "fr"));
    $("f-cat").innerHTML = '<option value="">Toutes les catégories</option>' + cats.map((c) => "<option>" + esc(c) + "</option>").join("");
    $("f-cat").value = state.cat;
    const subs = [...new Set(ops.filter((o) => !state.cat || o.cat === state.cat).map((o) => o.sub).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    $("f-sub").innerHTML = '<option value="">Toutes les sous-catégories</option>' + subs.map((c) => "<option>" + esc(c) + "</option>").join("");
    if (!subs.includes(state.sub)) state.sub = "";
    $("f-sub").value = state.sub;
  }

  function filtered() {
    const range = periodRange();
    const q = state.q.trim().toLowerCase().replace(",", ".");
    let rows = ops.filter((o) => inPeriod(o, range)
      && (!state.cat || o.cat === state.cat)
      && (!state.sub || o.sub === state.sub)
      && (!state.type || (state.type === "in" ? o.amount > 0 : o.amount < 0))
      && (!q || (o.lib + " " + o.cat + " " + o.sub).toLowerCase().includes(q) || Math.abs(o.amount).toFixed(2).includes(q)));
    const k = state.sort, d = state.dir;
    rows.sort((a, b) => {
      let r = k === "amount" ? a.amount - b.amount : k === "date" ? a.date.localeCompare(b.date) || a.i - b.i : String(a[k]).localeCompare(String(b[k]), "fr");
      return r * d;
    });
    return rows;
  }

  function renderTable() {
    const rows = filtered();
    const total = rows.reduce((s, o) => s + o.amount, 0);
    $("t-summary").textContent = rows.length + " opération" + (rows.length > 1 ? "s" : "") + ", total " + money(total);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * PAGE, state.page * PAGE + PAGE);
    $("tbody").innerHTML = slice.map((o) =>
      '<tr data-i="' + o.i + '"><td>' + fr(o.date) + '</td><td class="lib">' + esc(o.lib) + '</td><td><button class="catbtn" title="Changer la catégorie">' + esc(o.cat) +
      (o.sub ? '<br><span class="tag">' + esc(o.sub) + "</span>" : "") +
      (o.src !== "banque" ? ' <span class="tag src">' + (o.src === "manuel" ? "modifiée" : "règle") + "</span>" : "") +
      '</button></td><td class="amount ' + (o.amount < 0 ? "neg" : "pos") + '">' + money(o.amount) + "</td></tr>" +
      (editing === o.i ? editorRow(o) : "")).join("") ||
      '<tr><td colspan="4" class="muted">Aucune opération ne correspond.</td></tr>';
    $("pg-info").textContent = "Page " + (state.page + 1) + " / " + pages;
    $("pg-prev").disabled = state.page === 0;
    $("pg-next").disabled = state.page >= pages - 1;
    document.querySelectorAll("th[data-sort]").forEach((th) => {
      th.textContent = th.textContent.replace(/ [▲▼]$/, "") + (th.dataset.sort === state.sort ? (state.dir > 0 ? " ▲" : " ▼") : "");
    });
  }

  // ---------- Édition de catégorie ----------
  let editing = null;
  function suggestText(lib) {
    // Propose le début significatif du libellé, sans les dates ni le numéro de carte.
    return lib.replace(/^(PAIEMENT CB|PRELEVEMENT|VIREMENT( INSTANTANE)?( EMIS| RECU)?( DE| VERS)?|RETRAIT DISTRIBUTEUR)\s+/i, "")
      .split(/ DU \d{2}\/\d{2}\/\d{2}| - |\s{2,}/)[0].trim().slice(0, 40);
  }
  function editorRow(o) {
    const cats = [...new Set(ops.map((x) => x.cat).concat(ops.map((x) => x.bankCat)))].sort((a, b) => a.localeCompare(b, "fr"));
    const subs = [...new Set(ops.map((x) => x.sub).concat(ops.map((x) => x.bankSub)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    return '<tr class="editor"><td colspan="4"><div class="edit-grid">' +
      '<label>Catégorie<input id="e-cat" list="dl-cat" value="' + esc(o.cat) + '"></label>' +
      '<label>Sous-catégorie<input id="e-sub" list="dl-sub" value="' + esc(o.sub) + '"></label>' +
      '<datalist id="dl-cat">' + cats.map((c) => '<option value="' + esc(c) + '">').join("") + "</datalist>" +
      '<datalist id="dl-sub">' + subs.map((c) => '<option value="' + esc(c) + '">').join("") + "</datalist>" +
      '</div><label class="rule-line"><input type="checkbox" id="e-rule"> Créer une règle pour tous les libellés contenant ' +
      '<input id="e-text" value="' + esc(suggestText(o.lib)) + '"></label>' +
      '<p class="muted" style="margin:6px 0">Origine actuelle : ' + (o.src === "manuel" ? "modifiée à la main" : o.src === "règle" ? "règle « " + esc(o.rule) + " »" : "catégorie BNP") +
      " (BNP : " + esc(o.bankCat) + (o.bankSub ? " / " + esc(o.bankSub) : "") + ")</p>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="primary" id="e-save">Enregistrer</button>' +
      (o.src === "manuel" ? '<button id="e-reset">Revenir à la catégorie automatique</button>' : "") +
      '<button id="e-cancel">Annuler</button><span id="e-msg" class="neg"></span></div></td></tr>';
  }
  async function saveEdit(o, reset) {
    const cat = reset ? "" : $("e-cat").value.trim(), sub = reset ? "" : $("e-sub").value.trim();
    const asRule = !reset && $("e-rule").checked, text = !reset ? $("e-text").value.trim() : "";
    if (!reset && !cat) { $("e-msg").textContent = "Indique une catégorie."; return; }
    if (asRule && !text) { $("e-msg").textContent = "Indique le texte de la règle."; return; }
    document.querySelectorAll(".editor button").forEach((b) => (b.disabled = true));
    const r = encodeURIComponent;
    try {
      if (asRule) {
        await api("/values/" + r(RULES_TAB + "!A:C") + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", {
          method: "POST", body: JSON.stringify({ values: [[text, cat, sub]] })
        });
        // Une modification manuelle prime sur les règles : on l'efface pour que la nouvelle règle s'applique.
        if (o.ovCat) await writeOverride(o, "", "");
      } else {
        await writeOverride(o, cat, sub);
      }
      editing = null;
      await loadData();
      render();
    } catch (e) {
      if (e.message !== "401") { $("e-msg").textContent = e.message; document.querySelectorAll(".editor button").forEach((b) => (b.disabled = false)); }
    }
  }
  async function writeOverride(o, cat, sub) {
    const r = encodeURIComponent;
    // Vérifie que la ligne de la Sheet est toujours la bonne avant d'écrire.
    const cur = await api("/values/" + r(CFG.OPS_TAB + "!D" + o.row + ":E" + o.row) + "?valueRenderOption=UNFORMATTED_VALUE");
    const v = (cur.values || [[]])[0];
    if (String(v[0] || "") !== o.lib || Math.abs(toNum(v[1]) - o.amount) > 0.001) {
      throw new Error("La Sheet a changé depuis le chargement. Clique sur « Actualiser » puis réessaie.");
    }
    await api("/values/" + r(CFG.OPS_TAB + "!I" + o.row + ":J" + o.row) + "?valueInputOption=RAW", {
      method: "PUT", body: JSON.stringify({ values: [[cat, sub]] })
    });
  }
  $("tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.classList.contains("catbtn")) {
      const i = Number(btn.closest("tr").dataset.i);
      editing = editing === i ? null : i;
      renderTable();
      if (editing !== null && $("e-cat")) $("e-cat").focus();
      return;
    }
    const o = ops.find((x) => x.i === editing);
    if (!o) return;
    if (btn.id === "e-save") saveEdit(o, false);
    if (btn.id === "e-reset") saveEdit(o, true);
    if (btn.id === "e-cancel") { editing = null; renderTable(); }
  });

  function setCat(c) { state.cat = c; state.sub = ""; state.page = 0; render(); }

  // ---------- Import ----------
  function parseExport(buf) {
    const wb = XLSX.read(buf, { type: "array", cellDates: false });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
    let solde = null;
    for (let r = 0; r < Math.min(rows.length, 5); r++) {
      const cell = String(rows[r][1] || "");
      const m = cell.match(/Solde au\s*(\d{2}\/\d{2}\/\d{4})/i);
      if (m) solde = { date: parseDateStr(m[1]), solde: toNum(rows[r][2]), compte: String(rows[r][0] || "") };
    }
    const h = rows.findIndex((r) => String(r[0]).toLowerCase().startsWith("date op"));
    if (h < 0) throw new Error("Je ne trouve pas la ligne d'en-tête « Date operation » dans ce fichier.");
    const list = [];
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r];
      if (row[0] === "" || row[0] === undefined) continue;
      const date = typeof row[0] === "number" ? serialToISO(row[0]) : parseDateStr(String(row[0]));
      if (!date) continue;
      list.push({ date, cat: String(row[1] || ""), sub: String(row[2] || ""), lib: String(row[3] || "").trim(), amount: toNum(row[4]),
        pointage: String(row[5] || ""), comment: String(row[6] || "") });
    }
    list.sort((a, b) => a.date.localeCompare(b.date));
    return { solde, list };
  }

  function diffImport(parsed) {
    const have = {};
    ops.forEach((o) => { const k = keyOf(o); have[k] = (have[k] || 0) + 1; });
    const seen = {}, fresh = [];
    // Dans l'export BNP, l'ordre d'origine est du plus récent au plus ancien ; on compte les occurrences par clé.
    parsed.list.forEach((o) => {
      const k = keyOf(o);
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] > (have[k] || 0)) fresh.push(o);
    });
    return fresh;
  }

  async function handleFile(file) {
    $("import-msg").textContent = "";
    $("import-result").classList.add("hidden");
    try {
      const parsed = parseExport(new Uint8Array(await file.arrayBuffer()));
      const fresh = diffImport(parsed);
      pendingImport = { parsed, fresh, name: file.name };
      const span = parsed.list.length ? fr(parsed.list[0].date) + " au " + fr(parsed.list[parsed.list.length - 1].date) : "";
      const lastKnown = ops.length ? ops.reduce((m, o) => (o.date > m ? o.date : m), "") : "";
      let gap = "";
      if (lastKnown && parsed.list.length && parsed.list[0].date > lastKnown) {
        gap = " Attention : cet export commence après la dernière opération connue (" + fr(lastKnown) + "), il peut manquer des opérations entre les deux.";
      }
      $("import-summary").textContent = file.name + " : " + parsed.list.length + " opérations du " + span + ". " +
        (fresh.length ? fresh.length + " nouvelle" + (fresh.length > 1 ? "s" : "") + " à ajouter." : "Tout est déjà dans la Sheet.") + gap;
      $("import-preview").innerHTML = fresh.slice(-15).reverse().map((o) =>
        "<tr><td>" + fr(o.date) + '</td><td class="lib">' + esc(o.lib) + "</td><td>" + esc(o.cat) + '</td><td class="amount ' + (o.amount < 0 ? "neg" : "pos") + '">' + money(o.amount) + "</td></tr>").join("") +
        (fresh.length > 15 ? '<tr><td colspan="4" class="muted">… et ' + (fresh.length - 15) + " autres</td></tr>" : "");
      const soldeNew = parsed.solde && !soldes.some((s) => s.date === parsed.solde.date);
      $("btn-import").disabled = !fresh.length && !soldeNew;
      $("btn-import").textContent = fresh.length ? "Ajouter " + fresh.length + " opération" + (fresh.length > 1 ? "s" : "") : "Enregistrer le solde";
      $("import-result").classList.remove("hidden");
    } catch (e) {
      $("import-msg").textContent = "Lecture impossible : " + e.message;
      $("import-msg").className = "neg";
    }
  }

  async function doImport() {
    if (!pendingImport) return;
    const { parsed, fresh } = pendingImport;
    const exportDate = parsed.solde ? parsed.solde.date : new Date().toISOString().slice(0, 10);
    $("btn-import").disabled = true;
    try {
      // Recharge juste avant d'écrire pour éviter les doublons si la Sheet a changé entre-temps.
      await loadData();
      const freshNow = diffImport(parsed);
      const r = encodeURIComponent;
      if (freshNow.length) {
        await api("/values/" + r(CFG.OPS_TAB + "!A:H") + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", {
          method: "POST",
          body: JSON.stringify({ values: freshNow.map((o) => [o.date, o.cat, o.sub, o.lib, o.amount, exportDate, o.pointage, o.comment]) })
        });
      }
      if (parsed.solde && !soldes.some((s) => s.date === parsed.solde.date)) {
        await api("/values/" + r(CFG.SOLDES_TAB + "!A:D") + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", {
          method: "POST", body: JSON.stringify({ values: [[parsed.solde.date, parsed.solde.solde, parsed.solde.compte, exportDate]] })
        });
      }
      $("import-msg").textContent = freshNow.length + " opération" + (freshNow.length > 1 ? "s" : "") + " ajoutée" + (freshNow.length > 1 ? "s" : "") + ".";
      $("import-msg").className = "pos";
      $("import-result").classList.add("hidden");
      pendingImport = null;
      await loadData();
      buildPeriods();
      render();
    } catch (e) {
      $("import-msg").textContent = "Échec de l'ajout : " + e.message;
      $("import-msg").className = "neg";
      $("btn-import").disabled = false;
    }
  }

  // ---------- Views ----------
  function showSignin(msg) {
    $("signin-view").classList.remove("hidden");
    $("app").classList.add("hidden");
    ["btn-reload", "btn-signout"].forEach((id) => $(id).classList.add("hidden"));
    $("signin-error").textContent = msg || "";
  }
  async function start() {
    $("signin-view").classList.add("hidden");
    $("app").classList.remove("hidden");
    ["btn-reload", "btn-signout"].forEach((id) => $(id).classList.remove("hidden"));
    $("period-info").textContent = "Chargement…";
    try {
      await loadData();
      buildPeriods();
      render();
    } catch (e) {
      if (e.message !== "401") showSignin(e.message);
    }
  }

  // ---------- Events ----------
  $("btn-signin").onclick = signIn;
  $("btn-signout").onclick = () => {
    if (token && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(token, () => {});
    clearToken(); showSignin();
  };
  $("btn-reload").onclick = start;
  $("period").onchange = (e) => { state.period = e.target.value; state.page = 0; render(); };
  $("q").oninput = (e) => { state.q = e.target.value; state.page = 0; renderTable(); };
  $("f-cat").onchange = (e) => setCat(e.target.value);
  $("f-sub").onchange = (e) => { state.sub = e.target.value; state.page = 0; renderTable(); };
  $("f-type").onchange = (e) => { state.type = e.target.value; state.page = 0; renderTable(); };
  $("btn-clear").onclick = () => { Object.assign(state, { q: "", cat: "", sub: "", type: "", page: 0 }); $("q").value = ""; $("f-type").value = ""; render(); };
  $("pg-prev").onclick = () => { state.page--; renderTable(); };
  $("pg-next").onclick = () => { state.page++; renderTable(); };
  document.querySelectorAll("th[data-sort]").forEach((th) => th.onclick = () => {
    const k = th.dataset.sort;
    state.dir = state.sort === k ? -state.dir : (k === "date" || k === "amount" ? -1 : 1);
    state.sort = k; renderTable();
  });
  $("file").onchange = (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; };
  const drop = $("drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); };
  $("btn-import").onclick = doImport;
  $("btn-import-cancel").onclick = () => { pendingImport = null; $("import-result").classList.add("hidden"); };
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (ops.length) render(); });

  $("sheet-link").href = "https://docs.google.com/spreadsheets/d/" + CFG.SHEET_ID + "/edit";
  if (!CFG.GOOGLE_CLIENT_ID) $("config-notice").classList.remove("hidden");
  loadToken();
  if (token) start();
})();
