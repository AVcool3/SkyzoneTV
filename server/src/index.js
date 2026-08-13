import express from 'express';
import multer from 'multer';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { parseEventsCsv, matchMedia } from './csv.js';
import { startScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PORT = parseInt(process.env.PORT || '8080', 10);

fs.mkdirSync(MEDIA_DIR, { recursive: true });
const store = new Store(path.join(DATA_DIR, 'db.json'));

// Dashboard password: the ADMIN_PASSWORD env var wins; otherwise generate one
// on first boot and keep it (no well-known default a Wi-Fi guest could try).
// It is printed on the server console at every startup.
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  if (!store.data.settings.adminPassword) {
    store.data.settings.adminPassword = crypto.randomBytes(4).toString('hex');
    store.saveNow();
  }
  ADMIN_PASSWORD = store.data.settings.adminPassword;
}

// ---------------------------------------------------------------------------
// Auth (dashboard only; players are unauthenticated on the local network)
// ---------------------------------------------------------------------------
function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  const tokens = store.data.settings.tokens;
  tokens.push(token);
  while (tokens.length > 20) tokens.shift();
  store.save();
  return token;
}
function validToken(token) {
  return !!token && store.data.settings.tokens.includes(token);
}
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!validToken(token)) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ---------------------------------------------------------------------------
// State snapshots
// ---------------------------------------------------------------------------
const playerSockets = new Map();     // tvId -> Set<ws>
const dashboardSockets = new Set();  // ws

function tvOnline(tvId) {
  const set = playerSockets.get(tvId);
  return !!set && set.size > 0;
}

function mediaPublic(m) {
  return { id: m.id, label: m.label, originalName: m.originalName, size: m.size,
    uploadedAt: m.uploadedAt, url: `/media/${m.id}${m.ext}` };
}

function dashboardSnapshot() {
  return {
    type: 'state',
    tvs: store.data.tvs.map(t => ({
      id: t.id, name: t.name, power: t.power, online: tvOnline(t.id),
      lastSeen: t.lastSeen, assignedMediaIds: t.assignedMediaIds,
      nowPlaying: t.nowPlaying || null,
      override: t.override ? { name: t.override.name, endsAt: t.override.endsAt } : null
    })),
    media: store.data.media.map(mediaPublic),
    events: store.data.events.map(e => ({
      ...e, tvName: store.tv(e.tvId)?.name || '(removed TV)',
      mediaLabel: e.mediaId ? (store.medium(e.mediaId)?.label || null) : null
    })),
    settings: {
      birthdayMediaId: store.data.settings.birthdayMediaId,
      dayStarted: store.data.settings.dayStarted
    },
    serverTime: new Date().toISOString()
  };
}

function playerState(tv) {
  const playlist = tv.assignedMediaIds
    .map(id => store.medium(id))
    .filter(Boolean)
    .map(m => ({ id: m.id, label: m.label, url: `/media/${m.id}${m.ext}` }));
  let override = null;
  if (tv.override) {
    const m = tv.override.mediaId ? store.medium(tv.override.mediaId) : null;
    override = {
      name: tv.override.name,
      message: tv.override.message || `Happy Birthday, ${tv.override.name}!`,
      mediaUrl: m ? `/media/${m.id}${m.ext}` : null,
      endsAt: tv.override.endsAt
    };
  }
  return { type: 'state', tv: { id: tv.id, name: tv.name }, power: tv.power, playlist, override };
}

function pushTv(tvId) {
  const tv = store.tv(tvId);
  if (!tv) return;
  const msg = JSON.stringify(playerState(tv));
  for (const ws of playerSockets.get(tvId) || []) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function pushAllTvs() { for (const tv of store.data.tvs) pushTv(tv.id); }

function pushDashboards() {
  const msg = JSON.stringify(dashboardSnapshot());
  for (const ws of dashboardSockets) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

// Static: dashboard, player, media files (range requests supported by express.static)
app.use('/media', express.static(MEDIA_DIR, { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(ROOT, 'public')));
app.get('/', (req, res) => res.redirect('/dashboard/'));

// ---- Auth ----
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' ||
      password.length !== ADMIN_PASSWORD.length ||
      !crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD))) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: issueToken() });
});

