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
const broadcast = (event, obj) => { const d = `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`; for (const c of clients) c.write(d); };

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.post('/api/push', pushOk, (req, res) => {
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
  broadcast('item', item);
  res.json({ ok: true, id: item.id, clients: clients.size });
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
function wake(payload) {
  if (!WAKE || typeof fetch !== 'function') return;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000);
  fetch(WAKE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ac.signal })
    .catch(() => console.log('wake webhook failed')).finally(() => clearTimeout(t)); // never logs the text
}
function addUtt(u) { inbox.push(u); if (inbox.length > 50) inbox.splice(0, inbox.length - 50); broadcast('said', { id: u.id, ts: u.ts, kind: u.kind }); wake(u.kind === 'text' ? { id: u.id, ts: u.ts, text: u.text } : { id: u.id, ts: u.ts, audio_id: u.audio_id }); }
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
  while (voices.size > 5) voices.delete(voices.keys().next().value);
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
app.get('/api/latest', viewOk, (req, res) => res.json({ items }));
app.get('/api/stream', viewOk, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`retry: 3000\nevent: init\ndata: ${JSON.stringify({ items })}\n\n`);
  clients.add(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
});
app.get('/', viewOk, (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get('/eve-blob-white.svg', (req, res) => res.sendFile(path.join(PUB, 'eve-blob-white.svg')));
app.listen(PORT, () => console.log(`EvE Me on :${PORT}`));
