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
import { parseEventsCsv, matchMedia, matchTv, normalizeTheme, resolveTheme, normalizeLabel, THEMES,
  parseCsv, parseDate, parseTime } from './csv.js';
import { parseByline, defaultBirthdayMessage } from './byline.js';
import { rollerStatus, rollerSync } from './roller.js';
import { startScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PORT = parseInt(process.env.PORT || '8080', 10);
// Cloud mode: new TVs must be approved in the dashboard before they receive
// content (anyone on the internet can open the player URL; approval is what
// makes that safe). Leave unset on a LAN for instant pairing.
const REQUIRE_TV_APPROVAL = process.env.REQUIRE_TV_APPROVAL === '1' || process.env.REQUIRE_TV_APPROVAL === 'true';

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

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
function mediaType(m) {
  if (m.slide) return 'slide';
  return IMAGE_EXTS.includes(m.ext.toLowerCase()) ? 'image' : 'video';
}
// Replacing a file gives it a fresh filename (fileId) so the players' 1-year
// immutable cache can never serve stale content; the media id stays stable so
// playlists and assignments keep working.
function fileUrl(m) { return m.slide ? null : `/media/${m.fileId || m.id}${m.ext}`; }

function mediaPublic(m) {
  return { id: m.id, label: m.label, originalName: m.originalName, size: m.size,
    uploadedAt: m.uploadedAt, url: fileUrl(m),
    type: mediaType(m), slide: m.slide || undefined, durationSec: m.durationSec || 8,
    folderId: m.folderId || null };
}

function validFolderId(folderId) {
  return folderId && store.data.folders.some(f => f.id === folderId) ? folderId : null;
}

function dashboardSnapshot() {
  return {
    type: 'state',
    tvs: store.data.tvs.map(t => ({
      id: t.id, name: t.name, power: t.power, online: tvOnline(t.id),
      lastSeen: t.lastSeen, assignedMediaIds: t.assignedMediaIds,
      playlistId: t.playlistId || null,
      fit: t.fit || 'contain',
      approved: t.approved !== false,
      pairCode: t.approved === false ? t.pairCode : undefined,
      nowPlaying: t.nowPlaying || null,
      override: t.override ? { name: t.override.name, endsAt: t.override.endsAt } : null
    })),
    media: store.data.media.map(mediaPublic),
    folders: store.data.folders,
    playlists: store.data.playlists.map(p => ({
      id: p.id, name: p.name, transition: p.transition || 'none',
      items: p.items,
      usedBy: store.data.tvs.filter(t => t.playlistId === p.id).length
    })),
    events: store.data.events.map(e => ({
      ...e, tvName: store.tv(e.tvId)?.name || '(removed TV)',
      mediaLabel: e.mediaId ? (store.medium(e.mediaId)?.label || null) : null
    })),
    settings: {
      birthdayMediaId: store.data.settings.birthdayMediaId,
      dayStarted: store.data.settings.dayStarted,
      customThemes: store.data.settings.customThemes,
      venueName: venueName()
    },
    serverTime: new Date().toISOString()
  };
}

function playerItem(m, durationSec) {
  return { id: m.id, label: m.label, url: fileUrl(m),
    type: mediaType(m), slide: m.slide || undefined,
    durationSec: durationSec || m.durationSec || 8 };
}

function playerState(tv) {
  // Unapproved screens get no content — just their pairing code.
  if (tv.approved === false) {
    return { type: 'state', tv: { id: tv.id, name: tv.name }, power: 'on',
      approved: false, pairCode: tv.pairCode || '', fit: 'contain',
      playlist: [], transition: 'none', override: null };
  }
  // A TV plays either a named playlist (resolved live, so playlist edits hit
  // the screen immediately) or its own custom selection.
  let playlist = [];
  let transition = 'none';
  const pl = tv.playlistId ? store.playlist(tv.playlistId) : null;
  if (pl) {
    transition = pl.transition === 'fade' ? 'fade' : 'none';
    playlist = pl.items
      .filter(it => it.enabled !== false)
      .map(it => { const m = store.medium(it.mediaId); return m ? playerItem(m, it.durationSec) : null; })
      .filter(Boolean);
  } else {
    playlist = tv.assignedMediaIds
      .map(id => store.medium(id))
      .filter(Boolean)
      .map(m => playerItem(m));
  }
  let override = null;
  if (tv.override) {
    let m = tv.override.mediaId ? store.medium(tv.override.mediaId) : null;
    if (m && m.slide) m = null; // slides can't back a birthday takeover; use the theme
    // Custom themes are resolved to their spec at send time, so edits to a
    // theme apply to future (and re-pushed) takeovers immediately.
    let theme = tv.override.theme || 'party';
    let themeSpec = null;
    if (theme.startsWith('custom:')) {
      const ct = store.data.settings.customThemes.find(c => `custom:${c.id}` === theme);
      if (ct) {
        theme = 'custom';
        themeSpec = { bg: ct.bg, headline: ct.headline, confetti: ct.confetti, emojis: ct.emojis, elements: ct.elements };
      } else {
        theme = 'party'; // theme was deleted
      }
    }
    override = {
      name: tv.override.name,
      message: tv.override.message || `Happy Birthday, ${tv.override.name}!`,
      mediaUrl: m ? fileUrl(m) : null,
      endsAt: tv.override.endsAt,
      theme,
      themeSpec
    };
  }
  return { type: 'state', tv: { id: tv.id, name: tv.name }, power: tv.power,
    approved: true, fit: tv.fit || 'contain', playlist, transition, override,
    venueName: venueName() };
}

// The venue name shown on guest-facing screens (birthday subline). Settable
// per instance via /api/settings or the VENUE_NAME env var, so venue #2
// never shows venue #1's brand.
function venueName() {
  return store.data.settings.venueName || process.env.VENUE_NAME || 'Skyzone Schaumburg';
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
app.set('trust proxy', 1); // correct client IPs behind a cloud HTTPS proxy
app.use(express.json({ limit: '1mb' }));

// Brute-force protection on the dashboard password.
const loginAttempts = new Map(); // ip -> { count, resetAt }
function loginLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    if (loginAttempts.size > 10000) loginAttempts.clear();
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

// Health check for uptime monitoring and CI (no auth: it exposes only liveness).
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0'; }
  catch { return '0'; }
})();
const bootedAt = Date.now();
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
    tvs: store.data.tvs.length,
    online: store.data.tvs.filter(t => tvOnline(t.id)).length,
    time: new Date().toISOString()
  });
});

