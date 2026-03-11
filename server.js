const http = require('http');
const https = require('https');

const TD_KEY = '10b3ff3aa4b444ae85d350902c523b0f';
const PORT = process.env.PORT || 3000;

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

// Symboles XAU/EUR testés dans l'ordre
const SYMBOLS = ['XAU/EUR', 'XAUEUR'];

async function getPrice() {
  for (const sym of SYMBOLS) {
    try {
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}`;
      const d = await fetchURL(url);
      const p = parseFloat(d?.price);
      if (p > 100 && p < 100000) return { price: p, symbol: sym };
      console.log(`${sym} returned invalid price: ${p} — raw: ${JSON.stringify(d)}`);
    } catch(e) {
      console.log(`${sym} failed: ${e.message}`);
    }
  }
  throw new Error('All symbols failed');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/price') {
    try {
      const result = await getPrice();
      console.log(`Price OK: ${result.price} via ${result.symbol}`);
      res.writeHead(200);
      res.end(JSON.stringify({
        price: result.price,
        source: `TwelveData (${result.symbol})`,
        symbol: result.symbol,
        ts: new Date().toISOString()
      }));
    } catch(e) {
      console.error('Price error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Price unavailable', tried: SYMBOLS }));
    }

  } else if (req.url === '/health') {
    try {
      const result = await getPrice();
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        asset: 'XAU/EUR',
        workingSymbol: result.symbol,
        currentPrice: result.price,
        ts: new Date().toISOString()
      }));
    } catch(e) {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'degraded', error: e.message, tried: SYMBOLS }));
    }

  } else if (req.url === '/debug') {
    const results = {};
    for (const sym of SYMBOLS) {
      try {
        const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_KEY}`;
        results[sym] = await fetchURL(url);
      } catch(e) {
        results[sym] = { error: e.message };
      }
    }
    res.writeHead(200);
    res.end(JSON.stringify({ results, ts: new Date().toISOString() }));

  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Routes: /price /health /debug' }));
  }
});

server.listen(PORT, () => console.log(`XAU/EUR Proxy v2 running on port ${PORT}`));
