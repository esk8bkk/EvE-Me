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

## OpenAI voice (optional)
Set `OPENAI_API_KEY` in Render. Optional: `OPENAI_TTS_MODEL` (default `gpt-4o-mini-tts`) and `OPENAI_TTS_VOICE` (default `marin`). If no key is set, `/api/tts` returns 501 and the page uses the browser's voice.

## Car state for EvE (agent): `GET /api/car`
`curl -H "Authorization: Bearer $PUSH_TOKEN" https://evae-me.onrender.com/api/car`
Cached, refreshed from Tesla at most once per 60s while requested; never wakes the car.
Online response (units already converted):
- `state` online|asleep|offline, `ts` (ms epoch of the reading)
- Drive: `shift_state` (P/D/R/N or null = parked), `speed` km/h, `heading` deg, `lat`, `lng`, `odometer` km
- Battery: `battery_level` %, `battery_range` km, `charge_limit_soc` %, `charging_state` (Disconnected/Charging/Complete/Stopped), `charger_power` kW, `minutes_to_full_charge`
- Climate: `inside_temp`, `outside_temp` °C, `is_climate_on`
- Security: `locked`, `sentry_mode`, `doors` {df,dr,pf,pr} (driver/passenger front/rear; true = open), `ft` frunk, `rt` trunk, `windows` {fd,fp,rd,rp}
- Tyres: `tpms_pressure_fl/fr/rl/rr` bar (warning if < 2.6 or > 0.3 off the others)
Asleep/offline: `{state, known:{…last online reading…}, known_ts}`. `stale_error` appears if the last refresh failed (values are from cache). 409 = Tesla not linked.
Spoken alerts (server, 30-min debounce per kind): battery < 20 %, charge complete, tyre warning, locked with something open, unlocked in P > 5 min. The page shows a matching card but does not speak.

## Vehicle commands (navigation, media, climate)
How it works: navigation_request / navigation_gps_request / navigation_sc_request are not part of Tesla's signed protocol, so they go straight to the Fleet REST API. Media, climate, set_temps and flash_lights must be signed with our virtual key, so the Docker image runs Tesla's official `tesla-http-proxy` on localhost:4443 inside the same Render service. The server reaches it over TLS pinned to a cert made at startup. Nothing else is exposed.
Allowed: navigation_request {value}, navigation_gps_request {lat,lon}, navigation_sc_request, media_toggle_playback, media_next_track, media_prev_track, media_volume_up, media_volume_down, auto_conditioning_start, auto_conditioning_stop, set_temps {driver_temp,passenger_temp 15–28}, flash_lights. Everything else returns 403 (no unlock, no remote start). Commands wake the car if needed; reads never do.
`curl -X POST -H "Authorization: Bearer $PUSH_TOKEN" -H "Content-Type: application/json" -d '{"value":"Siam Paragon"}' https://evae-me.onrender.com/api/tesla/command/navigation_request`

### Steps
1. developer.tesla.com → your app → enable the **vehicle_cmds** scope and save.
2. Upload the new files to the repo: `server.js`, `index.html`, `Dockerfile`, `start.sh`, `.dockerignore`, `render.yaml`, `package.json`, `package-lock.json`. **Never commit `tesla_private.pem`.**
3. Render → evae-me → Settings → Build → Source → **Edit**. Keep the same repo/branch, set Runtime to **Docker** and the Dockerfile path to `./Dockerfile`, then Deploy. Keep the same service, so the evae-me.onrender.com domain and the public key stay the same.
4. Render → evae-me → Environment → **Secret Files** → Add: filename `tesla_private.pem`, contents = the private key file EvE sends you (open it in a text editor, copy all of it, paste, save). It is mounted at `/etc/secrets/tesla_private.pem`. Then delete your downloaded copy.
5. Wait for the deploy, then open `https://evae-me.onrender.com/?k=VIEW_KEY` → `https://evae-me.onrender.com/tesla/login` (re-login so the token includes vehicle_cmds). Copy the new refresh token into `TESLA_REFRESH_TOKEN`.
6. On your phone with the Tesla app installed, open **https://tesla.com/_ak/evae-me.onrender.com** and approve adding the key in the app, near the car if asked.
7. Test: `curl -X POST -H "Authorization: Bearer $PUSH_TOKEN" https://evae-me.onrender.com/api/tesla/command/flash_lights`

Env vars added: none required (`TESLA_PROXY_URL` / `TESLA_PROXY_CA` are set by the Dockerfile; optional `TESLA_KEY_FILE` overrides the key path).

## Calendar
`POST /api/calendar` (Bearer PUSH_TOKEN) `{events:[{id,title,start ISO,end?,location?,kind?}]}` replaces the list. `GET /api/calendar`. Every 60 s the server alerts once per event inside its lead time (60 min; `kind` flight/check-in: 150 min; or per-event `lead_min`). It shows a calendar card and speaks e.g. "อีก 45 นาที มีนัด ประชุมทีม ที่ Siam Paragon ให้ EvE นำทางไหม".
