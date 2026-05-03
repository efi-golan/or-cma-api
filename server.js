require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const PORT = process.env.PORT || 3001;
const reports = {};

app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
app.set('trust proxy', 1);
app.use('/api/', rateLimit({ windowMs: 60000, max: 60 }));

// ── SERVE FRONTEND ──────────────────────────────────────────
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send('<h1>CMA System</h1><p>index.html not found</p>');
  }
});

// ── GOVMAP ──────────────────────────────────────────────────
const GOVMAP = 'https://www.govmap.gov.il/api';
const GH = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.govmap.gov.il/',
  'Origin': 'https://www.govmap.gov.il'
};

async function gPost(path, body) {
  var r = await fetch(GOVMAP + path, { method: 'POST', headers: GH, body: JSON.stringify(body), timeout: 15000 });
  console.log('[gPost]', path, r.status);
  return JSON.parse(await r.text());
}

async function gGet(path) {
  var r = await fetch(GOVMAP + path, { headers: GH, timeout: 15000 });
  console.log('[gGet]', path.slice(0,60), r.status);
  return JSON.parse(await r.text());
}

function parsePoint(shape) {
  if (!shape) return null;
  var m = shape.match(/POINT\(([0-9.]+)\s+([0-9.]+)\)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

function normDeal(d, scope) {
  var price = d.dealAmount || 0;
  var area = d.assetArea || null;
  return {
    address: (d.streetName || '') + (d.houseNumber ? ' ' + d.houseNumber : ''),
    houseNumber: String(d.houseNumber || d.houseNum || ''),
    floor: d.floorNumber !== undefined ? d.floorNumber : null,
    rooms: d.assetRoomNum !== undefined ? d.assetRoomNum : null,
    area: area,
    price: price,
    pricePerSqm: (area && area > 0) ? Math.round(price / area) : null,
    date: d.dealDate ? String(d.dealDate).slice(0,10) : '',
    city: d.settlementNameHeb || '',
    scope: scope,
    removed: false
  };
}

async function fetchTransactions(city, street, houseNumber) {
  var searchText = street + ' ' + (houseNumber || '1') + ' ' + city;
  var acResults = [];
  for (var q of [searchText, street + ' ' + city]) {
    try {
      var ac = await gPost('/search-service/autocomplete', { searchText: q, language: 'he', isAccurate: false, maxResults: 10 });
      acResults = ac.results || [];
      if (acResults.length) break;
    } catch(e) {}
  }
  if (!acResults.length) throw new Error('כתובת לא נמצאה: ' + searchText);

  var point = null, polygons = [];
  for (var result of acResults.slice(0,3)) {
    var p = parsePoint(result.shape);
    if (!p) continue;
    for (var r of [50, 200, 500, 1000, 2000]) {
      try {
        var raw = await gGet('/real-estate/deals/' + p[0] + ',' + p[1] + '/' + r);
        var arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
        if (arr.length > 0) { point = p; polygons = arr; break; }
      } catch(e) {}
    }
    if (polygons.length) break;
  }
  if (!point) point = parsePoint(acResults[0].shape);
  if (!point) throw new Error('לא נמצאו קואורדינטות');

  var now = new Date();
  var sd = (now.getFullYear()-2) + '-' + String(now.getMonth()+1).padStart(2,'0');
  var ed = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  var bDeals = [], sDeals = [], nDeals = [];

  if (polygons.length > 0) {
    var poly0 = polygons[0];
    var polyId = String(poly0.polygon_id || poly0.polygonId || poly0.id || poly0.objectid || '').trim();
    console.log('[polygon] id=', polyId, 'keys=', Object.keys(poly0).join(','));

    if (polyId) {
      try {
        var sdRaw = await gGet('/real-estate/street-deals/' + polyId + '?startDate=' + sd + '&endDate=' + ed + '&limit=30&dealType=2');
        var sdArr = Array.isArray(sdRaw) ? sdRaw : (sdRaw && sdRaw.data ? sdRaw.data : []);
        console.log('[street-deals]', sdArr.length, 'deals');
        sdArr.forEach(function(d) {
          var hn = String(d.houseNumber || d.houseNum || '');
          if (houseNumber && hn === String(houseNumber)) bDeals.push(d);
          else sDeals.push(d);
        });
        bDeals = bDeals.slice(0,5); sDeals = sDeals.slice(0,8);
      } catch(e) { console.log('[street]', e.message); }

      try {
        var ndRaw = await gGet('/real-estate/neighborhood-deals/' + polyId + '?startDate=' + sd + '&endDate=' + ed + '&limit=20&dealType=2');
        var ndArr = Array.isArray(ndRaw) ? ndRaw : (ndRaw && ndRaw.data ? ndRaw.data : []);
        nDeals = ndArr.filter(function(d) { return !(d.streetName||'').includes(street); }).slice(0,8);
      } catch(e) { console.log('[nb]', e.message); }
    }
  }

  return {
    building: bDeals.map(function(d) { return normDeal(d,'building'); }),
    street: sDeals.map(function(d) { return normDeal(d,'street'); }),
    neighborhood: nDeals.map(function(d) { return normDeal(d,'neighborhood'); }),
    meta: { point: point, polygons: polygons.length, source: 'govmap.gov.il', fetchedAt: new Date().toISOString() }
  };
}

function calcPricing(tx) {
  var all = ((tx.building||[]).concat(tx.street||[])).filter(function(t) { return t.price>0 && !t.removed; });
  var prices = all.map(function(t) { return t.price; }).sort(function(a,b) { return a-b; });
  var med = prices.length ? prices[Math.floor(prices.length/2)] : 0;
  return {
    fast: med ? Math.round(med*0.92/10000)*10000 : 0,
    real: med ? Math.round(med*0.97/10000)*10000 : 0,
    ceil: med ? Math.round(med*1.05/10000)*10000 : 0
  };
}

// ── ROUTES ──────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '3.0.0', source: 'govmap.gov.il', reports: Object.keys(reports).length });
});

