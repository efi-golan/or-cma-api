require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1hr cache
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ──────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST']
}));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many requests' } });
app.use('/api/', limiter);

// ── NADLAN HEADERS (mimic browser) ──────────────────────────
const NADLAN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.nadlan.gov.il/',
  'Origin': 'https://www.nadlan.gov.il'
};

const NADLAN_BASE = 'https://www.nadlan.gov.il/Nadlan.REST/Main';

// ── HELPER: fetch with retry ─────────────────────────────────
async function nadlanFetch(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: NADLAN_HEADERS, timeout: 10000 });
      if (res.ok) return res.json();
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', source: 'nadlan.gov.il' });
});

// ── GET NEIGHBORHOODS ────────────────────────────────────────
// GET /api/neighborhoods?city=רחובות
app.get('/api/neighborhoods', async (req, res) => {
  const { city } = req.query;
  if (!city) return res.status(400).json({ error: 'city required' });

  const cacheKey = `nb_${city}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `${NADLAN_BASE}/GetNeighborhoodsListByCityAndStartsWith?cityName=${encodeURIComponent(city)}&startWithKey=-1`;
    const data = await nadlanFetch(url);
    cache.set(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── GET STREETS ──────────────────────────────────────────────
// GET /api/streets?city=רחובות&neighborhood=מרכז
app.get('/api/streets', async (req, res) => {
  const { city, neighborhood } = req.query;
  if (!city) return res.status(400).json({ error: 'city required' });

  const cacheKey = `st_${city}_${neighborhood}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `${NADLAN_BASE}/GetStreetListByCityAndNeighborhoodAndStartsWith?cityName=${encodeURIComponent(city)}&neighborhoodName=${encodeURIComponent(neighborhood || '')}&startWithKey=-1`;
    const data = await nadlanFetch(url);
    cache.set(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── SEARCH TRANSACTIONS ──────────────────────────────────────
// POST /api/transactions
// Body: { city, street, neighborhood, houseNumber, rooms, dateFrom, dateTo }
app.post('/api/transactions', async (req, res) => {
  const { city, street, neighborhood, houseNumber, rooms, dateFrom, dateTo } = req.body;
  if (!city || !street) return res.status(400).json({ error: 'city and street required' });

  // Date defaults: last 24 months
  const now = new Date();
  const from = dateFrom || new Date(now.getFullYear() - 2, now.getMonth(), 1).toLocaleDateString('en-GB').split('/').reverse().join('-');
  const to = dateTo || now.toLocaleDateString('en-GB').split('/').reverse().join('-');

  const cacheKey = `tx_${city}_${street}_${houseNumber || ''}_${rooms || ''}_${from}_${to}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // 1. Building-level search (with house number)
    const buildingUrl = `${NADLAN_BASE}/GetDealsByStreet?cityName=${encodeURIComponent(city)}&neighborhoodName=${encodeURIComponent(neighborhood || '')}&streetName=${encodeURIComponent(street)}&houseNum=${encodeURIComponent(houseNumber || '')}&fromDate=${from}&toDate=${to}&pageNum=1&pageSize=50`;

    // 2. Street-level search
    const streetUrl = `${NADLAN_BASE}/GetDealsByStreet?cityName=${encodeURIComponent(city)}&neighborhoodName=${encodeURIComponent(neighborhood || '')}&streetName=${encodeURIComponent(street)}&houseNum=&fromDate=${from}&toDate=${to}&pageNum=1&pageSize=50`;

    // 3. Neighborhood-level search
    const nbUrl = `${NADLAN_BASE}/GetDealsByNeighborhood?cityName=${encodeURIComponent(city)}&neighborhoodName=${encodeURIComponent(neighborhood || '')}&fromDate=${from}&toDate=${to}&pageNum=1&pageSize=50`;

    const [buildingRaw, streetRaw, nbRaw] = await Promise.allSettled([
      nadlanFetch(buildingUrl),
      nadlanFetch(streetUrl),
      neighborhood ? nadlanFetch(nbUrl) : Promise.resolve([])
    ]);

    const normalize = (raw, scope) => {
      const items = raw.status === 'fulfilled' ? (raw.value?.Data || raw.value || []) : [];
      return items
        .filter(t => t && t.DEALAMOUNT > 0)
        .map(t => ({
          address: [t.DISPLAYSTREET, t.HOUSENUMBER].filter(Boolean).join(' '),
          houseNumber: t.HOUSENUMBER || '',
          floor: t.FLOOR ?? null,
          rooms: t.ROOMS ?? null,
          area: t.DEALAREA ?? null,
          price: t.DEALAMOUNT,
          pricePerSqm: t.DEALAREA ? Math.round(t.DEALAMOUNT / t.DEALAREA) : null,
          date: t.DEALDATETXT || t.DEALDATE || '',
          neighborhood: t.NEIGHBORHOODNAME || neighborhood || '',
          city: t.CITYNAME || city,
          assetType: t.ASSETTYPENAME || '',
          source: 'nadlan.gov.il',
          scope
        }))
        .slice(0, 8); // max 8 per category per spec
    };

    // Building: only those with matching house number
    const bData = normalize(buildingRaw, 'building').filter(t =>
      !houseNumber || t.houseNumber === String(houseNumber)
    ).slice(0, 4);

    // Street: exclude building
    const sData = normalize(streetRaw, 'street').filter(t =>
      !houseNumber || t.houseNumber !== String(houseNumber)
    ).slice(0, 8);

    // Neighborhood
    const nData = normalize(nbRaw, 'neighborhood').slice(0, 8);

    const result = {
      building: bData,
      street: sData,
      neighborhood: nData,
      meta: {
        city, street, neighborhood, houseNumber,
        dateFrom: from, dateTo: to,
        source: 'nadlan.gov.il',
        fetchedAt: new Date().toISOString()
      }
    };

    cache.set(cacheKey, result);
    res.json(result);
  } catch (e) {
    console.error('Transaction fetch error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── CLAUDE ANALYSIS ──────────────────────────────────────────
// POST /api/analyze
// Body: { property, transactions, claudeKey }
app.post('/api/analyze', async (req, res) => {
  const { property, transactions, claudeKey } = req.body;
  const key = claudeKey || process.env.CLAUDE_API_KEY;
  if (!key) return res.status(400).json({ error: 'Claude API key required' });

  const allTx = [...(transactions.building || []), ...(transactions.street || [])].filter(t => t.price > 0);
  if (allTx.length === 0) {
    return res.json({ analysis: 'לא נמצאו עסקאות מספיקות לניתוח.', prices: { fast: 0, real: 0, ceil: 0 } });
  }

  // Calculate prices server-side first (conservative)
  const prices = allTx.map(t => t.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const calculatedPrices = {
    fast: Math.round(median * 0.92 / 10000) * 10000,
    real: Math.round(median * 0.97 / 10000) * 10000,
    ceil: Math.round(median * 1.05 / 10000) * 10000
  };

  const txSummary = allTx.slice(0, 6).map(t =>
    `${t.address}, ${t.rooms || '?'} חד', ${t.area || '?'}מ"ר, קומה ${t.floor ?? '?'}: ₪${t.price.toLocaleString()} (${t.date}) – ${t.source}`
  ).join('\n');

  const prompt = `אתה שמאי מקרקעין מוסמך ישראלי. נתח את הנכס הבא וכתוב דוח CMA קצר ומקצועי.

פרטי הנכס:
- כתובת: ${property.street} ${property.houseNumber || ''}, ${property.neighborhood ? 'שכונת ' + property.neighborhood + ',' : ''} ${property.city}
- סוג: ${property.type || 'דירה'} | קומה: ${property.floor || '?'} | חדרים: ${property.rooms || '?'} | שטח: ${property.area || '?'} מ"ר
- ממ"ד: ${property.mamad || '?'} | מרפסת: ${property.balcony || '?'} | מחסן: ${property.storage || '?'} | חנייה: ${property.parking || '?'}
${property.notes ? `- הערות: ${property.notes}` : ''}

עסקאות אמיתיות שנמצאו מnadlan.gov.il (${allTx.length} עסקאות, 24 חודשים אחרונים):
${txSummary}

טווח מחירים שחושב:
- מחיר מהיר: ₪${calculatedPrices.fast.toLocaleString()}
- מחיר ריאלי: ₪${calculatedPrices.real.toLocaleString()}
- מחיר תקרה: ₪${calculatedPrices.ceil.toLocaleString()}

כתוב ניתוח מקצועי בעברית (4-5 משפטים) הכולל:
1. מיקום הנכס ביחס לעסקאות שנמצאו
2. השפעת הקומה והמאפיינים (ממ"ד, מרפסת וכו')
3. המלצה לאסטרטגיית מחיר

אחר כך, החזר JSON בלבד בשורה נפרדת:
{"fast": מספר, "real": מספר, "ceil": מספר, "confidence": "גבוה/בינוני/נמוך", "note": "משפט קצר על הביטחון"}`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '';

    // Extract JSON prices if Claude provided them
    const jsonMatch = text.match(/\{[^{}]*"fast"[^{}]*\}/);
    let aiPrices = calculatedPrices;
    let analysis = text;

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        aiPrices = {
          fast: parsed.fast || calculatedPrices.fast,
          real: parsed.real || calculatedPrices.real,
          ceil: parsed.ceil || calculatedPrices.ceil,
          confidence: parsed.confidence || 'בינוני',
          note: parsed.note || ''
        };
        analysis = text.replace(jsonMatch[0], '').trim();
      } catch (_) {}
    }

    res.json({ analysis, prices: aiPrices });
  } catch (e) {
    console.error('Claude error:', e.message);
    // Return calculated prices even if Claude fails
    res.json({
      analysis: 'ניתוח AI לא זמין. המחירים חושבו על בסיס עסקאות בלבד.',
      prices: calculatedPrices
    });
  }
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ CMA Backend running on port ${PORT}`);
  console.log(`   Source: nadlan.gov.il`);
  console.log(`   Cache TTL: 1hr`);
});
