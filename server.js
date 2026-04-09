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

async function govmapPost(path, body) {
  const url = GOVMAP_API + path;
  console.log('[govmap POST]', url, JSON.stringify(body).slice(0,80));
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.govmap.gov.il/',
      'Origin': 'https://www.govmap.gov.il'
    },
    body: JSON.stringify(body),
    timeout: 15000
  });
  console.log('[govmap POST] status=' + r.status);
  const text = await r.text();
  console.log('[govmap POST] preview=' + text.slice(0,80));
  return JSON.parse(text);
}

async function govmapGet(path) {
  const url = GOVMAP_API + path;
  console.log('[govmap GET]', url.slice(0,100));
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.govmap.gov.il/',
      'Origin': 'https://www.govmap.gov.il'
    },
    timeout: 15000
  });
  console.log('[govmap GET] status=' + r.status);
  const text = await r.text();
  console.log('[govmap GET] preview=' + text.slice(0,80));
  return JSON.parse(text);
}

function normalizeDeal(deal, scope) {
  const price = deal.dealAmount || deal.price || 0;
  const area = deal.area || deal.buildingArea || null;
  return {
    address: deal.addressDescription || deal.address || deal.streetName || '',
    houseNumber: String(deal.houseNum || deal.houseNumber || ''),
    floor: deal.floor !== undefined ? deal.floor : null,
    rooms: deal.rooms !== undefined ? deal.rooms : null,
    area: area,
    price: price,
    pricePerSqm: area && area > 0 ? Math.round(price / area) : null,
    date: deal.dealDate || deal.date || '',
    neighborhood: deal.neighborhood || '',
    city: deal.city || deal.cityName || '',
    assetType: deal.assetType || '',
    source: 'govmap.gov.il',
    scope: scope
  };
}

app.get('/health', (req, res) => res.json({ status: 'ok', version: '6.0.0', source: 'govmap.gov.il' }));

