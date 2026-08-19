import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = () => ({
  tvs: [],      // { id, name, createdAt, lastSeen, power, assignedMediaIds, playlistId, override }
  media: [],    // { id, label, originalName, ext, size, uploadedAt, durationSec (images) }
  playlists: [], // { id, name, transition: 'none'|'fade', items: [{ mediaId, enabled, durationSec }] }
  events: [],   // { id, tvId, name, message, startsAt, durationMin, mediaId, theme, status, source }
  settings: {
    birthdayMediaId: null,
    dayStarted: true,
    adminPassword: null, // generated on first boot unless ADMIN_PASSWORD env is set
    customThemes: [],    // user-built birthday themes: { id, name, bg, headline, confetti, emojis, elements }
    tokens: []           // recent dashboard auth tokens (survive restarts)
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
  }

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
}