// ---- Player registration (no auth) ----
app.post('/api/player/register', (req, res) => {
  const { existingId } = req.body || {};
  let tv = existingId ? store.tv(existingId) : null;
  if (!tv) {
    if (store.data.tvs.length >= 50) {
      return res.status(429).json({ error: 'TV limit reached — remove unused TVs in the dashboard' });
    }
    // Lowest unused number, so deleting "TV 7" and re-pairing never creates a
    // duplicate name (CSV rows target TVs by name).
    const names = new Set(store.data.tvs.map(t => t.name));
    let n = 1;
    while (names.has(`TV ${n}`)) n++;
    tv = {
      id: crypto.randomUUID(),
      name: `TV ${n}`,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      power: 'on',
      assignedMediaIds: [],
      nowPlaying: null,
      override: null
    };
    store.data.tvs.push(tv);
    store.save();
    pushDashboards();
  }
  res.json({ tvId: tv.id, name: tv.name });
});

// ---- Dashboard API ----
app.get('/api/state', requireAuth, (req, res) => res.json(dashboardSnapshot()));

app.patch('/api/tvs/:id', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!tv) return res.status(404).json({ error: 'No such TV' });
  const { name } = req.body || {};
  if (typeof name === 'string' && name.trim()) tv.name = name.trim().slice(0, 60);
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

app.delete('/api/tvs/:id', requireAuth, (req, res) => {
  const i = store.data.tvs.findIndex(t => t.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such TV' });
  const [tv] = store.data.tvs.splice(i, 1);
  for (const ws of playerSockets.get(tv.id) || []) ws.close();
  playerSockets.delete(tv.id);
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/tvs/:id/assign', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!tv) return res.status(404).json({ error: 'No such TV' });
  const { mediaIds } = req.body || {};
  if (!Array.isArray(mediaIds)) return res.status(400).json({ error: 'mediaIds must be an array' });
  tv.assignedMediaIds = mediaIds.filter(id => store.medium(id));
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/tvs/:id/power', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!tv) return res.status(404).json({ error: 'No such TV' });
  const { power } = req.body || {};
  if (power !== 'on' && power !== 'off') return res.status(400).json({ error: 'power must be "on" or "off"' });
  tv.power = power;
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/tvs/:id/test-birthday', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!tv) return res.status(404).json({ error: 'No such TV' });
  const { name, durationMin } = req.body || {};
  const dur = Math.min(Math.max(parseFloat(durationMin) || 1, 0.2), 240);
  tv.override = {
    eventId: null,
    name: (name || 'Test').toString().slice(0, 60),
    message: null,
    mediaId: store.data.settings.birthdayMediaId || null,
    endsAt: new Date(Date.now() + dur * 60_000).toISOString(),
    restorePowerOff: tv.power === 'off'
  };
  tv.power = 'on';
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/tvs/:id/clear-override', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!tv) return res.status(404).json({ error: 'No such TV' });
  if (tv.override) {
    if (tv.override.eventId) {
      const ev = store.event(tv.override.eventId);
      if (ev && ev.status === 'active') ev.status = 'done';
    }
    if (tv.override.restorePowerOff) tv.power = 'off';
  }
  tv.override = null;
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

// ---- Media ----
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp4|m4v|webm|mov)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .mp4, .m4v, .webm or .mov files are accepted'), ok);
  }
});

app.post('/api/media', requireAuth, (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.filename);
    const m = {
      id: path.basename(req.file.filename, ext),
      label: (req.body.label || req.file.originalname.replace(/\.[^.]+$/, '')).slice(0, 80),
      originalName: req.file.originalname,
      ext,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };
    store.data.media.push(m);
    store.save();
    pushDashboards();
    res.json({ ok: true, media: mediaPublic(m) });
  });
});

app.patch('/api/media/:id', requireAuth, (req, res) => {
  const m = store.medium(req.params.id);
  if (!m) return res.status(404).json({ error: 'No such media' });
  const { label } = req.body || {};
  if (typeof label === 'string' && label.trim()) m.label = label.trim().slice(0, 80);
  store.save();
  pushAllTvs();
  pushDashboards();
  res.json({ ok: true });
});

