# EkNumber

Voice-based call routing for India. Call **one number**, say the company name (e.g. "Jio", "Swiggy", "HDFC Bank"), and get transferred to that company’s real support number.

## Tech stack

- **Node.js 18+** with Express
- **Exotel** – receive calls, record voice, transfer
- **Google Cloud Speech-to-Text** – transcribe what the user said
- **Fuse.js** – fuzzy match company names
- **Google Sheets API** – company database (edit without code changes)
- **Railway** – hosting
- **dotenv** – environment variables

## Call flow

1. User calls your Exotel number.
2. Exotel sends **POST /call/incoming** to your app.
3. App responds with XML: play welcome prompt and start recording.
4. User says a company name (e.g. "Jio", "Swiggy", "HDFC Bank").
5. Exotel sends **POST /call/recording** with the audio URL.
6. App downloads audio → Google STT → transcript.
7. App fuzzy-matches transcript to the company list.
8. **Strong match (score > 0.8):** play "Connecting you to [Company]" and transfer via Exotel API.
9. **Ambiguous (2 close matches):** play "Did you mean X or Y? Press 1 for X, 2 for Y" → **POST /call/digits** → transfer.
10. **No match:** play "Sorry, we could not find [X]. Please try again" and re-record (max 2 retries, then error message and hangup).

---

## Setup (from zero)

### 1. Node and repo

