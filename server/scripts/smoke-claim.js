/* Cloud pairing smoke test. Boot the server with REQUIRE_TV_APPROVAL=1 and a
 * fresh DATA_DIR, then: node scripts/smoke-claim.js
 * Exercises: screens registering unclaimed with a pairing code, vendors
 * claiming them by code into their own venue, and cross-venue code privacy.
 */
const BASE = process.env.BASE_URL || 'http://localhost:8080';

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
  // two vendors sign up
  const a = await api(null, 'POST', '/api/signup', {
    venue: 'Claim Venue A', email: 'claim-a@test.dev', password: 'claim-pass-a1'
  });
  check('vendor A signup', a.status === 200 && !!a.data.token);
  const b = await api(null, 'POST', '/api/signup', {
    venue: 'Claim Venue B', email: 'claim-b@test.dev', password: 'claim-pass-b1'
  });
  check('vendor B signup', b.status === 200 && !!b.data.token);
  const tokenA = a.data.token, tokenB = b.data.token;

  // a fresh screen registers unclaimed and shows a pairing code
  const reg = await api(null, 'POST', '/api/player/register', {});
  check('screen registers in cloud mode', reg.status === 200 && !!reg.data.tvId);
  const tvId = reg.data.tvId;
  const stateA0 = (await api(tokenA, 'GET', '/api/state')).data;
  check('unclaimed screen not in any venue', !stateA0.tvs.some(t => t.id === tvId));

  // the player socket is where the code appears; fetch it via the ws snapshot
  const playerSnapshot = id => new Promise((resolve, reject) => {
    const w = new WebSocket(BASE.replace('http', 'ws') + '/ws');
    const t = setTimeout(() => { try { w.close(); } catch {} reject(new Error('ws timeout')); }, 5000);
    w.onopen = () => w.send(JSON.stringify({ type: 'hello', role: 'player', tvId: id }));
    w.onmessage = e => { clearTimeout(t); const m = JSON.parse(e.data); w.close(); resolve(m); };
    w.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
  });
  const snap = await playerSnapshot(tvId);
  check('unclaimed screen is in pairing mode', snap.approved === false && /^\d{6}$/.test(snap.pairCode || ''));
  const code = snap.pairCode;

  // wrong code fails; right code pulls the screen into vendor B's venue
  const wrong = await api(tokenB, 'POST', '/api/tvs/claim', { code: '000000' });
  check('wrong code rejected', wrong.status === 404);
  const badShape = await api(tokenB, 'POST', '/api/tvs/claim', { code: '12' });
  check('malformed code rejected', badShape.status === 400);
  const claim = await api(tokenB, 'POST', '/api/tvs/claim', { code });
  check('claim by code works', claim.status === 200 && claim.data.tv?.id === tvId);

  const stateB = (await api(tokenB, 'GET', '/api/state')).data;
  check('claimed screen appears in claiming venue', stateB.tvs.some(t => t.id === tvId));
  const stateA = (await api(tokenA, 'GET', '/api/state')).data;
  check('claimed screen invisible to other venues', !stateA.tvs.some(t => t.id === tvId));

  // a claimed screen leaves pairing mode and cannot be claimed twice
  const snap2 = await playerSnapshot(tvId);
  check('claimed screen leaves pairing mode', snap2.approved === true && snap2.venueName === 'Claim Venue B');
  const reclaim = await api(tokenA, 'POST', '/api/tvs/claim', { code });
  check('code cannot be reused', reclaim.status === 404);

  console.log(failures === 0 ? '\nAll claim tests passed.' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch(err => { console.error('Claim test crashed:', err); process.exit(1); });