app.delete('/api/media/:id', requireAuth, (req, res) => {
  const i = store.data.media.findIndex(m => m.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such media' });
  const [m] = store.data.media.splice(i, 1);
  const touched = new Set();
  for (const tv of store.data.tvs) {
    if (tv.assignedMediaIds.includes(m.id)) {
      tv.assignedMediaIds = tv.assignedMediaIds.filter(id => id !== m.id);
      touched.add(tv.id);
    }
    if (tv.override && tv.override.mediaId === m.id) {
      tv.override.mediaId = null;
      touched.add(tv.id);
    }
  }
  for (const ev of store.data.events) if (ev.mediaId === m.id) ev.mediaId = null;
  if (store.data.settings.birthdayMediaId === m.id) store.data.settings.birthdayMediaId = null;
  try { fs.unlinkSync(path.join(MEDIA_DIR, m.id + m.ext)); } catch {}
  store.save();
  for (const id of touched) pushTv(id);
  pushDashboards();
  res.json({ ok: true });
});

// Assign the same playlist to every TV in one shot.
app.post('/api/assign-all', requireAuth, (req, res) => {
  const { mediaIds } = req.body || {};
  if (!Array.isArray(mediaIds)) return res.status(400).json({ error: 'mediaIds must be an array' });
  const clean = mediaIds.filter(id => store.medium(id));
  for (const tv of store.data.tvs) tv.assignedMediaIds = [...clean];
  store.save();
  pushAllTvs();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { birthdayMediaId } = req.body || {};
  if (birthdayMediaId !== undefined) {
    if (birthdayMediaId !== null && !store.medium(birthdayMediaId)) {
      return res.status(400).json({ error: 'No such media' });
    }
    store.data.settings.birthdayMediaId = birthdayMediaId;
  }
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

// ---- Events ----
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/events/csv', requireAuth, (req, res) => {
  csvUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { events, errors } = parseEventsCsv(req.file.buffer.toString('utf8'), store.data.tvs, store.data.media);
    if (events.length === 0) {
      // Nothing valid in the file (wrong file, bad headers): never wipe the
      // existing schedule on a failed import.
      return res.json({
        ok: true, imported: 0, kept: true,
        errors: errors.length ? errors : [{ line: 0, error: 'No valid rows found' }]
      });
    }
    // Replace still-scheduled events, but only for the dates present in this
    // file — pre-loading tomorrow's CSV must not delete tonight's parties.
    // Active/done events are history and always stay.
    const newDates = new Set(events.map(e => new Date(e.startsAt).toDateString()));
    store.data.events = store.data.events.filter(e =>
      e.status !== 'scheduled' || !newDates.has(new Date(e.startsAt).toDateString()));
    for (const e of events) {
      store.data.events.push({
        id: crypto.randomUUID(),
        ...e,
        status: 'scheduled',
        source: 'csv'
      });
    }
    store.data.events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    store.save();
    pushDashboards();
    res.json({ ok: true, imported: events.length, errors });
  });
});

