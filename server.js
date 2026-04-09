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

// govmap.gov.il API - Israeli government GIS with real estate transactions
const GOVMAP_BASE = 'https://es.govmap.gov.il/TranzactionsTax/api';
const GEOCODE_URL = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';

async function geocodeAddress(address) {
  const url = GEOCODE_URL + '?SingleLine=' + encodeURIComponent(address) + '&countryCode=ISR&f=json&maxLocations=1';
  const r = await fetch(url, { timeout: 10000 });
  const data = await r.json();
  if (data.candidates && data.candidates.length > 0) {
    return { x: data.candidates[0].location.x, y: data.candidates[0].location.y };
  }
  return null;
}

async function govmapFetch(url) {
  console.log('[govmap] GET', url.slice(0, 120));
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.govmap.gov.il/'
    },
    timeout: 15000
  });
  console.log('[govmap] status=' + r.status);
  const text = await r.text();
  console.log('[govmap] len=' + text.length + ' preview=' + text.slice(0, 80));
  return JSON.parse(text);
}

function normalizeTx(records, scope) {
  if (!records || !Array.isArray(records)) return [];
  return records
    .filter(function(r) { return r && r.price > 0; })
    .map(function(r) {
      return {
        address: r.address || r.streetName || '',
        houseNumber: String(r.houseNum || r.houseNumber || ''),
        floor: r.floor !== undefined ? r.floor : null,
        rooms: r.rooms !== undefined ? r.rooms : null,
        area: r.area || r.buildingArea || null,
        price: r.price || r.dealAmount || 0,
        pricePerSqm: r.area && r.area > 0 ? Math.round((r.price || 0) / r.area) : null,
        date: r.date || r.dealDate || '',
        neighborhood: r.neighborhood || '',
        city: r.city || r.cityName || '',
        assetType: r.assetType || '',
        source: 'govmap.gov.il',
        scope: scope
      };
    })
    .slice(0, 8);
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '5.0.0', source: 'govmap.gov.il' });
});

app.get('/api/test', async function(req, res) {
  try {
    // Test geocoding
    var coords = await geocodeAddress('הרצל 1 רחובות');
    if (!coords) return res.json({ success: false, error: 'geocoding failed' });

    // Convert to Israel TM coords (approximate)
    var x = Math.round((coords.x - 34.0) * 111000);
    var y = Math.round((coords.y - 29.5) * 111000);

    res.json({ success: true, geocoded: coords, source: 'govmap.gov.il' });
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

  var cacheKey = 'gm5_' + city + '_' + street + '_' + houseNumber;
  var cached = cache.get(cacheKey);
  if (cached) { console.log('[cache] hit'); return res.json(cached); }

  var now = new Date();
  var fromDate = '01/01/' + (now.getFullYear() - 2);
  var toDate = String(now.getDate()).padStart(2,'0') + '/' + String(now.getMonth()+1).padStart(2,'0') + '/' + now.getFullYear();

  try {
    // Step 1: Geocode address
    var searchAddr = street + ' ' + (houseNumber || '1') + ' ' + city;
    console.log('[geocode] ' + searchAddr);
    var coords = await geocodeAddress(searchAddr);
    if (!coords) throw new Error('Could not geocode address: ' + searchAddr);
    console.log('[geocode] x=' + coords.x + ' y=' + coords.y);

    // Step 2: Search govmap for transactions near this point
    // govmap uses Israel Transverse Mercator (ITM) coordinates
    // Convert WGS84 to approximate ITM
    var itm_x = Math.round(219529 + (coords.x - 34.7817676) * 96488.2);
    var itm_y = Math.round(626626 + (coords.y - 31.6538079) * 111325.1);
    console.log('[itm] x=' + itm_x + ' y=' + itm_y);

    // Search in 300m radius
    var radius = 300;
    var url = GOVMAP_BASE + '/GetTransactionsByRadius?x=' + itm_x + '&y=' + itm_y + '&radius=' + radius + '&fromDate=' + fromDate + '&toDate=' + toDate + '&lyrs=10&pageSize=50&pageNumber=1';

    var data = await govmapFetch(url);
    console.log('[govmap] response keys:', Object.keys(data || {}).join(','));

    var records = data.data || data.transactions || data.results || data || [];
    if (!Array.isArray(records)) records = [];

    // Separate building vs street vs neighborhood
    var bData = [], sData = [], nData = [];
    if (houseNumber) {
      bData = records.filter(function(r) { return String(r.houseNum || r.houseNumber || '') === String(houseNumber); }).slice(0,4);
      sData = records.filter(function(r) { return String(r.houseNum || r.houseNumber || '') !== String(houseNumber); }).slice(0,8);
    } else {
      sData = records.slice(0,8);
    }

    // Neighborhood: wider search
    var nbUrl = GOVMAP_BASE + '/GetTransactionsByRadius?x=' + itm_x + '&y=' + itm_y + '&radius=1000&fromDate=' + fromDate + '&toDate=' + toDate + '&lyrs=10&pageSize=50&pageNumber=1';
    try {
      var nbData = await govmapFetch(nbUrl);
      var nbRecords = nbData.data || nbData.transactions || nbData.results || nbData || [];
      if (Array.isArray(nbRecords)) {
        nData = nbRecords.filter(function(r) {
          var hn = String(r.houseNum || r.houseNumber || '');
          return !bData.some(function(b) { return String(b.houseNumber) === hn; }) && !sData.some(function(s) { return String(s.houseNumber) === hn; });
        }).slice(0,8);
      }
    } catch(e) { console.log('[nb] failed:', e.message); }

    var result = {
      building: normalizeTx(bData, 'building'),
      street: normalizeTx(sData, 'street'),
      neighborhood: normalizeTx(nData, 'neighborhood'),
      meta: { city: city, street: street, neighborhood: neighborhood, houseNumber: houseNumber, source: 'govmap.gov.il', coords: coords, fetchedAt: new Date().toISOString() }
    };

    console.log('[tx] b=' + result.building.length + ' s=' + result.street.length + ' n=' + result.neighborhood.length);
    if (result.building.length + result.street.length + result.neighborhood.length > 0) cache.set(cacheKey, result);
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
    return (t.address||'') + ', ק' + (t.floor!==null?t.floor:'?') + ', ' + (t.rooms||'?') + 'חד, ' + (t.area||'?') + 'מ"ר: ₪' + t.price.toLocaleString() + ' (' + (t.date||'') + ')';
  }).join('\n');

  var prompt = 'שמאי מקרקעין ישראלי. נתח ב-3 משפטים:\nנכס: ' + (property.type||'דירה') + ' ' + (property.rooms||'?') + 'חד ' + (property.area||'?') + 'מ"ר ק' + (property.floor||'?') + ' - ' + (property.street||'') + ' ' + (property.houseNumber||'') + ' ' + (property.city||'') + '\nעסקאות (govmap.gov.il):\n' + txStr + '\nסיים עם: JSON:{"fast":NUMBER,"real":NUMBER,"ceil":NUMBER}';

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
  console.log('CMA Backend v5.0 running on port ' + PORT);
  console.log('Source: govmap.gov.il + ArcGIS geocoding');
});
