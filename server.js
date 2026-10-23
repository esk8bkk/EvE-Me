const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';
const VIEW_KEY = process.env.VIEW_KEY || '';
const MAX = 20, MAX_ANS = 100, COOKIE = 'eve_k';
const items = [];
const answers = []; // newest first
const clients = new Set();
app.use(express.json({ limit: '64kb' }));
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } }
  }
  return '';
}
const viewOk = (req, res, next) => {
  if (!VIEW_KEY) return res.status(401).send('Unauthorized');
  if (typeof req.query.k === 'string' && safeEq(req.query.k, VIEW_KEY)) {
    if (!safeEq(getCookie(req, COOKIE), VIEW_KEY))
      res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(VIEW_KEY)}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`);
    return next();
  }
  if (safeEq(getCookie(req, COOKIE), VIEW_KEY)) return next();
  res.status(401).send('Unauthorized');
};
const pushOk = (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!PUSH_TOKEN || !m || !safeEq(m[1], PUSH_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
  next();
};
const broadcast = (event, obj) => { const d = `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`; for (const c of clients) { try { c.write(d); } catch {} } };
// ---- replay log: every pushed item gets an increasing seq; kept >= 10 min so a reconnecting car can catch up ----
const BOOT = crypto.randomBytes(4).toString('hex'); // changes on restart so clients can reset their lastSeq
let seq = 0;
const log = []; // oldest first: { seq, item }
const LOG_KEEP_MS = 15 * 60000, LOG_MAX = 300;
function pruneLog(now = Date.now()) { while (log.length && (log.length > LOG_MAX || now - log[0].item.ts > LOG_KEEP_MS)) log.shift(); }
const sseItem = item => `id: ${item.seq}\nevent: item\ndata: ${JSON.stringify(item)}\n\n`;
function emitItem(item) { // assign seq, remember, send with SSE id so EventSource resumes via Last-Event-ID
  item.seq = ++seq; item.boot = BOOT; log.push({ seq: item.seq, item }); pruneLog();
  const d = sseItem(item); let sent = 0;
  for (const c of clients) { try { c.write(d); sent++; } catch {} }
  return sent;
}
const itemsAfter = after => { pruneLog(); return log.filter(e => e.seq > after).map(e => e.item); };
const parseAfter = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null; };

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.post('/api/push', pushOk, (req, res) => {
  if ((req.body || {}).type === 'agenda') return pushAgenda(req, res);
  if ((req.body || {}).type === 'briefing') return pushBriefing(req, res);
  const { type = 'message', title = '', text = '', body = '', meta = {}, options, speak } = req.body || {};
  if (!['message', 'card', 'flight', 'question', 'reply'].includes(type)) return res.status(400).json({ error: 'bad type' });
  const item = { id: crypto.randomUUID(), ts: Date.now(), type, title: String(title || (type === 'question' ? text : '')).slice(0, 300), body: String(body || (type !== 'question' ? text : '')).slice(0, 4000), meta: typeof meta === 'object' && meta ? meta : {} };
  if (type === 'reply') { if (!item.body && !item.title) return res.status(400).json({ error: 'text required' }); item.speak = speak !== false; }
  else if (speak === true) item.speak = true;
  if (type === 'question') {
    if (!Array.isArray(options) || !options.length) return res.status(400).json({ error: 'options required' });
    item.options = options.slice(0, 6).map(o => String(o).slice(0, 80)).filter(Boolean);
    if (!item.title) return res.status(400).json({ error: 'title/text required' });
    item.answer = null;
  }
  items.unshift(item); items.length = Math.min(items.length, MAX);
  emitItem(item);
  res.json({ ok: true, id: item.id, seq: item.seq, clients: clients.size, queued: true });
});
app.post('/api/answer', viewOk, (req, res) => {
  const { id, answer } = req.body || {};
  const q = items.find(i => i.id === id && i.type === 'question');
  if (!q) return res.status(404).json({ error: 'question not found' });
  if (!q.options.includes(answer)) return res.status(400).json({ error: 'bad answer' });
  const a = { id: q.id, question: q.title, answer, ts: Date.now() };
  q.answer = answer; q.answeredAt = a.ts;
  const i = answers.findIndex(x => x.id === id); if (i >= 0) answers.splice(i, 1);
  answers.unshift(a); answers.length = Math.min(answers.length, MAX_ANS);
  broadcast('answer', a);
  res.json({ ok: true, ...a });
});
let lastLoc = null;
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
app.post('/api/location', viewOk, (req, res) => {
  const b = req.body || {};
  const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180);
  if (lat === null || lng === null) return res.status(400).json({ error: 'bad coords' });
  lastLoc = { lat, lng, accuracy: num(b.accuracy, 0, 1e6), speed: num(b.speed, 0, 1000), heading: num(b.heading, 0, 360), client_ts: num(b.ts, 0, 1e14), received: Date.now() };
  res.json({ ok: true });
});
app.get('/api/location', pushOk, (req, res) => {
  if (!lastLoc) return res.status(404).json({ error: 'no location yet' });
  res.json({ ...lastLoc, age_s: Math.round((Date.now() - lastLoc.received) / 1000) });
});
// ---- talk to EvE: inbox of utterances from the car ----
const inbox = [];            // newest last, max 50
const voices = new Map();    // id -> {buf, mime, ts}, max 5
const WAKE = process.env.WAKE_WEBHOOK_URL || '';
const WAKE_AUTH = process.env.WAKE_WEBHOOK_AUTH || ''; // sent verbatim as Authorization
function wake(payload) {
  if (!WAKE || typeof fetch !== 'function') return;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000);
  fetch(WAKE, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(WAKE_AUTH ? { Authorization: WAKE_AUTH } : {}) }, body: JSON.stringify(payload), signal: ac.signal })
    .catch(() => console.log('wake webhook failed')).finally(() => clearTimeout(t)); // never logs the text
}
// Wake debounce: clips/texts arriving within WAKE_DEBOUNCE_MS of each other become ONE wake (one bot run).
// Payload keeps the old single-utterance fields ({id, ts, text} or {id, ts, audio_id}) for the FIRST utterance,
// plus batch fields: ids[], audio_ids[], texts[], count, since (ts-1 of the first; use with /api/inbox?since=).
const WAKE_DEBOUNCE_MS = Number(process.env.WAKE_DEBOUNCE_MS) || 2500, WAKE_MAX_WAIT_MS = 8000;
const pend = { list: [], t: null, first: 0 };
const single = u => u.kind === 'text' ? { id: u.id, ts: u.ts, text: u.text } : { id: u.id, ts: u.ts, audio_id: u.audio_id };
function flushWake() {
  clearTimeout(pend.t); pend.t = null; const list = pend.list; pend.list = []; if (!list.length) return;
  const p = { ...single(list[0]), count: list.length, ids: list.map(u => u.id), since: list[0].ts - 1, batch: list.map(single) };
  const a = list.filter(u => u.kind === 'audio').map(u => u.audio_id); if (a.length) p.audio_ids = a;
  const t = list.filter(u => u.kind === 'text').map(u => u.text); if (t.length) { p.texts = t; if (list[0].kind === 'text' && t.length > 1) p.text_joined = t.join(' '); }
  wake(p);
}
function queueWake(u) {
  if (!pend.list.length) pend.first = Date.now();
  pend.list.push(u); clearTimeout(pend.t);
  pend.t = setTimeout(flushWake, Math.max(0, Math.min(WAKE_DEBOUNCE_MS, pend.first + WAKE_MAX_WAIT_MS - Date.now())));
}
function addUtt(u) { inbox.push(u); if (inbox.length > 50) inbox.splice(0, inbox.length - 50); broadcast('said', { id: u.id, ts: u.ts, kind: u.kind }); queueWake(u); }
app.post('/api/say', viewOk, (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'text required' });
  const u = { id: crypto.randomUUID(), ts: Date.now(), kind: 'text', text };
  addUtt(u); res.json({ ok: true, id: u.id, ts: u.ts });
});
app.post('/api/voice', viewOk, express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty audio' });
  const id = crypto.randomUUID(), ts = Date.now(), mime = String(req.get('content-type') || 'application/octet-stream').slice(0, 100);
  voices.set(id, { buf: req.body, mime, ts });
  while (voices.size > 10) voices.delete(voices.keys().next().value);
  const u = { id, ts, kind: 'audio', audio_id: id, mime, size: req.body.length };
  addUtt(u); res.json({ ok: true, id, ts });
});
app.get('/api/inbox', pushOk, (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json({ now: Date.now(), utterances: inbox.filter(u => u.ts > since).map(u => ({ ...u, audio_available: u.kind === 'audio' ? voices.has(u.id) : undefined })) });
});
app.get('/api/voice/:id', pushOk, (req, res) => {
  const v = voices.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  res.set('Content-Type', v.mime).send(v.buf);
});
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'too large' : 'bad request' }));
app.get('/api/answers', pushOk, (req, res) => res.json({ answers }));
// GET /api/latest            -> { items (history), seq, boot, missed: [] }   (backward compatible)
// GET /api/latest?after=<seq> -> missed = every logged item with seq > after (if boot changed, pass after=0)
app.get('/api/latest', viewOk, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const after = parseAfter(req.query.after);
  const stale = req.query.boot && req.query.boot !== BOOT; // server restarted: client's seq is from an old run
  res.json({ items, seq, boot: BOOT, missed: after === null ? [] : itemsAfter(stale ? 0 : after) });
});
const HB_MS = Number(process.env.SSE_HEARTBEAT_MS) || 15000;
app.get('/api/stream', viewOk, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  req.socket.setKeepAlive && req.socket.setKeepAlive(true, 10000);
  const lei = parseAfter(req.get('last-event-id')), qa = parseAfter(req.query.after);
  const after = lei !== null ? lei : qa;
  const stale = (req.query.boot && req.query.boot !== BOOT) || (after !== null && after > seq);
  res.write(`retry: 3000\nevent: init\ndata: ${JSON.stringify({ items, route: trip.route, seq, boot: BOOT })}\n\n`);
  if (after !== null) for (const it of itemsAfter(stale ? 0 : after)) res.write(sseItem(it)); // replay missed, in order
  clients.add(res);
  deliverBriefing('connect');
  const hb = setInterval(() => { try { res.write(`: hb ${Date.now()}\n\n`); } catch {} }, HB_MS);
  const bye = () => { clearInterval(hb); clients.delete(res); };
  req.on('close', bye); res.on('error', bye);
});

// ---- Tesla Fleet API ----
const T_ID = process.env.TESLA_CLIENT_ID || '', T_SECRET = process.env.TESLA_CLIENT_SECRET || '';
const T_BASE = (process.env.TESLA_AUDIENCE || 'https://fleet-api.prd.na.vn.cloud.tesla.com').replace(/\/+$/, ''); // NA + Asia-Pacific (incl. TH)
const T_AUTH = 'https://auth.tesla.com/oauth2/v3/authorize', T_TOKEN = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const T_DOMAIN = process.env.TESLA_DOMAIN || 'evae-me.onrender.com';
const T_REDIRECT = process.env.TESLA_REDIRECT_URI || `https://${T_DOMAIN}/tesla/callback`;
const T_SCOPES = process.env.TESLA_SCOPES || 'openid offline_access vehicle_device_data vehicle_location vehicle_cmds';
const tTok = { access: '', refresh: process.env.TESLA_REFRESH_TOKEN || '', exp: 0 };
const tStates = new Map(); // state -> expiry
const viewOrPush = (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (PUSH_TOKEN && m && safeEq(m[1], PUSH_TOKEN)) return next();
  return viewOk(req, res, next);
};
async function tokenReq(params) {
  const r = await fetch(T_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: T_ID, client_secret: T_SECRET, audience: T_BASE, ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('token ' + r.status + ' ' + (j.error || '')); e.status = 502; throw e; }
  return j;
}
function keep(j) { tTok.access = j.access_token; if (j.refresh_token) tTok.refresh = j.refresh_token; tTok.exp = Date.now() + ((j.expires_in || 28800) - 300) * 1000; }
let refreshing = null;
async function accessToken() {
  if (tTok.access && Date.now() < tTok.exp) return tTok.access;
  if (!tTok.refresh) { const e = new Error('not linked: visit /tesla/login'); e.status = 409; throw e; }
  refreshing = refreshing || tokenReq({ grant_type: 'refresh_token', refresh_token: tTok.refresh }).then(keep).finally(() => { refreshing = null; });
  await refreshing; return tTok.access;
}
async function fleet(pathq, retry = true) {
  const r = await fetch(T_BASE + pathq, { headers: { Authorization: 'Bearer ' + await accessToken() } });
  if (r.status === 401 && retry && tTok.refresh) { tTok.exp = 0; return fleet(pathq, false); }
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
const tErr = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });
app.get('/.well-known/appspecific/com.tesla.3p.public-key.pem', (req, res) => {
  const f = [path.join(__dirname, 'com.tesla.3p.public-key.pem'), path.join(PUB, 'com.tesla.3p.public-key.pem')].find(x => fs.existsSync(x));
  if (!f) return res.status(404).send('missing');
  res.type('application/x-pem-file').send(fs.readFileSync(f));
});
app.get('/tesla/login', viewOrPush, (req, res) => {
  if (!T_ID) return res.status(500).send('TESLA_CLIENT_ID not set');
  const state = crypto.randomBytes(16).toString('hex'); tStates.set(state, Date.now() + 600000);
  for (const [k, v] of tStates) if (v < Date.now()) tStates.delete(k);
  const q = new URLSearchParams({ response_type: 'code', client_id: T_ID, redirect_uri: T_REDIRECT, scope: T_SCOPES, state, locale: 'en-US', prompt: 'login', prompt_missing_scopes: 'true' });
  res.redirect(T_AUTH + '?' + q);
});
// Native app leg of the OAuth dance. The iPhone generates a state prefixed "app:"
// and validates it itself, so there is nothing to look up here: hand the code
// straight back to the app's custom scheme. The code is single-use and useless
// without PUSH_TOKEN at /tesla/exchange.
app.get('/tesla/callback', (req, res, next) => {
  const st = String(req.query.state || '');
  if (!st.startsWith('app:')) return next();
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
  const q = new URLSearchParams({ state: st });
  if (typeof req.query.code === 'string') q.set('code', req.query.code);
  if (typeof req.query.error === 'string') q.set('error', req.query.error);
  res.redirect(302, 'eveme://auth?' + q);
});
app.get('/tesla/callback', viewOk, async (req, res) => {
  const { code, state, error } = req.query;
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
  if (error) return res.status(400).send('Tesla returned: ' + String(error).replace(/[<>&]/g, ''));
  const exp = tStates.get(state); tStates.delete(state);
  if (!exp || exp < Date.now() || typeof code !== 'string') return res.status(400).send('Invalid or expired state. Start again at /tesla/login');
  try {
    const j = await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: T_REDIRECT }); keep(j);
    const rt = String(tTok.refresh).replace(/[<>&"]/g, '');
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Tesla linked</title><body style="font:18px system-ui;background:#07080a;color:#eee;padding:40px;max-width:900px">
<h1 style="color:#8B5CF6">✓ Tesla account linked</h1><p>Tokens are in memory now. Render's free tier forgets them on restart, so copy the refresh token below into the Render env var <b>TESLA_REFRESH_TOKEN</b> (Dashboard → Environment), then save. Don't share it.</p>
<textarea readonly style="width:100%;height:140px;background:#111;color:#C4B5FD;border:1px solid #8B5CF6;border-radius:8px;padding:12px;font:14px monospace" onclick="this.select()">${rt}</textarea>
<p style="color:#888">Note: Tesla rotates refresh tokens on use. If the server restarts long after, it still works from the env value; if it ever fails, just visit /tesla/login again.</p></body>`);
  } catch (e) { res.status(502).send('Token exchange failed: ' + String(e.message).replace(/[<>&]/g, '')); }
});
app.post('/tesla/register', pushOk, async (req, res) => {
  try {
    const p = await tokenReq({ grant_type: 'client_credentials', scope: 'openid vehicle_device_data vehicle_location' });
    const r = await fetch(T_BASE + '/api/1/partner_accounts', { method: 'POST', headers: { Authorization: 'Bearer ' + p.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: T_DOMAIN }) });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch (e) { tErr(res, e); }
});
async function listVehicles() { const { status, j } = await fleet('/api/1/vehicles'); if (status !== 200) { const e = new Error('vehicles ' + status); e.status = status; throw e; } return j.response || []; }
// ---- Native app support ----
// Everything the phone needs that is not a secret. It then talks to Tesla direct.
app.get('/tesla/app-config', pushOk, (req, res) => {
  if (!T_ID) return res.status(500).json({ error: 'TESLA_CLIENT_ID not set' });
  res.set('Cache-Control', 'no-store');
  res.json({ clientID: T_ID, audience: T_BASE, redirectURI: T_REDIRECT, scopes: T_SCOPES });
});
// The one call that needs client_secret: Tesla documents no PKCE public-client
// flow, so the authorization_code exchange goes through here. Tesla's response is
// passed back untouched and NOT kept on the server - the phone owns the tokens and
// rotates the refresh token itself (that grant needs no secret), which is what
// stops the refresh token going stale in an env var.
app.post('/tesla/exchange', pushOk, async (req, res) => {
  const code = (req.body || {}).code;
  if (typeof code !== 'string' || !code) return res.status(400).json({ error: 'code required' });
  res.set('Cache-Control', 'no-store');
  try {
    const j = await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: T_REDIRECT });
    res.json({ access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in });
  } catch (e) { tErr(res, e); }
});
app.get('/api/tesla/vehicles', pushOk, async (req, res) => {
  try { res.json({ vehicles: (await listVehicles()).map(v => ({ id: v.id, vin: v.vin, name: v.display_name, state: v.state })) }); } catch (e) { tErr(res, e); }
});
const MI = 1.609344, r1 = x => x == null ? null : Math.round(x * 10) / 10;
function condense(v, d) {
  const ds = d.drive_state || {}, cs = d.charge_state || {}, cl = d.climate_state || {}, vs = d.vehicle_state || {};
  return {
    state: d.state || v.state, shift_state: ds.shift_state ?? null,
    speed: ds.speed == null ? null : Math.round(ds.speed * MI), // km/h (Tesla reports mph)
    lat: ds.latitude ?? null, lng: ds.longitude ?? null, heading: ds.heading ?? null,
    battery_level: cs.battery_level ?? null, battery_range: cs.battery_range == null ? null : Math.round(cs.battery_range * MI),
    charging_state: cs.charging_state ?? null, charge_limit_soc: cs.charge_limit_soc ?? null,
    minutes_to_full_charge: cs.minutes_to_full_charge ?? null, charger_power: cs.charger_power ?? null,
    inside_temp: r1(cl.inside_temp), outside_temp: r1(cl.outside_temp), is_climate_on: cl.is_climate_on ?? null,
    media_playing: vs.media_info ? /^play/i.test(String(vs.media_info.media_playback_status || '')) : null,
    locked: vs.locked ?? null, sentry_mode: vs.sentry_mode ?? null,
    doors: { df: !!vs.df, dr: !!vs.dr, pf: !!vs.pf, pr: !!vs.pr }, ft: !!vs.ft, rt: !!vs.rt,
    windows: { fd: !!vs.fd_window, fp: !!vs.fp_window, rd: !!vs.rd_window, rp: !!vs.rp_window },
    odometer: vs.odometer == null ? null : Math.round(vs.odometer * MI),
    tpms_pressure_fl: r1(vs.tpms_pressure_fl), tpms_pressure_fr: r1(vs.tpms_pressure_fr), tpms_pressure_rl: r1(vs.tpms_pressure_rl), tpms_pressure_rr: r1(vs.tpms_pressure_rr),
    route: routeOf(ds),
    ts: ds.timestamp || cs.timestamp || vs.timestamp || Date.now(),
  };
}
function routeOf(ds) { // Tesla nav: active route fields live in drive_state (location_data scope)
  const dest = ds.active_route_destination, min = ds.active_route_minutes_to_arrival;
  if (!dest || min == null || !(Number(min) >= 0)) return null;
  return { destination: String(dest).slice(0, 120), minutes: Math.round(Number(min) * 10) / 10,
    km: ds.active_route_miles_to_arrival == null ? null : r1(ds.active_route_miles_to_arrival * MI),
    delay_min: ds.active_route_traffic_minutes_delay == null ? 0 : Math.round(Number(ds.active_route_traffic_minutes_delay)),
    lat: ds.active_route_latitude ?? null, lng: ds.active_route_longitude ?? null, ts: Date.now() };
}
const ENDPOINTS = 'charge_state;climate_state;vehicle_state;drive_state;location_data';
const MOCK_VD = process.env.MOCK_VEHICLE_FILE || '';
async function readCar(vin) {
  const vs = MOCK_VD ? [{ state: 'online' }] : await listVehicles();
  const v = vs.find(x => vin ? x.vin === vin : true);
  if (!v) { const e = new Error('no vehicle'); e.status = 404; throw e; }
  if (MOCK_VD) { const d = JSON.parse(fs.readFileSync(MOCK_VD, 'utf8')); return d.state && d.state !== 'online' ? { state: d.state } : condense({ state: 'online' }, d); } // local testing only
  if (v.state !== 'online') return { state: v.state === 'offline' ? 'offline' : 'asleep' }; // never wake the car
  const { status, j } = await fleet(`/api/1/vehicles/${encodeURIComponent(v.vin || v.id)}/vehicle_data?endpoints=${encodeURIComponent(ENDPOINTS)}`);
  if (status === 408) return { state: 'asleep' };
  if (status !== 200) { const e = new Error('vehicle_data ' + status); e.status = status; throw e; }
  return condense(v, j.response || {});
}
app.get('/api/tesla/scopes', pushOk, async (req, res) => {
  try {
    const t = await accessToken();
    const c = JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString());
    res.json({ scopes: c.scp || c.scope || null, expires: c.exp ? new Date(c.exp * 1000).toISOString() : null, refresh_tail: (tTok.refresh || '').slice(-4) });
  } catch (e) { tErr(res, e); }
});
app.get('/api/tesla/state', pushOk, async (req, res) => {
  try { res.json(await readCar(req.query.vin)); } catch (e) { tErr(res, e); }
});
// ---- /api/car: cached, refreshed at most every 60s while someone asks ----
const car = { last: null, at: 0, inflight: null, err: null };
function carHooks(prev, cur) {
  if (!prev || cur.state !== 'online') return;
  if (cur.battery_level != null && cur.battery_level < 20 && !(prev.battery_level < 20) && cur.charging_state !== 'Charging')
    hook('lowbatt', `แบตเหลือ ${cur.battery_level}% แล้วนะ หาที่ชาร์จกันไหม`);
  if (cur.charging_state === 'Complete' && prev.charging_state === 'Charging') hook('charged', `ชาร์จเต็มแล้ว ${cur.battery_level}% วิ่งได้ประมาณ ${cur.battery_range} กิโล`);
  const tw = tyreWarn(cur), pw = tyreWarn(prev); if (tw && !pw) hook('tyre', `ระวังนะ ยาง ${tw.pos} ลมเหลือ ${tw.bar} บาร์`);
  const opn = c => Object.values(c.doors || {}).some(Boolean) || c.ft || c.rt || Object.values(c.windows || {}).some(Boolean);
  const op = c => c.locked && c.shift_state !== 'D' && c.shift_state !== 'R' && opn(c);
  if (op(cur) && !op(prev)) hook('lockdoor', 'ล็อกรถแล้วแต่ยังมีประตูหรือกระจกเปิดอยู่นะ');
  const parkedUnl = cur.locked === false && (!cur.shift_state || cur.shift_state === 'P');
  if (!parkedUnl) car.unlSince = 0; else { car.unlSince = car.unlSince || Date.now(); if (Date.now() - car.unlSince > 5 * 60000) hook('unlocked', 'จอดรถไว้แต่ยังไม่ได้ล็อกนะ'); }
}
function tyreWarn(c) {
  const t = { FL: c.tpms_pressure_fl, FR: c.tpms_pressure_fr, RL: c.tpms_pressure_rl, RR: c.tpms_pressure_rr }, ks = Object.keys(t).filter(k => t[k] != null);
  for (const k of ks) { const others = ks.filter(o => o !== k).map(o => t[o]); const avg = others.reduce((a, b) => a + b, 0) / (others.length || 1);
    if (t[k] < 2.6 || (others.length && Math.abs(t[k] - avg) > 0.3)) return { pos: k, bar: t[k] }; }
  return null;
}
const hookAt = {};
function hook(key, text) { // debounce: one per kind per 30 min
  if (Date.now() - (hookAt[key] || 0) < 30 * 60000) return; hookAt[key] = Date.now();
  const item = { id: crypto.randomUUID(), ts: Date.now(), type: 'reply', title: '', body: text, meta: { car: key }, speak: true };
  items.unshift(item); items.length = Math.min(items.length, MAX); emitItem(item);
}
async function refreshCar() {
  try {
    const cur = await readCar();
    if (cur.state === 'online' && !(car.last && car.last.state === 'online')) setImmediate(() => deliverBriefing('awake'));
    if (cur.state === 'online') { carHooks(car.last && car.last.state === 'online' ? car.last : (car.last && car.last.known), cur); car.last = cur; car.known = cur; }
    else car.last = { state: cur.state, known: car.known || null, known_ts: car.known ? car.known.ts : null, ts: Date.now() };
    car.err = null;
    routeTick(cur.state === 'online' ? cur.route : null, cur.state === 'online');
  } catch (e) { car.err = { status: e.status || 500, error: String(e.message || e) }; }
  car.at = Date.now();
}
app.get('/api/car', viewOrPush, async (req, res) => {
  if (Date.now() - car.at > (routeFast() ? 30000 : 60000)) { car.inflight = car.inflight || refreshCar().finally(() => { car.inflight = null; }); if (!car.last) await car.inflight; }
  if (!car.last) return res.status(car.err ? car.err.status : 503).json(car.err || { error: 'no data' });
  res.json({ ...car.last, stale_error: car.err ? car.err.error : undefined });
});

// ---- Navigation ETA: per-trip voice alerts + faster poll only while driving a route ----
const trip = { dest: null, minDelay: null, said: new Set(), route: null };
const routeFast = () => { const c = car.last; return !!(c && c.state === 'online' && c.route && (c.shift_state === 'D' || c.shift_state === 'R' || c.speed > 0)); };
function routeSay(key, text, title, detail) {
  if (trip.said.has(key)) return; trip.said.add(key);
  const item = { id: crypto.randomUUID(), ts: Date.now(), type: 'reply', title: '', body: text, speak: true,
    meta: { car: 'route_' + key, alert: { kind: 'route', title: title || text, detail: detail || '', until: Date.now() + 10 * 60000, event_id: 'route-' + key } } };
  items.unshift(item); items.length = Math.min(items.length, MAX); emitItem(item);
}
const normLoc = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function locMatch(a, b) {
  a = normLoc(a); b = normLoc(b); if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const wa = a.split(' ').filter(w => w.length >= 3), wb = new Set(b.split(' ').filter(w => w.length >= 3));
  return wa.some(w => wb.has(w));
}
function routeTick(r, online, now = Date.now()) {
  if (!r) { // route ended (or car not online): reset trip, hide ETA
    if (trip.route) broadcast('route', null);
    if (!online || trip.route) { trip.dest = null; trip.minDelay = null; trip.said.clear(); }
    trip.route = null; return;
  }
  if (r.destination !== trip.dest) { trip.dest = r.destination; trip.minDelay = null; trip.said.clear(); }
  trip.route = r; broadcast('route', r);
  const d = r.delay_min || 0;
  if (trip.minDelay == null || d < trip.minDelay) trip.minDelay = d;
  if (r.minutes <= 10.5 && r.minutes >= 1) routeSay('eta10', `อีก 10 นาทีถึง${r.destination}`, `อีก ${Math.round(r.minutes)} นาที · ${r.destination}`);
  const grow = d - trip.minDelay;
  if (grow >= 10) routeSay('traffic', `รถติดเพิ่ม ${grow} นาที`, `รถติดเพิ่ม ${grow} นาที`, r.destination);
  const arrive = now + r.minutes * 60000;
  const evs = calendar.map(e => ({ e, t: Date.parse(e.start) })).filter(x => Number.isFinite(x.t) && x.t > now - 15 * 60000).sort((a, b) => a.t - b.t);
  const ev = evs.find(x => locMatch(x.e.location, r.destination)) || evs.find(x => x.t <= now + 3 * 3600000);
  if (ev) {
    const cut = ev.t - (CAL_LONG.has(String(ev.e.kind || '').toLowerCase()) ? 15 * 60000 : 0);
    if (arrive > cut) routeSay('late:' + ev.e.id, `อาจไปไม่ทัน${ev.e.title}`, `อาจไปไม่ทัน ${ev.e.title}`, `ถึง ${bkkHM(arrive)} · เริ่ม ${bkkHM(ev.t)}`);
  }
}
setInterval(() => { if (routeFast() && Date.now() - car.at >= 30000 && !car.inflight) car.inflight = refreshCar().finally(() => { car.inflight = null; }); }, 10000).unref(); // only re-reads while already online+driving a route; readCar never wakes

// ---- OpenAI text-to-speech ----
const OA_KEY = process.env.OPENAI_API_KEY || '';
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICES = ['marin', 'cedar', 'coral', 'nova', 'shimmer', 'sage', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'onyx', 'verse'];
const TTS_VOICE = TTS_VOICES.includes(process.env.OPENAI_TTS_VOICE) ? process.env.OPENAI_TTS_VOICE : 'marin';
const TTS_INSTR = 'Speak Thai naturally, warm, friendly, concise, like a calm in-car companion.';
const ttsCache = new Map(); // LRU: key -> Buffer
app.get('/api/tts/status', viewOrPush, (req, res) => res.json({ enabled: !!OA_KEY, model: TTS_MODEL, voice: TTS_VOICE, voices: TTS_VOICES }));
app.post('/api/tts', viewOrPush, async (req, res) => {
  if (!OA_KEY) return res.status(501).json({ error: 'tts not configured' });
  const text = String((req.body || {}).text || '').trim().slice(0, 600);
  if (!text) return res.status(400).json({ error: 'text required' });
  const voice = TTS_VOICES.includes((req.body || {}).voice) ? req.body.voice : TTS_VOICE;
  let speed = Number((req.body || {}).speed); speed = speed >= 0.25 && speed <= 4 ? Math.round(speed * 10) / 10 : 1;
  const key = voice + '|' + speed + '|' + text;
  let buf = ttsCache.get(key);
  if (buf) { ttsCache.delete(key); ttsCache.set(key, buf); }
  else {
    try {
      const body = { model: TTS_MODEL, input: text, voice, response_format: 'mp3', speed };
      if (!/^tts-1/.test(TTS_MODEL)) body.instructions = TTS_INSTR;
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 11000);
      const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + OA_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal }).finally(() => clearTimeout(t));
      if (!r.ok) { const j = await r.json().catch(() => ({})); const msg = String((j.error && j.error.message) || '').slice(0, 160); console.log('tts failed', r.status); return res.status(r.status === 429 ? 429 : 502).json({ error: 'tts upstream ' + r.status, detail: msg }); }
      buf = Buffer.from(await r.arrayBuffer());
      ttsCache.set(key, buf); while (ttsCache.size > 50) ttsCache.delete(ttsCache.keys().next().value);
    } catch (e) { const to = e && e.name === 'AbortError'; console.log(to ? 'tts timeout' : 'tts error'); return res.status(to ? 504 : 502).json({ error: to ? 'tts timeout' : 'tts error' }); }
  }
  res.set('Cache-Control', 'private, max-age=86400').type('audio/mpeg').send(buf);
});

// ---- Vehicle commands ----
// Signed (Vehicle Command Protocol) commands go through tesla-http-proxy (TESLA_PROXY_URL, run beside this app in the Docker image).
// navigation_* are not part of the signed protocol and go straight to Fleet REST (Tesla's proxy returns "requires using the REST API").
const CMD_REST = new Set(['navigation_request', 'navigation_gps_request', 'navigation_sc_request']);
const CMD_SIGNED = new Set(['media_toggle_playback', 'media_next_track', 'media_prev_track', 'media_volume_up', 'media_volume_down',
  'auto_conditioning_start', 'auto_conditioning_stop', 'set_temps', 'flash_lights', 'door_lock', 'actuate_trunk', 'window_control']);
// door_unlock and remote_start are deliberately absent. Locking a car by mistake costs nothing;
// unlocking it by mistake leaves it open.
const PROXY = (process.env.TESLA_PROXY_URL || '').replace(/\/+$/, '');
const PROXY_CA = process.env.TESLA_PROXY_CA || '';
const https = require('https');
function proxyPost(pathq, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(PROXY + pathq), data = JSON.stringify(body || {});
    const req = https.request(u, { method: 'POST', ca: PROXY_CA && fs.existsSync(PROXY_CA) ? fs.readFileSync(PROXY_CA) : undefined, timeout: 30000,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch { j = { raw: b.slice(0, 200) }; } resolve({ status: r.statusCode, j }); });
    });
    req.on('timeout', () => req.destroy(new Error('proxy timeout'))); req.on('error', reject); req.end(data);
  });
}
function cleanBody(name, b) {
  b = b && typeof b === 'object' ? b : {};
  const num = (x, lo, hi) => { const n = Number(x); if (!Number.isFinite(n) || n < lo || n > hi) { const e = new Error('bad ' + name + ' params'); e.status = 400; throw e; } return n; };
  if (name === 'navigation_request') { const v = String(b.value || b.text || '').trim().slice(0, 300); if (!v) { const e = new Error('value required'); e.status = 400; throw e; }
    return { type: 'share_ext_content_raw', locale: b.locale || 'th-TH', timestamp_ms: String(Date.now()), value: { 'android.intent.extra.TEXT': v } }; }
  if (name === 'navigation_gps_request') return { lat: num(b.lat, -90, 90), lon: num(b.lon ?? b.lng, -180, 180), order: 0 };
  if (name === 'navigation_sc_request') return { id: b.id ? Number(b.id) : 0, order: 0 };
  if (name === 'set_temps') return { driver_temp: num(b.driver_temp, 15, 28), passenger_temp: num(b.passenger_temp ?? b.driver_temp, 15, 28) };
  // Tesla takes which boot to actuate, and vent/close plus a position for the
  // windows. Anything else is refused rather than passed through blindly.
  if (name === 'actuate_trunk') { const w = b.which_trunk === 'front' ? 'front' : 'rear'; return { which_trunk: w }; }
  if (name === 'window_control') {
    const c = b.command === 'vent' ? 'vent' : b.command === 'close' ? 'close' : null;
    if (!c) { const e = new Error('command must be vent or close'); e.status = 400; throw e; }
    return { command: c, lat: Number(b.lat) || 0, lon: Number(b.lon) || 0 };
  }
  return {};
}
async function listVehiclesWith(token) {
  const r = await fetch(T_BASE + '/api/1/vehicles', { headers: { Authorization: 'Bearer ' + token } });
  if (r.status !== 200) { const e = new Error('vehicles ' + r.status); e.status = r.status; throw e; }
  const j = await r.json().catch(() => ({}));
  return j.response || [];
}
async function wakeAndWait(v, token) {
  // Uses the caller's token when the phone supplied one, so a stale
  // TESLA_REFRESH_TOKEN on this server cannot block a command any more.
  const bearer = async () => token || await accessToken();
  if (v.state === 'online') return;
  await fetch(T_BASE + `/api/1/vehicles/${encodeURIComponent(v.vin || v.id)}/wake_up`, { method: 'POST', headers: { Authorization: 'Bearer ' + await bearer() } });
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const vs = token ? await listVehiclesWith(token) : await listVehicles();
    const x = vs.find(y => y.vin === v.vin); if (x && x.state === 'online') return;
  }
  const e = new Error('car did not wake'); e.status = 504; throw e;
}
async function runCommand(name, rawBody, vin, opts = {}) {
  const token = opts.teslaToken || null; // supplied by the phone; falls back to this server's own
  if (!CMD_REST.has(name) && !CMD_SIGNED.has(name)) { const e = new Error('command not allowed'); e.status = 403; throw e; }
  const body = cleanBody(name, rawBody);
  if (CMD_SIGNED.has(name) && !PROXY) { const e = new Error('signing proxy not configured (TESLA_PROXY_URL)'); e.status = 501; throw e; }
  const vs = token ? await listVehiclesWith(token) : await listVehicles(); const v = vs.find(x => vin ? x.vin === vin : true);
  if (!v) { const e = new Error('no vehicle'); e.status = 404; throw e; }
  if (opts.noWake && v.state !== 'online') { const e = new Error('car not online'); e.status = 409; throw e; }
  await wakeAndWait(v, token); // commands only; reads never wake
  const pathq = `/api/1/vehicles/${encodeURIComponent(v.vin)}/command/${name}`;
  let out;
  if (CMD_REST.has(name)) {
    const r = await fetch(T_BASE + pathq, { method: 'POST', headers: { Authorization: 'Bearer ' + (token || await accessToken()), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    out = { status: r.status, j: await r.json().catch(() => ({})) };
  } else out = await proxyPost(pathq, token || await accessToken(), body);
  console.log('tesla command', name, out.status);
  return out;
}
app.post('/api/tesla/command/:name', pushOk, async (req, res) => {
  // X-Tesla-Token lets the phone sign in as itself; this server then only lends
  // its private key for the signing step.
  const m = /^Bearer (.+)$/.exec(req.get('x-tesla-token') || '');
  const teslaToken = m ? m[1] : (req.get('x-tesla-token') || null);
  try { const out = await runCommand(req.params.name, req.body, req.query.vin, { teslaToken }); res.status(out.status).json(out.j); } catch (e) { tErr(res, e); }
});
// ---- Voice ducking: pause car media while the wake-word conversation runs, resume only if we paused it ----
// Authorized by the page's view key; only ever sends media_toggle_playback; never wakes the car; rate-limited; auto-resume safety.
const duck = { paused: false, at: 0, hits: [], timer: null, busy: false };
const DUCK_MAX_MS = 150000;
async function duckResume(why) {
  clearTimeout(duck.timer); duck.timer = null;
  if (!duck.paused) return { ok: true, resumed: false };
  duck.paused = false;
  const out = await runCommand('media_toggle_playback', {}, null, { noWake: true });
  console.log('voice duck resume', why, out.status);
  if (car.last) car.last.media_playing = out.status < 300 ? true : car.last.media_playing;
  return { ok: out.status < 300, resumed: out.status < 300 };
}
app.post('/api/voice/duck', viewOk, async (req, res) => {
  const action = req.body && req.body.action;
  if (action !== 'pause' && action !== 'resume') return res.status(400).json({ error: 'action must be pause|resume' });
  const now = Date.now(); duck.hits = duck.hits.filter(t => now - t < 60000);
  if (duck.hits.length >= 8) return res.status(429).json({ error: 'rate limited' });
  duck.hits.push(now);
  if (duck.busy) return res.status(409).json({ error: 'busy' });
  duck.busy = true;
  try {
    if (action === 'resume') return res.json(await duckResume('client'));
    if (duck.paused) return res.json({ ok: true, paused: true, already: true });
    const c = car.last;
    if (!c || c.state !== 'online' || now - car.at > 120000) return res.json({ ok: true, paused: false, reason: 'car state unknown/asleep' });
    if (c.media_playing !== true) return res.json({ ok: true, paused: false, reason: c.media_playing === false ? 'not playing' : 'media state unavailable' });
    const out = await runCommand('media_toggle_playback', {}, null, { noWake: true });
    if (out.status >= 300) return res.status(502).json({ ok: false, paused: false, error: 'command ' + out.status });
    duck.paused = true; duck.at = now; c.media_playing = false;
    duck.timer = setTimeout(() => duckResume('timeout').catch(e => console.log('duck auto-resume failed', e.message)), DUCK_MAX_MS);
    console.log('voice duck pause');
    res.json({ ok: true, paused: true });
  } catch (e) { tErr(res, e); } finally { duck.busy = false; }
});
// ---- Calendar ----
let calendar = [];
const calFired = new Set();
const CAL_LONG = new Set(['flight', 'checkin', 'check-in', 'check_in']);
const leadMin = ev => Number(ev.lead_min) > 0 ? Number(ev.lead_min) : CAL_LONG.has(String(ev.kind || '').toLowerCase()) ? 150 : 60;
function fmtIn(min) { if (min < 60) return `อีก ${min} นาที`; const h = Math.floor(min / 60), m = min % 60; return `อีก ${h} ชม.` + (m >= 10 ? ` ${m} นาที` : ''); }
function calTick(now = Date.now()) {
  for (const ev of calendar) {
    const t = Date.parse(ev.start); if (!Number.isFinite(t)) continue;
    const key = ev.id + '|' + t, until = t - now;
    if (until <= 0 || until > leadMin(ev) * 60000 || calFired.has(key)) continue;
    calFired.add(key);
    const min = Math.max(1, Math.round(until / 60000));
    const what = CAL_LONG.has(String(ev.kind || '').toLowerCase()) ? (/flight/i.test(ev.kind) ? 'เที่ยวบิน' : 'เช็กอิน') : 'นัด';
    const body = `${fmtIn(min)} มี${what} ${ev.title}` + (ev.location ? ` ที่ ${ev.location} ให้ EvE นำทางไหม` : '');
    const item = { id: crypto.randomUUID(), ts: now, type: 'reply', title: '', body, speak: true,
      meta: { alert: { kind: 'calendar', title: `${fmtIn(min)} · ${ev.title}`, detail: ev.location || new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }), until: t, event_id: ev.id, event_title: ev.title, location: ev.location || null } } };
    items.unshift(item); items.length = Math.min(items.length, MAX); emitItem(item);
  }
  for (const k of calFired) if (Number(k.split('|').pop()) < now - 86400000) calFired.delete(k);
}
setInterval(() => calTick(), 60000).unref();
app.post('/api/calendar', pushOk, (req, res) => {
  const evs = (req.body || {}).events;
  if (!Array.isArray(evs)) return res.status(400).json({ error: 'events[] required' });
  calendar = evs.slice(0, 200).filter(e => e && e.id && e.title && e.start).map(e => ({ id: String(e.id).slice(0, 200), title: String(e.title).slice(0, 200), start: String(e.start), end: e.end ? String(e.end) : null,
    location: e.location ? String(e.location).slice(0, 300) : null, kind: e.kind ? String(e.kind).slice(0, 30) : null, lead_min: e.lead_min }));
  calTick(Number(req.query.now) && process.env.CAL_TEST ? Number(req.query.now) : Date.now());
  res.json({ ok: true, count: calendar.length });
});
app.get('/api/calendar', viewOrPush, (req, res) => res.json({ events: calendar }));

// ---- Today agenda (type "agenda") ----
const BKK = { timeZone: 'Asia/Bangkok' };
const bkkDay = t => new Date(t).toLocaleDateString('en-CA', BKK);
const bkkHM = t => new Date(t).toLocaleTimeString('en-GB', { ...BKK, hour: '2-digit', minute: '2-digit' });
function todayFromCalendar(now = Date.now()) {
  const d = bkkDay(now);
  return calendar.filter(e => Number.isFinite(Date.parse(e.start)) && bkkDay(Date.parse(e.start)) === d)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map(e => ({ time: bkkHM(Date.parse(e.start)), title: e.title, location: e.location || null }));
}
function pushAgenda(req, res) {
  const b = req.body || {};
  let evs = Array.isArray(b.events) ? b.events.slice(0, 50).map(e => ({
    time: e.time ? String(e.time).slice(0, 10) : (Number.isFinite(Date.parse(e.start)) ? bkkHM(Date.parse(e.start)) : ''),
    title: String(e.title || '').slice(0, 120), location: e.location ? String(e.location).slice(0, 120) : null })).filter(e => e.title)
    : todayFromCalendar();
  const first = evs[0];
  const text = b.text ? String(b.text).slice(0, 600) : !evs.length ? 'วันนี้ว่าง ไม่มีนัดเลย'
    : `วันนี้มี ${evs.length} นัด เริ่ม ${first.time} ${first.title}` + (evs.length > 1 ? ` ถัดไป ${evs[1].time} ${evs[1].title}` : '');
  const item = { id: crypto.randomUUID(), ts: Date.now(), type: 'agenda', title: 'วันนี้', body: text, meta: { events: evs }, speak: b.speak !== false };
  emitItem(item); // transient: not stored in the history list
  res.json({ ok: true, id: item.id, seq: item.seq, count: evs.length, clients: clients.size, queued: true });
}
// ---- Morning briefing (type "briefing"): held in memory, shown once per Bangkok date ----
const briefings = new Map(); // date -> { b, shown, shown_at }
const clip = (v, n) => v == null || v === '' ? null : String(v).slice(0, n);
function pushBriefing(req, res) {
  const b = req.body || {}, today = bkkDay(Date.now());
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today;
  const sl = Number(b.sleep_h);
  const rd = b.readiness == null || b.readiness === '' ? null : (Number.isFinite(Number(b.readiness)) ? Math.max(0, Math.min(100, Math.round(Number(b.readiness)))) : clip(b.readiness, 24));
  const br = { date, sleep_h: Number.isFinite(sl) && sl >= 0 && sl <= 24 ? Math.round(sl * 10) / 10 : null, readiness: rd,
    duty: clip(b.duty, 80), tip: clip(b.tip, 160), speak: clip(b.speak, 300), received_at: Date.now() };
  briefings.set(date, { b: br, shown: false, shown_at: null });
  for (const k of briefings.keys()) if (k < bkkDay(Date.now() - 3 * 864e5)) briefings.delete(k);
  res.json({ ok: true });
  if (date === today) setImmediate(() => { if (clients.size && car.last && car.last.state === 'online') deliverBriefing('push'); });
}
function briefingText(b) {
  if (b.speak) return b.speak;
  const p = ['อรุณสวัสดิ์'];
  if (b.sleep_h != null) p.push(`เมื่อคืนนอนได้ ${b.sleep_h} ชั่วโมง`);
  if (b.readiness != null) p.push(`ความพร้อม ${b.readiness}${typeof b.readiness === 'number' ? ' เปอร์เซ็นต์' : ''}`);
  if (b.duty) p.push(`วันนี้ ${b.duty}`);
  if (b.tip) p.push(b.tip);
  return p.join(' ');
}
function deliverBriefing(why) {
  const e = briefings.get(bkkDay(Date.now()));
  if (!e || e.shown || !clients.size) return false;
  const b = e.b, item = { id: crypto.randomUUID(), ts: Date.now(), type: 'briefing', title: '', body: briefingText(b), speak: true,
    meta: { briefing: { sleep_h: b.sleep_h, readiness: b.readiness, duty: b.duty, tip: b.tip }, compact: routeFast() || !!trip.route } };
  const sent = emitItem(item);
  if (sent) { e.shown = true; e.shown_at = Date.now(); console.log(`[briefing] ${b.date} shown (${why}) to ${sent}`); }
  return !!sent;
}
app.get('/api/briefing', pushOk, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : bkkDay(Date.now()), e = briefings.get(date);
  res.json({ date, briefing: e ? e.b : null, shown: e ? e.shown : false, shown_at: e && e.shown_at ? new Date(e.shown_at).toISOString() : null });
});
app.get('/', viewOk, (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get('/eve-blob-white.svg', (req, res) => res.sendFile(path.join(PUB, 'eve-blob-white.svg')));
setInterval(() => pruneLog(), 60000).unref();
app.listen(PORT, () => console.log(`EvE Me on :${PORT}`));