- Install **Node.js 18 or higher**: [nodejs.org](https://nodejs.org/).
- Clone or copy this repo, then:

```bash
cd eknumber
npm install
```

### 2. Exotel account and API keys

1. Sign up at [Exotel](https://exotel.com/).
2. Get a **virtual number** (where users will call) from the Exotel dashboard.
3. Go to **API Settings** (or [my.exotel.com/apisettings](https://my.exotel.com/apisettings/site#api-credentials)) and note:
   - **Account SID** → `EXOTEL_SID`
   - **API Key** → use as username for Basic auth (often same as SID)
   - **API Token** → `EXOTEL_TOKEN`
4. **Subdomain:** Mumbai cluster use `api.in.exotel.com`, Singapore use `api.exotel.com` → set `EXOTEL_SUBDOMAIN`.

### 3. Google Cloud (Speech-to-Text + Sheets)

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or pick one) and enable:
   - **Speech-to-Text API**
   - **Google Sheets API**
3. **Service account:**
   - APIs & Services → Credentials → Create Credentials → Service Account.
   - Create a key (JSON), download it, save as `google-credentials.json` in the **eknumber** folder.
4. Set in `.env`:
   - `GOOGLE_APPLICATION_CREDENTIALS=./google-credentials.json`

### 4. Google Sheet (company database)

1. Create a new Google Sheet.
2. First row (headers): `name`, `aliases`, `support_number`, `category`, `active`
3. Add rows (see [Sheet structure](#google-sheet-structure) below). You can copy from `data/companies.json` (columns: name, aliases, support_number, category, active).
4. Share the sheet with the **service account email** (from the JSON, e.g. `xxx@xxx.iam.gserviceaccount.com`) as **Viewer**.
5. Copy the Sheet ID from the URL:  
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`  
   Set in `.env`:  
   `GOOGLE_SHEETS_ID=<SHEET_ID>`

### 5. Environment variables

```bash
cp .env.example .env
```

Edit `.env` and set:

```env
EXOTEL_SID=your_account_sid
EXOTEL_TOKEN=your_api_token
EXOTEL_VIRTUAL_NUMBER=your_exotel_virtual_number
EXOTEL_SUBDOMAIN=api.exotel.com

GOOGLE_APPLICATION_CREDENTIALS=./google-credentials.json
GOOGLE_SHEETS_ID=your_google_sheet_id

PORT=3000
BASE_URL=https://your-public-url.com
```

For local testing with ngrok, set `BASE_URL=https://xxxx.ngrok.io` (no trailing slash).

### 6. Exotel dashboard (webhooks)

In your Exotel call flow / app:

1. **Incoming call** → point to your app’s **incoming** URL.
2. **After record** → point to your app’s **recording** URL.

Use the full URLs, e.g.:

- Incoming: `https://your-app.railway.app/call/incoming` (or your ngrok URL)
- Recording callback: `https://your-app.railway.app/call/recording`

Exotel may send GET or POST; this app supports **POST** with body or query params: `CallSid`, `From`/`CallFrom`, `To`/`CallTo`, `CallStatus`, `RecordingUrl`, `RecordingDuration`, `digits`.

**If your Exotel plan has no Record/Voicemail applet**, use the **Passthru + Recording API** flow instead. The app provides a **wait** endpoint (Passthru holds until the app responds), so you don’t need a Timing/Wait applet:

1. **Passthru** → URL: `https://your-app.onrender.com/call/start_recording`  
   When the call reaches this, the app starts recording and creates call state.  
   **Once URL returns OK (200)** → go to step 2.

2. **Greeting** → Play this text (or use text-to-speech):  
   *"Namaste. EkNumber pe aapka swagat hai. Aap kis company ka support chahte hain? Beep ke baad boliye."*

3. **Passthru** → URL: `https://your-app.onrender.com/call/wait?seconds=3`  
   The app waits 3 seconds then returns 200 (caller has time to say the company name while recording).

4. **Passthru** → URL: `https://your-app.onrender.com/call/stop_recording`  
   The app stops recording. Exotel will later POST the recording URL to your app.

5. **Passthru** → URL: `https://your-app.onrender.com/call/wait?seconds=5`  
   The app waits 5 seconds so it can receive the recording, run STT, and match the company before the next step.

6. **Connect** (dynamic URL) → URL: `https://your-app.onrender.com/call/connect`  
   The app returns the support number; Exotel connects the caller to it.

Replace `your-app.onrender.com` with your real app URL. You don’t need a Record/Voicemail or Timing applet—the app uses Exotel’s Recording API and the `/call/wait` endpoint for delays.

### 7. Run locally and test with ngrok

```bash
node src/server.js
```

In another terminal:

```bash
ngrok http 3000
```

Use the `https://xxxx.ngrok.io` URL as `BASE_URL` in `.env` and in the Exotel webhook URLs. Restart the app after changing `.env`.

### 8. Deploy to Railway

1. Push the repo to GitHub (or connect Railway to your repo).
2. In [Railway](https://railway.app/), New Project → Deploy from GitHub → select the repo.
3. Root directory: `eknumber` (if the app is in a subfolder).
4. Add environment variables in Railway (same as `.env`; do **not** commit `.env` or `google-credentials.json`).
5. For `GOOGLE_APPLICATION_CREDENTIALS`, paste the **contents** of your service account JSON as the value, or use Railway’s “mount file” if available; adjust the path in the variable if needed.
6. Set `PORT` to the value Railway provides (often `PORT` is set automatically).
7. Set `BASE_URL` to your Railway app URL, e.g. `https://your-app.railway.app`.
8. Deploy; Railway will run `npm install` and you can set start command to `node src/server.js` (or use `npm start`).

---

## Testing without a real call (mock webhooks)

Use `curl` against your running app (local or deployed). Replace `http://localhost:3000` with your `BASE_URL` if needed.

### 1. Simulate incoming call

```bash
curl -X POST "http://localhost:3000/call/incoming" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=test123" \
  -d "From=091234567890" \
  -d "To=08012345678" \
  -d "CallStatus=in-progress"
```

You should get XML with `<Say>` (welcome) and `<Record>` pointing to your `/call/recording` URL.

### 2. Simulate recording callback (no real audio)

The app expects a real `RecordingUrl` to download and send to Google STT. For a quick check that the route works (it will fail at STT without a valid URL), you can still hit the endpoint:

```bash
curl -X POST "http://localhost:3000/call/recording" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=test123" \
  -d "From=091234567890" \
  -d "To=08012345678" \
  -d "RecordingUrl=https://example.com/fake.wav" \
  -d "RecordingDuration=3"
```

Without a real audio file, STT will fail and the app will return the error prompt XML. To test the full flow, use a real Exotel recording URL or a public 8 kHz mono WAV URL.

### 3. Simulate ambiguous choice (digits)

First trigger a flow that sets ambiguous state (e.g. say something that matches two companies), then:

```bash
curl -X POST "http://localhost:3000/call/digits" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=test123" \
  -d "From=091234567890" \
  -d "To=08012345678" \
  -d "digits=1"
```

### 4. Health and admin

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/admin/refresh
```

---

## Google Sheet structure

| Column            | Type   | Example                                      |
|------------------|--------|----------------------------------------------|
| `name`           | string | Jio                                          |
| `aliases`        | string | jio, reliance jio, reliance                   |
| `support_number` | string | 1800-889-9999                                |
| `category`       | string | telecom                                      |
| `active`         | boolean| TRUE / FALSE                                 |

Example rows:

| name    | aliases              | support_number   | category | active |
|---------|----------------------|------------------|----------|--------|
| Jio     | jio, reliance jio    | 1800-889-9999    | telecom  | TRUE   |
| Swiggy  | swiggy               | 1800-208-8522    | food & delivery | TRUE |
| HDFC Bank | hdfc, hdfc bank    | 1800-202-6161    | banking & fintech | TRUE |

Use `active=FALSE` to hide a company without deleting the row. The app caches the sheet and refreshes every 10 minutes; use **POST /admin/refresh** to force a refresh.

---

## Adding new companies

1. **In Google Sheet:** Add a row with `name`, `aliases` (comma-separated), `support_number`, `category`, `active=TRUE`. Save.
2. **Optional:** Call `POST /admin/refresh` to refresh the cache immediately; otherwise it refreshes within 10 minutes.
3. **Local fallback:** If you also want the company when Sheets is unavailable, add the same row to `data/companies.json` (same column names, JSON format).

---

## Voice prompts (exact text)

- **Welcome:** "Namaste. EkNumber pe aapka swagat hai. Aap kis company ka support chahte hain? Beep ke baad boliye."
- **Connecting:** "Connecting you to [COMPANY NAME] support. Please hold."
- **Ambiguous:** "Did you mean [COMPANY A], press 1. Or [COMPANY B], press 2."
- **Not found:** "Sorry, we could not find [TRANSCRIPT]. Please try again after the beep."
- **Error:** "Something went wrong. Please call back in a moment."

---

## Project structure

```
eknumber/
├── src/
│   ├── server.js          # Express app, routes, XML responses
│   ├── callHandler.js     # Call state (in-memory Map), prompts
│   ├── speechService.js   # Google STT, download recording from URL
│   ├── companyService.js  # Google Sheets + Fuse.js fuzzy match
│   ├── exotelService.js   # Exotel Connect API (transfer)
│   └── logger.js          # Call logging (console + logs/calls.log)
├── data/
│   └── companies.json     # Local fallback company list (50 companies)
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## License

Use and modify as needed for your project.
#   e k n u m b e r 
 
 