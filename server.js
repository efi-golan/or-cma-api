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
app.use('/api/', rateLimit({ windowMs: 60000, max: 30 }));

// data.gov.il - Official Israeli government open data API
// Resource ID for real estate transactions (shimut mekarkaim)
const DATA_GOV_URL = 'https://data.gov.il/api/action/datastore_search';
const RESOURCE_ID = 'b8ef3b82-97d3-4f32-8b08-edd6b78d8df2';

app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '3.0.0', source: 'data.gov.il' });
});

app.get('/api/test', async function(req, res) {
  try {
    var url = DATA_GOV_URL + '?resource_id=' + RESOURCE_ID + '&limit=3&q=%D7%A8%D7%97%D7%95%D7%91%D7%95%D7%AA';
    var response = await fetch(url, { timeout: 15000 });
    var data = await response.json();
    res.json({
      success: data.success,
      total: data.result && data.result.total,
      sample: data.result && data.result.records && data.result.records.slice(0, 2),
      fields: data.result && data.result.fields && data.result.fields.map(function(f) { return f.id; })
    });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/transactions', async function(req, res) {
  var city = req.body.city;
  var street = req.body.street;
  var neighborhood = req.body.neighborhood;
  var houseNumber = req.body.houseNumber;

  if (!city) return res.status(400).json({ error: 'city required' });

  var cacheKey = 'dg_' + city + '_' + (street||'') + '_' + (houseNumber||'') + '_' + (neighborhood||'');
  var cached = cache.get(cacheKey);
  if (cached) { console.log('[cache] hit'); return res.json(cached); }

  // Date: last 24 months
  var now = new Date();
  var from = new Date(now.getFullYear() - 2, now.getMonth(), 1);
  var fromStr = from.getFullYear() + '-' + String(from.getMonth()+1).padStart(2,'0') + '-01';

  console.log('[tx] city=' + city + ' street=' + street + ' hn=' + houseNumber);

  try {
    // Build filters for data.gov.il API
    // Fields: CITY_NAME, STREET_NM_HEB, HOUSE_NUMBE, NEIGHBORHOOD, DEALTOTAL, DEALDATE, FLOORNO, ASSETROOMS, BUILDINGNEWVALUE
    var filters = {};
    if (city) filters['CITY_NAME'] = city;
    if (street) filters['STREET_NM_HEB'] = street;
    if (neighborhood) filters['NEIGHBORHOOD'] = neighborhood;

    var params = new URLSearchParams();
    params.append('resource_id', RESOURCE_ID);
    params.append('limit', '100');
    params.append('filters', JSON.stringify(filters));
    params.append('sort', 'DEALDATE desc');

    var url = DATA_GOV_URL + '?' + params.toString();
    console.log('[data.gov.il] Fetching:', url.slice(0, 150));

    var response = await fetch(url, { timeout: 20000 });
    var data = await response.json();

    if (!data.success) {
      throw new Error('data.gov.il error: ' + JSON.stringify(data.error));
    }

    var records = data.result && data.result.records || [];
    console.log('[data.gov.il] Total:', data.result.total, 'Got:', records.length);

    // Filter by date (last 24 months)
    records = records.filter(function(r) {
      if (!r.DEALDATE) return true;
      return r.DEALDATE >= fromStr;
    });

    // Filter by house number if provided
    var buildingRecords = [];
    var streetRecords = [];

    if (houseNumber) {
      buildingRecords = records.filter(function(r) {
        return String(r.HOUSE_NUMBE || '').trim() === String(houseNumber).trim();
      }).slice(0, 4);
      streetRecords = records.filter(function(r) {
        return String(r.HOUSE_NUMBE || '').trim() !== String(houseNumber).trim();
      }).slice(0, 8);
    } else {
      streetRecords = records.slice(0, 8);
    }

    // Neighborhood: search separately without street filter
    var nbRecords = [];
    if (neighborhood || city) {
      var nbFilters = {};
      if (city) nbFilters['CITY_NAME'] = city;
      if (neighborhood) nbFilters['NEIGHBORHOOD'] = neighborhood;

      var nbParams = new URLSearchParams();
      nbParams.append('resource_id', RESOURCE_ID);
      nbParams.append('limit', '50');
      nbParams.append('filters', JSON.stringify(nbFilters));
      nbParams.append('sort', 'DEALDATE desc');

      var nbUrl = DATA_GOV_URL + '?' + nbParams.toString();
      var nbResp = await fetch(nbUrl, { timeout: 15000 });
      var nbData = await nbResp.json();
      if (nbData.success && nbData.result && nbData.result.records) {
        nbRecords = nbData.result.records
          .filter(function(r) { return r.DEALDATE >= fromStr; })
          .filter(function(r) { return r.STREET_NM_HEB !== street; })
          .slice(0, 8);
      }
    }

    function normalize(records, scope) {
      return records
        .filter(function(r) { return r.DEALTOTAL > 0; })
        .map(function(r) {
          var price = parseFloat(r.DEALTOTAL) || 0;
          var area = parseFloat(r.BUILDINGNEWVALUE) || null;
          return {
            address: (r.STREET_NM_HEB || '') + ' ' + (r.HOUSE_NUMBE || ''),
            houseNumber: String(r.HOUSE_NUMBE || ''),
            floor: r.FLOORNO !== undefined && r.FLOORNO !== null ? r.FLOORNO : null,
            rooms: r.ASSETROOMS || null,
            area: area,
            price: price,
            pricePerSqm: area && area > 0 ? Math.round(price / area) : null,
            date: r.DEALDATE ? r.DEALDATE.slice(0, 7) : '',
            neighborhood: r.NEIGHBORHOOD || neighborhood || '',
            city: r.CITY_NAME || city,
            assetType: r.ASSET_TYPE || '',
            source: 'data.gov.il',
            scope: scope
          };
        });
    }

    var result = {
      building: normalize(buildingRecords, 'building'),
      street: normalize(streetRecords, 'street'),
      neighborhood: normalize(nbRecords, 'neighborhood'),
      meta: {
        city: city,
        street: street,
        neighborhood: neighborhood,
        houseNumber: houseNumber,
        totalFound: data.result.total,
        source: 'data.gov.il',
        fetchedAt: new Date().toISOString()
      }
    };

    console.log('[tx] building=' + result.building.length + ' street=' + result.street.length + ' nb=' + result.neighborhood.length);

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
  var prices = allTx.map(function(t) { return t.price; }).sort(function(a,b) { return a-b; });
  var median = prices.length ? prices[Math.floor(prices.length/2)] : 0;
  var calc = {
    fast: median ? Math.round(median * 0.92 / 10000) * 10000 : 0,
    real: median ? Math.round(median * 0.97 / 10000) * 10000 : 0,
    ceil: median ? Math.round(median * 1.05 / 10000) * 10000 : 0
  };

  if (!key || !allTx.length) {
    return res.json({ analysis: allTx.length ? '' : 'לא נמצאו עסקאות לניתוח.', prices: calc });
  }

  var txStr = allTx.slice(0,5).map(function(t) {
    return (t.address || '') + ', ק' + (t.floor !== null ? t.floor : '?') + ', ' + (t.rooms || '?') + 'חד, ' + (t.area || '?') + 'מ"ר: ₪' + t.price.toLocaleString() + ' (' + (t.date || '') + ')';
  }).join('\n');

  var prompt = 'שמאי מקרקעין ישראלי. נתח ב-3 משפטים:\nנכס: ' + (property.type||'דירה') + ' ' + (property.rooms||'?') + 'חד ' + (property.area||'?') + 'מ"ר ק' + (property.floor||'?') + ' - ' + (property.street||'') + ' ' + (property.houseNumber||'') + ' ' + (property.city||'') + '\nעסקאות (מקור: data.gov.il):\n' + txStr + '\nסיים עם: JSON:{"fast":NUMBER,"real":NUMBER,"ceil":NUMBER}';

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
    res.json({ analysis: 'AI לא זמין.', prices: calc });
  }
});

app.listen(PORT, function() {
  console.log('CMA Backend v3.0 running on port ' + PORT);
  console.log('Source: data.gov.il (official API)');
  console.log('Cache TTL: 1hr');
});
