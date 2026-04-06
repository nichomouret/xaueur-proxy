const http = require('http');
const https = require('https');
const TD_KEY = '10b3ff3aa4b444ae85d350902c523b0f';
const AV_KEY = 'TQPE9U0FIFDWE8ZY';
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
    const buys = (d.hits.hits || []).slice(0,30).map(h => {
      const src = h._source || {};
      const names = src.display_names || [];
      // EDGAR display_names: array of {name, entity_id, forms:[]}
      // First entry = company, second+ = insiders
      const company = names.length > 0 ? names[0].name || '' : src.entity_name || '';
      const insider = names.length > 1 ? names[1].name || '' : '';
      const title   = names.length > 1 && names[1].forms ? names[1].forms.join(', ') : '';
      return {
        date:    src.file_date || '',
        company: company,
        insider: insider,
        title:   title,
        period:  src.period_of_report || '',
        ticker:  src.period_of_report || ''
      };
    });
    return { buys, total: (d.hits.total && d.hits.total.value) || 0, source: 'SEC EDGAR Form 4', asOf: today() };
  } catch(e) {
    return { buys: [], error: e.message, source: 'SEC Form 4' };
  }
}

// ── Alpha Vantage (/av/*) ────────────────────────────────────────────────────
// /av/short?ticker=NVDA       → short interest + days to cover
// /av/holders?ticker=NVDA     → top holders institutionnels
// /av/insiders?ticker=NVDA    → transactions insiders récentes
// /av/overview?ticker=NVDA    → overview complet société

async function avShort(ticker) {
  try {
    // Alpha Vantage: SHORT_INTEREST endpoint
    const url = `https://www.alphavantage.co/query?function=SHORT_INTEREST&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || d.Information || d['Error Message']) {
      // Fallback: use OVERVIEW for basic short data
      const url2 = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`;
      const r2 = await fetchURL(url2);
      const d2 = jp(r2.body);
      if (!d2 || d2.Information) return { ticker, shortInterest: {}, source: 'Alpha Vantage', note: d && (d.Information || d['Error Message']) };
      return {
        ticker, source: 'Alpha Vantage OVERVIEW',
        shortInterest: {
          sharesShort:       parseInt(d2.SharesShort || 0),
          shortRatio:        parseFloat(d2.ShortRatio || 0),
          shortPercentFloat: parseFloat(d2.ShortPercentOutstanding || 0),
          lastUpdate:        d2.LatestQuarter || '',
          sharesOutstanding: parseInt(d2.SharesOutstanding || 0),
          float:             parseInt(d2.SharesFloat || 0),
          forwardPE:         parseFloat(d2.ForwardPE || 0),
          beta:              parseFloat(d2.Beta || 0),
        }
      };
    }
    const rows = (d.data || d.shortInterestData || []).slice(0,6);
    return {
      ticker, source: 'Alpha Vantage',
      shortInterest: rows.map(row => ({
        date:        row.date || row.settlementDate || '',
        sharesShort: parseInt(row.shortInterest || row.sharesShort || 0),
        shortRatio:  parseFloat(row.shortRatio || row.daysToCover || 0),
        shortPct:    parseFloat(row.shortPercentFloat || 0)
      }))
    };
  } catch(e) {
    return { ticker, shortInterest: {}, error: e.message, source: 'Alpha Vantage' };
  }
}

