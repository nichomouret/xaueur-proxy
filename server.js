const http = require('http');
const https = require('https');
const TD_KEY = '10b3ff3aa4b444ae85d350902c523b0f';
const PORT = process.env.PORT || 3000;

// ── Generic fetch ─────────────────────────────────────────────────────────────
function fetchURL(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 NMGroupProxy/1.0',
        'Accept': 'application/json, text/html, */*',
        ...(extraHeaders || {})
      }
    };
    const req = lib.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function jp(str) { try { return JSON.parse(str); } catch(e) { return null; } }
function today() { return new Date().toISOString().slice(0,10); }
function daysAgo(n) { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }

// ── XAU/EUR ───────────────────────────────────────────────────────────────────
const SYMBOLS = ['XAU/EUR','XAUEUR'];
async function getPrice() {
  for (const sym of SYMBOLS) {
    try {
      const r = await fetchURL(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}`);
      const d = jp(r.body);
      const p = parseFloat(d?.price);
      if (p > 100 && p < 100000) return { price: p, symbol: sym };
    } catch(e) { console.log(`${sym} failed: ${e.message}`); }
  }
  throw new Error('All symbols failed');
}

// ── TwelveData proxy (/td/*) ──────────────────────────────────────────────────
function tdURL(path, query) {
  const sep = query ? '&' : '?';
  return `https://api.twelvedata.com${path}?${query}${sep}apikey=${TD_KEY}`;
}

// ── SEC EDGAR (/sec/crossings, /sec/institutional) ────────────────────────────
async function secCrossings(ticker) {
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&dateRange=custom&startdt=${daysAgo(90)}&enddt=${today()}&forms=SC+13D,SC+13G,SC+13G%2FA,SC+13D%2FA`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || !d.hits) return { ticker, filings: [], source: 'SEC EDGAR' };
    const filings = (d.hits.hits || []).slice(0,10).map(h => ({
      type: h._source?.form_type || '',
      filer: h._source?.display_names?.[0]?.name || h._source?.entity_name || 'Unknown',
      filed: h._source?.file_date || '',
      period: h._source?.period_of_report || '',
      accession: (h._source?.accession_no || '').replace(/-/g,''),
      url: `https://www.sec.gov/Archives/edgar/data/${h._source?.entity_id}/${(h._source?.accession_no||'').replace(/-/g,'')}/`
    }));
    return { ticker, filings, total: d.hits.total?.value || 0, source: 'SEC EDGAR' };
  } catch(e) {
    return { ticker, filings: [], error: e.message, source: 'SEC EDGAR' };
  }
}

async function secInstitutional(ticker) {
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&forms=13F-HR&dateRange=custom&startdt=${daysAgo(120)}&enddt=${today()}`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || !d.hits) return { ticker, holdings: [], source: 'SEC 13F' };
    const holdings = (d.hits.hits || []).slice(0,15).map(h => ({
      filer: h._source?.display_names?.[0]?.name || h._source?.entity_name || 'Unknown',
      filed: h._source?.file_date || '',
      period: h._source?.period_of_report || '',
      type: h._source?.form_type || '13F-HR'
    }));
    return { ticker, holdings, total: d.hits.total?.value || 0, source: 'SEC 13F' };
  } catch(e) {
    return { ticker, holdings: [], error: e.message, source: 'SEC 13F' };
  }
}

// ── AMF (/amf/crossings) ──────────────────────────────────────────────────────
async function amfCrossings(ticker) {
  try {
    const clean = ticker.replace('.PA','').replace('.FR','');
    // AMF open data — déclarations de franchissement de seuils
    const url = `https://bdif.amf-france.org/technique/proxy/ARIArequeteProxy?typeFichier=BDIF&groupe=FRANCHISSEMENT_SEUIL&criteres=VALEUR_NOM%7C${encodeURIComponent(clean)}&langue=fr&dateDebut=${daysAgo(90)}&dateFin=${today()}&nombreLignes=20&triColonne=DATE_DEPOT&triOrdre=DESC`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || (!d.rows && !d.listeDocument)) {
      return { ticker, crossings: [], source: 'AMF BDIF', note: 'Aucun résultat — consultez data.amf-france.org' };
    }
    const rows = d.rows || d.listeDocument || [];
    const crossings = rows.slice(0,10).map(row => ({
      declarant: row.DECLARANT || row.declarant || row.nomDeclarant || '',
      date: row.DATE_DEPOT || row.dateDepot || '',
      seuil: row.SEUIL || row.seuil || '',
      sens: row.SENS || row.sens || '',
      pct: row.POURCENTAGE || row.pourcentage || ''
    }));
    return { ticker, crossings, total: rows.length, source: 'AMF BDIF' };
  } catch(e) {
    return { ticker, crossings: [], error: e.message, source: 'AMF', note: 'Consultez data.amf-france.org' };
  }
}

