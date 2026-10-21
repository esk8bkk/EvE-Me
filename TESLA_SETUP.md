# EvE Me × Tesla Fleet API setup

Region: Thailand is Asia-Pacific, so use the NA/APAC base URL `https://fleet-api.prd.na.vn.cloud.tesla.com` (see Tesla's docs, Regions & Countries).

## 1. Upload (flat repo root)
`server.js`, `index.html`, `eve-blob-white.svg`, `com.tesla.3p.public-key.pem`. The private key stays off the repo; it isn't needed for read-only data.

## 2. Render env vars
| Var | Value |
|---|---|
| TESLA_CLIENT_ID | from developer.tesla.com app |
| TESLA_CLIENT_SECRET | from developer.tesla.com app |
| TESLA_AUDIENCE | optional, default `https://fleet-api.prd.na.vn.cloud.tesla.com` |
| TESLA_REFRESH_TOKEN | set after step 5 |
| VIEW_KEY, PUSH_TOKEN | existing |
| WAKE_WEBHOOK_URL / WAKE_WEBHOOK_AUTH | optional; AUTH is sent verbatim as the `Authorization` header |

## 3. Deploy, then check the key is public
`curl https://evae-me.onrender.com/.well-known/appspecific/com.tesla.3p.public-key.pem`

## 4. Register the partner domain (once)
`curl -X POST -H "Authorization: Bearer $PUSH_TOKEN" https://evae-me.onrender.com/tesla/register`

## 5. Link your Tesla account
1. Open `https://evae-me.onrender.com/?k=VIEW_KEY` once in this browser (sets the cookie).
2. Open `https://evae-me.onrender.com/tesla/login`, sign in to Tesla, and approve the scopes.
3. The callback page shows a refresh token. Paste it into Render as `TESLA_REFRESH_TOKEN` and save (this redeploys).

## 6. Use it
- `GET /api/tesla/vehicles` (Bearer PUSH_TOKEN)
- `GET /api/tesla/state[?vin=...]` (Bearer PUSH_TOKEN) returns `{state, shift_state, speed, lat, lng, battery_level, charging_state, ts}`. It never wakes the car: if the car is asleep or offline you get only `state`.

Access tokens refresh automatically. Tesla rotates refresh tokens, so after a long restart gap you may need to repeat step 5.
