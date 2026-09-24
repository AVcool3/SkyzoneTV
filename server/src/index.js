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
import { parseEventsCsv, matchMedia, matchTv, normalizeTheme, resolveTheme, normalizeLabel,
  parseCsv, parseDate, parseTime } from './csv.js';
import { parseByline, defaultBirthdayMessage } from './byline.js';
import { rollerStatus, rollerSync } from './roller.js';
import { startScheduler } from './scheduler.js';
import { zonedTimeToUtc, isValidTz } from './tz.js';

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
// Auth: vendor accounts. Each user belongs to one venue (workspace); every
// API call is scoped to the caller's venue. The legacy ADMIN_PASSWORD login
// maps to a virtual owner of the default venue so existing setups keep
// working. Players stay unauthenticated (they pair by code).
// ---------------------------------------------------------------------------
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
// The OWNER_EMAIL account runs the platform, even if it signed up before
// the platform-admin flag existed.
if (OWNER_EMAIL) {
  const ownerUser = store.userByEmail(OWNER_EMAIL);
  if (ownerUser && ownerUser.platformAdmin !== true) {
    ownerUser.platformAdmin = true;
    store.saveNow();
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const probe = crypto.scryptSync(password, salt, 32);
  const known = Buffer.from(hash, 'hex');
  return probe.length === known.length && crypto.timingSafeEqual(probe, known);
}

const SESSION_TTL_MS = 30 * 86_400_000; // sessions expire after 30 days
const TOKENS_PER_USER = 10;             // signing in on an 11th device evicts the oldest

function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  let tokens = store.data.settings.tokens;
  // Caps are per-user so one busy (or hostile) account can never evict
  // other venues' live sessions, plus a generous global backstop.
  const mine = tokens.filter(t => t.userId === userId);
  if (mine.length >= TOKENS_PER_USER) {
    const drop = new Set(mine.slice(0, mine.length - TOKENS_PER_USER + 1).map(t => t.token));
    tokens = tokens.filter(t => !drop.has(t.token));
  }
  tokens.push({ token, userId, createdAt: Date.now() });
  while (tokens.length > 2000) tokens.shift();
  store.data.settings.tokens = tokens;
  store.save();
  return token;
}
// Resolve a bearer token to { userId, venueId } — null when invalid.
function sessionFor(token) {
  if (!token) return null;
  const entry = store.data.settings.tokens.find(t => t.token === token);
  if (!entry) return null;
  if (entry.createdAt && Date.now() - entry.createdAt > SESSION_TTL_MS) {
    store.data.settings.tokens = store.data.settings.tokens.filter(t => t !== entry);
    store.save();
    return null;
  }
  if (entry.userId === 'legacy-admin') {
    return { userId: 'legacy-admin', venueId: store.defaultVenueId() };
  }
  const user = store.user(entry.userId);
  if (!user) return null;
  if (user.disabled === true) return null; // access revoked platform-wide
  return { userId: user.id, venueId: user.venueId };
}
// Platform admins run the ParkCast service itself: they see every venue,
// create and suspend workspaces, and can open any venue for support. The
// flag is granted to the OWNER_EMAIL account and by existing admins only.
function isPlatformAdmin(userId) {
  return userId === 'legacy-admin' || store.user(userId)?.platformAdmin === true;
}
function requireAdmin(req, res, next) {
  if (!isPlatformAdmin(req.userId)) return res.status(403).json({ error: 'Platform admins only' });
  next();
}
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = sessionFor(token);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  // A suspended venue keeps its screens playing but loses dashboard/API
  // access for its members; platform admins still get in for support.
  const venue = store.venue(session.venueId);
  if (venue?.suspended && !isPlatformAdmin(session.userId)) {
    return res.status(403).json({ error: 'This venue is suspended — contact ParkCast support' });
  }
  req.userId = session.userId;
  req.venueId = session.venueId;
  next();
}
// True when an item exists AND belongs to the caller's venue.
const owned = (req, item) => !!item && item.venueId === req.venueId;
// Owner-only actions (team management, venue settings). The legacy admin
// password acts as the default venue's owner.
function requireOwner(req, res, next) {
  const role = req.userId === 'legacy-admin' ? 'owner' : store.user(req.userId)?.role;
  if (role !== 'owner') return res.status(403).json({ error: 'Only owners can do this' });
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
  if (m.comp) return 'comp';
  if (m.slide) return 'slide';
  return IMAGE_EXTS.includes(m.ext.toLowerCase()) ? 'image' : 'video';
}
// Replacing a file gives it a fresh filename (fileId) so the players' 1-year
// immutable cache can never serve stale content; the media id stays stable so
// playlists and assignments keep working.
function fileUrl(m) { return (m.slide || m.comp) ? null : `/media/${m.fileId || m.id}${m.ext}`; }

function mediaPublic(m) {
  return { id: m.id, label: m.label, originalName: m.originalName, size: m.size,
    uploadedAt: m.uploadedAt, url: fileUrl(m),
    type: mediaType(m), slide: m.slide || undefined, comp: m.comp || undefined,
    durationSec: m.durationSec || 8,
    folderId: m.folderId || null };
}

function validFolderId(venueId, folderId) {
  return folderId && store.data.folders.some(f => f.id === folderId && f.venueId === venueId) ? folderId : null;
}

function dashboardSnapshot(venueId) {
  const venue = store.venue(venueId) || store.venue(store.defaultVenueId());
  return {
    type: 'state',
    tvs: store.tvsOf(venue.id).map(t => ({
      id: t.id, name: t.name, power: t.power, online: tvOnline(t.id),
      lastSeen: t.lastSeen, assignedMediaIds: t.assignedMediaIds,
      playlistId: t.playlistId || null,
      fit: t.fit || 'contain',
      approved: t.approved !== false,
      pairCode: t.approved === false ? t.pairCode : undefined,
      nowPlaying: t.nowPlaying || null,
      override: t.override ? { name: t.override.name, endsAt: t.override.endsAt } : null
    })),
    media: store.mediaOf(venue.id).map(mediaPublic),
    folders: store.foldersOf(venue.id),
    playlists: store.playlistsOf(venue.id).map(p => ({
      id: p.id, name: p.name, transition: p.transition || 'none',
      items: p.items,
      usedBy: store.tvsOf(venue.id).filter(t => t.playlistId === p.id).length
    })),
    events: store.eventsOf(venue.id).map(e => ({
      ...e, tvName: store.tv(e.tvId)?.name || '(removed TV)',
      mediaLabel: e.mediaId ? (store.medium(e.mediaId)?.label || null) : null
    })),
    settings: {
      dayStarted: venue.dayStarted !== false,
      customThemes: venue.customThemes || [],
      venueName: venue.name,
      tz: venue.tz || ''
    },
    serverTime: new Date().toISOString()
  };
}

function playerItem(m, durationSec) {
  const item = { id: m.id, label: m.label, url: fileUrl(m),
    type: mediaType(m), slide: m.slide || undefined,
    durationSec: durationSec || m.durationSec || 8 };
  if (m.comp) {
    // Element media URLs are resolved at push time so replace-file
    // cache-busting flows through, and dead references simply drop out.
    item.comp = {
      bg: m.comp.bg,
      elements: m.comp.elements
        .map(el => {
          if (el.type !== 'image' && el.type !== 'video') return el;
          const em = store.medium(el.mediaId);
          return em ? { ...el, url: fileUrl(em) } : null;
        })
        .filter(Boolean)
    };
  }
  return item;
}