// Static: dashboard, player, media files (range requests supported by express.static)
app.use('/media', express.static(MEDIA_DIR, { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(ROOT, 'public')));
app.get('/', (req, res) => res.redirect('/dashboard/'));

// ---- Auth ----
app.post('/api/login', (req, res) => {
  if (loginLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes' });
  }
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
      // In cloud mode a new screen shows this code and waits until someone
      // hits Approve in the dashboard; on a LAN it's approved instantly.
      approved: !REQUIRE_TV_APPROVAL,
      pairCode: String(100000 + crypto.randomInt(900000)),
      assignedMediaIds: [],
      playlistId: null,
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
  const { name, fit } = req.body || {};
  if (typeof name === 'string' && name.trim()) tv.name = name.trim().slice(0, 60);
  if (fit === 'contain' || fit === 'cover') tv.fit = fit;
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/tvs/:id/approve', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!tv) return res.status(404).json({ error: 'No such TV' });
  tv.approved = true;
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
  tv.playlistId = null; // a custom selection takes the TV off any named playlist
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
  const { name, durationMin, theme } = req.body || {};
  const dur = Math.min(Math.max(parseFloat(durationMin) || 1, 0.2), 240);
  tv.override = {
    eventId: null,
    name: (name || 'Test').toString().slice(0, 60),
    message: null,
    mediaId: store.data.settings.birthdayMediaId || null,
    endsAt: new Date(Date.now() + dur * 60_000).toISOString(),
    theme: resolveTheme(theme, store.data.settings.customThemes) || 'party',
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
    const ok = /\.(mp4|m4v|webm|mov|jpg|jpeg|png|gif|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Accepted files: .mp4, .m4v, .webm, .mov video or .jpg, .png, .gif, .webp images'), ok);
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
      uploadedAt: new Date().toISOString(),
      folderId: validFolderId(req.body.folderId)
    };
    store.data.media.push(m);
    store.save();
    pushDashboards();
    res.json({ ok: true, media: mediaPublic(m) });
  });
});