app.get('/api/test', async (req, res) => {
  try {
    const r = await govmapPost('/search-service/autocomplete', { term: 'הרצל 1 רחובות', type: 0 });
    res.json({ success: true, sample: r });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/transactions', async (req, res) => {
  const { city, street, neighborhood='', houseNumber='' } = req.body;
  if (!city || !street) return res.status(400).json({ error: 'city and street required' });

  const cacheKey = 'v6_' + city + '_' + street + '_' + houseNumber;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const now = new Date();
  const startDate = (now.getFullYear()-2) + '-' + String(now.getMonth()+1).padStart(2,'0');
  const endDate = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');

  try {
    const searchText = street + ' ' + (houseNumber||'1') + ' ' + city;
    console.log('[search]', searchText);
    const autocomplete = await govmapPost('/search-service/autocomplete', { term: searchText, type: 0 });
    const results = autocomplete.results || autocomplete;
    if (!results || !results.length) throw new Error('Address not found: ' + searchText);
    const point = results[0].point || results[0].coordinates;
    if (!point) throw new Error('No coordinates for: ' + searchText);
    console.log('[point] x=' + point[0] + ' y=' + point[1]);

    const entityResult = await govmapPost('/layers-catalog/entitiesByPoint', { point, layerIds: ['STREETS_LAYER', 'NEIGHBORHOOD_LAYER'] });
    let polygonId = null, nbPolygonId = null;
    if (entityResult && entityResult.layers) {
      for (const layer of entityResult.layers) {
        if (layer.layerId === 'STREETS_LAYER' && layer.features?.length) polygonId = layer.features[0].id;
        if (layer.layerId === 'NEIGHBORHOOD_LAYER' && layer.features?.length) nbPolygonId = layer.features[0].id;
      }
    }
    console.log('[polygon] street=' + polygonId + ' nb=' + nbPolygonId);

    let bDeals=[], sDeals=[], nDeals=[];

    try {
      const radiusData = await govmapGet('/real-estate/deals/' + point[0] + ',' + point[1] + '/150');
      const radiusDeals = radiusData.deals || radiusData || [];
      if (Array.isArray(radiusDeals)) {
        if (houseNumber) {
          bDeals = radiusDeals.filter(d => String(d.houseNum||d.houseNumber||'') === String(houseNumber)).slice(0,4);
          sDeals = radiusDeals.filter(d => String(d.houseNum||d.houseNumber||'') !== String(houseNumber)).slice(0,8);
        } else { sDeals = radiusDeals.slice(0,8); }
      }
    } catch(e) { console.log('[radius] failed:', e.message); }

    if (polygonId && sDeals.length < 4) {
      try {
        const streetData = await govmapGet('/real-estate/street-deals/' + polygonId + '?startDate=' + startDate + '&endDate=' + endDate + '&limit=20');
        const sd = streetData.deals || streetData || [];
        if (Array.isArray(sd)) sDeals = sd.slice(0,8);
      } catch(e) { console.log('[street] failed:', e.message); }
    }

    if (nbPolygonId) {
      try {
        const nbData = await govmapGet('/real-estate/neighborhood-deals/' + nbPolygonId + '?startDate=' + startDate + '&endDate=' + endDate + '&limit=20');
        const nd = nbData.deals || nbData || [];
        if (Array.isArray(nd)) nDeals = nd.filter(d => !(d.addressDescription||'').includes(street)).slice(0,8);
      } catch(e) { console.log('[nb] failed:', e.message); }
    }

    const result = {
      building: bDeals.map(d => normalizeDeal(d,'building')),
      street: sDeals.map(d => normalizeDeal(d,'street')),
      neighborhood: nDeals.map(d => normalizeDeal(d,'neighborhood')),
      meta: { city, street, houseNumber, source: 'govmap.gov.il', polygonId, point, fetchedAt: new Date().toISOString() }
    };

    console.log('[tx] b=' + result.building.length + ' s=' + result.street.length + ' n=' + result.neighborhood.length);
    if (result.building.length+result.street.length+result.neighborhood.length > 0) cache.set(cacheKey, result);
    res.json(result);
  } catch(e) {
    console.error('[tx] Error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { property, transactions, claudeKey } = req.body;
  const key = claudeKey || process.env.CLAUDE_API_KEY;
  const allTx = [...(transactions.building||[]),...(transactions.street||[])].filter(t=>t.price>0);
  const prices = allTx.map(t=>t.price).sort((a,b)=>a-b);
  const median = prices.length ? prices[Math.floor(prices.length/2)] : 0;
  const calc = { fast: median?Math.round(median*.92/10000)*10000:0, real: median?Math.round(median*.97/10000)*10000:0, ceil: median?Math.round(median*1.05/10000)*10000:0 };
  if (!key||!allTx.length) return res.json({ analysis: allTx.length?'':'לא נמצאו עסקאות.', prices: calc });
  const txStr = allTx.slice(0,5).map(t => (t.address||'')+', ק'+(t.floor??'?')+', '+(t.rooms||'?')+'חד, '+(t.area||'?')+'מ"ר: ₪'+t.price.toLocaleString()+' ('+(t.date||')')).join('
');
  const prompt = 'שמאי ישראלי. נתח ב-3 משפטים:נכס: '+(property.type||'דירה')+' '+(property.rooms||'?')+'חד '+(property.area||'?')+'מ"ר - '+(property.street||'')+' '+(property.city||'')+'
עסקאות:
'+txStr+'
JSON:{"fast":NUMBER,"real":NUMBER,"ceil":NUMBER}';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:400,messages:[{role:'user',content:prompt}]})});
    const d = await r.json();
    const text = d.content?.[0]?.text||'';
    const jm = text.match(/JSON:s*({[^{}]+})/);
    let ap=calc; const an=text.replace(/JSON:s*{[^{}]+}/,'').trim();
    if(jm){try{const p=JSON.parse(jm[1]);ap={fast:p.fast||calc.fast,real:p.real||calc.real,ceil:p.ceil||calc.ceil};}catch(_){}}
    res.json({analysis:an,prices:ap});
  } catch(e) { res.json({analysis:'AI לא זמין.',prices:calc}); }
});

app.listen(PORT, () => { console.log('CMA Backend v6.0 port ' + PORT); console.log('Source: govmap.gov.il'); });
