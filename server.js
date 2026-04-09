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

const NADLAN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.nadlan.gov.il/',
  'Origin': 'https://www.nadlan.gov.il'
};

const NADLAN_BASE = 'https://www.nadlan.gov.il/Nadlan.REST/Main';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function nadlanFetch(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[nadlan] ${url.slice(0, 120)}`);
      const res = await fetch(url, { headers: NADLAN_HEADERS, timeout: 15000 });
      console.log(`[nadlan] status=${res.status}`);
      if (res.ok) {
        const text = await res.text();
        console.log(`[nadlan] len=${text.length} preview=${text.slice(0,80)}`);
        try { return JSON.parse(text); } catch(e) { return []; }
      }
      if (res.status === 429) { await sleep(3000*(i+1)); continue; }
      throw new Error(`HTTP ${res.status}`);
    } catch(e) {
      console.error(`[nadlan] err attempt ${i+1}:`, e.message);
      if (i === retries-1) throw e;
      await sleep(1500*(i+1));
    }
  }
}

function normalizeTx(raw, scope) {
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .filter(t => t && (t.DEALAMOUNT > 0 || t.dealAmount > 0))
    .map(t => ({
      address: t.DISPLAYSTREET || t.displayStreet || t.STREETNAME || '',
      houseNumber: String(t.HOUSENUMBER || t.houseNumber || ''),
      floor: t.FLOOR ?? t.floor ?? null,
      rooms: t.ROOMS ?? t.rooms ?? null,
      area: t.DEALAREA || t.dealArea || null,
      price: t.DEALAMOUNT || t.dealAmount || 0,
      pricePerSqm: (t.DEALAREA||t.dealArea) ? Math.round((t.DEALAMOUNT||t.dealAmount)/(t.DEALAREA||t.dealArea)) : null,
      date: t.DEALDATETXT || t.dealDateTxt || '',
      neighborhood: t.NEIGHBORHOODNAME || t.neighborhoodName || '',
      city: t.CITYNAME || t.cityName || '',
      assetType: t.ASSETTYPENAME || '',
      source: 'nadlan.gov.il',
      scope
    }))
    .slice(0, 8);
}

app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.1.0', source: 'nadlan.gov.il' }));

app.get('/api/test', async (req, res) => {
  try {
    const url = `${NADLAN_BASE}/GetNeighborhoodsListByCityAndStartsWith?cityName=%D7%A8%D7%97%D7%95%D7%91%D7%95%D7%AA&startWithKey=-1`;
    const data = await nadlanFetch(url);
    res.json({ success: true, type: typeof data, isArray: Array.isArray(data), count: Array.isArray(data) ? data.length : 'N/A', sample: Array.isArray(data) ? data.slice(0,2) : data });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/transactions', async (req, res) => {
  const { city, street, neighborhood, houseNumber } = req.body;
  if (!city || !street) return res.status(400).json({ error: 'city and street required' });

  const cacheKey = `tx2_${city}_${street}_${houseNumber||''}_${neighborhood||''}`;
  const cached = cache.get(cacheKey);
  if (cached) { console.log('[cache] hit'); return res.json(cached); }

  const now = new Date();
  const from = new Date(now.getFullYear()-2, now.getMonth(), 1);
  const fromStr = `${from.getFullYear()}-${String(from.getMonth()+1).padStart(2,'0')}-01`;
  const toStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  const cityE = encodeURIComponent(city);
  const streetE = encodeURIComponent(street);
  const nbE = encodeURIComponent(neighborhood||'');
  const hnE = encodeURIComponent(houseNumber||'');

  console.log(`[tx] city=${city} street=${street} hn=${houseNumber} nb=${neighborhood}`);

  try {
    const urls = [
      houseNumber ? `${NADLAN_BASE}/GetDealsByStreet?cityName=${cityE}&neighborhoodName=${nbE}&streetName=${streetE}&houseNum=${hnE}&fromDate=${fromStr}&toDate=${toStr}&pageNum=1&pageSize=50` : null,
      `${NADLAN_BASE}/GetDealsByStreet?cityName=${cityE}&neighborhoodName=${nbE}&streetName=${streetE}&houseNum=&fromDate=${fromStr}&toDate=${toStr}&pageNum=1&pageSize=50`,
      neighborhood ? `${NADLAN_BASE}/GetDealsByNeighborhood?cityName=${cityE}&neighborhoodName=${nbE}&fromDate=${fromStr}&toDate=${toStr}&pageNum=1&pageSize=50` : null
    ].filter(Boolean);

    const results = await Promise.allSettled(urls.map(u => nadlanFetch(u)));
    console.log('[tx] results:', results.map(r => `${r.status}:${r.status==='fulfilled'?JSON.stringify(r.value).slice(0,40):'err'}`));

    let bData=[], sData=[], nData=[];
    const r0 = results[0]?.status==='fulfilled' ? normalizeTx(results[0].value?.Data||results[0].value,'building') : [];
    const r1 = results[houseNumber?1:0]?.status==='fulfilled' ? normalizeTx(results[houseNumber?1:0].value?.Data||results[houseNumber?1:0].value,'street') : [];
    const r2 = results[houseNumber?2:1]?.status==='fulfilled' ? normalizeTx(results[houseNumber?2:1].value?.Data||results[houseNumber?2:1].value,'neighborhood') : [];

    if (houseNumber) {
      bData = r0.filter(t => t.houseNumber===String(houseNumber)).slice(0,4);
      sData = r0.filter(t => t.houseNumber!==String(houseNumber)).concat(r1).slice(0,8);
    } else {
      sData = r1.slice(0,8);
    }
    nData = r2.slice(0,8);

    console.log(`[tx] building=${bData.length} street=${sData.length} nb=${nData.length}`);

    const result = { building:bData, street:sData, neighborhood:nData, meta:{ city, street, neighborhood, houseNumber, dateFrom:fromStr, dateTo:toStr, source:'nadlan.gov.il', fetchedAt:new Date().toISOString() }};
    if (bData.length+sData.length+nData.length > 0) cache.set(cacheKey, result);
    res.json(result);
  } catch(e) {
    console.error('[tx] Error:', e);
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
  if (!key || !allTx.length) return res.json({ analysis: allTx.length?'':'לא נמצאו עסקאות.', prices: calc });
  const txStr = allTx.slice(0,5).map(t=>`${t.address} ${t.houseNumber}, ק${t.floor??'?'}, ${t.rooms??'?'}חד, ${t.area??'?'}מ"ר: ₪${t.price.toLocaleString()} (${t.date})`).join('\n');
  const prompt = `שמאי מקרקעין ישראלי. נתח ב-3 משפטים:\nנכס: ${property.type||'דירה'} ${property.rooms||'?'}חד ${property.area||'?'}מ"ר ק${property.floor||'?'} - ${property.street||''} ${property.houseNumber||''} ${property.city||''}\nעסקאות:\n${txStr}\nסיים עם: JSON:{"fast":מספר,"real":מספר,"ceil":מספר}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:400,messages:[{role:'user',content:prompt}]})});
    const d = await r.json();
    const text = d.content?.[0]?.text||'';
    const jm = text.match(/JSON:\s*(\{[^{}]+\})/);
    let ap=calc; let an=text.replace(/JSON:\s*\{[^{}]+\}/,'').trim();
    if(jm){try{const p=JSON.parse(jm[1]);ap={fast:p.fast||calc.fast,real:p.real||calc.real,ceil:p.ceil||calc.ceil};}catch(_){}}
    res.json({analysis:an,prices:ap});
  } catch(e) { res.json({analysis:'AI לא זמין.',prices:calc}); }
});

app.listen(PORT, () => {
  console.log(`✅ CMA Backend running on port ${PORT}`);
  console.log(`   Source: nadlan.gov.il`);
  console.log(`   Cache TTL: 1hr`);
});
