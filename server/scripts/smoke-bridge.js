/* PLAYER_HOME hand-off smoke test. Boot a second server with
 * PLAYER_HOME=<home origin>, then: BASE_URL=<that server> HOME_URL=<home> node scripts/smoke-bridge.js
 * A server forwarding its screens must answer every player — at registration
 * and on reconnect — with where to go instead, and create nothing itself.
 */
import http from 'node:http';
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://localhost:8082';
const HOME = (process.env.HOME_URL || 'http://localhost:8081').replace(/\/$/, '');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${name}`);
  if (!cond) failures++;
}

const run = async () => {
  const fresh = await fetch(BASE + '/api/player/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  }).then(r => r.json());
  check('new screen is told to move', fresh.moved === HOME && !fresh.tvId);

  const known = await fetch(BASE + '/api/player/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ existingId: 'anything' })
  }).then(r => r.json());
  check('returning screen is told to move', known.moved === HOME && !known.tvId);

  // a screen that was already connected learns on its next hello
  const msg = await new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    const t = setTimeout(() => { ws.terminate(); reject(new Error('no reply to hello')); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'player', tvId: 'stale-id' })));
    ws.on('message', data => { clearTimeout(t); ws.close(); resolve(JSON.parse(data)); });
    ws.on('error', reject);
  });
  check('connected screen is told to move', msg.moved === HOME);
  check('and gets the build fingerprint so older players reload', msg.type === 'state' && !!msg.assetVersion);

  // Built-in alias: with no PLAYER_HOME at all, a request addressed to
  // parkcast.onrender.com forwards to the live server; any other host doesn't.
  const LIVE = 'https://skyzone-tv.onrender.com';
  const asHost = (host, method, p, body) => new Promise((resolve, reject) => {
    const u = new URL(HOME + p);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { Host: host, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  const site = await asHost('parkcast.onrender.com', 'GET', '/dashboard/');
  check('parkcast website redirects to the live server', site.status === 302 && site.location === LIVE + '/dashboard/');
  const health = await asHost('parkcast.onrender.com', 'GET', '/healthz');
  check('parkcast health check stays local', health.status === 200);
  const aliasReg = await asHost('parkcast.onrender.com', 'POST', '/api/player/register', '{}');
  check('parkcast screens are handed to the live server', JSON.parse(aliasReg.data).moved === LIVE);
  const own = await asHost('skyzone-tv.onrender.com', 'GET', '/dashboard/');
  check('the live server never forwards itself', own.status === 200);

  console.log(failures === 0 ? '\nAll hand-off tests passed.' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch(err => { console.error('Hand-off test crashed:', err); process.exit(1); });
