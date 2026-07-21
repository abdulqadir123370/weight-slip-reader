# weight-slip-reader

Reads a photo of a printed digital-scale weight slip and returns the weight as structured JSON,
using Claude's vision API. Built to plug into the Brush Manufacturing Tracker's Sales tab.

## What it does

`POST /read-slip` — send a base64-encoded photo, get back:

```json
{
  "success": true,
  "netWeightKg": 45.5,
  "slipDate": "2026-07-21",
  "slipNumber": "00234",
  "confidence": "high",
  "notes": ""
}
```

## 1. Get an Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Settings → API Keys → Create Key
3. Add a small amount of credit (a receipt read costs a fraction of a cent — even a few dollars
   covers thousands of reads)

## 2. Deploy to Railway

1. Push this folder to a new GitHub repo (e.g. `weight-slip-reader`)
2. Railway dashboard → New Project → Deploy from GitHub repo → select it
3. Once deployed, go to the service's **Variables** tab and add:
   - `ANTHROPIC_API_KEY` — the key from step 1
   - `SHARED_SECRET` — any long random string you make up (e.g. run `openssl rand -hex 24`
     in a terminal, or just mash the keyboard for 40+ characters). This is **not** your
     Anthropic key — it's a separate password just for this endpoint, and it has to match
     exactly what you paste into the main app later.
   - `ALLOWED_ORIGIN` — `https://abdulqadir123370.github.io` (add more, comma-separated, if
     you also test via a local server)
4. Railway will give you a public URL like `https://weight-slip-reader-production.up.railway.app`
5. Visit `<that-url>/health` in a browser — you should see `{"ok":true}`. If you get an error,
   check the Railway deploy logs.

## 3. Connect it to the main app

Open `index.html`, find `WEIGHT_SLIP_READER_URL` and `WEIGHT_SLIP_READER_SECRET` near the top of
the script, and fill in:

```js
const WEIGHT_SLIP_READER_URL = 'https://weight-slip-reader-production.up.railway.app/read-slip';
const WEIGHT_SLIP_READER_SECRET = 'the same random string you set as SHARED_SECRET';
```

Push the updated app. Attaching a weight slip photo in the Sales tab will now auto-fill the KG
field.

## Cost

Each read is one Claude API call with a single image — typically a very small fraction of a
cent. Even hundreds of sales a month cost well under a dollar in API usage. Railway's free tier
covers a low-traffic service like this comfortably; if you outgrow it, Railway's usage-based
pricing is a few dollars a month for something this lightweight.

## If something goes wrong

- **"Unauthorized" errors in the app**: `SHARED_SECRET` on Railway doesn't match
  `WEIGHT_SLIP_READER_SECRET` in the app — check for typos or extra spaces.
- **CORS errors in the browser console**: your site's exact origin isn't in `ALLOWED_ORIGIN` on
  Railway. It must match exactly (no trailing slash).
- **"Could not reach the reading service"**: check Railway's logs for the actual Anthropic API
  error — usually a billing/credit issue or an invalid key.
