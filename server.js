require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.set('trust proxy', 1);
app.use('/api/', rateLimit({ windowMs: 60000, max: 30 }));

const NADLAN_BASE = 'https://www.nadlan.gov.il/Nadlan.REST/Main';

// Session cookie cache - renew every 30 min
let sessionCookie = null;
let sessionExpiry = 0;

async function getSession() {
  if (sessionCookie && Date.now() < sessionExpiry) return sessionCookie;
  try {
    console.log('[session] Getting new session cookie...');
    const res = await fetch('https://www.nadlan.gov.il/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'he-IL,he;q=0.9'
      },
      redirect: 'follow',
      timeout: 10000
    });
    const cookies = res.headers.raw()['set-cookie'];
    if (cookies && cookies.length > 0) {
      sessionCookie = cookies.map(c => c.split(';')[0]).join('; ');
      sessionExpiry = Date.now() + 30 * 60 * 1000;
      console.log('[session] Got cookie:', sessionCookie.slice(0, 60));
    } else {
      sessionCookie = '';
    }
  } catch(e) {
    console.error('[session] Error:', e.message);
    sessionCookie = '';
  }
  return sessionCookie;
}

async function nadlanFetch(url) {
  const cookie = await getSession();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
    'Referer': 'https://www.nadlan.gov.il/',
    'Origin': 'https://www.nadlan.gov.il'
  };
  if (cookie) headers['Cookie'] = cookie;

  console.log('[nadlan] GET', url.slice(0, 100));
  const res = await fetch(url, { headers, timeout: 15000 });
  console.log('[nadlan] status=' + res.status);

  const text = await res.text();
  console.log('[nadlan] len=' + text.length + ' preview=' + text.slice(0, 80));

  if (text.trim().startsWith('<')) {
    // Got HTML - session expired, clear and retry once
    sessionCookie = null;
    sessionExpiry = 0;
    const cookie2 = await getSession();
    if (cookie2) headers['Cookie'] = cookie2;
    const res2 = await fetch(url, { headers, timeout: 15000 });
    const text2 = await res2.text();
    if (text2.trim().startsWith('<')) throw new Error('nadlan returned HTML - blocked');
    return JSON.parse(text2);
  }
  return JSON.parse(text);
}

function normalizeTx(raw, scope) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : (raw.Data || raw.data || []);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(function(t) { return t && (t.DEALAMOUNT > 0 || t.dealAmount > 0); })
    .map(function(t) {
      var price = t.DEALAMOUNT || t.dealAmount || 0;
      var area = t.DEALAREA || t.dealArea || null;
      return {
        address: (t.DISPLAYSTREET || t.displayStreet || t.STREETNAME || '').trim(),
        houseNumber: String(t.HOUSENUMBER || t.houseNumber || '').trim(),
        floor: t.FLOOR !== undefined ? t.FLOOR : (t.floor !== undefined ? t.floor : null),
        rooms: t.ROOMS !== undefined ? t.ROOMS : (t.rooms !== undefined ? t.rooms : null),
        area: area,
        price: price,
        pricePerSqm: area && area > 0 ? Math.round(price / area) : null,
        date: t.DEALDATETXT || t.dealDateTxt || '',
        neighborhood: t.NEIGHBORHOODNAME || t.neighborhoodName || '',
        city: t.CITYNAME || t.cityName || '',
        assetType: t.ASSETTYPENAME || '',
        source: 'nadlan.gov.il',
        scope: scope
      };
    })
    .slice(0, 8);
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '4.0.0', source: 'nadlan.gov.il', session: !!sessionCookie });
});