// ── OpenInsider (/insider/buys, /insider/radar) ───────────────────────────────
function parseInsiderHTML(body) {
  const rows = [];
  const rowRx = /<tr[^>]*class="[^"]*(?:odd|even)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRx  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let rm;
  while ((rm = rowRx.exec(body)) !== null) {
    const cells = [];
    let tm;
    const rh = rm[1];
    const tdRx2 = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((tm = tdRx2.exec(rh)) !== null) {
      cells.push(tm[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").trim());
    }
    if (cells.length >= 11 && /^[A-Z]{1,6}$/.test(cells[3])) {
      rows.push({
        date:    cells[1]  || '',
        ticker:  cells[3]  || '',
        company: cells[4]  || '',
        insider: cells[5]  || '',
        title:   cells[6]  || '',
        type:    cells[7]  || '',
        price:   cells[8]  || '',
        qty:     cells[9]  || '',
        value:   cells[10] || ''
      });
    }
  }
  return rows;
}

async function insiderBuys(ticker) {
  try {
    const url = `https://openinsider.com/screener?s=${encodeURIComponent(ticker)}&o=&pl=&ph=&ll=&lh=&fd=90&fdr=&td=0&tdr=&fdlyl=&fdlyh=&dlt=&dth=&is=&vl=&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=20&page=1`;
    const r = await fetchURL(url);
    const rows = parseInsiderHTML(r.body);
    const buys = rows.filter(r => r.type.includes('P')).slice(0,15);
    return { ticker, buys, total: buys.length, source: 'OpenInsider' };
  } catch(e) {
    return { ticker, buys: [], error: e.message, source: 'OpenInsider' };
  }
}

async function insiderRadar() {
  try {
    // Achats > 100k$ dans les 14 derniers jours
    const url = 'https://openinsider.com/screener?s=&o=&pl=100000&ph=&ll=&lh=&fd=14&fdr=&td=0&tdr=&fdlyl=&fdlyh=&dlt=&dth=&is=&vl=&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=40&page=1';
    const r = await fetchURL(url);
    const rows = parseInsiderHTML(r.body);
    const buys = rows.filter(r => r.type.includes('P')).slice(0,25);
    return { buys, total: buys.length, source: 'OpenInsider', asOf: today() };
  } catch(e) {
    return { buys: [], error: e.message, source: 'OpenInsider' };
  }
}

// ── FINRA Short Interest (/finra/short) ───────────────────────────────────────
async function finraShort(ticker) {
  try {
    const filter = JSON.stringify([{ compareType:'EQUAL', fieldName:'symbolCode', fieldValue: ticker }]);
    const url = `https://api.finra.org/data/group/OTCMarket/name/otcShortInterest?compareFilters=${encodeURIComponent(filter)}&limit=6&offset=0&fields=symbolCode,settlementDate,shortInterestQty,avgDailyVolume,daysToCover&sortFields=${encodeURIComponent(JSON.stringify([{fieldName:'settlementDate',sortType:'DESC'}]))}`;
    const r = await fetchURL(url, { 'Accept': 'application/json' });
    const d = jp(r.body);
    if (!d || !Array.isArray(d) || d.length === 0) {
      // Try consolidated endpoint
      const url2 = `https://api.finra.org/data/group/OTCMarket/name/consolidatedShortInterest?compareFilters=${encodeURIComponent(filter)}&limit=6&sortFields=${encodeURIComponent(JSON.stringify([{fieldName:'settlementDate',sortType:'DESC'}]))}`;
      const r2 = await fetchURL(url2, { 'Accept': 'application/json' });
      const d2 = jp(r2.body);
      if (!d2 || !Array.isArray(d2) || d2.length === 0) {
        return { ticker, data: [], source: 'FINRA', note: 'Symbole non trouvé dans les données FINRA OTC' };
      }
      return {
        ticker, source: 'FINRA Consolidated',
        data: d2.slice(0,5).map(row => ({
          date: row.settlementDate || '',
          shortQty: row.shortInterestQty || 0,
          avgVol: row.avgDailyVolume || 0,
          dtc: parseFloat(row.daysToCover || 0).toFixed(1)
        }))
      };
    }
    return {
      ticker, source: 'FINRA OTC',
      data: d.slice(0,5).map(row => ({
        date: row.settlementDate || '',
        shortQty: row.shortInterestQty || 0,
        avgVol: row.avgDailyVolume || 0,
        dtc: parseFloat(row.daysToCover || 0).toFixed(1)
      }))
    };
  } catch(e) {
    return { ticker, data: [], error: e.message, source: 'FINRA' };
  }
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const [rawPath, rawQuery] = req.url.split('?');
  const params = new URLSearchParams(rawQuery || '');
  const ticker = (params.get('ticker') || '').toUpperCase();

  try {

    // TwelveData proxy
    if (rawPath.startsWith('/td/')) {
      const tdPath = rawPath.replace('/td','');
      console.log(`[TD] ${tdPath}?${rawQuery}`);
      const r = await fetchURL(tdURL(tdPath, rawQuery || ''));
      res.writeHead(200); res.end(r.body); return;
    }

    // SEC EDGAR
    if (rawPath === '/sec/crossings') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[SEC] crossings ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await secCrossings(ticker))); return;
    }
    if (rawPath === '/sec/institutional') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[SEC] institutional ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await secInstitutional(ticker))); return;
    }

    // AMF
    if (rawPath === '/amf/crossings') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[AMF] crossings ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await amfCrossings(ticker))); return;
    }

    // OpenInsider
    if (rawPath === '/insider/buys') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[INSIDER] buys ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await insiderBuys(ticker))); return;
    }
    if (rawPath === '/insider/radar') {
      console.log(`[INSIDER] radar`);
      res.writeHead(200); res.end(JSON.stringify(await insiderRadar())); return;
    }

    // FINRA
    if (rawPath === '/finra/short') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[FINRA] short ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await finraShort(ticker))); return;
    }

    // XAU/EUR gold dashboard
    if (rawPath === '/price') {
      const result = await getPrice();
      res.writeHead(200);
      res.end(JSON.stringify({ price: result.price, source:`TwelveData (${result.symbol})`, symbol: result.symbol, ts: new Date().toISOString() }));
      return;
    }

    if (rawPath === '/health') {
      const result = await getPrice();
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok', asset: 'XAU/EUR', workingSymbol: result.symbol, currentPrice: result.price,
        routes: ['/price','/health','/debug','/td/*','/sec/crossings?ticker=X','/sec/institutional?ticker=X','/amf/crossings?ticker=X','/insider/buys?ticker=X','/insider/radar','/finra/short?ticker=X'],
        ts: new Date().toISOString()
      }));
      return;
    }

    if (rawPath === '/debug') {
      const results = {};
      for (const sym of SYMBOLS) {
        try { const r = await fetchURL(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}`); results[sym] = jp(r.body); }
        catch(e) { results[sym] = { error: e.message }; }
      }
      res.writeHead(200); res.end(JSON.stringify({ results, ts: new Date().toISOString() })); return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error:'Route inconnue', routes:['/price','/health','/debug','/td/quote?symbol=X','/td/time_series?symbol=X&interval=1day&outputsize=60','/sec/crossings?ticker=X','/sec/institutional?ticker=X','/amf/crossings?ticker=X','/insider/buys?ticker=X','/insider/radar','/finra/short?ticker=X'] }));

  } catch(e) {
    console.error('Unhandled error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`NM Trading Proxy v3 — port ${PORT}`));