function playerState(tv) {
  // Unclaimed/unapproved screens get no content — just their pairing code.
  if (tv.approved === false || !tv.venueId) {
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
    if (m && (m.slide || m.comp)) m = null; // only real videos can back a takeover; use the theme
    // Custom themes are resolved to their spec at send time, so edits to a
    // theme apply to future (and re-pushed) takeovers immediately.
    let theme = tv.override.theme || 'party';
    let themeSpec = null;
    if (theme.startsWith('custom:')) {
      const ct = (store.venue(tv.venueId)?.customThemes || []).find(c => `custom:${c.id}` === theme);
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
      // Remaining time computed HERE: a TV whose clock runs fast would end
      // the party early if it compared endsAt against its own Date.now().
      msRemaining: Math.max(0, Date.parse(tv.override.endsAt) - Date.now()),
      theme,
      themeSpec
    };
  }
  return { type: 'state', tv: { id: tv.id, name: tv.name }, power: tv.power,
    approved: true, fit: tv.fit || 'contain', playlist, transition, override,
    venueName: store.venue(tv.venueId)?.name || '' };
}

function pushTv(tvId) {
  const tv = store.tv(tvId);
  if (!tv) return;
  const msg = JSON.stringify(playerState(tv));
  for (const ws of playerSockets.get(tvId) || []) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function pushVenueTvs(venueId) { for (const tv of store.tvsOf(venueId)) pushTv(tv.id); }

function pushDashboards(venueId) {
  const cache = new Map();
  for (const ws of dashboardSockets) {
    if (ws.readyState !== ws.OPEN) continue;
    if (venueId && ws.venueId !== venueId) continue;
    if (!cache.has(ws.venueId)) cache.set(ws.venueId, JSON.stringify(dashboardSnapshot(ws.venueId)));
    ws.send(cache.get(ws.venueId));
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
    if (loginAttempts.size > 10000) {
      // Evict only expired windows — clearing everything would reset an
      // attacker's own counter along with everyone else's.
      for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
    }
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
  // Liveness only — fleet counts are tenant data and stay behind auth.
  res.json({
    ok: true,
    version: VERSION,
    uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
    time: new Date().toISOString()
  });
});

// Static: dashboard, player, media files (range requests supported by express.static)
app.use('/media', express.static(MEDIA_DIR, { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(ROOT, 'public')));
// Clean privacy-policy URL (Play Console links to this).
app.get('/privacy', (req, res) => res.sendFile(path.join(ROOT, 'public', 'privacy.html')));
// The sideload APK moved with the rebrand; old Downloader links keep working.
app.get('/skyzone-player.apk', (req, res) => res.redirect(301, '/parkcast-player.apk'));

// ---- Auth ----
app.post('/api/login', (req, res) => {
  if (loginLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes' });
  }
  const { password } = req.body || {};
  // Compare as byte buffers: JS string length can match while UTF-8 byte
  // length differs, and timingSafeEqual throws on unequal buffer lengths.
  const given = typeof password === 'string' ? Buffer.from(password) : Buffer.alloc(0);
  const actual = Buffer.from(ADMIN_PASSWORD);
  if (given.length !== actual.length || !crypto.timingSafeEqual(given, actual)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  loginAttempts.delete(req.ip); // successful logins don't count toward the lockout
  res.json({ token: issueToken('legacy-admin') });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Create a vendor account. The first-ever signup (or the OWNER_EMAIL match)
// claims the default venue with all its existing screens and media; every
// later signup gets a fresh, empty workspace.
app.post('/api/signup', (req, res) => {
  if (loginLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes' });
  const { venue, name, email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (store.userByEmail(cleanEmail)) return res.status(400).json({ error: 'That email already has an account — sign in instead' });
  if (store.data.users.length >= 500) return res.status(429).json({ error: 'Signups are temporarily closed' });

  // The default venue (all pre-multi-tenant screens and media) goes to the
  // first signup that is ALLOWED to claim it: the OWNER_EMAIL when one is
  // set, otherwise whoever signs up first. A stranger signing up earlier
  // gets a fresh venue and never blocks the real owner's claim.
  const defaultClaimed = store.data.users.some(u => u.venueId === store.defaultVenueId());
  const claimsDefault = !defaultClaimed && (!OWNER_EMAIL || OWNER_EMAIL === cleanEmail);
  let venueId;
  if (claimsDefault) {
    venueId = store.defaultVenueId();
    const v = store.venue(venueId);
    if (venue && String(venue).trim()) v.name = String(venue).trim().slice(0, 60);
  } else {
    const v = {
      id: crypto.randomUUID(),
      name: (String(venue || '').trim() || 'My Venue').slice(0, 60),
      dayStarted: true,
      customThemes: [],
      createdAt: new Date().toISOString()
    };
    store.data.venues.push(v);
    venueId = v.id;
  }
  const user = {
    id: crypto.randomUUID(),
    email: cleanEmail,
    passHash: hashPassword(password),
    name: String(name || '').trim().slice(0, 60),
    venueId,
    role: 'owner',
    // Claiming the default venue means running the platform itself.
    ...(claimsDefault ? { platformAdmin: true } : {}),
    createdAt: new Date().toISOString()
  };
  store.data.users.push(user);
  store.save();
  loginAttempts.delete(req.ip);
  res.json({ token: issueToken(user.id), venueName: store.venue(venueId).name });
});

app.post('/api/signin', (req, res) => {
  if (loginLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes' });
  const { email, password } = req.body || {};
  const user = store.userByEmail(email);
  if (!user || typeof password !== 'string' || !verifyPassword(password, user.passHash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (user.disabled === true) {
    return res.status(403).json({ error: 'This account is disabled — contact ParkCast support' });
  }
  const home = store.venue(user.venueId);
  if (home?.suspended && user.platformAdmin !== true) {
    return res.status(403).json({ error: 'This venue is suspended — contact ParkCast support' });
  }
  loginAttempts.delete(req.ip);
  res.json({ token: issueToken(user.id), venueName: home?.name || '' });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = req.userId === 'legacy-admin'
    ? { email: null, name: 'Admin', role: 'owner' }
    : store.user(req.userId);
  res.json({ email: user?.email || null, name: user?.name || '',
    role: user?.role || 'staff',
    platformAdmin: isPlatformAdmin(req.userId),
    venueName: store.venue(req.venueId)?.name || '' });
});

// Sign out server-side: the token stops working everywhere, not just in
// the browser that forgot it.
app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').slice(7);
  store.data.settings.tokens = store.data.settings.tokens.filter(t => t.token !== token);
  store.save();
  res.json({ ok: true });
});

// Change your own password (any role). Other sessions are signed out; the
// one making the change keeps working.
app.post('/api/me/password', requireAuth, (req, res) => {
  if (req.userId === 'legacy-admin') {
    return res.status(400).json({ error: 'The admin password is set in the server environment' });
  }
  const { current, next } = req.body || {};
  const user = store.user(req.userId);
  if (!user || typeof current !== 'string' || !verifyPassword(current, user.passHash)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  if (typeof next !== 'string' || next.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  user.passHash = hashPassword(next);
  const keep = (req.headers.authorization || '').slice(7);
  store.data.settings.tokens = store.data.settings.tokens.filter(
    t => t.userId !== user.id || t.token === keep);
  store.save();
  res.json({ ok: true });
});

// ---- Team (owner portal): who can sign in to this venue ----
const teamMember = (u, selfId) => ({
  id: u.id, email: u.email, name: u.name, role: u.role,
  createdAt: u.createdAt, you: u.id === selfId
});

// End every session a user holds — their bearer tokens and any live
// dashboard sockets — so cutting access or resetting a password is instant.
function revokeSessions(userId) {
  store.data.settings.tokens = store.data.settings.tokens.filter(t => t.userId !== userId);
  for (const ws of dashboardSockets) {
    if (ws.userId === userId) { try { ws.close(4001, 'access revoked'); } catch {} }
  }
}

app.get('/api/team', requireAuth, requireOwner, (req, res) => {
  res.json({ members: store.data.users
    .filter(u => u.venueId === req.venueId)
    .map(u => teamMember(u, req.userId)) });
});

app.post('/api/team', requireAuth, requireOwner, (req, res) => {
  const { email, name, password, role } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (store.userByEmail(cleanEmail)) return res.status(400).json({ error: 'That email already has an account' });
  if (store.data.users.length >= 500) return res.status(429).json({ error: 'Account limit reached' });
  const user = {
    id: crypto.randomUUID(),
    email: cleanEmail,
    passHash: hashPassword(password),
    name: String(name || '').trim().slice(0, 60),
    venueId: req.venueId,
    role: role === 'owner' ? 'owner' : 'staff',
    createdAt: new Date().toISOString()
  };
  store.data.users.push(user);
  store.save();
  res.json({ ok: true, member: teamMember(user, req.userId) });
});

app.patch('/api/team/:id', requireAuth, requireOwner, (req, res) => {
  const user = store.user(req.params.id);
  if (!owned(req, user)) return res.status(404).json({ error: 'No such member' });
  // Blocking self-edits keeps at least one owner in every venue.
  if (user.id === req.userId) return res.status(400).json({ error: 'You cannot change your own access — ask another owner' });
  const { role, password } = req.body || {};
  // Validate EVERYTHING before touching the user: a request that half-fails
  // must change nothing, or "error" responses silently apply edits.
  if (role !== undefined && role !== 'owner' && role !== 'staff') {
    return res.status(400).json({ error: 'Role must be owner or staff' });
  }
  if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (role !== undefined) user.role = role; // takes effect on their next request — roles are checked live
  if (password !== undefined) {
    user.passHash = hashPassword(password);
    revokeSessions(user.id); // old sessions die with the old password
  }
  store.save();
  res.json({ ok: true, member: teamMember(user, req.userId) });
});

app.delete('/api/team/:id', requireAuth, requireOwner, (req, res) => {
  const user = store.user(req.params.id);
  if (!owned(req, user)) return res.status(404).json({ error: 'No such member' });
  if (user.id === req.userId) return res.status(400).json({ error: 'You cannot remove yourself' });
  store.data.users = store.data.users.filter(u => u.id !== user.id);
  revokeSessions(user.id);
  store.save();
  res.json({ ok: true });
});

// ---- Platform administration (cross-vendor management) ----
// The operator's console over every vendor workspace: list venues with
// live stats, provision a venue with its owner account, suspend/resume,
// and open any venue in a scoped support session.
app.get('/api/admin/venues', requireAuth, requireAdmin, (req, res) => {
  res.json({ venues: store.data.venues.map(v => {
    const tvs = store.tvsOf(v.id);
    return {
      id: v.id, name: v.name, tz: v.tz || null,
      suspended: v.suspended === true,
      isDefault: v.id === store.defaultVenueId(),
      createdAt: v.createdAt,
      screens: tvs.length,
      online: tvs.filter(t => tvOnline(t.id)).length,
      members: store.data.users.filter(u => u.venueId === v.id).length,
      media: store.mediaOf(v.id).length,
      upcomingParties: store.eventsOf(v.id).filter(e => e.status === 'scheduled').length
    };
  }) });
});

app.post('/api/admin/venues', requireAuth, requireAdmin, (req, res) => {
  const { name, ownerEmail, ownerPassword } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Venue needs a name' });
  const cleanEmail = String(ownerEmail || '').trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid owner email' });
  if (typeof ownerPassword !== 'string' || ownerPassword.length < 8) {
    return res.status(400).json({ error: 'Owner password must be at least 8 characters' });
  }
  if (store.userByEmail(cleanEmail)) return res.status(400).json({ error: 'That email already has an account' });
  if (store.data.users.length >= 500) return res.status(429).json({ error: 'Account limit reached' });
  const v = {
    id: crypto.randomUUID(),
    name: String(name).trim().slice(0, 60),
    dayStarted: true,
    customThemes: [],
    tz: null,
    createdAt: new Date().toISOString()
  };
  store.data.venues.push(v);
  store.data.users.push({
    id: crypto.randomUUID(),
    email: cleanEmail,
    passHash: hashPassword(ownerPassword),
    name: '',
    venueId: v.id,
    role: 'owner',
    createdAt: new Date().toISOString()
  });
  store.save();
  res.json({ ok: true, venue: { id: v.id, name: v.name } });
});

app.post('/api/admin/venues/:id/suspend', requireAuth, requireAdmin, (req, res) => {
  const v = store.venue(req.params.id);
  if (!v) return res.status(404).json({ error: 'No such venue' });
  const suspend = req.body?.suspended === true;
  if (suspend && v.id === store.defaultVenueId()) {
    return res.status(400).json({ error: 'The platform home venue cannot suspend itself' });
  }
  v.suspended = suspend;
  if (suspend) {
    // Members are signed out everywhere immediately; the venue's screens
    // deliberately keep playing — suspension is a dashboard/API lock, not
    // a kill switch for TVs in a public space.
    const memberIds = new Set(store.data.users
      .filter(u => u.venueId === v.id && u.platformAdmin !== true)
      .map(u => u.id));
    store.data.settings.tokens = store.data.settings.tokens.filter(t => !memberIds.has(t.userId));
    for (const ws of dashboardSockets) {
      if (memberIds.has(ws.userId)) { try { ws.close(4001, 'venue suspended'); } catch {} }
    }
  }
  store.save();
  res.json({ ok: true, suspended: v.suspended });
});

// Governance boundary: platform admins manage venues and ACCESS — never
// content. There is deliberately no way to mint a session inside a vendor
// venue, so vendor media, screens, playlists, and parties stay theirs alone
// (the venue list above exposes counts only).

app.get('/api/admin/venues/:id/members', requireAuth, requireAdmin, (req, res) => {
  const v = store.venue(req.params.id);
  if (!v) return res.status(404).json({ error: 'No such venue' });
  res.json({ members: store.data.users
    .filter(u => u.venueId === v.id)
    .map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role,
      disabled: u.disabled === true, platformAdmin: u.platformAdmin === true,
      createdAt: u.createdAt })) });
});

// Give a venue a (new) owner — e.g. after its previous owner left.
app.post('/api/admin/venues/:id/owner', requireAuth, requireAdmin, (req, res) => {
  const v = store.venue(req.params.id);
  if (!v) return res.status(404).json({ error: 'No such venue' });
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (store.userByEmail(cleanEmail)) return res.status(400).json({ error: 'That email already has an account' });
  if (store.data.users.length >= 500) return res.status(429).json({ error: 'Account limit reached' });
  store.data.users.push({
    id: crypto.randomUUID(), email: cleanEmail, passHash: hashPassword(password),
    name: '', venueId: v.id, role: 'owner', createdAt: new Date().toISOString()
  });
  store.save();
  res.json({ ok: true });
});

// Account governance: role, password reset, service access, platform admin.
// Everything validates before applying; nobody edits their own access.
app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const user = store.user(req.params.id);
  if (!user) return res.status(404).json({ error: 'No such user' });
  if (user.id === req.userId) return res.status(400).json({ error: 'You cannot change your own access — ask another platform admin' });
  const { role, password, disabled, platformAdmin } = req.body || {};
  if (role !== undefined && role !== 'owner' && role !== 'staff') {
    return res.status(400).json({ error: 'Role must be owner or staff' });
  }
  if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (disabled !== undefined && typeof disabled !== 'boolean') {
    return res.status(400).json({ error: 'disabled must be true or false' });
  }
  if (platformAdmin !== undefined && typeof platformAdmin !== 'boolean') {
    return res.status(400).json({ error: 'platformAdmin must be true or false' });
  }
  if (role !== undefined) user.role = role;
  if (password !== undefined) { user.passHash = hashPassword(password); revokeSessions(user.id); }
  if (disabled !== undefined) {
    user.disabled = disabled;
    if (disabled) revokeSessions(user.id); // out, everywhere, now
  }
  if (platformAdmin !== undefined) user.platformAdmin = platformAdmin;
  store.save();
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const user = store.user(req.params.id);
  if (!user) return res.status(404).json({ error: 'No such user' });
  if (user.id === req.userId) return res.status(400).json({ error: 'You cannot remove yourself' });
  store.data.users = store.data.users.filter(u => u.id !== user.id);
  revokeSessions(user.id);
  store.save();
  res.json({ ok: true });
});

// ---- Player registration (no auth) ----
function nextTvName(venueId) {
  // Lowest unused number within the venue, so deleting "TV 7" and re-pairing
  // never creates a duplicate name (booking rows target TVs by name).
  const names = new Set(store.tvsOf(venueId).map(t => t.name));
  let n = 1;
  while (names.has(`TV ${n}`)) n++;
  return `TV ${n}`;
}

// A pairing code no other waiting screen is showing (collisions would let
// a claim grab the wrong TV).
function freshPairCode() {
  for (;;) {
    const code = String(100000 + crypto.randomInt(900000));
    if (!store.data.tvs.some(t => !t.venueId && t.pairCode === code)) return code;
  }
}

// Registration is necessarily unauthenticated (it IS the pairing step), so
// new-screen creation is rate limited per IP to keep junk rows bounded.
const registerAttempts = new Map(); // ip -> { count, resetAt }
function registerLimited(ip) {
  const now = Date.now();
  const entry = registerAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    registerAttempts.set(ip, { count: 1, resetAt: now + 60 * 60_000 });
    if (registerAttempts.size > 10000) {
      for (const [k, v] of registerAttempts) if (now > v.resetAt) registerAttempts.delete(k);
    }
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

app.post('/api/player/register', (req, res) => {
  const { existingId } = req.body || {};
  let tv = existingId ? store.tv(existingId) : null;
  if (!tv) {
    if (registerLimited(req.ip)) {
      return res.status(429).json({ error: 'Too many new screens from this network — try again in an hour' });
    }
    if (store.data.tvs.length >= 500) {
      return res.status(429).json({ error: 'Screen limit reached' });
    }
    // Cloud mode: the screen starts unclaimed and shows a pairing code; an
    // operator types that code in their dashboard to pull it into their
    // venue. On a LAN (approval unset) it joins the default venue instantly.
    const cloud = REQUIRE_TV_APPROVAL;
    tv = {
      id: crypto.randomUUID(),
      venueId: cloud ? null : store.defaultVenueId(),
      name: cloud ? 'New screen' : nextTvName(store.defaultVenueId()),
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      power: 'on',
      approved: !cloud,
      pairCode: freshPairCode(),
      pairCodeAt: Date.now(),
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

// Pairing-pool maintenance: codes rotate so they can't be brute-forced over
// time, and screens nobody ever claims don't pile up against the cap. A
// still-connected screen just shows its new code; an abandoned row (no
// heartbeat for a day) is dropped — the player re-registers if it returns.
const PAIR_CODE_TTL = 15 * 60_000;
const UNCLAIMED_TTL = 24 * 60 * 60_000;
setInterval(() => {
  let changed = false;
  // Retention: finished parties carry children's first names — they don't
  // need to sit in the database forever. 30 days covers any dispute window.
  const cutoff = Date.now() - 30 * 86_400_000;
  const before = store.data.events.length;
  store.data.events = store.data.events.filter(e =>
    e.status !== 'done' || Date.parse(e.startsAt) > cutoff);
  if (store.data.events.length !== before) changed = true;
  const keep = [];
  for (const tv of store.data.tvs) {
    if (tv.venueId) { keep.push(tv); continue; }
    if (Date.now() - Date.parse(tv.lastSeen || tv.createdAt) > UNCLAIMED_TTL) { changed = true; continue; }
    if (Date.now() - (tv.pairCodeAt || 0) > PAIR_CODE_TTL) {
      tv.pairCode = freshPairCode();
      tv.pairCodeAt = Date.now();
      changed = true;
      keep.push(tv);
      pushTv(tv.id);
    } else keep.push(tv);
  }
  if (changed) { store.data.tvs = keep; store.save(); }
}, 60_000).unref();

// Claiming is rate limited per account: six-digit codes only stay safe if
// nobody gets to guess a million of them.
const claimAttempts = new Map(); // userId -> { count, resetAt }
function claimLimited(userId) {
  const now = Date.now();
  const entry = claimAttempts.get(userId);
  if (!entry || now > entry.resetAt) {
    claimAttempts.set(userId, { count: 1, resetAt: now + 15 * 60_000 });
    return false;
  }
  entry.count++;
  return entry.count > 20;
}

// Claim an unpaired screen into the caller's venue by its on-screen code.
app.post('/api/tvs/claim', requireAuth, (req, res) => {
  if (claimLimited(req.userId)) {
    return res.status(429).json({ error: 'Too many attempts — wait 15 minutes and read the code off the TV again' });
  }
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (code.length !== 6) return res.status(400).json({ error: 'Enter the 6-digit code shown on the TV' });
  const tv = store.data.tvs.find(t => !t.venueId && t.pairCode === code);
  if (!tv) return res.status(404).json({ error: 'No waiting screen has that code — check the TV and try again' });
  if (store.tvsOf(req.venueId).length >= 100) {
    return res.status(429).json({ error: 'This venue has reached its 100-screen limit' });
  }
  claimAttempts.delete(req.userId);
  tv.venueId = req.venueId;
  tv.approved = true;
  tv.name = nextTvName(req.venueId);
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true, tv: { id: tv.id, name: tv.name } });
});

// ---- Dashboard API ----
app.get('/api/state', requireAuth, (req, res) => res.json(dashboardSnapshot(req.venueId)));

app.patch('/api/tvs/:id', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!owned(req, tv)) return res.status(404).json({ error: 'No such TV' });
  const { name, fit } = req.body || {};
  if (typeof name === 'string' && name.trim()) {
    const clean = name.trim().slice(0, 60);
    // Names must stay unique per venue: booking imports route parties to
    // screens BY NAME, and a duplicate would send a birthday to the wrong room.
    const clash = store.tvsOf(req.venueId).find(t => t.id !== tv.id && normalizeLabel(t.name) === normalizeLabel(clean));
    if (clash) return res.status(400).json({ error: `Another screen is already named "${clash.name}"` });
    tv.name = clean;
  }
  if (fit === 'contain' || fit === 'cover') tv.fit = fit;
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/tvs/:id/approve', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!owned(req, tv)) return res.status(404).json({ error: 'No such TV' });
  tv.approved = true;
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

app.delete('/api/tvs/:id', requireAuth, requireOwner, (req, res) => {
  const i = store.data.tvs.findIndex(t => t.id === req.params.id && t.venueId === req.venueId);
  if (i === -1) return res.status(404).json({ error: 'No such TV' });
  const [tv] = store.data.tvs.splice(i, 1);
  for (const ws of playerSockets.get(tv.id) || []) ws.close();
  playerSockets.delete(tv.id);
  // Cascade: parties scheduled for a screen that no longer exists would sit
  // in the list and silently never play; active ones finish now.
  store.data.events = store.data.events.filter(e => !(e.tvId === tv.id && e.status === 'scheduled'));
  for (const e of store.data.events) if (e.tvId === tv.id && e.status === 'active') e.status = 'done';
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/tvs/:id/assign', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!owned(req, tv)) return res.status(404).json({ error: 'No such TV' });
  const { mediaIds } = req.body || {};
  if (!Array.isArray(mediaIds)) return res.status(400).json({ error: 'mediaIds must be an array' });
  tv.assignedMediaIds = mediaIds.filter(id => owned(req, store.medium(id)));
  tv.playlistId = null; // a custom selection takes the TV off any named playlist
  store.save();
  pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/tvs/:id/power', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!owned(req, tv)) return res.status(404).json({ error: 'No such TV' });
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
  if (!owned(req, tv)) return res.status(404).json({ error: 'No such TV' });
  const { name, durationMin, theme } = req.body || {};
  const dur = Math.min(Math.max(parseFloat(durationMin) || 1, 0.2), 240);
  tv.override = {
    eventId: null,
    name: (name || 'Test').toString().slice(0, 60),
    message: null,
    mediaId: null,
    endsAt: new Date(Date.now() + dur * 60_000).toISOString(),
    theme: resolveTheme(theme, store.venue(req.venueId)?.customThemes || []) || 'party',
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
  if (!owned(req, tv)) return res.status(404).json({ error: 'No such TV' });
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
// Multer hands filenames over latin1-decoded; re-decode so uploads with
// accents, dashes, or any non-ASCII name keep a readable label.
const fixName = name => {
  try { return Buffer.from(String(name), 'latin1').toString('utf8'); }
  catch { return String(name); }
};
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
    const original = fixName(req.file.originalname);
    const m = {
      id: path.basename(req.file.filename, ext),
      label: (req.body.label || original.replace(/\.[^.]+$/, '')).slice(0, 80),
      originalName: original,
      ext,
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
      venueId: req.venueId,
      folderId: validFolderId(req.venueId, req.body.folderId)
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
  const clash = store.foldersOf(req.venueId).find(f => f.id !== id && normalizeLabel(f.name) === normalizeLabel(clean));
  if (clash) return res.status(400).json({ error: `A folder named "${clash.name}" already exists` });
  let f = id ? store.data.folders.find(x => x.id === id && x.venueId === req.venueId) : null;
  // A rename aimed at a folder that no longer exists must fail loudly, not
  // silently fork a new folder (same contract as playlists).
  if (id && !f) return res.status(404).json({ error: 'That folder no longer exists — refresh and try again' });
  if (!f) {
    if (store.foldersOf(req.venueId).length >= 50) return res.status(400).json({ error: 'Folder limit reached' });
    f = { id: crypto.randomUUID(), venueId: req.venueId, name: clean };
    store.data.folders.push(f);
  } else {
    f.name = clean;
  }
  store.save();
  pushDashboards();
  res.json({ ok: true, folder: f });
});

app.delete('/api/folders/:id', requireAuth, requireOwner, (req, res) => {
  const i = store.data.folders.findIndex(f => f.id === req.params.id && f.venueId === req.venueId);
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
  if (id && !owned(req, m)) return res.status(404).json({ error: 'No such media' });
  if (m && !m.slide) return res.status(400).json({ error: 'That media is a file, not a slide' });
  if (!m) {
    m = {
      id: crypto.randomUUID(),
      venueId: req.venueId,
      label: '', originalName: null, ext: '', size: 0,
      uploadedAt: new Date().toISOString()
    };
    store.data.media.push(m);
  }
  m.slide = clean;
  if (folderId !== undefined) m.folderId = validFolderId(req.venueId, folderId);
  if (typeof label === 'string' && label.trim()) m.label = label.trim().slice(0, 80);
  if (!m.label) m.label = clean.headline.slice(0, 40);
  const d = parseFloat(durationSec);
  if (Number.isFinite(d)) m.durationSec = Math.min(Math.max(d, 1), 3600);
  store.save();
  pushVenueTvs(req.venueId);
  pushDashboards();
  res.json({ ok: true, media: mediaPublic(m) });
});

// ---- Layout designs (compositions: positioned text/image/video/box
// elements on one 16:9 canvas, rendered natively by the player) ----
const okHex = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
const num = (v, lo, hi, dflt) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
};

// Validate and normalize a composition. Returns { comp } or { error }.
function cleanComp(raw, venueId) {
  if (!raw || typeof raw !== 'object') return { error: 'Missing design data' };
  const bgColors = Array.isArray(raw.bg?.colors) ? raw.bg.colors.filter(okHex).slice(0, 2) : [];
  if (bgColors.length === 0) return { error: 'Pick a background color' };
  const src = Array.isArray(raw.elements) ? raw.elements.slice(0, 12) : [];
  const elements = [];
  let videos = 0;
  for (const e of src) {
    if (!e || typeof e !== 'object') continue;
    const base = {
      type: e.type,
      x: num(e.x, 0, 98, 5), y: num(e.y, 0, 98, 5),
      w: num(e.w, 2, 100, 30), h: num(e.h, 2, 100, 20),
      z: Math.round(num(e.z, 0, 20, 0)),
      rot: Math.round(num(e.rot, 0, 359, 0))
    };
    if (e.type === 'text') {
      const text = String(e.text ?? '').slice(0, 300);
      if (!text.trim()) continue;
      elements.push({ ...base, text,
        size: num(e.size, 1, 30, 6),
        weight: [400, 700, 900].includes(+e.weight) ? +e.weight : 700,
        color: okHex(e.color) ? e.color : '#ffffff',
        align: ['left', 'center', 'right'].includes(e.align) ? e.align : 'center',
        boxBg: okHex(e.boxBg) ? e.boxBg : null });
    } else if (e.type === 'image' || e.type === 'video') {
      const m = store.medium(e.mediaId);
      if (!m || m.venueId !== venueId) return { error: 'A placed photo/video no longer exists in the library' };
      if (mediaType(m) !== e.type) return { error: `"${m.label}" is not a ${e.type === 'image' ? 'photo' : 'video'}` };
      if (e.type === 'video' && ++videos > 1) return { error: 'One video per design — TV boxes can only decode one smoothly' };
      elements.push({ ...base, mediaId: e.mediaId,
        fit: e.fit === 'contain' ? 'contain' : 'cover',
        radius: num(e.radius, 0, 50, 0) });
    } else if (e.type === 'box') {
      elements.push({ ...base,
        color: okHex(e.color) ? e.color : '#000000',
        radius: num(e.radius, 0, 50, 0) });
    }
  }
  if (elements.length === 0) return { error: 'Add at least one element to the design' };
  return { comp: { bg: { colors: bgColors }, elements } };
}

app.post('/api/comps', requireAuth, (req, res) => {
  const { id, label, durationSec, folderId, comp } = req.body || {};
  const cleaned = cleanComp(comp, req.venueId);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });
  let m = id ? store.medium(id) : null;
  if (id && !owned(req, m)) return res.status(404).json({ error: 'No such media' });
  if (m && !m.comp) return res.status(400).json({ error: 'That media is not a layout design' });
  if (!m) {
    m = {
      id: crypto.randomUUID(),
      venueId: req.venueId,
      label: '', originalName: null, ext: '', size: 0,
      uploadedAt: new Date().toISOString(),
      folderId: validFolderId(req.venueId, folderId)
    };
    store.data.media.push(m);
  }
  m.comp = cleaned.comp;
  if (typeof label === 'string' && label.trim()) m.label = label.trim().slice(0, 80);
  if (!m.label) m.label = 'Design';
  const d = parseFloat(durationSec);
  if (Number.isFinite(d)) m.durationSec = Math.min(Math.max(d, 1), 3600);
  store.save();
  pushVenueTvs(req.venueId);
  pushDashboards();
  res.json({ ok: true, media: mediaPublic(m) });
});

// Swap the file behind an existing photo/video while keeping its identity —
// it stays in every playlist and assignment, and screens refresh instantly.
app.post('/api/media/:id/replace', requireAuth, requireOwner, (req, res) => {
  const m = store.medium(req.params.id);
  if (!owned(req, m)) return res.status(404).json({ error: 'No such media' });
  if (m.slide || m.comp) return res.status(400).json({ error: 'Slides and designs are edited in the dashboard, not replaced' });
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const oldPath = path.join(MEDIA_DIR, (m.fileId || m.id) + m.ext);
    const ext = path.extname(req.file.filename);
    m.fileId = path.basename(req.file.filename, ext);
    m.ext = ext;
    m.size = req.file.size;
    m.originalName = fixName(req.file.originalname);
    try { fs.unlinkSync(oldPath); } catch {}
    store.save();
    pushVenueTvs(req.venueId);
    pushDashboards();
    res.json({ ok: true, media: mediaPublic(m) });
  });
});

app.patch('/api/media/:id', requireAuth, (req, res) => {
  const m = store.medium(req.params.id);
  if (!owned(req, m)) return res.status(404).json({ error: 'No such media' });
  const { label, durationSec, folderId } = req.body || {};
  if (typeof label === 'string' && label.trim()) m.label = label.trim().slice(0, 80);
  if (folderId !== undefined) m.folderId = validFolderId(req.venueId, folderId);
  if (durationSec !== undefined) {
    const d = parseFloat(durationSec);
    if (Number.isFinite(d)) m.durationSec = Math.min(Math.max(d, 1), 3600);
  }
  store.save();
  pushVenueTvs(req.venueId);
  pushDashboards();
  res.json({ ok: true });
});

app.delete('/api/media/:id', requireAuth, requireOwner, (req, res) => {
  const i = store.data.media.findIndex(m => m.id === req.params.id && m.venueId === req.venueId);
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
  // Designs referencing the deleted photo/video lose that element (never the
  // whole design); screens re-render from the pushed state.
  let compsTouched = false;
  for (const other of store.data.media) {
    if (other.comp && other.comp.elements.some(el => el.mediaId === m.id)) {
      other.comp.elements = other.comp.elements.filter(el => el.mediaId !== m.id);
      compsTouched = true;
    }
  }
  if (!m.slide && !m.comp) { try { fs.unlinkSync(path.join(MEDIA_DIR, (m.fileId || m.id) + m.ext)); } catch {} }
  store.save();
  if (compsTouched) pushVenueTvs(req.venueId);
  else for (const id of touched) pushTv(id);
  pushDashboards();
  res.json({ ok: true });
});

// Assign the same media selection to every TV in one shot.
app.post('/api/assign-all', requireAuth, (req, res) => {
  const { mediaIds } = req.body || {};
  if (!Array.isArray(mediaIds)) return res.status(400).json({ error: 'mediaIds must be an array' });
  const clean = mediaIds.filter(id => owned(req, store.medium(id)));
  for (const tv of store.tvsOf(req.venueId)) { tv.assignedMediaIds = [...clean]; tv.playlistId = null; }
  store.save();
  pushVenueTvs(req.venueId);
  pushDashboards();
  res.json({ ok: true });
});

// ---- Playlists ----
function cleanPlaylistItems(req, items) {
  return (Array.isArray(items) ? items : [])
    .filter(it => it && owned(req, store.medium(it.mediaId)))
    .slice(0, 100)
    .map(it => {
      const d = parseFloat(it.durationSec);
      return {
        mediaId: it.mediaId,
        enabled: it.enabled !== false,
        // 0 clamps to the 1s minimum instead of silently becoming the default
        durationSec: Math.min(Math.max(Number.isFinite(d) ? d : 8, 1), 3600)
      };
    });
}

app.post('/api/playlists', requireAuth, (req, res) => {
  const { id, name, transition, items } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Playlist needs a name' });
  // An explicit id that doesn't exist is a stale edit, not a create — forking
  // a new playlist here would silently duplicate content.
  if (id && !owned(req, store.playlist(id))) return res.status(404).json({ error: 'No such playlist — it may have been deleted' });
  const pl = {
    id: id || crypto.randomUUID(),
    venueId: req.venueId,
    name: String(name).trim().slice(0, 60),
    transition: transition === 'fade' ? 'fade' : 'none',
    items: cleanPlaylistItems(req, items)
  };
  const i = store.data.playlists.findIndex(p => p.id === pl.id);
  if (i === -1) store.data.playlists.push(pl); else store.data.playlists[i] = pl;
  store.save();
  for (const tv of store.tvsOf(req.venueId)) if (tv.playlistId === pl.id) pushTv(tv.id);
  pushDashboards();
  res.json({ ok: true, playlist: pl });
});

app.delete('/api/playlists/:id', requireAuth, requireOwner, (req, res) => {
  const i = store.data.playlists.findIndex(p => p.id === req.params.id && p.venueId === req.venueId);
  if (i === -1) return res.status(404).json({ error: 'No such playlist' });
  store.data.playlists.splice(i, 1);
  for (const tv of store.tvsOf(req.venueId)) {
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
  if (!owned(req, store.playlist(req.params.id))) return res.status(404).json({ error: 'No such playlist' });
  for (const tv of store.tvsOf(req.venueId)) tv.playlistId = req.params.id;
  store.save();
  pushVenueTvs(req.venueId);
  pushDashboards();
  res.json({ ok: true });
});

// Point a TV at a playlist (playlistId: null reverts to its custom selection).
app.post('/api/tvs/:id/playlist', requireAuth, (req, res) => {
  const tv = store.tv(req.params.id);
  if (!owned(req, tv)) return res.status(404).json({ error: 'No such TV' });
  const { playlistId } = req.body || {};
  if (playlistId !== null && !owned(req, store.playlist(playlistId))) {
    return res.status(404).json({ error: 'No such playlist' });
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
  const themes = store.venue(req.venueId).customThemes;
  // An edit aimed at a deleted theme fails loudly instead of forking a copy.
  if (id && !themes.some(c => c.id === id)) {
    return res.status(404).json({ error: 'That theme no longer exists — refresh and try again' });
  }
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
  for (const tv of store.tvsOf(req.venueId)) {
    if (tv.override && tv.override.theme === `custom:${theme.id}`) pushTv(tv.id);
  }
  pushDashboards();
  res.json({ ok: true, theme });
});

app.delete('/api/themes/:id', requireAuth, requireOwner, (req, res) => {
  const themes = store.venue(req.venueId).customThemes;
  const i = themes.findIndex(c => c.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'No such theme' });
  const key = `custom:${themes[i].id}`;
  themes.splice(i, 1);
  for (const ev of store.eventsOf(req.venueId)) if (ev.theme === key) ev.theme = 'party';
  for (const tv of store.tvsOf(req.venueId)) {
    if (tv.override && tv.override.theme === key) { tv.override.theme = 'party'; pushTv(tv.id); }
  }
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/settings', requireAuth, requireOwner, (req, res) => {
  const { venueName: newVenueName, tz } = req.body || {};
  if (newVenueName !== undefined && !String(newVenueName).trim()) {
    return res.status(400).json({ error: 'Venue name cannot be empty' });
  }
  if (tz !== undefined && tz !== null && tz !== '' && !isValidTz(tz)) {
    return res.status(400).json({ error: 'Unknown timezone' });
  }
  const venue = store.venue(req.venueId);
  if (newVenueName !== undefined) {
    venue.name = String(newVenueName).trim().slice(0, 60);
    for (const tv of store.tvsOf(req.venueId)) pushTv(tv.id); // subline updates immediately
  }
  if (tz !== undefined) venue.tz = tz || null; // imported party times use this zone
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
    const venue = store.venue(req.venueId);
    const { events, errors } = parseEventsCsv(req.file.buffer.toString('utf8'),
      store.tvsOf(req.venueId), store.mediaOf(req.venueId),
      venue.customThemes, venue.tz || null);
    if (events.length === 0) {
      // Nothing valid in the file (wrong file, bad headers): never wipe the
      // existing schedule on a failed import.
      return res.json({
        ok: true, imported: 0, kept: true,
        errors: errors.length ? errors : [{ line: 0, error: 'No valid rows found' }]
      });
    }
    // Replace still-scheduled events, but ONLY rows this importer owns
    // (source 'csv') and only for the dates present in this file — a re-import
    // must never delete manually-added, ROLLER, or test-import parties, and
    // pre-loading tomorrow's CSV must not delete tonight's. Active/done
    // events are history and always stay.
    const newDates = new Set(events.map(e => new Date(e.startsAt).toDateString()));
    store.data.events = store.data.events.filter(e =>
      e.venueId !== req.venueId || e.source !== 'csv' || e.status !== 'scheduled' ||
      !newDates.has(new Date(e.startsAt).toDateString()));
    for (const e of events) {
      store.data.events.push({
        id: crypto.randomUUID(),
        venueId: req.venueId,
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
  if (!owned(req, tv)) return res.status(404).json({ error: 'No such TV' });
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
    const m = matchMedia(store.mediaOf(req.venueId), mediaLabel);
    if (m) mediaId = m.id;
  }
  // Same contract as PATCH: an explicitly given unknown theme is an error,
  // not a silent fallback to party.
  let cleanDuration = 5;
  if (durationMin !== undefined && durationMin !== null && durationMin !== '') {
    const d = parseFloat(durationMin);
    if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: 'Duration must be a positive number of minutes' });
    cleanDuration = Math.min(Math.max(d, 0.2), 240);
  }
  const cleanTheme = resolveTheme(theme, store.venue(req.venueId).customThemes);
  if (theme && !cleanTheme) return res.status(400).json({ error: 'Unknown theme' });
  const ev = {
    id: crypto.randomUUID(),
    venueId: req.venueId,
    tvId,
    name: String(name).trim().slice(0, 60),
    age: cleanAge,
    message: message ? String(message).slice(0, 120) : null,
    startsAt: new Date(start).toISOString(),
    durationMin: cleanDuration,
    mediaId,
    theme: cleanTheme || 'party',
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
  if (!owned(req, ev)) return res.status(404).json({ error: 'No such event' });
  const { name, age, message, theme, tvId, startsAt, durationMin } = req.body || {};
  // Two passes — validate everything, THEN apply — so a request that fails
  // any field changes nothing (a half-applied edit persists silently).
  const apply = {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    apply.name = String(name).trim().slice(0, 60);
  }
  if (age !== undefined) {
    if (age === null || age === '') apply.age = null;
    else {
      const a = parseInt(age, 10);
      if (!Number.isFinite(a) || a < 1 || a > 99) return res.status(400).json({ error: 'Age must be 1–99 (or blank)' });
      apply.age = a;
    }
  }
  if (message !== undefined) apply.message = message ? String(message).slice(0, 120) : null;
  if (theme !== undefined) {
    const t = resolveTheme(theme, store.venue(req.venueId).customThemes);
    if (!t) return res.status(400).json({ error: 'Unknown theme' });
    apply.theme = t;
  }
  if (tvId !== undefined) {
    if (!owned(req, store.tv(tvId))) return res.status(404).json({ error: 'No such TV' });
    apply.tvId = tvId;
  }
  if (startsAt !== undefined) {
    const t = Date.parse(startsAt);
    if (!Number.isFinite(t)) return res.status(400).json({ error: 'Bad start time' });
    apply.startsAt = new Date(t).toISOString();
  }
  if (durationMin !== undefined) {
    const d = parseFloat(durationMin);
    if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: 'Bad duration' });
    apply.durationMin = Math.min(Math.max(d, 0.2), 240);
  }
  Object.assign(ev, apply);
  // If this party is on screen right now, the edit reaches the screen live —
  // including a moved room and a changed end time.
  if (ev.status === 'active') {
    const holder = store.tvsOf(req.venueId).find(t => t.override && t.override.eventId === ev.id);
    const endMs = Date.parse(ev.startsAt) + ev.durationMin * 60_000;
    if (Date.now() >= endMs) {
      // The edited window is already over: finish the party cleanly instead
      // of leaving a takeover the scheduler will strand.
      ev.status = 'done';
      if (holder) {
        if (holder.override.restorePowerOff) holder.power = 'off';
        holder.override = null;
        pushTv(holder.id);
      }
    } else {
      const target = store.tv(ev.tvId);
      if (holder && target && holder.id !== target.id) {
        // Party moved rooms mid-takeover: clear the old screen, take the new.
        if (holder.override.restorePowerOff) holder.power = 'off';
        holder.override = null;
        pushTv(holder.id);
      }
      if (target) {
        const prev = (holder && holder.id === target.id) ? holder.override : null;
        target.override = {
          eventId: ev.id,
          name: ev.name,
          message: ev.message || defaultBirthdayMessage(ev),
          mediaId: prev ? prev.mediaId : (ev.mediaId || null),
          endsAt: new Date(endMs).toISOString(),
          theme: ev.theme || 'party',
          restorePowerOff: prev ? prev.restorePowerOff : target.power === 'off'
        };
        target.power = 'on';
        pushTv(target.id);
      }
    }
  }
  store.data.events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  store.save();
  pushDashboards();
  res.json({ ok: true, event: ev });
});

app.delete('/api/events/:id', requireAuth, (req, res) => {
  const i = store.data.events.findIndex(e => e.id === req.params.id && e.venueId === req.venueId);
  if (i === -1) return res.status(404).json({ error: 'No such event' });
  const [ev] = store.data.events.splice(i, 1);
  // Clear the takeover from WHICHEVER TV holds it — after a mid-takeover
  // room move the holder can differ from ev.tvId.
  for (const tv of store.data.tvs) {
    if (tv.override && tv.override.eventId === ev.id) {
      if (tv.override.restorePowerOff) tv.power = 'off';
      tv.override = null;
      pushTv(tv.id);
    }
  }
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/events/:id/start-now', requireAuth, (req, res) => {
  const ev = store.event(req.params.id);
  if (!owned(req, ev)) return res.status(404).json({ error: 'No such event' });
  ev.startsAt = new Date().toISOString();
  ev.status = 'scheduled';
  store.data.events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  store.save();
  scheduler.tick();
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/events/clear-done', requireAuth, (req, res) => {
  store.data.events = store.data.events.filter(e => e.venueId !== req.venueId || e.status !== 'done');
  store.save();
  pushDashboards();
  res.json({ ok: true });
});

// ---- ROLLER connection ----
app.get('/api/roller/status', requireAuth, (req, res) => res.json(rollerStatus()));

app.post('/api/roller/sync', requireAuth, async (req, res) => {
  // The env-var ROLLER credentials belong to ONE venue (the default one).
  // Any other venue syncing with them would import that venue's bookings —
  // children's names and party times — into their own list.
  if (req.venueId !== store.defaultVenueId()) {
    return res.status(403).json({ error: 'ROLLER is connected per venue — contact support to connect yours' });
  }
  try {
    const result = await rollerSync(store, { matchTv, days: 7, venueId: req.venueId, tz: store.venue(req.venueId).tz || null }); // this week's parties
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
      const tv = matchTv(store.tvsOf(req.venueId), get(iRoom));
      if (!tv) { errors.push({ line, error: `No TV matches room "${get(iRoom)}"` }); continue; }
      const byline = get(iByline);
      if (!byline) { errors.push({ line, error: 'Empty byline' }); continue; }
      const parsed = parseByline(byline);
      let durationMin = parseFloat(get(iDur));
      if (!Number.isFinite(durationMin) || durationMin <= 0) durationMin = 5;
      imported.push({
        id: crypto.randomUUID(),
        venueId: req.venueId,
        tvId: tv.id,
        // The parse pre-fills; the Parties page keeps every field editable.
        name: parsed.name || 'Birthday Star',
        age: parsed.age,
        message: null,
        startsAt: zonedTimeToUtc(date.y, date.mo, date.d, time.h, time.min, store.venue(req.venueId).tz || null).toISOString(),
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
        e.venueId !== req.venueId || e.source !== 'test-csv' || e.status !== 'scheduled' ||
        !newDates.has(new Date(e.startsAt).toDateString()));
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
  store.venue(req.venueId).dayStarted = true;
  for (const tv of store.tvsOf(req.venueId)) tv.power = 'on';
  store.save();
  pushVenueTvs(req.venueId);
  pushDashboards();
  res.json({ ok: true });
});

app.post('/api/day/end', requireAuth, (req, res) => {
  store.venue(req.venueId).dayStarted = false;
  for (const tv of store.tvsOf(req.venueId)) {
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
  pushVenueTvs(req.venueId);
  pushDashboards();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------
const server = http.createServer(app);
// A 3GB video over venue Wi-Fi takes far longer than Node's default
// 5-minute whole-request deadline, but this server is public — a fully
// disabled deadline lets a trickled body hold a connection forever. One
// hour covers any realistic upload; multer enforces the size limit.
server.requestTimeout = 60 * 60_000;
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
      const session = sessionFor(msg.token);
      if (!session) { ws.close(4001, 'bad token'); return; }
      ws.role = 'dashboard';
      ws.userId = session.userId;
      ws.venueId = session.venueId;
      dashboardSockets.add(ws);
      ws.send(JSON.stringify(dashboardSnapshot(session.venueId)));
    } else if (msg.type === 'status' && ws.role === 'player' && ws.tvId) {
      const tv = store.tv(ws.tvId);
      if (!tv) return;
      tv.lastSeen = new Date().toISOString();
      const nowPlaying = typeof msg.nowPlaying === 'string' ? msg.nowPlaying.slice(0, 120) : null;
      const changed = tv.nowPlaying !== nowPlaying;
      tv.nowPlaying = nowPlaying;
      // Persist heartbeats at most once a minute per TV — every 10s status
      // from every screen was rewriting the whole db.json continuously.
      if (changed || !tv._seenSavedAt || Date.now() - tv._seenSavedAt > 60_000) {
        tv._seenSavedAt = Date.now();
        store.save();
      }
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
  console.log(`ParkCast server running on port ${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard/`);
  console.log(`  Player:    http://localhost:${PORT}/player/`);
  for (const a of lanAddresses()) {
    console.log(`  On your network: http://${a}:${PORT}/dashboard/  (players: http://${a}:${PORT}/player/)`);
  }
  // The password is printed ONLY when this boot generated it (first run on
  // a fresh database, where the operator has no other way to learn it).
  // Cloud platforms retain stdout logs — an env-configured password must
  // never appear there.
  if (process.env.ADMIN_PASSWORD) {
    console.log('  Dashboard password: (set via ADMIN_PASSWORD environment variable)');
  } else {
    console.log(`  Dashboard password: ${ADMIN_PASSWORD}  (auto-generated; set the ADMIN_PASSWORD environment variable to choose your own)`);
  }
});

process.on('SIGINT', () => { try { store.saveNow(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { store.saveNow(); } catch {} process.exit(0); });
