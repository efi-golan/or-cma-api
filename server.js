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

const GOVMAP_API = 'https://www.govmap.gov.il/api';
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.govmap.gov.il/',
  'Origin': 'https://www.govmap.gov.il'
};

async function gPost(path, body) {
  const r = await fetch(GOVMAP_API + path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body), timeout: 15000 });
  console.log('[gPost]', path, 'status=' + r.status);
  const t = await r.text();
  console.log('[gPost] preview=' + t.slice(0,80));
  return JSON.parse(t);
}

async function gGet(path) {
  const r = await fetch(GOVMAP_API + path, { headers: HEADERS, timeout: 15000 });
  console.log('[gGet]', path.slice(0,80), 'status=' + r.status);
  const t = await r.text();
  console.log('[gGet] preview=' + t.slice(0,80));
  return JSON.parse(t);
}

function norm(deal, scope) {
  var price = deal.dealAmount || deal.price || 0;
  var area = deal.area || deal.buildingArea || null;
  return {
    address: deal.addressDescription || deal.address || deal.streetName || '',
    houseNumber: String(deal.houseNum || deal.houseNumber || ''),
    floor: deal.floor !== undefined ? deal.floor : null,
    rooms: deal.rooms !== undefined ? deal.rooms : null,
    area: area,
    price: price,
    pricePerSqm: (area && area > 0) ? Math.round(price / area) : null,
    date: deal.dealDate || deal.date || '',
    neighborhood: deal.neighborhood || '',
    city: deal.city || deal.cityName || '',
    assetType: deal.assetType || '',
    source: 'govmap.gov.il',
    scope: scope
  };
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '7.0.0', source: 'govmap.gov.il' });
});

