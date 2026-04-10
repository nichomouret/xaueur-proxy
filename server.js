const http = require('http');
const https = require('https');
const TD_KEY = '10b3ff3aa4b444ae85d350902c523b0f';
const AV_KEY = 'TQPE9U0FIFDWE8ZY';
const PORT = process.env.PORT || 3000;

// ── SSE CLIENTS ───────────────────────────────────────────────────────────────
const sseClients = new Set();
let lastPrice = null;

function broadcastPrice(price, symbol) {
  lastPrice = { price, symbol, ts: new Date().toISOString() };
  const data = 'data: ' + JSON.stringify(lastPrice) + '\n\n';
  sseClients.forEach(client => {
    try { client.write(data); } catch(e) { sseClients.delete(client); }
  });
}

// Poll TwelveData every 10s and broadcast to SSE clients
async function pollAndBroadcast() {
  try {
    const result = await getPrice();
    broadcastPrice(result.price, result.symbol);
  } catch(e) {}
  setTimeout(pollAndBroadcast, 10000);
}

// ── Generic fetch ─────────────────────────────────────────────────────────────
function fetchURL(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, application/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(extraHeaders || {})
      }
    }, (res) => {
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

// Parse XML/Atom simply without external lib
function parseXMLAtom(xml) {
  const entries = [];
  const entryRx = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRx.exec(xml)) !== null) {
    const e = m[1];
    const get = (tag) => {
      const rx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const match = rx.exec(e);
      return match ? match[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim() : '';
    };
    entries.push({
      title:   get('title'),
      updated: get('updated'),
      summary: get('summary'),
      link:    (/<link[^>]+href="([^"]+)"/.exec(e) || [])[1] || ''
    });
  }
  return entries;
}

// ── XAU/EUR (gold dashboard) ──────────────────────────────────────────────────
const SYMBOLS = ['XAU/EUR','XAUEUR'];

async function getPriceDukascopy() {
  // Dukascopy free tick data — no cache, truly real-time
  const ts = Date.now();
  const url = `https://freeserv.dukascopy.com/2.0/?path=chart/json&instrument=XAU%2FUSD&offer_side=B&interval=1&time=${ts}&from=0&to=1&jsonp=cb`;
  const urlEUR = `https://freeserv.dukascopy.com/2.0/?path=chart/json&instrument=EUR%2FUSD&offer_side=B&interval=1&time=${ts}&from=0&to=1&jsonp=cb`;
  const [r1, r2] = await Promise.all([fetchURL(url), fetchURL(urlEUR)]);
  // Dukascopy returns JSONP: cb([...])
  const parseJSONP = (body) => {
    const match = body.match(/cb\((.*)\)/s);
    if (!match) return null;
    return jp(match[1]);
  };
  const d1 = parseJSONP(r1.body);
  const d2 = parseJSONP(r2.body);
  if (d1 && d1[0] && d2 && d2[0]) {
    const xauUsd = parseFloat(d1[0][4]); // close price
    const eurUsd = parseFloat(d2[0][4]);
    if (xauUsd > 1000 && eurUsd > 0.5) {
      const xauEur = xauUsd / eurUsd;
      console.log(`Dukascopy: XAU/USD=${xauUsd} EUR/USD=${eurUsd} XAU/EUR=${xauEur.toFixed(2)}`);
      return { price: xauEur, symbol: 'XAU/EUR (Dukascopy)' };
    }
  }
  throw new Error('Dukascopy parse failed');
}

