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
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS — autorise tout
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/price') {
    try {
      // Prix XAU/EUR via TwelveData
      const d = await fetchURL(`https://api.twelvedata.com/price?symbol=XAU/EUR&apikey=${TD_KEY}`);
      const p = parseFloat(d?.price);
      if (p > 1000) {
        res.writeHead(200);
        res.end(JSON.stringify({ price: p, source: 'TwelveData', ts: new Date().toISOString() }));
        return;
      }
    } catch(e) {}

    // Fallback : XAU/USD × EUR/USD
    try {
      const [xau, fx] = await Promise.all([
        fetchURL(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TD_KEY}`),
        fetchURL(`https://api.twelvedata.com/price?symbol=EUR/USD&apikey=${TD_KEY}`)
      ]);
      const xauUsd = parseFloat(xau?.price);
      const eurUsd = parseFloat(fx?.price);
      if (xauUsd > 100 && eurUsd > 0) {
        const price = xauUsd / eurUsd;
        res.writeHead(200);
        res.end(JSON.stringify({ price, source: 'TwelveData (calc)', ts: new Date().toISOString() }));
        return;
      }
    } catch(e) {}

    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Price unavailable' }));

  } else if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));

  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => console.log(`XAU/EUR Proxy running on port ${PORT}`));
