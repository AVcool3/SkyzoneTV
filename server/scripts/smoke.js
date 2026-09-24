/* End-to-end smoke test. Start the server first (npm start), then: npm run smoke
 * Exercises: login, player registration, upload, assignment, CSV import,
 * birthday takeover, power, day end. Exits 0 on success.
 */
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
let PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) {
  // No env override: the server generated one and stored it in db.json.
  try {
    PASSWORD = JSON.parse(fs.readFileSync(new URL('../data/db.json', import.meta.url), 'utf8')).settings.adminPassword;
  } catch {}
}
if (!PASSWORD) { console.error('Cannot determine dashboard password (set ADMIN_PASSWORD)'); process.exit(1); }

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${name}`);
  if (!cond) failures++;
}

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Remove anything a previous (possibly interrupted) smoke run left behind,
// so the suite is safe to re-run against a live server.
async function cleanupLeftovers(token) {
  const state = (await api(token, 'GET', '/api/state')).data;
  for (const t of state.tvs) if (/^Smoke /.test(t.name)) await api(token, 'DELETE', `/api/tvs/${t.id}`);
  for (const m of state.media) if (/^smoke-/.test(m.label)) await api(token, 'DELETE', `/api/media/${m.id}`);
  for (const p of state.playlists || []) if (/^Smoke /.test(p.name)) await api(token, 'DELETE', `/api/playlists/${p.id}`);
  for (const f of state.folders || []) if (/^Smoke /.test(f.name)) await api(token, 'DELETE', `/api/folders/${f.id}`);
  for (const c of state.settings.customThemes || []) if (/^Smoke /.test(c.name)) await api(token, 'DELETE', `/api/themes/${c.id}`);
  for (const e of state.events) {
    if (['CsvKid', 'CsvKid2', 'ThemeKid', 'NextDayKid', 'SoccerKid'].includes(e.name)) {
      await api(token, 'DELETE', `/api/events/${e.id}`);
    }
  }
}

const run = async () => {
  // login
  const bad = await api(null, 'POST', '/api/login', { password: 'wrong' });
  check('rejects wrong password', bad.status === 401);
  const login = await api(null, 'POST', '/api/login', { password: PASSWORD });
  check('login works', login.status === 200 && login.data.token);
  const token = login.data.token;

  const noAuth = await api(null, 'GET', '/api/state');
  check('state requires auth', noAuth.status === 401);

  await cleanupLeftovers(token);

  // the native Android app is served for Downloader installs on the TVs
  const apk = await fetch(BASE + '/parkcast-player.apk', { method: 'HEAD' });
  check('android player apk is served', apk.status === 200);

  // marketing landing page at the root, with signup/signin entry points
  const landing = await fetch(BASE + '/');
  const landingHtml = await landing.text();
  check('landing page served at root', landing.status === 200 && /Sign up/.test(landingHtml));
  check('landing page has contact section', /Deployment support/.test(landingHtml));

  // player registration
  const reg = await api(null, 'POST', '/api/player/register', {});
  check('player registers', reg.status === 200 && reg.data.tvId);
  const tvId = reg.data.tvId;
  const reg2 = await api(null, 'POST', '/api/player/register', { existingId: tvId });
  check('re-register keeps same id', reg2.data.tvId === tvId);

  // rename + screen fit
  await api(token, 'PATCH', `/api/tvs/${tvId}`, { name: 'Smoke Room 1', fit: 'cover' });
  let state = (await api(token, 'GET', '/api/state')).data;
  check('rename works', state.tvs.find(t => t.id === tvId)?.name === 'Smoke Room 1');
  check('screen fit stored', state.tvs.find(t => t.id === tvId)?.fit === 'cover');
  await api(token, 'PATCH', `/api/tvs/${tvId}`, { fit: 'contain' });

  // upload a tiny fake mp4
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(1000)], { type: 'video/mp4' }), 'smoke-test.mp4');
  const up = await fetch(BASE + '/api/media', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form
  });
  const upData = await up.json();
  check('upload works', up.status === 200 && upData.media?.id);
  const mediaId = upData.media.id;

  const badUp = new FormData();
  badUp.append('file', new Blob(['x']), 'evil.exe');
  const upBad = await fetch(BASE + '/api/media', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: badUp
  });
  check('rejects non-video upload', upBad.status === 400);

  // serve with range support
  const range = await fetch(BASE + upData.media.url, { headers: { Range: 'bytes=0-99' } });
  check('media served with Range support', range.status === 206);

  // assign
  await api(token, 'POST', `/api/tvs/${tvId}/assign`, { mediaIds: [mediaId] });
  state = (await api(token, 'GET', '/api/state')).data;
  check('assignment stored', state.tvs.find(t => t.id === tvId)?.assignedMediaIds[0] === mediaId);

  // assign-all
  await api(token, 'POST', '/api/assign-all', { mediaIds: [mediaId] });
  state = (await api(token, 'GET', '/api/state')).data;
  check('assign-all covers every tv', state.tvs.every(t => t.assignedMediaIds.includes(mediaId)));

  // image media + playlists
  const imgForm = new FormData();
  imgForm.append('file', new Blob([new Uint8Array(500)], { type: 'image/png' }), 'smoke-photo.png');
  const imgUp = await fetch(BASE + '/api/media', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: imgForm
  }).then(r => r.json());
  check('image upload works', !!imgUp.media?.id);
  check('image gets type image', imgUp.media?.type === 'image');
  const imageId = imgUp.media.id;

  await api(token, 'PATCH', `/api/media/${imageId}`, { durationSec: 12 });
  state = (await api(token, 'GET', '/api/state')).data;
  check('image duration editable', state.media.find(m => m.id === imageId)?.durationSec === 12);

  const plRes = await api(token, 'POST', '/api/playlists', {
    name: 'Smoke Mix', transition: 'fade',
    items: [{ mediaId, enabled: true }, { mediaId: imageId, enabled: false, durationSec: 5 }]
  });
  check('playlist created', plRes.status === 200 && plRes.data.playlist?.id);
  const playlistId = plRes.data.playlist.id;

  const plAssign = await api(token, 'POST', `/api/tvs/${tvId}/playlist`, { playlistId });
  check('tv accepts playlist', plAssign.status === 200);
  state = (await api(token, 'GET', '/api/state')).data;
  check('tv playlistId stored', state.tvs.find(t => t.id === tvId)?.playlistId === playlistId);

  await api(token, 'POST', `/api/tvs/${tvId}/assign`, { mediaIds: [mediaId] });
  state = (await api(token, 'GET', '/api/state')).data;
  check('custom assign takes tv off playlist', state.tvs.find(t => t.id === tvId)?.playlistId === null);

  await api(token, 'POST', `/api/playlists/${playlistId}/assign-all`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('playlist assign-all covers every tv', state.tvs.every(t => t.playlistId === playlistId));

  await api(token, 'DELETE', `/api/media/${imageId}`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('deleting media removes it from playlists',
    !state.playlists.find(p => p.id === playlistId)?.items.some(it => it.mediaId === imageId));

  await api(token, 'DELETE', `/api/playlists/${playlistId}`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('deleting playlist frees tvs', state.tvs.every(t => t.playlistId === null));

  // media folders
  const folderRes = await api(token, 'POST', '/api/folders', { name: 'Smoke Folder' });
  check('folder created', folderRes.status === 200 && folderRes.data.folder?.id);
  const folderId = folderRes.data.folder.id;
  const dupFolder = await api(token, 'POST', '/api/folders', { name: 'smoke folder' });
  check('duplicate folder name rejected', dupFolder.status === 400);

  const fForm = new FormData();
  fForm.append('folderId', folderId);
  fForm.append('file', new Blob([new Uint8Array(800)], { type: 'video/mp4' }), 'smoke-foldered.mp4');
  const fUp = await fetch(BASE + '/api/media', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fForm
  }).then(r => r.json());
  check('upload lands in folder', fUp.media?.folderId === folderId);
  const folderedId = fUp.media.id;

  await api(token, 'PATCH', `/api/media/${folderedId}`, { folderId: null });
  state = (await api(token, 'GET', '/api/state')).data;
  check('media movable out of folder', state.media.find(x => x.id === folderedId)?.folderId === null);
  await api(token, 'PATCH', `/api/media/${folderedId}`, { folderId });
  await api(token, 'POST', '/api/folders', { id: folderId, name: 'Smoke Folder 2' });
  state = (await api(token, 'GET', '/api/state')).data;
  check('folder renamed', state.folders.find(f => f.id === folderId)?.name === 'Smoke Folder 2');

  await api(token, 'DELETE', `/api/folders/${folderId}`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('deleting folder keeps media (moved to root)',
    state.media.find(x => x.id === folderedId)?.folderId === null);
  await api(token, 'DELETE', `/api/media/${folderedId}`);

  // slides: create in the UI, edit any time, no file behind them
  const slideRes = await api(token, 'POST', '/api/slides', {
    label: 'smoke-slide', durationSec: 6,
    slide: { bg: ['#ff6a00', '#d92b6a'], headline: 'Pizza + Drink $8.99', subtext: 'At the cafe', badge: 'TODAY', textColor: '#ffffff' }
  });
  check('slide created', slideRes.status === 200 && slideRes.data.media?.type === 'slide');
  const slideId = slideRes.data.media.id;
  await api(token, 'POST', '/api/slides', {
    id: slideId, label: 'smoke-slide',
    slide: { bg: ['#111111', '#222222'], headline: 'Updated deal $9.99', textColor: '#ffffff' }
  });
  state = (await api(token, 'GET', '/api/state')).data;
  check('slide editable in place', state.media.find(x => x.id === slideId)?.slide?.headline === 'Updated deal $9.99');
  const badSlide = await api(token, 'POST', '/api/slides', { slide: { bg: ['#123456', '#654321'] } });
  check('slide requires headline', badSlide.status === 400);

  // replace file keeps identity but changes the served URL (cache busting)
  const beforeUrl = (await api(token, 'GET', '/api/state')).data.media.find(x => x.id === mediaId).url;
  const repForm = new FormData();
  repForm.append('file', new Blob([new Uint8Array(2000)], { type: 'video/mp4' }), 'smoke-replaced.mp4');
  const rep = await fetch(BASE + `/api/media/${mediaId}/replace`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: repForm
  }).then(r => r.json());
  check('replace works', rep.ok === true && rep.media.size === 2000);
  check('replace keeps media id', rep.media.id === mediaId);
  check('replace changes served url', rep.media.url !== beforeUrl);
  state = (await api(token, 'GET', '/api/state')).data;
  check('replaced media still assigned to tvs', state.tvs.every(t => t.assignedMediaIds.includes(mediaId)));
  const served = await fetch(BASE + rep.media.url, { method: 'HEAD' });
  check('replaced file is served', served.status === 200);

  await api(token, 'DELETE', `/api/media/${slideId}`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('slide deletable', !state.media.some(x => x.id === slideId));

  // layout designs: positioned elements, validated, media refs resolved live
  const compRes = await api(token, 'POST', '/api/comps', {
    label: 'smoke-design', durationSec: 7,
    comp: { bg: { colors: ['#18181b', '#3f3f46'] }, elements: [
      { type: 'text', x: 10, y: 10, w: 80, h: 20, z: 2, text: 'Smoke Board', size: 8, weight: 900, color: '#ffffff', align: 'center' },
      { type: 'box', x: 5, y: 60, w: 30, h: 20, z: 0, color: '#ea580c', radius: 3 },
      { type: 'video', x: 40, y: 40, w: 50, h: 50, z: 1, mediaId, fit: 'cover' }
    ] }
  });
  check('design created', compRes.status === 200 && compRes.data.media?.type === 'comp');
  const compId = compRes.data.media.id;
  const twoVideos = await api(token, 'POST', '/api/comps', {
    label: 'smoke-design-bad',
    comp: { bg: { colors: ['#111111'] }, elements: [
      { type: 'video', x: 0, y: 0, w: 50, h: 50, mediaId, fit: 'cover' },
      { type: 'video', x: 50, y: 0, w: 50, h: 50, mediaId, fit: 'cover' }
    ] }
  });
  check('design rejects two videos', twoVideos.status === 400);
  const badRef = await api(token, 'POST', '/api/comps', {
    label: 'smoke-design-bad2',
    comp: { bg: { colors: ['#111111'] }, elements: [{ type: 'image', x: 0, y: 0, w: 50, h: 50, mediaId: 'nope', fit: 'cover' }] }
  });
  check('design rejects missing media ref', badRef.status === 400);
  const emptyComp = await api(token, 'POST', '/api/comps', {
    label: 'smoke-design-bad3', comp: { bg: { colors: ['#111111'] }, elements: [] }
  });
  check('design rejects zero elements', emptyComp.status === 400);
  // design in a playlist reaches the player with the video URL resolved
  const playerSnapshot = id => new Promise((resolve, reject) => {
    const w = new WebSocket(BASE.replace('http', 'ws') + '/ws');
    const t = setTimeout(() => { try { w.close(); } catch {} reject(new Error('ws timeout')); }, 5000);
    w.onopen = () => w.send(JSON.stringify({ type: 'hello', role: 'player', tvId: id }));
    w.onmessage = e => { clearTimeout(t); const m = JSON.parse(e.data); w.close(); resolve(m); };
    w.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
  });
  const compPl = await api(token, 'POST', '/api/playlists', {
    name: 'Smoke Design List', items: [{ mediaId: compId, durationSec: 7 }]
  });
  await api(token, 'POST', `/api/tvs/${tvId}/playlist`, { playlistId: compPl.data.playlist.id });
  const compWs = await playerSnapshot(tvId);
  const compItem = compWs.playlist.find(i => i.id === compId);
  check('design reaches player with resolved media url',
    compItem?.type === 'comp' && compItem.comp.elements.some(e => e.type === 'video' && typeof e.url === 'string'));
  // deleting a referenced video strips just that element, not the design
  const scrapForm = new FormData();
  scrapForm.append('file', new Blob([new Uint8Array(900)], { type: 'video/mp4' }), 'smoke-scrap.mp4');
  const scrap = await fetch(BASE + '/api/media', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: scrapForm
  }).then(r => r.json());
  await api(token, 'POST', '/api/comps', {
    id: compId, label: 'smoke-design',
    comp: { bg: { colors: ['#18181b', '#3f3f46'] }, elements: [
      { type: 'text', x: 10, y: 10, w: 80, h: 20, z: 2, text: 'Smoke Board', size: 8, weight: 900, color: '#ffffff', align: 'center' },
      { type: 'box', x: 5, y: 60, w: 30, h: 20, z: 0, color: '#ea580c', radius: 3 },
      { type: 'video', x: 40, y: 40, w: 50, h: 50, z: 1, mediaId: scrap.media.id, fit: 'cover' }
    ] }
  });
  await api(token, 'DELETE', `/api/media/${scrap.media.id}`);
  state = (await api(token, 'GET', '/api/state')).data;
  const compAfter = state.media.find(x => x.id === compId);
  check('deleting referenced media strips the element only',
    compAfter && compAfter.comp.elements.length === 2 && !compAfter.comp.elements.some(e => e.type === 'video'));
  await api(token, 'DELETE', `/api/playlists/${compPl.data.playlist.id}`);
  await api(token, 'DELETE', `/api/media/${compId}`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('design deletable', !state.media.some(x => x.id === compId));

  // CSV import (uses named TV; far-future dates so nothing fires during the test)
  const uploadCsv = async body => {
    const f = new FormData();
    f.append('file', new Blob([body], { type: 'text/csv' }), 'events.csv');
    const r = await fetch(BASE + '/api/events/csv', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: f
    });
    return r.json();
  };
  const csvData = await uploadCsv(
    'date,time,tv,name,duration,theme\n' +
    '2099-01-01,10:00,Smoke Room 1,CsvKid,5,ninja\n' +
    'baddate,10:00,Smoke Room 1,X,5,\n' +           // unparseable date
    '2099-13-05,10:00,Smoke Room 1,Y,5,\n' +        // impossible month (must not roll over)
    '2099-01-01,10:00,Smoke Room 13,Z,5,\n' +       // TV typo (must flag, not guess Room 1)
    '2099-01-01,11:00,Smoke Room 1,ThemeKid,5,dinosaur\n'); // unknown theme -> flagged, falls back
  check('csv imports valid rows', csvData.imported === 2);
  check('csv flags bad date, impossible date, unknown TV, unknown theme', csvData.errors.length === 4);
  state = (await api(token, 'GET', '/api/state')).data;
  check('csv theme stored', state.events.find(e => e.name === 'CsvKid')?.theme === 'ninja');
  check('unknown theme falls back to party', state.events.find(e => e.name === 'ThemeKid')?.theme === 'party');

  // A failed/garbage upload must not wipe the schedule…
  const garbage = await uploadCsv('this,is,not\nan,events,file\n');
  check('garbage csv imports nothing', garbage.imported === 0 && garbage.kept === true);
  state = (await api(token, 'GET', '/api/state')).data;
  check('garbage csv keeps existing events', state.events.some(e => e.name === 'CsvKid'));

  // …and a CSV for a different date must not wipe other dates' events.
  const otherDate = await uploadCsv('date,time,tv,name\n2099-01-02,10:00,Smoke Room 1,NextDayKid\n');
  check('other-date csv imports', otherDate.imported === 1);
  state = (await api(token, 'GET', '/api/state')).data;
  check('other-date csv keeps first date', state.events.some(e => e.name === 'CsvKid'));
  check('other-date csv added its event', state.events.some(e => e.name === 'NextDayKid'));

  // Re-uploading the same date replaces that date's pending events.
  await uploadCsv('date,time,tv,name\n2099-01-01,11:00,Smoke Room 1,CsvKid2\n');
  state = (await api(token, 'GET', '/api/state')).data;
  check('same-date csv replaces pending events', !state.events.some(e => e.name === 'CsvKid') &&
    state.events.some(e => e.name === 'CsvKid2') && state.events.some(e => e.name === 'NextDayKid'));
  await uploadCsv('date,time,tv,name\n2099-01-01,10:00,Smoke Room 1,CsvKid,5\n2099-01-02,10:00,Smoke Room 1,NextDayKid\n');

  // birthday takeover via start-now
  state = (await api(token, 'GET', '/api/state')).data;
  const evId = state.events.find(e => e.name === 'CsvKid')?.id;
  check('csv event exists', !!evId);
  await api(token, 'POST', `/api/events/${evId}/start-now`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('start-now activates takeover', state.tvs.find(t => t.id === tvId)?.override?.name === 'CsvKid');

  await api(token, 'POST', `/api/tvs/${tvId}/clear-override`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('clear-override works', !state.tvs.find(t => t.id === tvId)?.override);
  check('event marked done', state.events.find(e => e.id === evId)?.status === 'done');

  // manual test birthday
  await api(token, 'POST', `/api/tvs/${tvId}/test-birthday`, { name: 'Zoe', durationMin: 1 });
  state = (await api(token, 'GET', '/api/state')).data;
  check('test birthday activates', state.tvs.find(t => t.id === tvId)?.override?.name === 'Zoe');

  // independence: takeover on tv1 must not touch other tvs
  const regB = await api(null, 'POST', '/api/player/register', {});
  state = (await api(token, 'GET', '/api/state')).data;
  const other = state.tvs.find(t => t.id === regB.data.tvId);
  check('other TVs unaffected by takeover', !other.override && other.power === 'on');

  // power + day end
  await api(token, 'POST', `/api/tvs/${tvId}/power`, { power: 'off' });
  state = (await api(token, 'GET', '/api/state')).data;
  check('power off works', state.tvs.find(t => t.id === tvId)?.power === 'off');

  // Custom themes: create, use by name in CSV and test, delete falls back.
  const themeRes = await api(token, 'POST', '/api/themes', {
    name: 'Smoke Soccer', bg: ['#1d7a3e', '#0b3d20'],
    headline: { fill: '#ffffff', stroke: '#1d7a3e' },
    confetti: ['#ffffff', '#ffd93b'], emojis: '⚽🏆', elements: ['sparkles']
  });
  check('custom theme created', themeRes.status === 200 && themeRes.data.theme?.id);
  const customId = themeRes.data.theme.id;
  const dupe = await api(token, 'POST', '/api/themes', {
    name: 'smoke-soccer', bg: ['#111111', '#222222'], headline: { fill: '#ffffff', stroke: '#000000' }
  });
  check('duplicate theme name rejected', dupe.status === 400);
  const builtinClash = await api(token, 'POST', '/api/themes', {
    name: 'Ninja', bg: ['#111111', '#222222'], headline: { fill: '#ffffff', stroke: '#000000' }
  });
  check('built-in theme name rejected', builtinClash.status === 400);

  const customCsv = await uploadCsv('date,time,tv,name,theme\n2099-01-03,10:00,Smoke Room 1,SoccerKid,smoke soccer\n');
  check('csv resolves custom theme by name', customCsv.imported === 1 && customCsv.errors.length === 0);
  state = (await api(token, 'GET', '/api/state')).data;
  check('csv event stores custom theme id', state.events.find(e => e.name === 'SoccerKid')?.theme === `custom:${customId}`);

  await api(token, 'POST', `/api/tvs/${tvId}/test-birthday`, { name: 'Zed', theme: 'Smoke Soccer', durationMin: 1 });
  state = (await api(token, 'GET', '/api/state')).data;
  check('test accepts custom theme name', state.tvs.find(t => t.id === tvId)?.override?.name === 'Zed');
  await api(token, 'POST', `/api/tvs/${tvId}/clear-override`);

  await api(token, 'DELETE', `/api/themes/${customId}`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('deleting theme reverts its events to party', state.events.find(e => e.name === 'SoccerKid')?.theme === 'party');

  // A takeover on a powered-off TV wakes the screen, then re-blanks it after.
  await api(token, 'POST', `/api/tvs/${tvId}/test-birthday`, { name: 'WakeKid', durationMin: 1 });
  state = (await api(token, 'GET', '/api/state')).data;
  check('takeover wakes a powered-off screen', state.tvs.find(t => t.id === tvId)?.power === 'on');
  await api(token, 'POST', `/api/tvs/${tvId}/clear-override`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('screen re-blanks after takeover ends', state.tvs.find(t => t.id === tvId)?.power === 'off');

  // TV names must stay unique even after deletions re-open low numbers.
  const names = state.tvs.map(t => t.name);
  check('tv names are unique', new Set(names).size === names.length);

  await api(token, 'POST', '/api/day/end');
  state = (await api(token, 'GET', '/api/state')).data;
  check('day end blanks all + clears overrides', state.tvs.every(t => t.power === 'off' && !t.override));

  await api(token, 'POST', '/api/day/start');
  state = (await api(token, 'GET', '/api/state')).data;
  check('day start restores all', state.tvs.every(t => t.power === 'on'));

  // ---- multi-tenant vendors: signup, signin, workspace isolation ----
  // The first-ever signup claims the default venue (all existing screens and
  // media). On a fresh test server that's this "owner" account; on a server
  // where someone already signed up, it just gets an empty workspace instead.
  const ownEmail = 'smoke-owner@test.dev';
  const ownPass = 'smoke-owner-pw1';
  let signOwn = await api(null, 'POST', '/api/signup', { venue: 'Smoke HQ', email: ownEmail, password: ownPass });
  if (signOwn.status === 400) {
    signOwn = await api(null, 'POST', '/api/signin', { email: ownEmail, password: ownPass });
  }
  check('owner signup/signin works', signOwn.status === 200 && !!signOwn.data.token);
  const stateOwn = (await api(signOwn.data.token, 'GET', '/api/state')).data;
  check('first signup claims default venue (or gets clean workspace on a used server)',
    stateOwn.tvs.some(t => t.id === tvId) || stateOwn.tvs.length === 0);

  // Every signup after the first gets a fresh, isolated venue.
  const vbEmail = 'smoke-vendor-b@test.dev';
  const vbPass = 'smoke-pass-123';
  let signB = await api(null, 'POST', '/api/signup', {
    venue: 'Smoke Venue B', name: 'Smokey', email: vbEmail, password: vbPass
  });
  if (signB.status === 400) {
    // account left over from a previous run against a live server — sign in
    signB = await api(null, 'POST', '/api/signin', { email: vbEmail, password: vbPass });
    check('vendor account reachable (signin after prior signup)', signB.status === 200 && !!signB.data.token);
  } else {
    check('vendor signup works', signB.status === 200 && !!signB.data.token);
    check('signup returns venue name', signB.data.venueName === 'Smoke Venue B');
  }
  const tokenB = signB.data.token;

  const dupSignup = await api(null, 'POST', '/api/signup', { venue: 'Other', email: vbEmail, password: vbPass });
  check('duplicate email rejected', dupSignup.status === 400);
  const shortPw = await api(null, 'POST', '/api/signup', { venue: 'X', email: 'smoke-short@test.dev', password: 'short' });
  check('short password rejected', shortPw.status === 400);
  const badEmail = await api(null, 'POST', '/api/signup', { venue: 'X', email: 'not-an-email', password: 'longenough1' });
  check('invalid email rejected', badEmail.status === 400);
  const badSignin = await api(null, 'POST', '/api/signin', { email: vbEmail, password: 'wrong-pass-xyz' });
  check('wrong vendor password rejected', badSignin.status === 401);
  const signin2 = await api(null, 'POST', '/api/signin', { email: vbEmail, password: vbPass });
  check('vendor signin round-trip works', signin2.status === 200 && !!signin2.data.token);
  const meB = await api(tokenB, 'GET', '/api/me');
  check('me reports vendor email + venue', meB.data.email === vbEmail && meB.data.venueName === 'Smoke Venue B');

  // vendor B's workspace is empty and cannot see or touch venue A's things
  const stateB = (await api(tokenB, 'GET', '/api/state')).data;
  check('vendor workspace is isolated (no foreign tvs/media/events)',
    stateB.tvs.length === 0 && stateB.media.length === 0 && stateB.events.length === 0);
  check('vendor sees own venue name', stateB.settings.venueName === 'Smoke Venue B');
  const crossTv = await api(tokenB, 'PATCH', `/api/tvs/${tvId}`, { name: 'Hijacked' });
  check('cross-venue tv access blocked', crossTv.status === 404);
  const crossMedia = await api(tokenB, 'DELETE', `/api/media/${mediaId}`);
  check('cross-venue media access blocked', crossMedia.status === 404);
  const crossAssign = await api(tokenB, 'POST', `/api/tvs/${tvId}/assign`, { mediaIds: [] });
  check('cross-venue assign blocked', crossAssign.status === 404);

  // and vendor B's own objects never leak into venue A
  const folderB = await api(tokenB, 'POST', '/api/folders', { name: 'Smoke B Folder' });
  check('vendor can create in own workspace', folderB.status === 200);
  state = (await api(token, 'GET', '/api/state')).data;
  check('vendor objects invisible to other venues', !state.folders.some(f => f.name === 'Smoke B Folder'));
  await api(tokenB, 'DELETE', `/api/folders/${folderB.data.folder.id}`);

  // legacy admin still lands in the default venue with its data intact
  const meA = await api(token, 'GET', '/api/me');
  check('legacy admin maps to default venue', meA.status === 200 && meA.data.venueName === state.settings.venueName);

  // ---- owner portal: add, change, and cut team access ----
  const team0 = await api(tokenB, 'GET', '/api/team');
  check('owner sees team list with self marked',
    team0.status === 200 && team0.data.members.some(m => m.email === vbEmail && m.you));
  const selfId = team0.data.members.find(m => m.you).id;
  // leftovers from an interrupted run
  for (const m of team0.data.members) {
    if (m.email === 'smoke-staff@test.dev') await api(tokenB, 'DELETE', `/api/team/${m.id}`);
  }

  const addStaff = await api(tokenB, 'POST', '/api/team', {
    name: 'Front Desk', email: 'smoke-staff@test.dev', password: 'staff-pass-99', role: 'staff'
  });
  check('owner adds a staff account', addStaff.status === 200 && addStaff.data.member?.role === 'staff');
  const staffId = addStaff.data.member.id;
  const staffIn = await api(null, 'POST', '/api/signin', { email: 'smoke-staff@test.dev', password: 'staff-pass-99' });
  check('staff can sign in', staffIn.status === 200 && !!staffIn.data.token);
  const tokenS = staffIn.data.token;
  const staffState = await api(tokenS, 'GET', '/api/state');
  check('staff lands in the owner venue', staffState.data.settings?.venueName === 'Smoke Venue B');
  const meS = await api(tokenS, 'GET', '/api/me');
  check('me reports staff role', meS.data.role === 'staff');

  check('staff cannot open the owner portal', (await api(tokenS, 'GET', '/api/team')).status === 403);
  check('staff cannot add accounts',
    (await api(tokenS, 'POST', '/api/team', { email: 'x@y.dev', password: '12345678' })).status === 403);
  check('staff cannot rename the venue',
    (await api(tokenS, 'POST', '/api/settings', { venueName: 'Hacked' })).status === 403);
  check('owner cannot remove self', (await api(tokenB, 'DELETE', `/api/team/${selfId}`)).status === 400);

  const promote = await api(tokenB, 'PATCH', `/api/team/${staffId}`, { role: 'owner' });
  check('owner can promote staff to owner', promote.status === 200 && promote.data.member.role === 'owner');
  check('promoted member can open the portal', (await api(tokenS, 'GET', '/api/team')).status === 200);
  await api(tokenB, 'PATCH', `/api/team/${staffId}`, { role: 'staff' });
  check('demotion applies immediately', (await api(tokenS, 'GET', '/api/team')).status === 403);

  const resetPw = await api(tokenB, 'PATCH', `/api/team/${staffId}`, { password: 'new-staff-pass1' });
  check('owner can reset a member password', resetPw.status === 200);
  check('password reset revokes old sessions', (await api(tokenS, 'GET', '/api/state')).status === 401);
  const staffIn2 = await api(null, 'POST', '/api/signin', { email: 'smoke-staff@test.dev', password: 'new-staff-pass1' });
  check('new password works', staffIn2.status === 200);

  check('cross-venue team access blocked',
    (await api(token, 'PATCH', `/api/team/${staffId}`, { role: 'owner' })).status === 404);

  check('owner cuts access', (await api(tokenB, 'DELETE', `/api/team/${staffId}`)).status === 200);
  check('cut member loses access immediately',
    (await api(staffIn2.data.token, 'GET', '/api/state')).status === 401);
  check('cut member cannot sign back in',
    (await api(null, 'POST', '/api/signin', { email: 'smoke-staff@test.dev', password: 'new-staff-pass1' })).status === 401);

  // ---- staff can run the day, but destructive actions are owner-only ----
  // A desk account in the DEFAULT venue, where this suite's screens and media
  // live, so the restrictions are tested against real objects.
  const adminTeam = await api(token, 'GET', '/api/team');
  for (const m of adminTeam.data.members || []) {
    if (m.email === 'smoke-desk@test.dev') await api(token, 'DELETE', `/api/team/${m.id}`);
  }
  const deskAdd = await api(token, 'POST', '/api/team', {
    name: 'Desk', email: 'smoke-desk@test.dev', password: 'desk-pass-99', role: 'staff'
  });
  check('legacy admin can add staff to default venue', deskAdd.status === 200);
  const deskIn = await api(null, 'POST', '/api/signin', { email: 'smoke-desk@test.dev', password: 'desk-pass-99' });
  const tokenD = deskIn.data.token;

  // staff CAN run the operational day
  check('staff can power a screen',
    (await api(tokenD, 'POST', `/api/tvs/${tvId}/power`, { power: 'on' })).status === 200);
  check('staff can start a takeover',
    (await api(tokenD, 'POST', `/api/tvs/${tvId}/test-birthday`, { name: 'DeskKid', durationMin: 1 })).status === 200);
  check('staff can stop a takeover',
    (await api(tokenD, 'POST', `/api/tvs/${tvId}/clear-override`)).status === 200);
  check('staff can assign media',
    (await api(tokenD, 'POST', `/api/tvs/${tvId}/assign`, { mediaIds: [mediaId] })).status === 200);
  check('staff can rename a screen',
    (await api(tokenD, 'PATCH', `/api/tvs/${tvId}`, { name: 'Smoke Room 1' })).status === 200);

  // staff CANNOT destroy or replace
  check('staff cannot delete a screen', (await api(tokenD, 'DELETE', `/api/tvs/${tvId}`)).status === 403);
  check('staff cannot delete media', (await api(tokenD, 'DELETE', `/api/media/${mediaId}`)).status === 403);
  const repFormD = new FormData();
  repFormD.append('file', new Blob([new Uint8Array(100)], { type: 'video/mp4' }), 'smoke-x.mp4');
  const repD = await fetch(BASE + `/api/media/${mediaId}/replace`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tokenD }, body: repFormD
  });
  check('staff cannot replace a file', repD.status === 403);

  const guardPl = await api(token, 'POST', '/api/playlists', { name: 'Smoke Guard', items: [{ mediaId }] });
  const guardFo = await api(token, 'POST', '/api/folders', { name: 'Smoke Guard' });
  const guardTh = await api(token, 'POST', '/api/themes', {
    name: 'Smoke Guard', bg: ['#101010', '#202020'], headline: { fill: '#ffffff', stroke: '#000000' }
  });
  check('staff cannot delete a playlist',
    (await api(tokenD, 'DELETE', `/api/playlists/${guardPl.data.playlist.id}`)).status === 403);
  check('staff cannot delete a folder',
    (await api(tokenD, 'DELETE', `/api/folders/${guardFo.data.folder.id}`)).status === 403);
  check('staff cannot delete a theme',
    (await api(tokenD, 'DELETE', `/api/themes/${guardTh.data.theme.id}`)).status === 403);
  check('owner still deletes fine',
    (await api(token, 'DELETE', `/api/playlists/${guardPl.data.playlist.id}`)).status === 200 &&
    (await api(token, 'DELETE', `/api/folders/${guardFo.data.folder.id}`)).status === 200 &&
    (await api(token, 'DELETE', `/api/themes/${guardTh.data.theme.id}`)).status === 200);

  // parties stay fully operational for staff, including deleting one
  const deskEv = await api(tokenD, 'POST', '/api/events', {
    tvId, name: 'DeskParty', startsAt: '2099-06-01T10:00:00.000Z', durationMin: 5
  });
  check('staff can add a party', deskEv.status === 200);
  if (deskEv.data.event?.id) {
    check('staff can delete a party',
      (await api(tokenD, 'DELETE', `/api/events/${deskEv.data.event.id}`)).status === 200);
  }
  await api(token, 'DELETE', `/api/team/${deskAdd.data.member.id}`);

  // ---- platform administration: cross-vendor management ----
  const meAdmin = await api(token, 'GET', '/api/me');
  check('legacy admin is a platform admin', meAdmin.data.platformAdmin === true);
  check('vendor owner is NOT a platform admin',
    (await api(tokenB, 'GET', '/api/me')).data.platformAdmin !== true);

  const adminList = await api(token, 'GET', '/api/admin/venues');
  check('admin lists every venue with stats',
    adminList.status === 200 && adminList.data.venues.some(v => v.isDefault) &&
    adminList.data.venues.some(v => v.name === 'Smoke Venue B'));
  check('non-admin cannot list venues', (await api(tokenB, 'GET', '/api/admin/venues')).status === 403);

  // provision a venue with its owner account
  let pvCreate = await api(token, 'POST', '/api/admin/venues', {
    name: 'Smoke Platform Venue', ownerEmail: 'smoke-pv@test.dev', ownerPassword: 'pv-pass-9999'
  });
  check('admin provisions a venue (or it exists from a prior run)',
    pvCreate.status === 200 || pvCreate.status === 400);
  const pvId = (await api(token, 'GET', '/api/admin/venues')).data.venues
    .find(v => v.name === 'Smoke Platform Venue')?.id;
  check('provisioned venue appears in the list', !!pvId);
  const pvIn = await api(null, 'POST', '/api/signin', { email: 'smoke-pv@test.dev', password: 'pv-pass-9999' });
  check('provisioned owner can sign in', pvIn.status === 200 && !!pvIn.data.token);

  check('non-admin cannot provision venues',
    (await api(tokenB, 'POST', '/api/admin/venues', { name: 'X', ownerEmail: 'x@y.dev', ownerPassword: '12345678' })).status === 403);

  // governance boundary: there is NO way into a vendor's workspace — the
  // enter endpoint must not exist, and stats expose counts only
  const bId = adminList.data.venues.find(v => v.name === 'Smoke Venue B').id;
  check('venue-enter capability does not exist',
    (await api(token, 'POST', `/api/admin/venues/${bId}/enter`)).status === 404);
  const bRow = adminList.data.venues.find(v => v.id === bId);
  check('admin venue stats expose counts only',
    bRow.media === undefined || typeof bRow.media === 'number');

  // account governance: list, role, password, disable, remove
  const bMembers = await api(token, 'GET', `/api/admin/venues/${bId}/members`);
  check('admin lists a venue\'s members', bMembers.status === 200 &&
    bMembers.data.members.some(m => m.email === vbEmail));
  check('non-admin cannot list members',
    (await api(tokenB, 'GET', `/api/admin/venues/${bId}/members`)).status === 403);

  // clean leftover from prior runs, then add a governed account to venue B
  for (const m of bMembers.data.members) {
    if (m.email === 'smoke-gov@test.dev') await api(token, 'DELETE', `/api/admin/users/${m.id}`);
  }
  const govAdd = await api(token, 'POST', `/api/admin/venues/${bId}/owner`, {
    email: 'smoke-gov@test.dev', password: 'gov-pass-9999'
  });
  check('admin adds an owner to a venue', govAdd.status === 200);
  const govId = (await api(token, 'GET', `/api/admin/venues/${bId}/members`)).data.members
    .find(m => m.email === 'smoke-gov@test.dev').id;
  const govIn = await api(null, 'POST', '/api/signin', { email: 'smoke-gov@test.dev', password: 'gov-pass-9999' });
  check('governed account signs in to its venue',
    govIn.status === 200 &&
    (await api(govIn.data.token, 'GET', '/api/state')).data.settings?.venueName === 'Smoke Venue B');

  const govRole = await api(token, 'PATCH', `/api/admin/users/${govId}`, { role: 'staff' });
  check('admin changes a role', govRole.status === 200);
  await api(token, 'PATCH', `/api/admin/users/${govId}`, { password: 'gov-pass-new1' });
  check('admin password reset revokes sessions',
    (await api(govIn.data.token, 'GET', '/api/state')).status === 401);
  const govDis = await api(token, 'PATCH', `/api/admin/users/${govId}`, { disabled: true });
  check('admin disables service access', govDis.status === 200);
  check('disabled account cannot sign in',
    (await api(null, 'POST', '/api/signin', { email: 'smoke-gov@test.dev', password: 'gov-pass-new1' })).status === 403);
  await api(token, 'PATCH', `/api/admin/users/${govId}`, { disabled: false });
  check('restored account signs in again',
    (await api(null, 'POST', '/api/signin', { email: 'smoke-gov@test.dev', password: 'gov-pass-new1' })).status === 200);
  // a platform admin can never edit their own access (no self-lockout, no
  // self-privilege games) — smoke-owner claimed the default venue, so they
  // are a platform admin with a real user row to test against
  const defId = adminList.data.venues.find(v => v.isDefault).id;
  const ownRow = (await api(token, 'GET', `/api/admin/venues/${defId}/members`)).data.members
    .find(m => m.email === ownEmail);
  check('admin cannot edit their own access',
    (await api(signOwn.data.token, 'PATCH', `/api/admin/users/${ownRow.id}`, { disabled: true })).status === 400);
  check('admin removes an account',
    (await api(token, 'DELETE', `/api/admin/users/${govId}`)).status === 200);
  check('removed account cannot sign in',
    (await api(null, 'POST', '/api/signin', { email: 'smoke-gov@test.dev', password: 'gov-pass-new1' })).status === 401);
  check('non-admin cannot govern accounts',
    (await api(tokenB, 'PATCH', `/api/admin/users/${govId}`, { disabled: true })).status === 403);

  // suspension locks the dashboard out, immediately and at sign-in
  const susp = await api(token, 'POST', `/api/admin/venues/${pvId}/suspend`, { suspended: true });
  check('admin suspends a venue', susp.status === 200 && susp.data.suspended === true);
  const lockedNow = await api(pvIn.data.token, 'GET', '/api/state');
  check('suspension kills live sessions', lockedNow.status === 401 || lockedNow.status === 403);
  check('suspended member cannot sign in',
    (await api(null, 'POST', '/api/signin', { email: 'smoke-pv@test.dev', password: 'pv-pass-9999' })).status === 403);
  check('default venue cannot be suspended',
    (await api(token, 'POST', `/api/admin/venues/${adminList.data.venues.find(v => v.isDefault).id}/suspend`, { suspended: true })).status === 400);
  await api(token, 'POST', `/api/admin/venues/${pvId}/suspend`, { suspended: false });
  check('resume restores sign-in',
    (await api(null, 'POST', '/api/signin', { email: 'smoke-pv@test.dev', password: 'pv-pass-9999' })).status === 200);
  check('non-admin cannot suspend',
    (await api(tokenB, 'POST', `/api/admin/venues/${pvId}/suspend`, { suspended: true })).status === 403);

  // cleanup: delete media + tvs created by this test
  await api(token, 'DELETE', `/api/media/${mediaId}`);
  state = (await api(token, 'GET', '/api/state')).data;
  check('delete media removes from assignments', state.tvs.every(t => !t.assignedMediaIds.includes(mediaId)));
  await api(token, 'DELETE', `/api/tvs/${tvId}`);
  await api(token, 'DELETE', `/api/tvs/${regB.data.tvId}`);

  console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch(err => { console.error('Smoke test crashed:', err); process.exit(1); });
