import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = () => ({
  tvs: [],      // { id, name, createdAt, lastSeen, power: 'on'|'off', assignedMediaIds: [], override: null }
  media: [],    // { id, label, originalName, ext, size, uploadedAt }
  events: [],   // { id, tvId, name, message, startsAt, durationMin, mediaId, status: 'scheduled'|'active'|'done', source }
  settings: {
    birthdayMediaId: null,
    dayStarted: true,
    tokens: []  // recent dashboard auth tokens (survive restarts)
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
  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 150);
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
}
