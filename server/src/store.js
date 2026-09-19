import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULTS = () => ({
  venues: [],   // { id, name, dayStarted, customThemes, createdAt } — one per customer workspace
  users: [],    // { id, email, passHash, name, venueId, role, createdAt }
  tvs: [],      // { id, venueId, name, createdAt, lastSeen, power, assignedMediaIds, playlistId, override }
  media: [],    // { id, venueId, label, originalName, ext, size, uploadedAt, durationSec, folderId, slide?, comp? }
  folders: [],  // { id, venueId, name } — single-level media library folders
  playlists: [], // { id, venueId, name, transition: 'none'|'fade', items: [{ mediaId, enabled, durationSec }] }
  events: [],   // { id, venueId, tvId, name, age, message, startsAt, durationMin, mediaId, theme, status, source }
  settings: {
    adminPassword: null, // generated on first boot unless ADMIN_PASSWORD env is set (legacy default-venue login)
    tokens: []           // dashboard sessions: { token, userId } (legacy plain strings map to the default venue owner)
  }
});

export class Store {
  constructor(file) {
    this.file = file;
    this.data = DEFAULTS();
    this._saveTimer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data = { ...DEFAULTS(), ...loaded, settings: { ...DEFAULTS().settings, ...(loaded.settings || {}) } };
      } catch (err) {
        // Corrupt db: keep a backup and start fresh rather than crash-looping.
        const backup = file + '.corrupt-' + Date.now();
        try { fs.copyFileSync(file, backup); } catch {}
        console.error(`db.json unreadable (${err.message}); backed up to ${backup}, starting fresh`);
        this.data = DEFAULTS();
      }
    }
    this.migrate();
  }

  // Single-venue databases (pre-multi-tenant) migrate in place: everything
  // that exists is adopted by a default venue, and per-venue settings move
  // off the global settings object.
  migrate() {
    const d = this.data;
    if (d.venues.length === 0) {
      const legacy = d.settings || {};
      d.venues.push({
        id: crypto.randomUUID(),
        name: legacy.venueName || 'Sky Zone Schaumburg',
        dayStarted: legacy.dayStarted !== false,
        customThemes: Array.isArray(legacy.customThemes) ? legacy.customThemes : [],
        createdAt: new Date().toISOString()
      });
      delete legacy.venueName;
      delete legacy.dayStarted;
      delete legacy.customThemes;
      this.saveNow();
    }
    const def = d.venues[0].id;
    let touched = false;
    for (const coll of ['tvs', 'media', 'folders', 'playlists', 'events']) {
      for (const item of d[coll]) {
        if (!item.venueId) { item.venueId = def; touched = true; }
      }
    }
    // Legacy plain-string tokens become sessions of the default venue owner.
    if (d.settings.tokens.some(t => typeof t === 'string')) {
      d.settings.tokens = d.settings.tokens.map(t =>
        typeof t === 'string' ? { token: t, userId: 'legacy-admin' } : t);
      touched = true;
    }
    if (touched) this.saveNow();
  }

  defaultVenueId() { return this.data.venues[0].id; }

  // Debounced save; multiple mutations in one tick produce a single write.
  // A failed write (full disk, permissions) must not crash the process from
  // inside the timer — log it and retry; the data stays live in memory.
  save(delay = 150) {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        this.saveNow();
      } catch (err) {
        console.error(`Could not write db.json (${err.message}) — retrying in 15s`);
        this.save(15000);
      }
    }, delay);
  }

  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  tv(id) { return this.data.tvs.find(t => t.id === id); }
  medium(id) { return this.data.media.find(m => m.id === id); }
  event(id) { return this.data.events.find(e => e.id === id); }
  playlist(id) { return this.data.playlists.find(p => p.id === id); }
  venue(id) { return this.data.venues.find(v => v.id === id); }
  userByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return this.data.users.find(u => u.email === e);
  }
  user(id) { return this.data.users.find(u => u.id === id); }

  // Venue-scoped views. Lookups by id stay global; LISTS are always scoped.
  tvsOf(v) { return this.data.tvs.filter(t => t.venueId === v); }
  mediaOf(v) { return this.data.media.filter(m => m.venueId === v); }
  foldersOf(v) { return this.data.folders.filter(f => f.venueId === v); }
  playlistsOf(v) { return this.data.playlists.filter(p => p.venueId === v); }
  eventsOf(v) { return this.data.events.filter(e => e.venueId === v); }
}
