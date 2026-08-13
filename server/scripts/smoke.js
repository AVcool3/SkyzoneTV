/* End-to-end smoke test. Start the server first (npm start), then: npm run smoke
 * Exercises: login, player registration, upload, assignment, CSV import,
 * birthday takeover, power, day end. Exits 0 on success.
 */
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const PASSWORD = process.env.ADMIN_PASSWORD || 'skyzone';

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

const run = async () => {
  // login
  const bad = await api(null, 'POST', '/api/login', { password: 'wrong' });
  check('rejects wrong password', bad.status === 401);
  const login = await api(null, 'POST', '/api/login', { password: PASSWORD });
  check('login works', login.status === 200 && login.data.token);
  const token = login.data.token;

  const noAuth = await api(null, 'GET', '/api/state');
  check('state requires auth', noAuth.status === 401);

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

  // CSV import (uses named TV; event for later today)
  const csv = 'date,time,tv,name,duration\n2099-01-01,10:00,Smoke Room 1,CsvKid,5\nbaddate,10:00,Smoke Room 1,X,5\n';
  const csvForm = new FormData();
  csvForm.append('file', new Blob([csv], { type: 'text/csv' }), 'events.csv');
  const csvRes = await fetch(BASE + '/api/events/csv', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: csvForm
  });
  const csvData = await csvRes.json();
  check('csv imports valid rows', csvData.imported === 1);
  check('csv reports bad rows', csvData.errors.length === 1);

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