app.post('/api/reports', function(req, res) {
  var id = Math.random().toString(36).slice(2,11);
  reports[id] = { id, status:'collecting', property:{}, transactions:null, pricing:null, analysis:null, audit:[] };
  res.json({ reportId: id });
});

app.patch('/api/property-input/:id', function(req, res) {
  var r = reports[req.params.id];
  if (!r) return res.status(404).json({ error:'not found' });
  r.property = Object.assign({}, r.property, req.body);
  res.json({ property: r.property });
});

app.post('/api/generate/:id', async function(req, res) {
  var r = reports[req.params.id];
  if (!r) return res.status(404).json({ error:'not found' });
  var p = r.property;
  if (!p.city || !p.street) return res.status(400).json({ error:'city and street required' });
  try {
    var tx = await fetchTransactions(p.city, p.street, p.houseNumber||'');
    r.transactions = tx;
    r.pricing = calcPricing(tx);
    r.status = 'generated';
    res.json({ success:true, transactions:tx, pricing:r.pricing });
  } catch(e) {
    res.status(502).json({ error:e.message });
  }
});

app.delete('/api/analysis/:id/transactions/:scope/:index', function(req, res) {
  var r = reports[req.params.id];
  if (!r || !r.transactions) return res.status(404).json({ error:'not found' });
  var arr = r.transactions[req.params.scope];
  var idx = parseInt(req.params.index);
  if (!arr || !arr[idx]) return res.status(404).json({ error:'tx not found' });
  arr[idx].removed = true;
  r.pricing = calcPricing(r.transactions);
  res.json({ success:true, pricing:r.pricing });
});

app.patch('/api/analysis/:id/pricing', function(req, res) {
  var r = reports[req.params.id];
  if (!r) return res.status(404).json({ error:'not found' });
  r.pricing = req.body;
  res.json({ pricing:r.pricing });
});

app.post('/api/analyze/:id', async function(req, res) {
  var r = reports[req.params.id];
  if (!r || !r.transactions) return res.status(400).json({ error:'no transactions' });
  var key = req.body.claudeKey || process.env.CLAUDE_API_KEY;
  if (!key) return res.json({ analysis:'נדרש Claude API Key.' });
  var all = ((r.transactions.building||[]).concat(r.transactions.street||[])).filter(function(t) { return t.price>0&&!t.removed; });
  if (!all.length) return res.json({ analysis:'אין עסקאות לניתוח.' });
  var p = r.property;
  var txStr = all.slice(0,6).map(function(t) {
    return (t.address||'') + ', ק'+(t.floor!=null?t.floor:'?')+', '+(t.rooms||'?')+'חד, '+(t.area||'?')+'מ"ר: ₪'+t.price.toLocaleString()+' ('+(t.date||'')+')';
  }).join('\n');
  var prompt = 'שמאי מקרקעין ישראלי. נתח ב-3-4 משפטים:\nנכס: '+(p.type||'דירה')+' '+(p.rooms||'?')+' חד, '+(p.area||'?')+'מ"ר, ק'+(p.floor||'?')+', '+(p.street||'')+' '+(p.houseNumber||'')+' '+(p.city||'')+'\nעסקאות:\n'+txStr+'\nסיים: JSON:{"fast":NUMBER,"real":NUMBER,"ceil":NUMBER}';
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:500, messages:[{role:'user',content:prompt}] })
    });
    var d = await resp.json();
    var text = d.content&&d.content[0]?d.content[0].text:'';
    var jm = text.match(/JSON:\s*(\{[^{}]+\})/);
    var an = text.replace(/JSON:\s*\{[^{}]+\}/,'').trim();
    if (jm) { try { var pr = JSON.parse(jm[1]); r.pricing = pr; } catch(_) {} }
    r.analysis = an;
    res.json({ analysis:an, pricing:r.pricing });
  } catch(e) { res.json({ analysis:'שגיאה: '+e.message }); }
});

app.listen(PORT, function() {
  console.log('CMA v3.0 running on port', PORT);
  console.log('Frontend: / | API: /api/*');
});
