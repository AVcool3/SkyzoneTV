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
  const apk = await fetch(BASE + '/skyzone-player.apk', { method: 'HEAD' });
  check('android player apk is served', apk.status === 200);

  // player registration
  const reg = await api(null, 'POST', '/api/player/register', {});
  check('player registers', reg.status === 200 && reg.data.tvId);
  const tvId = reg.data.tvId;
  const reg2 = await api(null, 'POST', '/api/player/register', { existingId: tvId });
  check('re-register keeps same id', reg2.data.tvId === tvId);

  // rename
  await api(token, 'PATCH', `/api/tvs/${tvId}`, { name: 'Smoke Room 1' });
  let state = (await api(token, 'GET', '/api/state')).data;
  check('rename works', state.tvs.find(t => t.id === tvId)?.name === 'Smoke Room 1');

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
