const http = require('http');
const https = require('https');
const TD_KEY = '10b3ff3aa4b444ae85d350902c523b0f';
const PORT = process.env.PORT || 3000;

// ── Generic HTTPS fetch ───────────────────────────────────────────────────────
function fetchURL(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(extraHeaders || {})
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchURL(res.headers.location, extraHeaders).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function jp(str) { try { return JSON.parse(str); } catch(e) { return null; } }
function today() { return new Date().toISOString().slice(0,10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }

// ── XAU/EUR (dashboard gold) ──────────────────────────────────────────────────
const SYMBOLS = ['XAU/EUR','XAUEUR'];
async function getPrice() {
  for (const sym of SYMBOLS) {
    try {
      const r = await fetchURL(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}`);
      const d = jp(r.body);
      const p = parseFloat(d && d.price);
      if (p > 100 && p < 100000) return { price: p, symbol: sym };
    } catch(e) { console.log(`${sym} failed: ${e.message}`); }
  }
  throw new Error('All XAU symbols failed');
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
      type:   (h._source && h._source.form_type) || '',
      filer:  (h._source && h._source.display_names && h._source.display_names[0] && h._source.display_names[0].name) || (h._source && h._source.entity_name) || 'Unknown',
      filed:  (h._source && h._source.file_date) || '',
      period: (h._source && h._source.period_of_report) || '',
      url:    `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&forms=SC+13D,SC+13G`
    }));
    return { ticker, filings, total: (d.hits.total && d.hits.total.value) || 0, source: 'SEC EDGAR' };
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
      filer:  (h._source && h._source.display_names && h._source.display_names[0] && h._source.display_names[0].name) || (h._source && h._source.entity_name) || 'Unknown',
      filed:  (h._source && h._source.file_date) || '',
      period: (h._source && h._source.period_of_report) || '',
      type:   (h._source && h._source.form_type) || '13F-HR'
    }));
    return { ticker, holdings, total: (d.hits.total && d.hits.total.value) || 0, source: 'SEC 13F' };
  } catch(e) {
    return { ticker, holdings: [], error: e.message, source: 'SEC 13F' };
  }
}

// ── SEC Form 4 — Insider transactions (/insider/buys, /insider/radar) ─────────
async function insiderBuys(ticker) {
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&forms=4&dateRange=custom&startdt=${daysAgo(90)}&enddt=${today()}`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || !d.hits) return { ticker, buys: [], source: 'SEC Form 4' };
    const buys = (d.hits.hits || []).slice(0,15).map(h => ({
      date:    (h._source && h._source.file_date) || '',
      ticker:  ticker,
      insider: (h._source && h._source.display_names && h._source.display_names[1] && h._source.display_names[1].name) || 'Unknown',
      title:   (h._source && h._source.display_names && h._source.display_names[1] && h._source.display_names[1].forms && h._source.display_names[1].forms[0]) || '',
      period:  (h._source && h._source.period_of_report) || '',
      type:    (h._source && h._source.form_type) || '4'
    }));
    return { ticker, buys, total: (d.hits.total && d.hits.total.value) || 0, source: 'SEC EDGAR Form 4' };
  } catch(e) {
    return { ticker, buys: [], error: e.message, source: 'SEC Form 4' };
  }
}

async function insiderRadar() {
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=${daysAgo(7)}&enddt=${today()}`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || !d.hits) return { buys: [], source: 'SEC Form 4', asOf: today() };
    const buys = (d.hits.hits || []).slice(0,30).map(h => ({
      date:    (h._source && h._source.file_date) || '',
      company: (h._source && h._source.display_names && h._source.display_names[0] && h._source.display_names[0].name) || '',
      insider: (h._source && h._source.display_names && h._source.display_names[1] && h._source.display_names[1].name) || '',
      title:   (h._source && h._source.display_names && h._source.display_names[1] && h._source.display_names[1].forms && h._source.display_names[1].forms[0]) || '',
      period:  (h._source && h._source.period_of_report) || ''
    }));
    return { buys, total: (d.hits.total && d.hits.total.value) || 0, source: 'SEC EDGAR Form 4', asOf: today() };
  } catch(e) {
    return { buys: [], error: e.message, source: 'SEC Form 4' };
  }
}

// ── Yahoo Finance (/yahoo/*) ──────────────────────────────────────────────────
// /yahoo/quote?ticker=NVDA          → quote complet avec shortRatio, shortPercent
// /yahoo/short?ticker=NVDA          → données short interest extraites du quote
// /yahoo/insiders?ticker=NVDA       → transactions insiders récentes
// /yahoo/holders?ticker=NVDA        → principaux actionnaires institutionnels

async function yahooQuote(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=summaryDetail,defaultKeyStatistics,institutionOwnership,insiderHolders,insiderTransactions`;
    const r = await fetchURL(url, { 'Accept': 'application/json' });
    const d = jp(r.body);
    if (!d || !d.quoteSummary || d.quoteSummary.error) {
      return { ticker, error: (d && d.quoteSummary && d.quoteSummary.error && d.quoteSummary.error.description) || 'Yahoo Finance unavailable', source: 'Yahoo Finance' };
    }
    return { ticker, data: d.quoteSummary.result && d.quoteSummary.result[0], source: 'Yahoo Finance' };
  } catch(e) {
    return { ticker, error: e.message, source: 'Yahoo Finance' };
  }
}

async function yahooShort(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics,summaryDetail`;
    const r = await fetchURL(url, { 'Accept': 'application/json' });
    const d = jp(r.body);
    if (!d || !d.quoteSummary || d.quoteSummary.error) {
      return { ticker, error: 'Yahoo Finance unavailable', source: 'Yahoo Finance' };
    }
    const result = d.quoteSummary.result && d.quoteSummary.result[0];
    const ks = (result && result.defaultKeyStatistics) || {};
    const sd = (result && result.summaryDetail) || {};
    return {
      ticker,
      source: 'Yahoo Finance',
      shortInterest: {
        sharesShort:         (ks.sharesShort && ks.sharesShort.raw) || 0,
        sharesShortPriorMonth: (ks.sharesShortPriorMonth && ks.sharesShortPriorMonth.raw) || 0,
        shortRatio:          (ks.shortRatio && ks.shortRatio.raw) || 0,        // Days To Cover
        shortPercentFloat:   (ks.shortPercentOfFloat && ks.shortPercentOfFloat.raw) || 0,
        shortPercentShares:  (ks.sharesPercentSharesOut && ks.sharesPercentSharesOut.raw) || 0,
        lastUpdate:          (ks.dateShortInterest && new Date(ks.dateShortInterest.raw * 1000).toISOString().slice(0,10)) || '',
        float:               (ks.floatShares && ks.floatShares.raw) || 0,
        sharesOutstanding:   (ks.sharesOutstanding && ks.sharesOutstanding.raw) || 0,
      }
    };
  } catch(e) {
    return { ticker, error: e.message, source: 'Yahoo Finance' };
  }
}

async function yahooInsiders(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=insiderTransactions,insiderHolders`;
    const r = await fetchURL(url, { 'Accept': 'application/json' });
    const d = jp(r.body);
    if (!d || !d.quoteSummary || d.quoteSummary.error) {
      return { ticker, transactions: [], holders: [], source: 'Yahoo Finance' };
    }
    const result = d.quoteSummary.result && d.quoteSummary.result[0];
    const it = (result && result.insiderTransactions && result.insiderTransactions.transactions) || [];
    const ih = (result && result.insiderHolders && result.insiderHolders.holders) || [];

    const transactions = it.slice(0,15).map(t => ({
      name:        (t.filerName && t.filerName.raw) || t.filerName || '',
      relation:    (t.filerRelation && t.filerRelation.raw) || t.filerRelation || '',
      date:        (t.startDate && new Date(t.startDate.raw * 1000).toISOString().slice(0,10)) || '',
      shares:      (t.shares && t.shares.raw) || 0,
      value:       (t.value && t.value.raw) || 0,
      type:        (t.transactionText && t.transactionText.raw) || t.transactionText || '',
      ownership:   (t.ownership && t.ownership.raw) || t.ownership || ''
    }));

    const holders = ih.slice(0,10).map(h => ({
      name:          (h.name && h.name.raw) || h.name || '',
      relation:      (h.relation && h.relation.raw) || h.relation || '',
      date:          (h.latestTransDate && new Date(h.latestTransDate.raw * 1000).toISOString().slice(0,10)) || '',
      shares:        (h.positionDirect && h.positionDirect.raw) || 0,
      pctHeld:       (h.pctHeld && h.pctHeld.raw) || 0,
      pctChange:     (h.pctChange && h.pctChange.raw) || 0
    }));

    return { ticker, transactions, holders, source: 'Yahoo Finance' };
  } catch(e) {
    return { ticker, transactions: [], holders: [], error: e.message, source: 'Yahoo Finance' };
  }
}

