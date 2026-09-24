/* Copy one venue's CONTENT from an old ParkCast server to a new one.
 *
 *   OLD_URL=https://skyzone-tv.onrender.com OLD_PASSWORD=<admin password> \
 *   NEW_URL=https://parkcast.onrender.com NEW_EMAIL=you@example.com NEW_PASSWORD=<your password> \
 *   node scripts/migrate-service.js
 *
 * Migrates: folders, uploaded media (with labels, durations, folder
 * placement), text slides, layout designs (media references remapped),
 * playlists (order, transitions, per-item durations), custom themes, and
 * the venue name + timezone.
 *
 * Deliberately NOT migrated:
 *  - screens/TVs: their identities are issued by the server; each TV
 *    re-pairs on the new service with its 6-digit code (seconds per TV)
 *  - party events: re-import from ROLLER/CSV on the new service
 *  - accounts/passwords: sign-ups happen on the new service
 *
 * Run it ONCE against an empty venue. It aborts if the target venue
 * already has media (set FORCE=1 to override).
 *
 * Old-service sign-in: OLD_PASSWORD alone uses the legacy admin password;
 * set OLD_EMAIL too to sign in with a vendor account instead.
 */

const OLD_URL = (process.env.OLD_URL || '').replace(/\/$/, '');
const NEW_URL = (process.env.NEW_URL || '').replace(/\/$/, '');
const { OLD_EMAIL, OLD_PASSWORD, NEW_EMAIL, NEW_PASSWORD, FORCE } = process.env;

if (!OLD_URL || !NEW_URL || !OLD_PASSWORD || !NEW_EMAIL || !NEW_PASSWORD) {
  console.error('Required env vars: OLD_URL, OLD_PASSWORD (and OLD_EMAIL unless using the legacy admin password), NEW_URL, NEW_EMAIL, NEW_PASSWORD');
  process.exit(1);
}

async function api(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error || ''}`);
  return data;
}

const run = async () => {
  // sign in to both sides
  const oldTok = OLD_EMAIL
    ? (await api(OLD_URL, null, 'POST', '/api/signin', { email: OLD_EMAIL, password: OLD_PASSWORD })).token
    : (await api(OLD_URL, null, 'POST', '/api/login', { password: OLD_PASSWORD })).token;
  const signin = await api(NEW_URL, null, 'POST', '/api/signin', { email: NEW_EMAIL, password: NEW_PASSWORD });
  const newTok = signin.token;
  console.log(`Old server OK (${OLD_URL})`);
  console.log(`New server OK (${NEW_URL}) — venue "${signin.venueName}"`);

  const oldState = await api(OLD_URL, oldTok, 'GET', '/api/state');
  const newState = await api(NEW_URL, newTok, 'GET', '/api/state');
  if (newState.media.length > 0 && FORCE !== '1') {
    console.error(`Target venue already has ${newState.media.length} media items — this script is for an empty venue. Set FORCE=1 to run anyway (may create duplicates).`);
    process.exit(1);
  }

  // 1) folders
  const folderMap = new Map(); // old id -> new id
  for (const f of oldState.folders || []) {
    const made = await api(NEW_URL, newTok, 'POST', '/api/folders', { name: f.name });
    folderMap.set(f.id, made.folder.id);
    console.log(`folder  "${f.name}"`);
  }

  // 2) uploaded files (videos/photos) — download from old, upload to new
  const mediaMap = new Map(); // old media id -> new media id
  const files = (oldState.media || []).filter(m => m.url && m.type !== 'slide' && m.type !== 'comp');
  for (const m of files) {
    const dl = await fetch(OLD_URL + m.url);
    if (!dl.ok) { console.warn(`SKIP "${m.label}" — file fetch failed (${dl.status})`); continue; }
    const blob = await dl.blob();
    const form = new FormData();
    if (m.folderId && folderMap.has(m.folderId)) form.append('folderId', folderMap.get(m.folderId));
    const ext = (m.originalName && m.originalName.includes('.')) ? m.originalName.slice(m.originalName.lastIndexOf('.')) : (m.url.includes('.') ? m.url.slice(m.url.lastIndexOf('.')) : '');
    form.append('file', blob, `${m.label}${ext}`);
    const up = await api(NEW_URL, newTok, 'POST', '/api/media', form);
    mediaMap.set(m.id, up.media.id);
    const patch = {};
    if (m.label && up.media.label !== m.label) patch.label = m.label;
    if (m.durationSec) patch.durationSec = m.durationSec;
    if (Object.keys(patch).length) await api(NEW_URL, newTok, 'PATCH', `/api/media/${up.media.id}`, patch);
    console.log(`media   "${m.label}" (${Math.round(blob.size / 1024)} KB)`);
  }

  // 3) text slides (self-contained)
  for (const m of (oldState.media || []).filter(x => x.type === 'slide')) {
    const made = await api(NEW_URL, newTok, 'POST', '/api/slides', {
      label: m.label, durationSec: m.durationSec, slide: m.slide
    });
    mediaMap.set(m.id, made.media.id);
    console.log(`slide   "${m.label}"`);
  }

  // 4) layout designs (element media references remapped; dropped if missing)
  for (const m of (oldState.media || []).filter(x => x.type === 'comp')) {
    const comp = {
      ...m.comp,
      elements: (m.comp.elements || [])
        .map(el => el.mediaId ? (mediaMap.has(el.mediaId) ? { ...el, mediaId: mediaMap.get(el.mediaId) } : null) : el)
        .filter(Boolean)
    };
    if (comp.elements.length === 0) { console.warn(`SKIP design "${m.label}" — all elements referenced missing media`); continue; }
    const made = await api(NEW_URL, newTok, 'POST', '/api/comps', {
      label: m.label, durationSec: m.durationSec, comp
    });
    mediaMap.set(m.id, made.media.id);
    console.log(`design  "${m.label}"`);
  }

  // 5) playlists (items remapped, order/transition/durations kept)
  for (const p of oldState.playlists || []) {
    const items = (p.items || [])
      .filter(it => mediaMap.has(it.mediaId))
      .map(it => ({ mediaId: mediaMap.get(it.mediaId), enabled: it.enabled !== false,
        ...(it.durationSec ? { durationSec: it.durationSec } : {}) }));
    if (items.length === 0) { console.warn(`SKIP playlist "${p.name}" — no migratable items`); continue; }
    await api(NEW_URL, newTok, 'POST', '/api/playlists', {
      name: p.name, transition: p.transition || 'none', items
    });
    console.log(`playlist "${p.name}" (${items.length} items)`);
  }

  // 6) custom themes
  for (const t of oldState.settings?.customThemes || []) {
    try {
      await api(NEW_URL, newTok, 'POST', '/api/themes', {
        name: t.name, bg: t.bg, headline: t.headline,
        confetti: t.confetti, emojis: t.emojis, elements: t.elements
      });
      console.log(`theme   "${t.name}"`);
    } catch (e) { console.warn(`SKIP theme "${t.name}" — ${e.message}`); }
  }

  // 7) venue name + timezone
  const settings = {};
  if (oldState.settings?.venueName) settings.venueName = oldState.settings.venueName;
  if (oldState.settings?.tz) settings.tz = oldState.settings.tz;
  if (Object.keys(settings).length) {
    await api(NEW_URL, newTok, 'POST', '/api/settings', settings);
    console.log(`settings venueName/tz applied`);
  }

  console.log('\nContent migration complete.');
  console.log('Still manual: re-pair each TV (6-digit code -> "+ Add screen"),');
  console.log('assign playlists to the new screens, and re-import parties from ROLLER/CSV.');
};

run().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