async function getPrice() {
  // Try Dukascopy first
  try {
    const result = await getPriceDukascopy();
    return result;
  } catch(e) {
    console.log('Dukascopy failed:', e.message);
  }
  // Try TwelveData /quote (more real-time than /price)
  for (const sym of ['XAU/EUR', 'XAUEUR']) {
    try {
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&t=${Date.now()}`;
      const r = await fetchURL(url);
      const d = jp(r.body);
      const p = parseFloat(d && (d.close || d.price));
      if (p > 100 && p < 100000) {
        console.log(`TwelveData quote: ${sym} = ${p}`);
        return { price: p, symbol: sym + ' (quote)' };
      }
    } catch(e) { console.log(`quote ${sym} failed: ${e.message}`); }
  }
  // Fallback: /price endpoint
  for (const sym of SYMBOLS) {
    try {
      const r = await fetchURL(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&t=${Date.now()}`);
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

// ── Alpha Vantage (/av/*) ─────────────────────────────────────────────────────
// /av/overview?ticker=NVDA  → full overview incl. short interest, beta, PE, analyst targets
// /av/insiders?ticker=NVDA  → insider transactions (Form 4 equivalent)
// /av/holders?ticker=NVDA   → institutional ownership

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
      data: {
        name:              d.Name || '',
        sector:            d.Sector || '',
        industry:          d.Industry || '',
        description:       d.Description || '',
        exchange:          d.Exchange || '',
        currency:          d.Currency || '',
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
        sharesShortPrior:  parseInt(d.SharesShortPriorMonth || 0),
        shortRatio:        parseFloat(d.ShortRatio || 0),          // Days To Cover
        shortPctFloat:     parseFloat(d.ShortPercentOutstanding || 0),
        dividendYield:     parseFloat(d.DividendYield || 0),
        analystTarget:     parseFloat(d.AnalystTargetPrice || 0),
        analystStrongBuy:  parseInt(d.AnalystRatingStrongBuy || 0),
        analystBuy:        parseInt(d.AnalystRatingBuy || 0),
        analystHold:       parseInt(d.AnalystRatingHold || 0),
        analystSell:       parseInt(d.AnalystRatingSell || 0),
        analystStrongSell: parseInt(d.AnalystRatingStrongSell || 0),
        latestQuarter:     d.LatestQuarter || '',
        revenueGrowthYOY:  parseFloat(d.QuarterlyRevenueGrowthYOY || 0),
        earningsGrowthYOY: parseFloat(d.QuarterlyEarningsGrowthYOY || 0),
      }
    };
  } catch(e) {
    return { ticker, error: e.message, source: 'Alpha Vantage' };
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
    const raw = d.data || d.insiderTransactions || [];
    const transactions = raw.slice(0,20).map(t => ({
      name:       t.executive || t.executiveName || t.name || t.insider || '',
      title:      t.executiveTitle || t.title || t.relation || '',
      date:       t.transactionDate || t.date || '',
      type:       t.acquistionOrDisposal === 'A' ? 'Achat' : t.acquistionOrDisposal === 'D' ? 'Vente' : (t.transactionType || t.type || ''),
      shares:     parseInt(t.shares || 0),
      price:      parseFloat(t.sharePrice || t.price || 0),
      total:      Math.round(parseInt(t.shares || 0) * parseFloat(t.sharePrice || t.price || 0)),
      ownership:  t.ownershipType || ''
    }));
    const buys = transactions.filter(t => t.type === 'Achat' || t.type === 'A' || (t.type && t.type.toLowerCase().includes('buy')));
    return { ticker, transactions, buys, total: transactions.length, source: 'Alpha Vantage' };
  } catch(e) {
    return { ticker, transactions: [], buys: [], error: e.message, source: 'Alpha Vantage' };
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
    const raw = d.ownership || d.institutionalOwnership || d.data || [];
    const holders = raw.slice(0,15).map(h => ({
      name:      h.institutionName || h.organization || h.name || h.holder || '',
      date:      h.date || h.reportDate || '',
      shares:    parseInt(h.sharesHeld || h.position || h.shares || 0),
      value:     parseInt(h.marketValue || h.value || 0),
      pctHeld:   parseFloat(h.percentPortfolio || h.pctHeld || h.percentHeld || 0),
      pctChange: parseFloat(h.changeInSharesPercent || h.pctChange || h.changePercent || 0),
      change:    parseInt(h.changeInShares || h.change || 0)
    }));
    return { ticker, holders, total: holders.length, source: 'Alpha Vantage' };
  } catch(e) {
    return { ticker, holders: [], error: e.message, source: 'Alpha Vantage' };
  }
}