async function avHolders(ticker) {
  try {
    const url = `https://www.alphavantage.co/query?function=INSTITUTIONAL_OWNERSHIP&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || d.Information || d['Error Message']) {
      return { ticker, holders: [], source: 'Alpha Vantage', note: d && (d.Information || d['Error Message']) };
    }
    const holders = (d.ownership || d.institutionalOwnership || d.data || []).slice(0,15).map(h => ({
      name:      h.institutionName || h.name || h.holder || '',
      date:      h.date || h.reportDate || '',
      shares:    parseInt(h.sharesHeld || h.shares || 0),
      value:     parseInt(h.marketValue || h.value || 0),
      pctHeld:   parseFloat(h.percentPortfolio || h.pctHeld || 0),
      pctChange: parseFloat(h.changeInSharesPercent || h.pctChange || 0)
    }));
    return { ticker, holders, total: holders.length, source: 'Alpha Vantage' };
  } catch(e) {
    return { ticker, holders: [], error: e.message, source: 'Alpha Vantage' };
  }
}

async function avInsiders(ticker) {
  try {
    const url = `https://www.alphavantage.co/query?function=INSIDER_TRANSACTIONS&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || d.Information || d['Error Message']) {
      return { ticker, transactions: [], source: 'Alpha Vantage', note: d && (d.Information || d['Error Message']) };
    }
    const transactions = (d.data || d.insiderTransactions || []).slice(0,15).map(t => ({
      name:     t.executiveName || t.name || t.insider || '',
      title:    t.executiveTitle || t.title || t.relation || '',
      date:     t.transactionDate || t.date || '',
      type:     t.acquistionOrDisposal === 'A' ? 'Achat' : t.acquistionOrDisposal === 'D' ? 'Vente' : t.type || '',
      shares:   parseInt(t.shares || 0),
      value:    parseFloat(t.sharePrice || t.price || 0),
      total:    parseInt(t.shares || 0) * parseFloat(t.sharePrice || t.price || 0)
    }));
    // Filter only buys
    const buys = transactions.filter(t => t.type === 'Achat' || t.type === 'A' || t.type.toLowerCase().includes('buy') || t.type.toLowerCase().includes('achat'));
    return { ticker, transactions, buys, total: transactions.length, source: 'Alpha Vantage' };
  } catch(e) {
    return { ticker, transactions: [], buys: [], error: e.message, source: 'Alpha Vantage' };
  }
}

async function avOverview(ticker) {
  try {
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || d.Information || d['Error Message'] || !d.Symbol) {
      return { ticker, error: (d && (d.Information || d['Error Message'])) || 'No data', source: 'Alpha Vantage' };
    }
    return {
      ticker, source: 'Alpha Vantage',
      overview: {
        name:              d.Name || '',
        sector:            d.Sector || '',
        industry:          d.Industry || '',
        marketCap:         parseInt(d.MarketCapitalization || 0),
        pe:                parseFloat(d.PERatio || 0),
        forwardPE:         parseFloat(d.ForwardPE || 0),
        eps:               parseFloat(d.EPS || 0),
        beta:              parseFloat(d.Beta || 0),
        high52:            parseFloat(d['52WeekHigh'] || 0),
        low52:             parseFloat(d['52WeekLow'] || 0),
        sharesOutstanding: parseInt(d.SharesOutstanding || 0),
        sharesFloat:       parseInt(d.SharesFloat || 0),
        sharesShort:       parseInt(d.SharesShort || 0),
        shortRatio:        parseFloat(d.ShortRatio || 0),
        shortPctFloat:     parseFloat(d.ShortPercentOutstanding || 0),
        dividendYield:     parseFloat(d.DividendYield || 0),
        analystTarget:     parseFloat(d.AnalystTargetPrice || 0),
        analystRating:     d.AnalystRatingStrongBuy ? {
          strongBuy:  parseInt(d.AnalystRatingStrongBuy || 0),
          buy:        parseInt(d.AnalystRatingBuy || 0),
          hold:       parseInt(d.AnalystRatingHold || 0),
          sell:       parseInt(d.AnalystRatingSell || 0),
          strongSell: parseInt(d.AnalystRatingStrongSell || 0),
        } : null
      }
    };
  } catch(e) {
    return { ticker, error: e.message, source: 'Alpha Vantage' };
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

    // ── Alpha Vantage (/av/*) ────────────────────────────────────────────────
    if (rawPath === '/av/short') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[AV] short ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await avShort(ticker))); return;
    }
    if (rawPath === '/av/holders') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[AV] holders ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await avHolders(ticker))); return;
    }
    if (rawPath === '/av/insiders') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[AV] insiders ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await avInsiders(ticker))); return;
    }
    if (rawPath === '/av/overview') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[AV] overview ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await avOverview(ticker))); return;
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
          '/av/short?ticker=X', '/av/holders?ticker=X', '/av/insiders?ticker=X', '/av/overview?ticker=X'
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
      routes: ['/price','/health','/debug','/td/quote?symbol=X','/td/time_series?symbol=X&interval=1day&outputsize=60','/sec/crossings?ticker=X','/sec/institutional?ticker=X','/insider/buys?ticker=X','/insider/radar','/av/short?ticker=X','/av/holders?ticker=X','/av/insiders?ticker=X','/av/overview?ticker=X']
    }));

  } catch(e) {
    console.error('Unhandled error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`NM Trading Proxy v4 — port ${PORT}`));