app.get('/api/test', async function(req, res) {
  try {
    var r = await gPost('/search-service/autocomplete', { term: 'הרצל 1 רחובות', type: 0 });
    res.json({ success: true, sample: r });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/transactions', async function(req, res) {
  var city = req.body.city;
  var street = req.body.street;
  var neighborhood = req.body.neighborhood || '';
  var houseNumber = req.body.houseNumber || '';

  if (!city || !street) return res.status(400).json({ error: 'city and street required' });

  var cacheKey = 'v7_' + city + '_' + street + '_' + houseNumber;
  var cached = cache.get(cacheKey);
  if (cached) { console.log('[cache] hit'); return res.json(cached); }

  var now = new Date();
  var startDate = (now.getFullYear() - 2) + '-' + String(now.getMonth() + 1).padStart(2, '0');
  var endDate = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  try {
    var searchText = street + ' ' + (houseNumber || '1') + ' ' + city;
    console.log('[search]', searchText);
    var ac = await gPost('/search-service/autocomplete', { term: searchText, type: 0 });
    var results = ac.results || ac;
    if (!results || !results.length) throw new Error('Address not found: ' + searchText);
    var point = results[0].point || results[0].coordinates;
    if (!point) throw new Error('No coordinates for: ' + searchText);
    console.log('[point] x=' + point[0] + ' y=' + point[1]);

    var entityResult = await gPost('/layers-catalog/entitiesByPoint', { point: point, layerIds: ['STREETS_LAYER', 'NEIGHBORHOOD_LAYER'] });
    var polygonId = null, nbPolygonId = null;
    if (entityResult && entityResult.layers) {
      for (var i = 0; i < entityResult.layers.length; i++) {
        var layer = entityResult.layers[i];
        if (layer.layerId === 'STREETS_LAYER' && layer.features && layer.features.length > 0) {
          polygonId = layer.features[0].id;
        }
        if (layer.layerId === 'NEIGHBORHOOD_LAYER' && layer.features && layer.features.length > 0) {
          nbPolygonId = layer.features[0].id;
        }
      }
    }
    console.log('[polygon] street=' + polygonId + ' nb=' + nbPolygonId);

    var bDeals = [], sDeals = [], nDeals = [];

    try {
      var radiusData = await gGet('/real-estate/deals/' + point[0] + ',' + point[1] + '/150');
      var rd = radiusData.deals || radiusData || [];
      if (Array.isArray(rd)) {
        if (houseNumber) {
          bDeals = rd.filter(function(d) { return String(d.houseNum || d.houseNumber || '') === String(houseNumber); }).slice(0, 4);
          sDeals = rd.filter(function(d) { return String(d.houseNum || d.houseNumber || '') !== String(houseNumber); }).slice(0, 8);
        } else {
          sDeals = rd.slice(0, 8);
        }
      }
    } catch(e) { console.log('[radius] failed:', e.message); }

    if (polygonId && sDeals.length < 4) {
      try {
        var sd = await gGet('/real-estate/street-deals/' + polygonId + '?startDate=' + startDate + '&endDate=' + endDate + '&limit=20');
        var sdArr = sd.deals || sd || [];
        if (Array.isArray(sdArr)) sDeals = sdArr.slice(0, 8);
      } catch(e) { console.log('[street] failed:', e.message); }
    }

    if (nbPolygonId) {
      try {
        var nd = await gGet('/real-estate/neighborhood-deals/' + nbPolygonId + '?startDate=' + startDate + '&endDate=' + endDate + '&limit=20');
        var ndArr = nd.deals || nd || [];
        if (Array.isArray(ndArr)) {
          nDeals = ndArr.filter(function(d) {
            var addr = d.addressDescription || d.address || '';
            return addr.indexOf(street) === -1;
          }).slice(0, 8);
        }
      } catch(e) { console.log('[nb] failed:', e.message); }
    }

    var result = {
      building: bDeals.map(function(d) { return norm(d, 'building'); }),
      street: sDeals.map(function(d) { return norm(d, 'street'); }),
      neighborhood: nDeals.map(function(d) { return norm(d, 'neighborhood'); }),
      meta: { city: city, street: street, houseNumber: houseNumber, source: 'govmap.gov.il', polygonId: polygonId, point: point, fetchedAt: new Date().toISOString() }
    };

    console.log('[tx] b=' + result.building.length + ' s=' + result.street.length + ' n=' + result.neighborhood.length);
    if (result.building.length + result.street.length + result.neighborhood.length > 0) {
      cache.set(cacheKey, result);
    }
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
  var prices = allTx.map(function(t) { return t.price; }).sort(function(a, b) { return a - b; });
  var median = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  var calc = {
    fast: median ? Math.round(median * 0.92 / 10000) * 10000 : 0,
    real: median ? Math.round(median * 0.97 / 10000) * 10000 : 0,
    ceil: median ? Math.round(median * 1.05 / 10000) * 10000 : 0
  };

  if (!key || !allTx.length) {
    return res.json({ analysis: allTx.length ? '' : 'לא נמצאו עסקאות לניתוח.', prices: calc });
  }

  var txStr = allTx.slice(0, 5).map(function(t) {
    return (t.address || '') + ', ק' + (t.floor !== null ? t.floor : '?') + ', ' + (t.rooms || '?') + 'חד, ' + (t.area || '?') + 'מ"ר: ש"']' + t.price.toLocaleString() + ' (' + (t.date || '') + ')';
  }).join('\n');

  var prompt = 'שמאי מקרקעין ישראלי. נתח 3 משפטים:\nנכס: ' + (property.type || 'דירה') + ' ' + (property.rooms || '?') + 'חד ' + (property.area || '?') + 'מ"ר ק' + (property.floor || '?') + ' - ' + (property.street || '') + ' ' + (property.houseNumber || '') + ' ' + (property.city || '') + '\nעסקאות (govmap.gov.il):\n' + txStr + '\nסיים עה: JSON:{"fast":NUMBER,"real":NUMBER,"ceil":NUMBER}';

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
    if (jm) {
      try {
        var p = JSON.parse(jm[1]);
        ap = { fast: p.fast || calc.fast, real: p.real || calc.real, ceil: p.ceil || calc.ceil };
      } catch(_) {}
    }
    res.json({ analysis: an, prices: ap });
  } catch(e) {
    res.json({ analysis: 'AI lot available.', prices: calc });
  }
});

app.listen(PORT, function() {
  console.log('CMA Backend v7.0 running on port ' + PORT);
  console.log('Source: govmap.gov.il official API');
});