app.post('/api/events', requireAuth, (req, res) => {
  const { tvId, name, message, startsAt, durationMin, mediaLabel } = req.body || {};
  const tv = store.tv(tvId);
  if (!tv) return res.status(400).json({ error: 'Pick a TV' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) return res.status(400).json({ error: 'Bad start time' });
  let mediaId = null;
  if (mediaLabel) {
    const m = matchMedia(store.data.media, mediaLabel);
    if (m) mediaId = m.id;
  }
  const ev = {
    id: crypto.randomUUID(),
    tvId,
    name: String(name).trim().slice(0, 60),
    message: message ? String(message).slice(0, 120) : null,
    startsAt: new Date(start).toISOString(),
    durationMin: Math.min(Math.max(parseFloat(durationMin) || 5, 0.2), 240),
    mediaId,
    status: 'scheduled',
    source: 'manual'
  };
  store.data.events.push(ev);
  store.data.events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  store.save();
  pushDashboards();
  res.json({ ok: true, event: ev });
});

app.delete('/api/events/:id', requireAuth, (req, res) => {
  const i = store.data.events.findIndex(e => e.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such event' });
  const [ev] = store.data.events.splice(i, 1);
  const tv = store.tv(ev.tvId);
  if (tv && tv.override && tv.override.eventId === ev.id) {
    tv.override = null;
    pushTv(tv.id);
  }
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/events/:id/start-now', requireAuth, (req, res) => {
  const ev = store.event(req.params.id);
  if (!ev) return res.status(404).json({ error: 'No such event' });
  ev.startsAt = new Date().toISOString();
  ev.status = 'scheduled';
  store.save();
  scheduler.tick();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/events/clear-done', requireAuth, (req, res) => {
  store.data.events = store.data.events.filter(e => e.status !== 'done');
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

// ---- Day open / close ----
app.post('/api/day/start', requireAuth, (req, res) => {
  store.data.settings.dayStarted = true;
  for (const tv of store.data.tvs) tv.power = 'on';
  store.save();
  pushAllTvs();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/day/end', requireAuth, (req, res) => {
  store.data.settings.dayStarted = false;
  for (const tv of store.data.tvs) {
    tv.power = 'off';
    if (tv.override) {
      if (tv.override.eventId) {
        const ev = store.event(tv.override.eventId);
        if (ev && ev.status === 'active') ev.status = 'done';
      }
      tv.override = null;
    }
  }
  store.save();
  pushAllTvs();
  pushDashboards();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------
const server = http.createServer(app);
// A 3GB video from a phone on venue Wi-Fi takes far longer than Node's
// default 5-minute whole-request deadline — disable it (uploads are LAN-only
// and multer enforces the size limit).
server.requestTimeout = 0;
// 64KB is far beyond any legitimate player/dashboard message; the default
// (100MB) would let any LAN device force huge disk writes and broadcasts.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'hello' && msg.role === 'player') {
      const tv = store.tv(msg.tvId);
      if (!tv) { ws.send(JSON.stringify({ type: 'reregister' })); return; }
      ws.role = 'player';
      ws.tvId = tv.id;
      if (!playerSockets.has(tv.id)) playerSockets.set(tv.id, new Set());
      playerSockets.get(tv.id).add(ws);
      tv.lastSeen = new Date().toISOString();
      store.save();
      ws.send(JSON.stringify(playerState(tv)));
      pushDashboards();
    } else if (msg.type === 'hello' && msg.role === 'dashboard') {
      if (!validToken(msg.token)) { ws.close(4001, 'bad token'); return; }
      ws.role = 'dashboard';
      dashboardSockets.add(ws);
      ws.send(JSON.stringify(dashboardSnapshot()));
    } else if (msg.type === 'status' && ws.role === 'player' && ws.tvId) {
      const tv = store.tv(ws.tvId);
      if (!tv) return;
      tv.lastSeen = new Date().toISOString();
      const nowPlaying = typeof msg.nowPlaying === 'string' ? msg.nowPlaying.slice(0, 120) : null;
      const changed = tv.nowPlaying !== nowPlaying;
      tv.nowPlaying = nowPlaying;
      store.save();
      // Only re-broadcast when something visible changed — heartbeats alone
      // shouldn't cause 12 TVs × every 10s of dashboard re-renders.
      if (changed) pushDashboards();
    }
  });

  ws.on('close', () => {
    if (ws.role === 'player' && ws.tvId) {
      const set = playerSockets.get(ws.tvId);
      if (set) { set.delete(ws); if (set.size === 0) playerSockets.delete(ws.tvId); }
      pushDashboards();
    } else if (ws.role === 'dashboard') {
      dashboardSockets.delete(ws);
    }
  });
});

const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(pingInterval));

const scheduler = startScheduler(store, {
  onTvChanged: pushTv,
  onStateChanged: pushDashboards
});

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`Skyzone TV server running on port ${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard/`);
  console.log(`  Player:    http://localhost:${PORT}/player/`);
  for (const a of lanAddresses()) {
    console.log(`  On your network: http://${a}:${PORT}/dashboard/  (players: http://${a}:${PORT}/player/)`);
  }
  console.log(`  Dashboard password: ${ADMIN_PASSWORD}` +
    (process.env.ADMIN_PASSWORD ? '' : '  (auto-generated; set the ADMIN_PASSWORD environment variable to choose your own)'));
});

process.on('SIGINT', () => { try { store.saveNow(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { store.saveNow(); } catch {} process.exit(0); });