async function yahooHolders(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=institutionOwnership,majorHoldersBreakdown`;
    const r = await fetchURL(url, { 'Accept': 'application/json' });
    const d = jp(r.body);
    if (!d || !d.quoteSummary || d.quoteSummary.error) {
      return { ticker, holders: [], source: 'Yahoo Finance' };
    }
    const result = d.quoteSummary.result && d.quoteSummary.result[0];
    const io = (result && result.institutionOwnership && result.institutionOwnership.ownershipList) || [];
    const mh = (result && result.majorHoldersBreakdown) || {};

    const holders = io.slice(0,15).map(h => ({
      name:      (h.organization && h.organization.raw) || h.organization || '',
      date:      (h.reportDate && new Date(h.reportDate.raw * 1000).toISOString().slice(0,10)) || '',
      shares:    (h.position && h.position.raw) || 0,
      value:     (h.value && h.value.raw) || 0,
      pctHeld:   (h.pctHeld && h.pctHeld.raw) || 0,
      pctChange: (h.pctChange && h.pctChange.raw) || 0
    }));

    return {
      ticker,
      holders,
      summary: {
        insiderPct:      (mh.insidersPercentHeld && mh.insidersPercentHeld.raw) || 0,
        institutionPct:  (mh.institutionsPercentHeld && mh.institutionsPercentHeld.raw) || 0,
        floatPct:        (mh.institutionsFloatPercentHeld && mh.institutionsFloatPercentHeld.raw) || 0,
      },
      source: 'Yahoo Finance'
    };
  } catch(e) {
    return { ticker, holders: [], error: e.message, source: 'Yahoo Finance' };
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

    // ── TwelveData (/td/*) ──────────────────────────────────────────────────
    if (rawPath.startsWith('/td/')) {
      const tdPath = rawPath.replace('/td', '');
      console.log(`[TD] ${tdPath}?${rawQuery}`);
      const r = await fetchURL(tdURL(tdPath, rawQuery || ''));
      res.writeHead(200); res.end(r.body); return;
    }

    // ── SEC EDGAR ──────────────────────────────────────────────────────────
    if (rawPath === '/sec/crossings') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[SEC] crossings ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await secCrossings(ticker))); return;
    }
    if (rawPath === '/sec/institutional') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[SEC] 13F ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await secInstitutional(ticker))); return;
    }

    // ── SEC Form 4 Insiders ─────────────────────────────────────────────────
    if (rawPath === '/insider/buys') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[INSIDER] buys ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await insiderBuys(ticker))); return;
    }
    if (rawPath === '/insider/radar') {
      console.log(`[INSIDER] radar`);
      res.writeHead(200); res.end(JSON.stringify(await insiderRadar())); return;
    }

    // ── Yahoo Finance ───────────────────────────────────────────────────────
    if (rawPath === '/yahoo/quote') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[YAHOO] quote ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await yahooQuote(ticker))); return;
    }
    if (rawPath === '/yahoo/short') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[YAHOO] short ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await yahooShort(ticker))); return;
    }
    if (rawPath === '/yahoo/insiders') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[YAHOO] insiders ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await yahooInsiders(ticker))); return;
    }
    if (rawPath === '/yahoo/holders') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[YAHOO] holders ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await yahooHolders(ticker))); return;
    }

    // ── XAU/EUR dashboard gold ──────────────────────────────────────────────
    if (rawPath === '/price') {
      const result = await getPrice();
      res.writeHead(200);
      res.end(JSON.stringify({ price: result.price, source: `TwelveData (${result.symbol})`, symbol: result.symbol, ts: new Date().toISOString() }));
      return;
    }

    if (rawPath === '/health') {
      const result = await getPrice();
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok', asset: 'XAU/EUR',
        workingSymbol: result.symbol, currentPrice: result.price,
        routes: [
          '/price', '/health', '/debug',
          '/td/quote?symbol=X', '/td/time_series?symbol=X&interval=1day&outputsize=60',
          '/sec/crossings?ticker=X', '/sec/institutional?ticker=X',
          '/insider/buys?ticker=X', '/insider/radar',
          '/yahoo/short?ticker=X', '/yahoo/insiders?ticker=X', '/yahoo/holders?ticker=X'
        ],
        ts: new Date().toISOString()
      }));
      return;
    }

    if (rawPath === '/debug') {
      const results = {};
      for (const sym of SYMBOLS) {
        try {
          const r = await fetchURL(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}`);
          results[sym] = jp(r.body);
        } catch(e) { results[sym] = { error: e.message }; }
      }
      res.writeHead(200); res.end(JSON.stringify({ results, ts: new Date().toISOString() })); return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({
      error: 'Route inconnue',
      routes: ['/price','/health','/debug','/td/quote?symbol=X','/td/time_series?symbol=X&interval=1day&outputsize=60','/sec/crossings?ticker=X','/sec/institutional?ticker=X','/insider/buys?ticker=X','/insider/radar','/yahoo/short?ticker=X','/yahoo/insiders?ticker=X','/yahoo/holders?ticker=X']
    }));

  } catch(e) {
    console.error('Unhandled error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`NM Trading Proxy v4 — port ${PORT}`));