// ── SEC EDGAR (/sec/*) ────────────────────────────────────────────────────────
async function secCrossings(ticker) {
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&dateRange=custom&startdt=${daysAgo(90)}&enddt=${today()}&forms=SC+13D,SC+13G,SC+13G%2FA,SC+13D%2FA`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || !d.hits) return { ticker, filings: [], source: 'SEC EDGAR' };
    const filings = (d.hits.hits || []).slice(0,10).map(h => {
      const src = h._source || {};
      const names = src.display_names || [];
      return {
        type:   src.form_type || '',
        filer:  names.length > 0 ? names[0].name || '' : src.entity_name || 'Unknown',
        filed:  src.file_date || '',
        period: src.period_of_report || ''
      };
    });
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
    const holdings = (d.hits.hits || []).slice(0,15).map(h => {
      const src = h._source || {};
      const names = src.display_names || [];
      return {
        filer:  names.length > 0 ? names[0].name || '' : src.entity_name || 'Unknown',
        filed:  src.file_date || '',
        period: src.period_of_report || '',
        type:   src.form_type || '13F-HR'
      };
    });
    return { ticker, holdings, total: (d.hits.total && d.hits.total.value) || 0, source: 'SEC 13F' };
  } catch(e) {
    return { ticker, holdings: [], error: e.message, source: 'SEC 13F' };
  }
}

// ── SEC EDGAR Form 4 via RSS (/insider/*) ─────────────────────────────────────
// Uses EDGAR RSS feed which properly includes company + insider names
async function insiderBuys(ticker) {
  try {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=&CIK=${encodeURIComponent(ticker)}&type=4&dateb=&owner=include&count=20&search_text=&output=atom`;
    const r = await fetchURL(url);
    const entries = parseXMLAtom(r.body);
    const buys = entries.slice(0,15).map(e => {
      const title = e.title || '';
      const parts = title.split(' - ').map(p => p.trim());
      const insider = parts.length > 1 ? parts[1].replace(/\(\d+\)/g,'').replace(/\(Issuer\)/gi,'').trim() : '';
      const company = parts.length > 2 ? parts.slice(2).join(' - ').replace(/\(\d+\)/g,'').replace(/\(Issuer\)/gi,'').trim() : ticker;
      return {
        date:    e.updated ? e.updated.slice(0,10) : '',
        ticker:  ticker,
        insider: insider,
        company: company,
        summary: e.summary ? e.summary.replace(/<[^>]+>/g,'').slice(0,120).trim() : '',
        link:    e.link || ''
      };
    });
    return { ticker, buys, total: buys.length, source: 'SEC EDGAR RSS Form 4' };
  } catch(e) {
    return { ticker, buys: [], error: e.message, source: 'SEC EDGAR RSS' };
  }
}