// ---- Media folders ----
app.post('/api/folders', requireAuth, (req, res) => {
  const { id, name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder needs a name' });
  const clean = String(name).trim().slice(0, 40);
  const clash = store.data.folders.find(f => f.id !== id && normalizeLabel(f.name) === normalizeLabel(clean));
  if (clash) return res.status(400).json({ error: `A folder named "${clash.name}" already exists` });
  let f = id ? store.data.folders.find(x => x.id === id) : null;
  if (!f) {
    if (store.data.folders.length >= 50) return res.status(400).json({ error: 'Folder limit reached' });
    f = { id: crypto.randomUUID(), name: clean };
    store.data.folders.push(f);
  } else {
    f.name = clean;
  }
  store.save();
  pushDashboards();
  res.json({ ok: true, folder: f });
});

app.delete('/api/folders/:id', requireAuth, (req, res) => {
  const i = store.data.folders.findIndex(f => f.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such folder' });
  store.data.folders.splice(i, 1);
  // The folder's media moves back to the library root — nothing is deleted.
  for (const m of store.data.media) if (m.folderId === req.params.id) m.folderId = null;
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

// ---- Slides (media created and edited entirely in the dashboard) ----
app.post('/api/slides', requireAuth, (req, res) => {
  const { id, label, durationSec, slide, folderId } = req.body || {};
  if (!slide || !slide.headline || !String(slide.headline).trim()) {
    return res.status(400).json({ error: 'Slide needs a headline' });
  }
  const okColor = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
  const bg = Array.isArray(slide.bg) ? slide.bg.filter(okColor).slice(0, 2) : [];
  if (bg.length < 2) return res.status(400).json({ error: 'Pick two background colors' });
  const clean = {
    bg,
    headline: String(slide.headline).trim().slice(0, 80),
    subtext: slide.subtext ? String(slide.subtext).slice(0, 120) : '',
    badge: slide.badge ? String(slide.badge).slice(0, 40) : '',
    textColor: okColor(slide.textColor) ? slide.textColor : '#ffffff'
  };
  let m = id ? store.medium(id) : null;
  if (m && !m.slide) return res.status(400).json({ error: 'That media is a file, not a slide' });
  if (!m) {
    m = {
      id: crypto.randomUUID(),
      label: '', originalName: null, ext: '', size: 0,
      uploadedAt: new Date().toISOString()
    };
    store.data.media.push(m);
  }
  m.slide = clean;
  if (folderId !== undefined) m.folderId = validFolderId(folderId);
  if (typeof label === 'string' && label.trim()) m.label = label.trim().slice(0, 80);
  if (!m.label) m.label = clean.headline.slice(0, 40);
  const d = parseFloat(durationSec);
  if (Number.isFinite(d)) m.durationSec = Math.min(Math.max(d, 1), 3600);
  store.save();
  pushAllTvs();
  pushDashboards();
  res.json({ ok: true, media: mediaPublic(m) });
});

// Swap the file behind an existing photo/video while keeping its identity —
// it stays in every playlist and assignment, and screens refresh instantly.
app.post('/api/media/:id/replace', requireAuth, (req, res) => {
  const m = store.medium(req.params.id);
  if (!m) return res.status(404).json({ error: 'No such media' });
  if (m.slide) return res.status(400).json({ error: 'Slides are edited in the dashboard, not replaced' });
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const oldPath = path.join(MEDIA_DIR, (m.fileId || m.id) + m.ext);
    const ext = path.extname(req.file.filename);
    m.fileId = path.basename(req.file.filename, ext);
    m.ext = ext;
    m.size = req.file.size;
    m.originalName = req.file.originalname;
    try { fs.unlinkSync(oldPath); } catch {}
    store.save();
    pushAllTvs();
    pushDashboards();
    res.json({ ok: true, media: mediaPublic(m) });
  });
});

app.patch('/api/media/:id', requireAuth, (req, res) => {
  const m = store.medium(req.params.id);
  if (!m) return res.status(404).json({ error: 'No such media' });
  const { label, durationSec, folderId } = req.body || {};
  if (typeof label === 'string' && label.trim()) m.label = label.trim().slice(0, 80);
  if (folderId !== undefined) m.folderId = validFolderId(folderId);
  if (durationSec !== undefined) {
    const d = parseFloat(durationSec);
    if (Number.isFinite(d)) m.durationSec = Math.min(Math.max(d, 1), 3600);
  }
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
  for (const pl of store.data.playlists) {
    const before = pl.items.length;
    pl.items = pl.items.filter(it => it.mediaId !== m.id);
    if (pl.items.length !== before) {
      for (const tv of store.data.tvs) if (tv.playlistId === pl.id) touched.add(tv.id);
    }
  }
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
  if (!m.slide) { try { fs.unlinkSync(path.join(MEDIA_DIR, (m.fileId || m.id) + m.ext)); } catch {} }
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
  for (const tv of store.data.tvs) { tv.assignedMediaIds = [...clean]; tv.playlistId = null; }
  store.save();
  pushAllTvs();
  pushDashboards();
  res.json({ ok: true });
});

// ---- Playlists ----
function cleanPlaylistItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter(it => it && store.medium(it.mediaId))
    .slice(0, 100)
    .map(it => ({
      mediaId: it.mediaId,
      enabled: it.enabled !== false,
      durationSec: Math.min(Math.max(parseFloat(it.durationSec) || 8, 1), 3600)
    }));
}

app.post('/api/playlists', requireAuth, (req, res) => {
  const { id, name, transition, items } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Playlist needs a name' });
  const pl = {
    id: id && store.playlist(id) ? id : crypto.randomUUID(),
    name: String(name).trim().slice(0, 60),
    transition: transition === 'fade' ? 'fade' : 'none',
    items: cleanPlaylistItems(items)
  };
  const i = store.data.playlists.findIndex(p => p.id === pl.id);
  if (i === -1) store.data.playlists.push(pl); else store.data.playlists[i] = pl;
  store.save();
  for (const tv of store.data.tvs) if (tv.playlistId === pl.id) pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true, playlist: pl });
});

