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
  const { type = 'message', title = '', text = '', body = '', meta = {}, options } = req.body || {};
  if (!['message', 'card', 'flight', 'question'].includes(type)) return res.status(400).json({ error: 'bad type' });
  const item = { id: crypto.randomUUID(), ts: Date.now(), type, title: String(title || (type === 'question' ? text : '')).slice(0, 300), body: String(body || (type !== 'question' ? text : '')).slice(0, 4000), meta: typeof meta === 'object' && meta ? meta : {} };
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
  lastLoc = { lat, lng, accuracy: num(b.accuracy, 0, 1e6), speed: num(b.speed, 0, 1000), heading: num(b.heading, 0, 360), ts: num(b.ts, 0, 1e14) || Date.now(), received: Date.now() };
  res.json({ ok: true });
});
app.get('/api/location', pushOk, (req, res) => {
  if (!lastLoc) return res.status(404).json({ error: 'no location yet' });
  res.json({ ...lastLoc, age_s: Math.round((Date.now() - lastLoc.ts) / 1000) });
});
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
