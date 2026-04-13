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

async function pollAndBroadcast() {
  try {
    const result = await getPrice();
    broadcastPrice(result.price, result.symbol);
    console.log('[PRICE] ' + result.symbol + ' = ' + result.price.toFixed(2));
  } catch(e) {
    console.log('[PRICE] Error:', e.message);
  }
  setTimeout(pollAndBroadcast, 15000);
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
function daysFromNow(n) { const d = new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }

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

// ── XAU/EUR ───────────────────────────────────────────────────────────────────
const SYMBOLS = ['XAU/EUR','XAUEUR'];

async function getPriceDukascopy() {
  const ts = Date.now();
  const url = `https://freeserv.dukascopy.com/2.0/?path=chart/json&instrument=XAU%2FUSD&offer_side=B&interval=1&time=${ts}&from=0&to=1&jsonp=cb`;
  const urlEUR = `https://freeserv.dukascopy.com/2.0/?path=chart/json&instrument=EUR%2FUSD&offer_side=B&interval=1&time=${ts}&from=0&to=1&jsonp=cb`;
  const [r1, r2] = await Promise.all([fetchURL(url), fetchURL(urlEUR)]);
  const parseJSONP = (body) => {
    const match = body.match(/cb\((.*)\)/s);
    if (!match) return null;
    return jp(match[1]);
  };
  const d1 = parseJSONP(r1.body);
  const d2 = parseJSONP(r2.body);
  if (d1 && d1[0] && d2 && d2[0]) {
    const xauUsd = parseFloat(d1[0][4]);
    const eurUsd = parseFloat(d2[0][4]);
    if (xauUsd > 1000 && eurUsd > 0.5) {
      return { price: xauUsd / eurUsd, symbol: 'XAU/EUR (Dukascopy)' };
    }
  }
  throw new Error('Dukascopy parse failed');
}

async function getPrice() {
  try { return await getPriceDukascopy(); } catch(e) { console.log('Dukascopy failed:', e.message); }
  for (const sym of ['XAU/EUR', 'XAUEUR']) {
    try {
      const r = await fetchURL(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&t=${Date.now()}`);
      const d = jp(r.body);
      const p = parseFloat(d && (d.close || d.price));
      if (p > 100 && p < 100000) return { price: p, symbol: sym + ' (quote)' };
    } catch(e) {}
  }
  for (const sym of SYMBOLS) {
    try {
      const r = await fetchURL(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}&t=${Date.now()}`);
      const d = jp(r.body);
      const p = parseFloat(d && d.price);
      if (p > 100 && p < 100000) return { price: p, symbol: sym };
    } catch(e) {}
  }
  throw new Error('All XAU symbols failed');
}

// ── TwelveData helpers ────────────────────────────────────────────────────────
function tdURL(path, query) {
  const sep = query ? '&' : '?';
  return `https://api.twelvedata.com${path}?${query}${sep}apikey=${TD_KEY}`;
}

// ── Alpha Vantage helpers ─────────────────────────────────────────────────────
async function avOverview(ticker) {
  try {
    const r = await fetchURL(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`);
    const d = jp(r.body);
    if (!d || d.Information || d['Error Message'] || !d.Symbol) {
      return { ticker, error: (d && (d.Information || d['Error Message'])) || 'No data', source: 'Alpha Vantage' };
    }
    return {
      ticker, source: 'Alpha Vantage',
      data: {
        name: d.Name || '', sector: d.Sector || '', industry: d.Industry || '',
        description: d.Description || '', exchange: d.Exchange || '', currency: d.Currency || '',
        marketCap: parseInt(d.MarketCapitalization || 0), pe: parseFloat(d.PERatio || 0),
        forwardPE: parseFloat(d.ForwardPE || 0), eps: parseFloat(d.EPS || 0),
        beta: parseFloat(d.Beta || 0), high52: parseFloat(d['52WeekHigh'] || 0),
        low52: parseFloat(d['52WeekLow'] || 0), sharesOutstanding: parseInt(d.SharesOutstanding || 0),
        sharesFloat: parseInt(d.SharesFloat || 0), sharesShort: parseInt(d.SharesShort || 0),
        sharesShortPrior: parseInt(d.SharesShortPriorMonth || 0),
        shortRatio: parseFloat(d.ShortRatio || 0), shortPctFloat: parseFloat(d.ShortPercentOutstanding || 0),
        dividendYield: parseFloat(d.DividendYield || 0), analystTarget: parseFloat(d.AnalystTargetPrice || 0),
        analystStrongBuy: parseInt(d.AnalystRatingStrongBuy || 0), analystBuy: parseInt(d.AnalystRatingBuy || 0),
        analystHold: parseInt(d.AnalystRatingHold || 0), analystSell: parseInt(d.AnalystRatingSell || 0),
        analystStrongSell: parseInt(d.AnalystRatingStrongSell || 0), latestQuarter: d.LatestQuarter || '',
        revenueGrowthYOY: parseFloat(d.QuarterlyRevenueGrowthYOY || 0),
        earningsGrowthYOY: parseFloat(d.QuarterlyEarningsGrowthYOY || 0),
      }
    };
  } catch(e) { return { ticker, error: e.message, source: 'Alpha Vantage' }; }
}

async function avInsiders(ticker) {
  try {
    const r = await fetchURL(`https://www.alphavantage.co/query?function=INSIDER_TRANSACTIONS&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`);
    const d = jp(r.body);
    if (!d || d.Information || d['Error Message']) {
      return { ticker, transactions: [], source: 'Alpha Vantage', note: d && (d.Information || d['Error Message']) };
    }
    const raw = d.data || d.insiderTransactions || [];
    const transactions = raw.slice(0,20).map(t => ({
      name: t.executive || t.executiveName || t.name || t.insider || '',
      title: t.executiveTitle || t.title || t.relation || '',
      date: t.transactionDate || t.date || '',
      type: t.acquistionOrDisposal === 'A' ? 'Achat' : t.acquistionOrDisposal === 'D' ? 'Vente' : (t.transactionType || t.type || ''),
      shares: parseInt(t.shares || 0), price: parseFloat(t.sharePrice || t.price || 0),
      total: Math.round(parseInt(t.shares || 0) * parseFloat(t.sharePrice || t.price || 0)),
      ownership: t.ownershipType || ''
    }));
    const buys = transactions.filter(t => t.type === 'Achat' || t.type === 'A' || (t.type && t.type.toLowerCase().includes('buy')));
    return { ticker, transactions, buys, total: transactions.length, source: 'Alpha Vantage' };
  } catch(e) { return { ticker, transactions: [], buys: [], error: e.message, source: 'Alpha Vantage' }; }
}

async function avHolders(ticker) {
  try {
    const r = await fetchURL(`https://www.alphavantage.co/query?function=INSTITUTIONAL_OWNERSHIP&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`);
    const d = jp(r.body);
    if (!d || d.Information || d['Error Message']) {
      return { ticker, holders: [], source: 'Alpha Vantage', note: d && (d.Information || d['Error Message']) };
    }
    const raw = d.ownership || d.institutionalOwnership || d.data || [];
    const holders = raw.slice(0,15).map(h => ({
      name: h.institutionName || h.organization || h.name || h.holder || '',
      date: h.date || h.reportDate || '', shares: parseInt(h.sharesHeld || h.position || h.shares || 0),
      value: parseInt(h.marketValue || h.value || 0),
      pctHeld: parseFloat(h.percentPortfolio || h.pctHeld || h.percentHeld || 0),
      pctChange: parseFloat(h.changeInSharesPercent || h.pctChange || h.changePercent || 0),
      change: parseInt(h.changeInShares || h.change || 0)
    }));
    return { ticker, holders, total: holders.length, source: 'Alpha Vantage' };
  } catch(e) { return { ticker, holders: [], error: e.message, source: 'Alpha Vantage' }; }
}

// ── SEC EDGAR ─────────────────────────────────────────────────────────────────
async function secCrossings(ticker) {
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&dateRange=custom&startdt=${daysAgo(90)}&enddt=${today()}&forms=SC+13D,SC+13G,SC+13G%2FA,SC+13D%2FA`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || !d.hits) return { ticker, filings: [], source: 'SEC EDGAR' };
    const filings = (d.hits.hits || []).slice(0,10).map(h => {
      const src = h._source || {};
      const names = src.display_names || [];
      return { type: src.form_type || '', filer: names.length > 0 ? names[0].name || '' : src.entity_name || 'Unknown', filed: src.file_date || '', period: src.period_of_report || '' };
    });
    return { ticker, filings, total: (d.hits.total && d.hits.total.value) || 0, source: 'SEC EDGAR' };
  } catch(e) { return { ticker, filings: [], error: e.message, source: 'SEC EDGAR' }; }
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
      return { filer: names.length > 0 ? names[0].name || '' : src.entity_name || 'Unknown', filed: src.file_date || '', period: src.period_of_report || '', type: src.form_type || '13F-HR' };
    });
    return { ticker, holdings, total: (d.hits.total && d.hits.total.value) || 0, source: 'SEC 13F' };
  } catch(e) { return { ticker, holdings: [], error: e.message, source: 'SEC 13F' }; }
}

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
      return { date: e.updated ? e.updated.slice(0,10) : '', ticker, insider, company, summary: e.summary ? e.summary.replace(/<[^>]+>/g,'').slice(0,120).trim() : '', link: e.link || '' };
    });
    return { ticker, buys, total: buys.length, source: 'SEC EDGAR RSS Form 4' };
  } catch(e) { return { ticker, buys: [], error: e.message, source: 'SEC EDGAR RSS' }; }
}

async function insiderRadar() {
  try {
    const url = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=30&search_text=&output=atom';
    const r = await fetchURL(url);
    const entries = parseXMLAtom(r.body);
    const buys = entries.slice(0,25).map(e => {
      const title = e.title || '';
      const parts = title.split(' - ').map(p => p.trim());
      const insider = parts.length > 1 ? parts[1].replace(/\(\d+\)/g,'').replace(/\(Issuer\)/gi,'').trim() : '';
      const company = parts.length > 2 ? parts.slice(2).join(' - ').replace(/\(\d+\)/g,'').replace(/\(Issuer\)/gi,'').trim() : '';
      return { date: e.updated ? e.updated.slice(0,10) : '', company: company || insider, insider: company ? insider : '', summary: e.summary ? e.summary.replace(/<[^>]+>/g,'').slice(0,120).trim() : '', link: e.link || '' };
    });
    return { buys, total: buys.length, source: 'SEC EDGAR RSS Form 4', asOf: today() };
  } catch(e) { return { buys: [], error: e.message, source: 'SEC EDGAR RSS' }; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── BEAT TRACKER — NOUVEAUX ENDPOINTS ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// Watchlist SBF 120 semis + US équivalents (maintenu ici, éditable)
const WATCHLIST = [
  // SBF 120 / Europe
  { ticker: 'SOI',  name: 'Soitec',             zone: 'fr', exchange: 'EPA', mic: 'XPAR' },
  { ticker: 'ASML', name: 'ASML Holding',        zone: 'fr', exchange: 'NASDAQ', mic: 'XNAS' },
  { ticker: 'STM',  name: 'STMicroelectronics',  zone: 'fr', exchange: 'NYSE', mic: 'XNYS' },
  { ticker: 'IFX',  name: 'Infineon',            zone: 'fr', exchange: 'XETRA', mic: 'XETR' },
  { ticker: 'NBTX', name: 'Nanobiotix',          zone: 'fr', exchange: 'NASDAQ', mic: 'XNAS' },
  // US semis
  { ticker: 'TXN',  name: 'Texas Instruments',   zone: 'us', exchange: 'NASDAQ', mic: 'XNAS' },
  { ticker: 'NVDA', name: 'Nvidia',              zone: 'us', exchange: 'NASDAQ', mic: 'XNAS' },
  { ticker: 'AMD',  name: 'AMD',                 zone: 'us', exchange: 'NASDAQ', mic: 'XNAS' },
  { ticker: 'INTC', name: 'Intel',               zone: 'us', exchange: 'NASDAQ', mic: 'XNAS' },
  { ticker: 'QCOM', name: 'Qualcomm',            zone: 'us', exchange: 'NASDAQ', mic: 'XNAS' },
  { ticker: 'MRVL', name: 'Marvell Technology',  zone: 'us', exchange: 'NASDAQ', mic: 'XNAS' },
  { ticker: 'AMAT', name: 'Applied Materials',   zone: 'us', exchange: 'NASDAQ', mic: 'XNAS' },
  { ticker: 'LRCX', name: 'Lam Research',        zone: 'us', exchange: 'NASDAQ', mic: 'XNAS' },
];

// 1. TwelveData earnings calendar pour une liste de tickers
async function getEarningsFromTD(tickers) {
  try {
    const symbols = tickers.join(',');
    const url = `https://api.twelvedata.com/earnings?symbol=${encodeURIComponent(symbols)}&period=quarterly&outputsize=1&apikey=${TD_KEY}`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d) return {};
    // TwelveData renvoie soit un objet par ticker, soit tableau pour un seul
    const results = {};
    if (Array.isArray(d)) {
      // single ticker
      results[tickers[0]] = d;
    } else {
      for (const [sym, val] of Object.entries(d)) {
        results[sym] = Array.isArray(val) ? val : (val.earnings || []);
      }
    }
    return results;
  } catch(e) {
    console.log('[TD earnings] error:', e.message);
    return {};
  }
}

// 2. Alpha Vantage EARNINGS pour un ticker (historique + prochaine date)
async function getEarningsFromAV(ticker) {
  try {
    const url = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`;
    const r = await fetchURL(url);
    const d = jp(r.body);
    if (!d || d.Information || d['Error Message']) return null;
    const quarterly = d.quarterlyEarnings || [];
    return {
      ticker,
      nextReportDate: quarterly.length > 0 ? quarterly[0].reportedDate || quarterly[0].fiscalDateEnding : null,
      history: quarterly.slice(0, 8).map(q => ({
        period:         q.fiscalDateEnding || '',
        reportedDate:   q.reportedDate || '',
        estimate:       parseFloat(q.estimatedEPS || 0),
        actual:         parseFloat(q.reportedEPS || 0),
        surprise:       parseFloat(q.surprise || 0),
        surprisePct:    parseFloat(q.surprisePercentage || 0),
        beat:           parseFloat(q.reportedEPS || 0) > parseFloat(q.estimatedEPS || 0)
      })),
      source: 'Alpha Vantage EARNINGS'
    };
  } catch(e) { return null; }
}

// 3. Calcule un score de probabilité de beat basé sur historique AV
function computeBeatScore(avHistory) {
  if (!avHistory || !avHistory.history || avHistory.history.length === 0) return 50;
  const hist = avHistory.history.filter(h => h.estimate !== 0);
  if (hist.length === 0) return 50;
  const beatCount = hist.filter(h => h.beat).length;
  const beatRate = beatCount / hist.length;
  // Pondération récente : 3 derniers trimestres comptent double
  const recent = hist.slice(0, 3);
  const recentBeat = recent.filter(h => h.beat).length;
  const recentRate = recent.length > 0 ? recentBeat / recent.length : 0.5;
  // Score composite : 40% historique global, 60% récent
  const rawScore = (beatRate * 0.4 + recentRate * 0.6) * 100;
  // Ajustement momentum : tendance des surprises
  const avgSurprise = hist.slice(0, 4).reduce((s, h) => s + h.surprisePct, 0) / Math.min(4, hist.length);
  const momentumBonus = Math.min(10, Math.max(-10, avgSurprise * 0.5));
  return Math.round(Math.min(95, Math.max(20, rawScore + momentumBonus)));
}

// 4. Endpoint principal : /earnings/calendar
// Cascade : TwelveData → Alpha Vantage → fallback statique
async function earningsCalendar(zone) {
  const list = zone ? WATCHLIST.filter(w => w.zone === zone) : WATCHLIST;
  const tickers = list.map(w => w.ticker);

  // Source 1 : TwelveData calendar (prochaines dates)
  let tdResults = {};
  try {
    tdResults = await getEarningsFromTD(tickers);
    console.log('[EARNINGS] TwelveData OK, tickers:', Object.keys(tdResults).length);
  } catch(e) {
    console.log('[EARNINGS] TwelveData failed:', e.message);
  }

  // Source 2 : Alpha Vantage (historique EPS + beat calc) — en parallèle, limité à 5 pour éviter rate limit
  const avPromises = tickers.slice(0, 5).map(t => getEarningsFromAV(t).then(r => ({ ticker: t, data: r })));
  const avResults = {};
  try {
    const settled = await Promise.allSettled(avPromises);
    settled.forEach(s => {
      if (s.status === 'fulfilled' && s.value.data) {
        avResults[s.value.ticker] = s.value.data;
      }
    });
    console.log('[EARNINGS] Alpha Vantage OK, tickers:', Object.keys(avResults).length);
  } catch(e) {
    console.log('[EARNINGS] Alpha Vantage batch failed:', e.message);
  }

  // Fusion des données
  const now = new Date();
  const output = list.map(stock => {
    const tdData = tdResults[stock.ticker] || [];
    const avData = avResults[stock.ticker] || null;

    // Cherche prochaine date dans TwelveData
    let nextDate = null;
    let nextDateSource = null;
    if (tdData.length > 0) {
      const upcoming = tdData.find(e => e.date && new Date(e.date) >= now);
      if (upcoming) { nextDate = upcoming.date; nextDateSource = 'TwelveData'; }
    }
    // Fallback AV
    if (!nextDate && avData && avData.nextReportDate) {
      nextDate = avData.nextReportDate;
      nextDateSource = 'Alpha Vantage';
    }

    // Calcul jours restants
    const daysLeft = nextDate ? Math.round((new Date(nextDate) - now) / (1000*60*60*24)) : null;

    // Beat score depuis historique AV
    const beatProb = avData ? computeBeatScore(avData) : 50;

    // Signal
    let signal = 'watch';
    if (daysLeft !== null && daysLeft <= 7) signal = 'hot';
    else if (daysLeft !== null && daysLeft <= 14) signal = 'alert';
    else if (beatProb >= 75) signal = 'alert';

    // Historique EPS pour le beat tracker UI
    const epsHistory = avData ? avData.history.slice(0, 6) : [];

    // Moyenne surprise historique
    const avgSurprisePct = epsHistory.length > 0
      ? parseFloat((epsHistory.reduce((s, h) => s + h.surprisePct, 0) / epsHistory.length).toFixed(1))
      : null;

    return {
      ticker:       stock.ticker,
      name:         stock.name,
      zone:         stock.zone,
      exchange:     stock.exchange,
      nextDate,
      nextDateSource,
      daysLeft,
      beatProb,
      signal,
      avgSurprisePct,
      epsHistory,
      sources: {
        td:  tdData.length > 0,
        av:  !!avData
      }
    };
  });

  // Tri par daysLeft croissant (null à la fin)
  output.sort((a, b) => {
    if (a.daysLeft === null && b.daysLeft === null) return 0;
    if (a.daysLeft === null) return 1;
    if (b.daysLeft === null) return -1;
    return a.daysLeft - b.daysLeft;
  });

  return {
    asOf: now.toISOString(),
    count: output.length,
    urgent: output.filter(s => s.daysLeft !== null && s.daysLeft <= 14).length,
    avgBeatProb: Math.round(output.reduce((s, o) => s + o.beatProb, 0) / output.length),
    results: output,
    sources: ['TwelveData earnings', 'Alpha Vantage EARNINGS']
  };
}

// 5. Endpoint : /earnings/ticker — détail complet pour un ticker
async function earningsDetail(ticker) {
  const [tdRaw, avData] = await Promise.allSettled([
    getEarningsFromTD([ticker]),
    getEarningsFromAV(ticker)
  ]);

  const td = tdRaw.status === 'fulfilled' ? (tdRaw.value[ticker] || []) : [];
  const av = avData.status === 'fulfilled' ? avData.value : null;

  const beatScore = computeBeatScore(av);
  const now = new Date();
  const upcoming = td.find(e => e.date && new Date(e.date) >= now);

  return {
    ticker,
    beatProb: beatScore,
    nextDate: upcoming ? upcoming.date : (av ? av.nextReportDate : null),
    epsHistory: av ? av.history : [],
    avgSurprisePct: av && av.history.length > 0
      ? parseFloat((av.history.reduce((s,h) => s + h.surprisePct, 0) / av.history.length).toFixed(1))
      : null,
    raw: { td, av },
    asOf: now.toISOString()
  };
}

// 6. Endpoint : /earnings/beatrate — beat rate global du secteur semis
async function sectorBeatRate() {
  const tickers = WATCHLIST.map(w => w.ticker);
  const promises = tickers.slice(0, 6).map(t => getEarningsFromAV(t));
  const results = await Promise.allSettled(promises);
  let totalQ = 0, beatQ = 0, totalSurprise = 0;
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value && r.value.history) {
      r.value.history.forEach(h => {
        if (h.estimate !== 0) {
          totalQ++;
          if (h.beat) beatQ++;
          totalSurprise += h.surprisePct;
        }
      });
    }
  });
  return {
    sectorBeatRate: totalQ > 0 ? parseFloat((beatQ / totalQ * 100).toFixed(1)) : null,
    avgSurprisePct: totalQ > 0 ? parseFloat((totalSurprise / totalQ).toFixed(1)) : null,
    sampledTickers: tickers.slice(0, 6),
    quartersAnalyzed: totalQ,
    asOf: today()
  };
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const [rawPath, rawQuery] = req.url.split('?');
  const params = new URLSearchParams(rawQuery || '');
  const ticker = (params.get('ticker') || '').toUpperCase();

  try {

    // ── BEAT TRACKER ENDPOINTS (nouveaux) ─────────────────────────────────────

    // /earnings/calendar — liste complète avec beat scores
    // ?zone=fr  ou  ?zone=us  ou  sans param = tout
    if (rawPath === '/earnings/calendar') {
      const zone = params.get('zone') || null;
      console.log(`[EARNINGS] calendar zone=${zone || 'all'}`);
      const data = await earningsCalendar(zone);
      res.writeHead(200);
      res.end(JSON.stringify(data));
      return;
    }

    // /earnings/ticker?ticker=NVDA — détail EPS pour un titre
    if (rawPath === '/earnings/ticker') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({ error: 'ticker required' })); return; }
      console.log(`[EARNINGS] detail ${ticker}`);
      const data = await earningsDetail(ticker);
      res.writeHead(200);
      res.end(JSON.stringify(data));
      return;
    }

    // /earnings/beatrate — beat rate sectoriel semis
    if (rawPath === '/earnings/beatrate') {
      console.log('[EARNINGS] beatrate');
      const data = await sectorBeatRate();
      res.writeHead(200);
      res.end(JSON.stringify(data));
      return;
    }

    // ── ENDPOINTS EXISTANTS (inchangés) ──────────────────────────────────────

    if (rawPath.startsWith('/td/')) {
      const tdPath = rawPath.replace('/td', '');
      console.log(`[TD] ${tdPath}?${rawQuery}`);
      const r = await fetchURL(tdURL(tdPath, rawQuery || ''));
      res.writeHead(200); res.end(r.body); return;
    }

    if (rawPath === '/av/overview') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      res.writeHead(200); res.end(JSON.stringify(await avOverview(ticker))); return;
    }
    if (rawPath === '/av/short') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      const ov = await avOverview(ticker);
      if (ov.error) { res.writeHead(200); res.end(JSON.stringify({ticker, error: ov.error})); return; }
      const d = ov.data || {};
      res.writeHead(200); res.end(JSON.stringify({
        ticker, source: 'Alpha Vantage OVERVIEW',
        shortInterest: {
          sharesShort: d.sharesShort || 0, sharesShortPriorMonth: d.sharesShortPrior || 0,
          changeVsPrior: d.sharesShortPrior > 0 ? (((d.sharesShort - d.sharesShortPrior) / d.sharesShortPrior) * 100).toFixed(1) : 0,
          shortRatio: d.shortRatio || 0, shortPctFloat: d.shortPctFloat || 0,
          floatShares: d.sharesFloat || 0, sharesOutstanding: d.sharesOutstanding || 0,
          lastUpdate: d.latestQuarter || '', beta: d.beta || 0, analystTarget: d.analystTarget || 0,
        }
      })); return;
    }
    if (rawPath === '/av/insiders') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      res.writeHead(200); res.end(JSON.stringify(await avInsiders(ticker))); return;
    }
    if (rawPath === '/av/holders') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      res.writeHead(200); res.end(JSON.stringify(await avHolders(ticker))); return;
    }

    if (rawPath === '/sec/crossings') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      res.writeHead(200); res.end(JSON.stringify(await secCrossings(ticker))); return;
    }
    if (rawPath === '/sec/institutional') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      res.writeHead(200); res.end(JSON.stringify(await secInstitutional(ticker))); return;
    }

    if (rawPath === '/insider/buys') {
      if (!ticker) { res.writeHead(400); res.end(JSON.stringify({error:'ticker required'})); return; }
      res.writeHead(200); res.end(JSON.stringify(await insiderBuys(ticker))); return;
    }
    if (rawPath === '/insider/radar') {
      res.writeHead(200); res.end(JSON.stringify(await insiderRadar())); return;
    }

    if (rawPath === '/dukascopy/price') {
      try {
        const now = Date.now();
        const [rXAU, rEUR] = await Promise.all([
          fetchURL(`https://freeserv.dukascopy.com/2.0/?path=chart/json&instrument=XAU%2FUSD&offer_side=B&interval=1&time=${now}&from=0&to=1&jsonp=a`),
          fetchURL(`https://freeserv.dukascopy.com/2.0/?path=chart/json&instrument=EUR%2FUSD&offer_side=B&interval=1&time=${now}&from=0&to=1&jsonp=a`)
        ]);
        const pj = (body) => { const m = body.match(/a\(([\s\S]*)\)/); return m ? jp(m[1]) : null; };
        const dXAU = pj(rXAU.body); const dEUR = pj(rEUR.body);
        if (dXAU && dXAU[0] && dEUR && dEUR[0]) {
          const xauEur = parseFloat(dXAU[0][4]) / parseFloat(dEUR[0][4]);
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.writeHead(200);
          res.end(JSON.stringify({ price: xauEur, source: 'Dukascopy', ts: new Date().toISOString() }));
          return;
        }
      } catch(e) {}
      try {
        const result = await getPrice();
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.writeHead(200);
        res.end(JSON.stringify({ price: result.price, source: result.symbol, ts: new Date().toISOString() }));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (rawPath === '/price') {
      const result = await getPrice();
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.writeHead(200);
      res.end(JSON.stringify({ price: result.price, source: result.symbol, symbol: result.symbol, ts: new Date().toISOString() }));
      return;
    }

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
              hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'web-search-2025-03-05' }
            };
            const r = https.request(opts, (resp) => {
              let d = ''; resp.on('data', chunk => d += chunk); resp.on('end', () => resolve(d));
            });
            r.on('error', reject);
            r.setTimeout(60000, () => { r.destroy(); reject(new Error('Claude timeout')); });
            r.write(data); r.end();
          });
          res.writeHead(200); res.end(response);
        } catch(e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
      });
      return;
    }

    if (rawPath === '/dxy') {
      try {
        let result = null;
        for (const sym of ['DX-Y.NYB', 'USDX', 'DXY']) {
          try {
            const r = await fetchURL(tdURL('/quote', 'symbol='+encodeURIComponent(sym)));
            const d = jp(r.body);
            if (d && d.close && !d.status) { result = d; break; }
          } catch(e) {}
        }
        res.writeHead(200);
        res.end(JSON.stringify(result ? { price: parseFloat(result.close), change: parseFloat(result.change || 0), pct: parseFloat(result.percent_change || 0), source: 'TwelveData DXY', ts: new Date().toISOString() } : { price: 104.5, change: 0, pct: 0, source: 'fallback' }));
      } catch(e) { res.writeHead(200); res.end(JSON.stringify({ price: 104.5, change: 0, pct: 0, error: e.message })); }
      return;
    }

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
        status: 'ok', version: 'v6-beat-tracker',
        asset: 'XAU/EUR', workingSymbol: result.symbol, currentPrice: result.price,
        routes: [
          '/price', '/health', '/debug',
          '/td/quote?symbol=X', '/td/time_series?symbol=X&interval=1day&outputsize=60',
          '/av/overview?ticker=X', '/av/insiders?ticker=X', '/av/holders?ticker=X', '/av/short?ticker=X',
          '/sec/crossings?ticker=X', '/sec/institutional?ticker=X',
          '/insider/buys?ticker=X', '/insider/radar',
          '/earnings/calendar', '/earnings/calendar?zone=fr', '/earnings/calendar?zone=us',
          '/earnings/ticker?ticker=X', '/earnings/beatrate'
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
      error: 'Route inconnue', version: 'v6-beat-tracker',
      newRoutes: ['/earnings/calendar', '/earnings/calendar?zone=fr', '/earnings/ticker?ticker=X', '/earnings/beatrate']
    }));

  } catch(e) {
    console.error('Unhandled error:', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log('NM Trading Proxy v6 (Beat Tracker) — port ' + PORT);
  setTimeout(pollAndBroadcast, 2000);
});