async function insiderRadar() {
  try {
    const url = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=30&search_text=&output=atom';
    const r = await fetchURL(url);
    const entries = parseXMLAtom(r.body);
    // SEC EDGAR RSS title format: "4 - INSIDER NAME - COMPANY NAME"
    // or "4 - COMPANY NAME (0001234) (Issuer)"
    const buys = entries.slice(0,25).map(e => {
      const title = e.title || '';
      const parts = title.split(' - ').map(p => p.trim());
      // parts[0] = form type (4), parts[1] = filer name, parts[2+] = company
      const insider = parts.length > 1 ? parts[1].replace(/\(\d+\)/g,'').replace(/\(Issuer\)/gi,'').trim() : '';
      const company = parts.length > 2 ? parts.slice(2).join(' - ').replace(/\(\d+\)/g,'').replace(/\(Issuer\)/gi,'').trim() : '';
      return {
        date:    e.updated ? e.updated.slice(0,10) : '',
        company: company || insider,
        insider: company ? insider : '',
        summary: e.summary ? e.summary.replace(/<[^>]+>/g,'').slice(0,120).trim() : '',
        link:    e.link || ''
      };
    });
    return { buys, total: buys.length, source: 'SEC EDGAR RSS Form 4', asOf: today() };
  } catch(e) {
    return { buys: [], error: e.message, source: 'SEC EDGAR RSS' };
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
      const tdPath = rawPath.replace('/td', '');
      console.log(`[TD] ${tdPath}?${rawQuery}`);
      const r = await fetchURL(tdURL(tdPath, rawQuery || ''));
      res.writeHead(200); res.end(r.body); return;
    }

    // Alpha Vantage
    if (rawPath === '/av/overview') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[AV] overview ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await avOverview(ticker))); return;
    }
    if (rawPath === '/av/short') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[AV] short ${ticker}`);
      // Extract short interest data from OVERVIEW
      const ov = await avOverview(ticker);
      if (ov.error) { res.writeHead(200); res.end(JSON.stringify({ticker, error: ov.error, source:'Alpha Vantage'})); return; }
      const d = ov.data || {};
      res.writeHead(200); res.end(JSON.stringify({
        ticker, source: 'Alpha Vantage OVERVIEW',
        shortInterest: {
          sharesShort:           d.sharesShort || 0,
          sharesShortPriorMonth: d.sharesShortPrior || 0,
          changeVsPrior:         d.sharesShortPrior > 0 ? (((d.sharesShort - d.sharesShortPrior) / d.sharesShortPrior) * 100).toFixed(1) : 0,
          shortRatio:            d.shortRatio || 0,
          shortPctFloat:         d.shortPctFloat || 0,
          floatShares:           d.sharesFloat || 0,
          sharesOutstanding:     d.sharesOutstanding || 0,
          lastUpdate:            d.latestQuarter || '',
          beta:                  d.beta || 0,
          analystTarget:         d.analystTarget || 0,
        }
      })); return;
    }
    if (rawPath === '/av/insiders') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[AV] insiders ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await avInsiders(ticker))); return;
    }
    if (rawPath === '/av/holders') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[AV] holders ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await avHolders(ticker))); return;
    }

    // SEC EDGAR institutional
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

    // SEC Form 4 insiders via RSS
    if (rawPath === '/insider/buys') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      console.log(`[INSIDER] buys ${ticker}`);
      res.writeHead(200); res.end(JSON.stringify(await insiderBuys(ticker))); return;
    }
    if (rawPath === '/insider/radar') {
      console.log(`[INSIDER] radar`);
      res.writeHead(200); res.end(JSON.stringify(await insiderRadar())); return;
    }

    // ── Dukascopy real-time XAU/EUR (/dukascopy/price) ──────────────────────
    if (rawPath === '/dukascopy/price') {
      try {
        const now = Date.now();
        const [rXAU, rEUR] = await Promise.all([
          fetchURL(`https://freeserv.dukascopy.com/2.0/?path=chart/json&instrument=XAU%2FUSD&offer_side=B&interval=1&time=${now}&from=0&to=1&jsonp=a`),
          fetchURL(`https://freeserv.dukascopy.com/2.0/?path=chart/json&instrument=EUR%2FUSD&offer_side=B&interval=1&time=${now}&from=0&to=1&jsonp=a`)
        ]);
        const parseJSONP = (body) => {
          const m = body.match(/a\(([\s\S]*)\)/);
          return m ? jp(m[1]) : null;
        };
        const dXAU = parseJSONP(rXAU.body);
        const dEUR = parseJSONP(rEUR.body);
        if (dXAU && dXAU[0] && dEUR && dEUR[0]) {
          const xauUsd = parseFloat(dXAU[0][4]);
          const eurUsd = parseFloat(dEUR[0][4]);
          const xauEur = xauUsd / eurUsd;
          console.log(`[DK] XAU/USD=${xauUsd} EUR/USD=${eurUsd} XAU/EUR=${xauEur.toFixed(2)}`);
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.writeHead(200);
          res.end(JSON.stringify({ price: xauEur, source: 'Dukascopy', ts: new Date().toISOString() }));
          return;
        }
      } catch(e) { console.log('Dukascopy error:', e.message); }
      // Fallback
      try {
        const result = await getPrice();
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.writeHead(200);
        res.end(JSON.stringify({ price: result.price, source: result.symbol, ts: new Date().toISOString() }));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // XAU/EUR gold dashboard
    if (rawPath === '/price') {
      const result = await getPrice();
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.writeHead(200);
      res.end(JSON.stringify({ price: result.price, source: result.symbol, symbol: result.symbol, ts: new Date().toISOString() }));
      return;
    }

    // ── Claude API proxy (/claude) ─────────────────────────────────────────────
  if (rawPath === '/claude') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({error:'POST required'})); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
        if (!CLAUDE_KEY) { res.writeHead(500); res.end(JSON.stringify({error:'ANTHROPIC_API_KEY not set'})); return; }
        const response = await new Promise((resolve, reject) => {
          const data = Buffer.from(body);
          const opts = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': data.length,
              'x-api-key': CLAUDE_KEY,
              'anthropic-version': '2023-06-01'
            }
          };
          const r = https.request(opts, (resp) => {
            let d = '';
            resp.on('data', chunk => d += chunk);
            resp.on('end', () => resolve(d));
          });
          r.on('error', reject);
          r.setTimeout(30000, () => { r.destroy(); reject(new Error('Claude timeout')); });
          r.write(data);
          r.end();
        });
        res.writeHead(200);
        res.end(response);
      } catch(e) {
        console.error('Claude proxy error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({error: e.message}));
      }
    });
    return;
  }

  // ── DXY Dollar Index ──────────────────────────────────────────────────────
  if (rawPath === '/dxy') {
    try {
      const symbols = ['DX-Y.NYB', 'USDX', 'DXY'];
      let result = null;
      for (const sym of symbols) {
        try {
          const r = await fetchURL(tdURL('/quote', 'symbol='+encodeURIComponent(sym)));
          const d = jp(r.body);
          if (d && d.close && !d.status) { result = d; break; }
        } catch(e) {}
      }
      res.writeHead(200);
      res.end(JSON.stringify(result ? {
        price: parseFloat(result.close),
        change: parseFloat(result.change || 0),
        pct: parseFloat(result.percent_change || 0),
        source: 'TwelveData DXY', ts: new Date().toISOString()
      } : { price: 104.5, change: 0, pct: 0, source: 'fallback' }));
    } catch(e) {
      res.writeHead(200);
      res.end(JSON.stringify({ price: 104.5, change: 0, pct: 0, error: e.message }));
    }
    return;
  }

  // ── SSE Stream (/stream) ──────────────────────────────────────────────────
  if (rawPath === '/stream') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200);
    if(lastPrice) res.write('data: ' + JSON.stringify(lastPrice) + '\n\n');
    else res.write('data: ' + JSON.stringify({price:0,symbol:'connecting',ts:new Date().toISOString()}) + '\n\n');
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(':heartbeat\n\n'); } catch(e) { clearInterval(heartbeat); sseClients.delete(res); }
    }, 15000);
    req.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); });
    return;
  }

  if (rawPath === '/health') {
      const result = await getPrice();
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok', version: 'v5',
        asset: 'XAU/EUR', workingSymbol: result.symbol, currentPrice: result.price,
        routes: [
          '/price', '/health', '/debug',
          '/td/quote?symbol=X', '/td/time_series?symbol=X&interval=1day&outputsize=60',
          '/av/overview?ticker=X', '/av/insiders?ticker=X', '/av/holders?ticker=X',
          '/sec/crossings?ticker=X', '/sec/institutional?ticker=X',
          '/insider/buys?ticker=X', '/insider/radar'
        ],
        ts: new Date().toISOString()
      }));
      return;
    }

    if (rawPath === '/debug') {
      const results = {};
      for (const sym of SYMBOLS) {
        try {
          const r = await fetchURL(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&t=${Date.now()}`);
          results[sym] = jp(r.body);
        } catch(e) { results[sym] = { error: e.message }; }
      }
      res.writeHead(200); res.end(JSON.stringify({ results, ts: new Date().toISOString() })); return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({
      error: 'Route inconnue', version: 'v5',
      routes: ['/price','/health','/debug','/td/quote?symbol=X','/td/time_series?symbol=X&interval=1day&outputsize=60','/av/overview?ticker=X','/av/insiders?ticker=X','/av/holders?ticker=X','/sec/crossings?ticker=X','/sec/institutional?ticker=X','/insider/buys?ticker=X','/insider/radar']
    }));

  } catch(e) {
    console.error('Unhandled error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`NM Trading Proxy v5 — port ${PORT}`);
  setTimeout(pollAndBroadcast, 2000);
});