app.delete('/api/playlists/:id', requireAuth, (req, res) => {
  const i = store.data.playlists.findIndex(p => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such playlist' });
  store.data.playlists.splice(i, 1);
  for (const tv of store.data.tvs) {
    if (tv.playlistId === req.params.id) {
      tv.playlistId = null; // falls back to the TV's custom selection
      pushTv(tv.id);
    }
  }
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/playlists/:id/assign-all', requireAuth, (req, res) => {
  if (!store.playlist(req.params.id)) return res.status(404).json({ error: 'No such playlist' });
  for (const tv of store.data.tvs) tv.playlistId = req.params.id;
  store.save();
  pushAllTvs();
  pushDashboards();
  res.json({ ok: true });
});

// Point a TV at a playlist (playlistId: null reverts to its custom selection).
app.post('/api/tvs/:id/playlist', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!tv) return res.status(404).json({ error: 'No such TV' });
  const { playlistId } = req.body || {};
  if (playlistId !== null && !store.playlist(playlistId)) {
    return res.status(400).json({ error: 'No such playlist' });
  }
  tv.playlistId = playlistId;
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

// ---- Custom birthday themes ----
const THEME_ELEMENTS = ['sparkles', 'balloons', 'dots', 'bursts'];
const isColor = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

app.post('/api/themes', requireAuth, (req, res) => {
  const { id, name, bg, headline, confetti, emojis, elements } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Theme needs a name' });
  const cleanName = String(name).trim().slice(0, 40);
  if (normalizeTheme(cleanName) !== null && normalizeLabel(cleanName) !== '') {
    return res.status(400).json({ error: `"${cleanName}" is a built-in theme name — pick another` });
  }
  const themes = store.data.settings.customThemes;
  const clash = themes.find(c => c.id !== id && normalizeLabel(c.name) === normalizeLabel(cleanName));
  if (clash) return res.status(400).json({ error: `A theme named "${clash.name}" already exists` });
  if (!Array.isArray(bg) || bg.length < 2 || !bg.every(isColor)) {
    return res.status(400).json({ error: 'Pick two background colors' });
  }
  if (!headline || !isColor(headline.fill) || !isColor(headline.stroke)) {
    return res.status(400).json({ error: 'Pick headline colors' });
  }
  const theme = {
    id: id && themes.some(c => c.id === id) ? id : crypto.randomUUID(),
    name: cleanName,
    bg: bg.slice(0, 3),
    headline: { fill: headline.fill, stroke: headline.stroke },
    confetti: (Array.isArray(confetti) ? confetti.filter(isColor) : []).slice(0, 6),
    emojis: typeof emojis === 'string' ? [...emojis.replace(/\s+/g, '')].slice(0, 8).join('') : '',
    elements: (Array.isArray(elements) ? elements.filter(e => THEME_ELEMENTS.includes(e)) : [])
  };
  if (theme.confetti.length === 0) theme.confetti = [theme.headline.fill, theme.headline.stroke, '#ffffff'];
  const i = themes.findIndex(c => c.id === theme.id);
  if (i === -1) themes.push(theme); else themes[i] = theme;
  store.save();
  // TVs currently showing this theme pick up the edit immediately.
  for (const tv of store.data.tvs) {
    if (tv.override && tv.override.theme === `custom:${theme.id}`) pushTv(tv.id);
  }
  pushDashboards();
  res.json({ ok: true, theme });
});

app.delete('/api/themes/:id', requireAuth, (req, res) => {
  const themes = store.data.settings.customThemes;
  const i = themes.findIndex(c => c.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such theme' });
  const key = `custom:${themes[i].id}`;
  themes.splice(i, 1);
  for (const ev of store.data.events) if (ev.theme === key) ev.theme = 'party';
  for (const tv of store.data.tvs) {
    if (tv.override && tv.override.theme === key) { tv.override.theme = 'party'; pushTv(tv.id); }
  }
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { birthdayMediaId, venueName: newVenueName } = req.body || {};
  if (birthdayMediaId !== undefined) {
    if (birthdayMediaId !== null && !store.medium(birthdayMediaId)) {
      return res.status(400).json({ error: 'No such media' });
    }
    store.data.settings.birthdayMediaId = birthdayMediaId;
  }
  if (newVenueName !== undefined) {
    if (!String(newVenueName).trim()) return res.status(400).json({ error: 'Venue name cannot be empty' });
    store.data.settings.venueName = String(newVenueName).trim().slice(0, 60);
    pushAllTvs(); // guest-facing subline changes immediately
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
    const { events, errors } = parseEventsCsv(req.file.buffer.toString('utf8'), store.data.tvs, store.data.media,
      store.data.settings.customThemes);
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
  const { tvId, name, age, message, startsAt, durationMin, mediaLabel, theme } = req.body || {};
  const tv = store.tv(tvId);
  if (!tv) return res.status(400).json({ error: 'Pick a TV' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) return res.status(400).json({ error: 'Bad start time' });
  let cleanAge = null;
  if (age !== undefined && age !== null && age !== '') {
    cleanAge = parseInt(age, 10);
    if (!Number.isFinite(cleanAge) || cleanAge < 1 || cleanAge > 99) {
      return res.status(400).json({ error: 'Age must be 1–99 (or blank)' });
    }
  }
  let mediaId = null;
  if (mediaLabel) {
    const m = matchMedia(store.data.media, mediaLabel);
    if (m) mediaId = m.id;
  }
  const ev = {
    id: crypto.randomUUID(),
    tvId,
    name: String(name).trim().slice(0, 60),
    age: cleanAge,
    message: message ? String(message).slice(0, 120) : null,
    startsAt: new Date(start).toISOString(),
    durationMin: Math.min(Math.max(parseFloat(durationMin) || 5, 0.2), 240),
    mediaId,
    theme: resolveTheme(theme, store.data.settings.customThemes) || 'party',
    status: 'scheduled',
    source: 'manual'
  };
  store.data.events.push(ev);
  store.data.events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  store.save();
  pushDashboards();
  res.json({ ok: true, event: ev });
});

// Edit a party/event in place. Name, age and theme are ALWAYS editable — the
// byline parser only pre-fills them, it never owns them (a "correct"-looking
// parse can still be the parent's name, so the operator has the final word).
app.patch('/api/events/:id', requireAuth, (req, res) => {
  const ev = store.event(req.params.id);
  if (!ev) return res.status(404).json({ error: 'No such event' });
  const { name, age, message, theme, tvId, startsAt, durationMin } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    ev.name = String(name).trim().slice(0, 60);
  }
  if (age !== undefined) {
    if (age === null || age === '') ev.age = null;
    else {
      const a = parseInt(age, 10);
      if (!Number.isFinite(a) || a < 1 || a > 99) return res.status(400).json({ error: 'Age must be 1–99 (or blank)' });
      ev.age = a;
    }
  }
  if (message !== undefined) ev.message = message ? String(message).slice(0, 120) : null;
  if (theme !== undefined) {
    const t = resolveTheme(theme, store.data.settings.customThemes);
    if (!t) return res.status(400).json({ error: 'Unknown theme' });
    ev.theme = t;
  }
  if (tvId !== undefined) {
    if (!store.tv(tvId)) return res.status(400).json({ error: 'No such TV' });
    ev.tvId = tvId;
  }
  if (startsAt !== undefined) {
    const t = Date.parse(startsAt);
    if (!Number.isFinite(t)) return res.status(400).json({ error: 'Bad start time' });
    ev.startsAt = new Date(t).toISOString();
  }
  if (durationMin !== undefined) {
    const d = parseFloat(durationMin);
    if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: 'Bad duration' });
    ev.durationMin = Math.min(Math.max(d, 0.2), 240);
  }
  // If this party is on screen right now, the edit reaches the screen live.
  const tv = store.tv(ev.tvId);
  if (ev.status === 'active' && tv && tv.override && tv.override.eventId === ev.id) {
    tv.override.name = ev.name;
    tv.override.message = ev.message || defaultBirthdayMessage(ev);
    tv.override.theme = ev.theme || 'party';
    pushTv(tv.id);
  }
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

// ---- ROLLER connection ----
app.get('/api/roller/status', requireAuth, (req, res) => res.json(rollerStatus()));

app.post('/api/roller/sync', requireAuth, async (req, res) => {
  try {
    const result = await rollerSync(store, { matchTv });
    if (result.imported || result.updated) pushDashboards();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(502).json({ error: `ROLLER sync failed: ${e.message}` });
  }
});

// ---- TEMPORARY: test-booking CSV import -----------------------------------
// Stand-in for the ROLLER feed while credentials are pending. It accepts a
// raw booking export — date,time,room,byline[,duration] — with NO name or
// theme columns, so the byline parser does the work exactly as it will for
// live ROLLER data. This whole block (plus the dashboard's "Test import"
// card and sample-test-bookings.csv) is scheduled for deletion once the
// ROLLER connection is live; nothing else depends on it.
app.post('/api/test-bookings/csv', requireAuth, (req, res) => {
  csvUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const rows = parseCsv(req.file.buffer.toString('utf8'));
    if (rows.length === 0) return res.json({ ok: true, imported: 0, errors: [{ line: 0, error: 'Empty file' }] });

    const headers = rows[0].map(h => normalizeLabel(h));
    const col = (...names) => {
      for (const n of names) { const i = headers.indexOf(normalizeLabel(n)); if (i !== -1) return i; }
      return -1;
    };
    const iDate = col('date'), iTime = col('time', 'start', 'starttime'),
      iRoom = col('room', 'tv', 'resource', 'space', 'screen'),
      iByline = col('byline', 'booking', 'title', 'name', 'description'),
      iDur = col('duration', 'minutes', 'durationminutes');
    if (iDate === -1 || iTime === -1 || iRoom === -1 || iByline === -1) {
      return res.json({ ok: true, imported: 0,
        errors: [{ line: 1, error: 'Missing headers. Need: date, time, room, byline (optional: duration)' }] });
    }

    const errors = [];
    const imported = [];
    for (let r = 1; r < rows.length; r++) {
      const line = r + 1;
      const get = i => (i >= 0 && i < rows[r].length ? rows[r][i].trim() : '');
      const date = parseDate(get(iDate));
      const time = parseTime(get(iTime));
      if (!date) { errors.push({ line, error: `Bad date "${get(iDate)}"` }); continue; }
      if (!time) { errors.push({ line, error: `Bad time "${get(iTime)}"` }); continue; }
      const tv = matchTv(store.data.tvs, get(iRoom));
      if (!tv) { errors.push({ line, error: `No TV matches room "${get(iRoom)}"` }); continue; }
      const byline = get(iByline);
      if (!byline) { errors.push({ line, error: 'Empty byline' }); continue; }
      const parsed = parseByline(byline);
      let durationMin = parseFloat(get(iDur));
      if (!Number.isFinite(durationMin) || durationMin <= 0) durationMin = 5;
      imported.push({
        id: crypto.randomUUID(),
        tvId: tv.id,
        // The parse pre-fills; the Parties page keeps every field editable.
        name: parsed.name || 'Birthday Star',
        age: parsed.age,
        message: null,
        startsAt: new Date(date.y, date.mo - 1, date.d, time.h, time.min, 0, 0).toISOString(),
        durationMin: Math.min(durationMin, 240),
        mediaId: null,
        theme: 'party',
        status: 'scheduled',
        source: 'test-csv',
        byline,
        parsed
      });
    }
    if (imported.length > 0) {
      // Re-importing a day's file replaces that day's still-scheduled test
      // rows only — manual and ROLLER parties are never touched by this path.
      const newDates = new Set(imported.map(e => new Date(e.startsAt).toDateString()));
      store.data.events = store.data.events.filter(e =>
        e.source !== 'test-csv' || e.status !== 'scheduled' || !newDates.has(new Date(e.startsAt).toDateString()));
      store.data.events.push(...imported);
      store.data.events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
      store.save();
      pushDashboards();
    }
    res.json({
      ok: true,
      imported: imported.length,
      errors,
      // Per-row parse report so the operator can eyeball what the parser did.
      parsed: imported.map(e => ({
        byline: e.byline, name: e.name, age: e.age, confidence: e.parsed.confidence
      }))
    });
  });
});
// ---- END TEMPORARY --------------------------------------------------------

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
