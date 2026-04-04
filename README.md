# אור נכסים – CMA System

מערכת CMA לחיפוש עסקאות נדל"ן אמיתיות מ-nadlan.gov.il (רשות המסים).

---

## ארכיטקטורה

```
Frontend (Render Static)
    ↓  POST /api/transactions
Backend (Render Node.js)
    ↓  fetch() עם browser headers
nadlan.gov.il (רשות המסים)
    ↓  JSON
Backend → Cache → Frontend → דוח
```

---

## דפלוי ב-Render – שלב אחר שלב

### 1. Backend

1. צור repo ב-GitHub: `or-nesachim-cma-api`
2. העלה את תיקיית `cma-backend/`
3. ב-Render → **New Web Service** → חבר GitHub
4. הגדרות:
   - **Name:** `or-nesachim-cma-api`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Environment Variables:
   - `CLAUDE_API_KEY` → המפתח שלך (אופציונלי)
   - `FRONTEND_URL` → (אחרי שיודעים את הURL של הפרונט)
6. לחץ **Deploy**
7. שמור את ה-URL: `https://or-nesachim-cma-api.onrender.com`

### 2. Frontend

1. צור repo ב-GitHub: `or-nesachim-cma`
2. העלה את תיקיית `cma-frontend/`
3. ב-Render → **New Static Site** → חבר GitHub
4. הגדרות:
   - **Publish Directory:** `public`
5. לחץ **Deploy**
6. פתח את הפרונט → **הגדרות** → הזן את כתובת ה-Backend → **בדוק חיבור**

---

## API Endpoints

| Method | Path | תיאור |
|--------|------|--------|
| GET | `/health` | בדיקת חיבור |
| GET | `/api/neighborhoods?city=רחובות` | רשימת שכונות |
| GET | `/api/streets?city=רחובות&neighborhood=מרכז` | רשימת רחובות |
| POST | `/api/transactions` | חיפוש עסקאות |
| POST | `/api/analyze` | ניתוח Claude AI |

### דוגמת בקשה – חיפוש עסקאות

```bash
curl -X POST https://your-api.onrender.com/api/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "city": "רחובות",
    "street": "הרצל",
    "neighborhood": "מרכז העיר",
    "houseNumber": "42",
    "rooms": "4"
  }'
```

### תשובה לדוגמה

```json
{
  "building": [
    {
      "address": "הרצל 42",
      "floor": 3,
      "rooms": 4,
      "area": 98,
      "price": 1750000,
      "pricePerSqm": 17857,
      "date": "11/2024",
      "source": "nadlan.gov.il",
      "scope": "building"
    }
  ],
  "street": [...],
  "neighborhood": [...],
  "meta": {
    "source": "nadlan.gov.il",
    "fetchedAt": "2025-04-03T10:00:00.000Z"
  }
}
```

---

## הגדרות בפרונט

- **שרת URL:** כתובת ה-Render backend
- **Claude API Key:** לניתוח מקצועי (אופציונלי)
- כל ההגדרות נשמרות ב-localStorage

---

## מגבלות ידועות

- nadlan.gov.il מגביל בקשות – ה-backend כולל rate limiting ו-1hr cache
- הנתונים מתעדכנים ברשות המסים בפיגור של 30-90 יום מיום העסקה
- חלק מהשדות (חדרים, שטח) עלולים להיות לא מדויקים בבניינים ישנים

---

## Audit Log

כל שינוי ידני (הסרת עסקה, שינוי מחיר) נשמר ב-`S.auditLog` בזיכרון ובקונסול.