app.get('/api/test', async function(req, res) {
  try {
    var url = NADLAN_BASE + '/GetNeighborhoodsListByCityAndStartsWith?cityName=%D7%A8%D7%97%D7%95%D7%91%D7%95%D7%AA&startWithKey=-1';
    var data = await nadlanFetch(url);
    res.json({ success: true, type: typeof data, isArray: Array.isArray(data), count: Array.isArray(data) ? data.length : 'N/A', sample: Array.isArray(data) ? data.slice(0,3) : data });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/transactions', async function(req, res) {
  var city = req.body.city;
  var street = req.body.street;
  var neighborhood = req.body.neighborhood || '';
  var houseNumber = req.body.houseNumber || '';

  if (!city || !street) return res.status(400).json({ error: 'city and street required' });

  var cacheKey = 'v4_' + city + '_' + street + '_' + houseNumber + '_' + neighborhood;
  var cached = cache.get(cacheKey);
  if (cached) { console.log('[cache] hit'); return res.json(cached); }

  var now = new Date();
  var from = new Date(now.getFullYear()-2, now.getMonth(), 1);
  var fromStr = from.getFullYear() + '-' + String(from.getMonth()+1).padStart(2,'0') + '-01';
  var toStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');

  var cityE = encodeURIComponent(city);
  var streetE = encodeURIComponent(street);
  var nbE = encodeURIComponent(neighborhood);
  var hnE = encodeURIComponent(houseNumber);

  console.log('[tx] city=' + city + ' street=' + street + ' hn=' + houseNumber);

  try {
    var urls = [];
    if (houseNumber) {
      urls.push(NADLAN_BASE + '/GetDealsByStreet?cityName=' + cityE + '&neighborhoodName=' + nbE + '&streetName=' + streetE + '&houseNum=' + hnE + '&fromDate=' + fromStr + '&toDate=' + toStr + '&pageNum=1&pageSize=50');
    }
    urls.push(NADLAN_BASE + '/GetDealsByStreet?cityName=' + cityE + '&neighborhoodName=' + nbE + '&streetName=' + streetE + '&houseNum=&fromDate=' + fromStr + '&toDate=' + toStr + '&pageNum=1&pageSize=50');
    if (neighborhood) {
      urls.push(NADLAN_BASE + '/GetDealsByNeighborhood?cityName=' + cityE + '&neighborhoodName=' + nbE + '&fromDate=' + fromStr + '&toDate=' + toStr + '&pageNum=1&pageSize=50');
    }

    var results = await Promise.allSettled(urls.map(function(u) { return nadlanFetch(u); }));

    var r0 = results[0] && results[0].status === 'fulfilled' ? normalizeTx(results[0].value, 'building') : [];
    var r1idx = houseNumber ? 1 : 0;
    var r1 = results[r1idx] && results[r1idx].status === 'fulfilled' ? normalizeTx(results[r1idx].value, 'street') : [];
    var r2idx = houseNumber ? 2 : 1;
    var r2 = results[r2idx] && results[r2idx].status === 'fulfilled' ? normalizeTx(results[r2idx].value, 'neighborhood') : [];

    var bData = [], sData = [], nData = [];
    if (houseNumber) {
      bData = r0.filter(function(t) { return t.houseNumber === String(houseNumber); }).slice(0,4);
      sData = r0.filter(function(t) { return t.houseNumber !== String(houseNumber); }).concat(r1).slice(0,8);
    } else {
      sData = r1.slice(0,8);
    }
    nData = r2.slice(0,8);

    console.log('[tx] building=' + bData.length + ' street=' + sData.length + ' nb=' + nData.length);

    var result = {
      building: bData,
      street: sData,
      neighborhood: nData,
      meta: { city: city, street: street, neighborhood: neighborhood, houseNumber: houseNumber, dateFrom: fromStr, dateTo: toStr, source: 'nadlan.gov.il', fetchedAt: new Date().toISOString() }
    };

    if (bData.length + sData.length + nData.length > 0) cache.set(cacheKey, result);
    res.json(result);
  } catch(e) {
    console.error('[tx] Error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/analyze', async function(req, res) {
  var property = req.body.property;
  var transactions = req.body.transactions;
  var claudeKey = req.body.claudeKey;
  var key = claudeKey || process.env.CLAUDE_API_KEY;

  var allTx = ((transactions.building || []).concat(transactions.street || [])).filter(function(t) { return t.price > 0; });
  var prices = allTx.map(function(t) { return t.price; }).sort(function(a,b) { return a-b; });
  var median = prices.length ? prices[Math.floor(prices.length/2)] : 0;
  var calc = {
    fast: median ? Math.round(median * 0.92 / 10000) * 10000 : 0,
    real: median ? Math.round(median * 0.97 / 10000) * 10000 : 0,
    ceil: median ? Math.round(median * 1.05 / 10000) * 10000 : 0
  };

  if (!key || !allTx.length) return res.json({ analysis: allTx.length ? '' : 'לא נמצאו עסקאות לניתוח.', prices: calc });

  var txStr = allTx.slice(0,5).map(function(t) {
    return (t.address || '') + ' ' + (t.houseNumber || '') + ', ק' + (t.floor !== null ? t.floor : '?') + ', ' + (t.rooms || '?') + 'חד, ' + (t.area || '?') + 'מ"ר: ₪' + t.price.toLocaleString() + ' (' + (t.date || '') + ')';
  }).join('\n');

  var prompt = 'שמאי מקרקעין ישראלי. נתח ב-3 משפטים:\nנכס: ' + (property.type||'דירה') + ' ' + (property.rooms||'?') + 'חד ' + (property.area||'?') + 'מ"ר ק' + (property.floor||'?') + ' - ' + (property.street||'') + ' ' + (property.houseNumber||'') + ' ' + (property.city||'') + '\nעסקאות:\n' + txStr + '\nסיים עם: JSON:{"fast":NUMBER,"real":NUMBER,"ceil":NUMBER}';

  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    var d = await r.json();
    var text = d.content && d.content[0] ? d.content[0].text : '';
    var jm = text.match(/JSON:\s*(\{[^{}]+\})/);
    var ap = calc;
    var an = text.replace(/JSON:\s*\{[^{}]+\}/, '').trim();
    if (jm) { try { var p = JSON.parse(jm[1]); ap = { fast: p.fast||calc.fast, real: p.real||calc.real, ceil: p.ceil||calc.ceil }; } catch(_) {} }
    res.json({ analysis: an, prices: ap });
  } catch(e) {
    res.json({ analysis: 'AI לא זמין.', prices: calc });
  }
});

app.listen(PORT, function() {
  console.log('CMA Backend v4.0 running on port ' + PORT);
  console.log('Source: nadlan.gov.il (with session)');
  getSession(); // warm up session on startup
});
