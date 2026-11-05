/* Full screen lifecycle, driven by "virtual TVs" that speak the same
 * protocol as the TV app. Safe to run against the LIVE server: it works in a
 * throwaway venue and deletes it (with its files) at the end.
 *
 *   BASE_URL=<server the venue lives on>  ENTRY_URL=<address the TV app opens>
 *   node scripts/smoke-lifecycle.js
 *
 * ENTRY_URL defaults to BASE_URL. Point it at a forwarding server (parkcast)
 * to test the path a freshly installed TV actually takes.
 */
import WebSocket from 'ws';

const BASE = (process.env.BASE_URL || 'http://localhost:8081').replace(/\/$/, '');
const ENTRY = (process.env.ENTRY_URL || BASE).replace(/\/$/, '');
const RUN = Date.now().toString(36);
const EMAIL = `lifecycle-${RUN}@test.parkcast.dev`;
const PASSWORD = `life-${RUN}-pass`;
const VENUE = `Lifecycle check ${RUN}`;

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${name}`);
  if (!cond) failures++;
  return cond;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function http(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// A TV as the server sees it: registers (following a hand-off like the real
// player), holds a WebSocket, and keeps every state the server pushes.
class VirtualTV {
  constructor(label) { this.label = label; this.msgs = []; this.waiters = []; }
  async register() {
    let r = (await http(ENTRY, null, 'POST', '/api/player/register', {})).data;
    this.home = ENTRY;
    if (r.moved) { this.home = r.moved; this.movedFrom = ENTRY; r = (await http(this.home, null, 'POST', '/api/player/register', {})).data; }
    this.id = r.tvId;
    return this;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.home.replace(/^http/, 'ws') + '/ws');
      this.ws.on('open', () => { this.ws.send(JSON.stringify({ type: 'hello', role: 'player', tvId: this.id })); resolve(); });
      this.ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.type === 'state') this.state = m;
        if (m.type === 'adopt') { this.id = m.tvId; this.ws.send(JSON.stringify({ type: 'hello', role: 'player', tvId: this.id })); }
        this.msgs.push(m);
        this.waiters = this.waiters.filter(w => (w.pred(m) ? (w.resolve(m), false) : true));
      });
      this.ws.on('error', reject);
    });
  }
  // Resolves on the first message (already received or arriving) matching pred.
  waitFor(pred, ms = 8000) {
    const hit = this.msgs.slice().reverse().find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise(resolve => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); resolve(null); }, ms);
    });
  }
  // Only messages from now on (state already seen doesn't count).
  next(pred, ms) { this.msgs = []; return this.waitFor(pred, ms); }
  status(extra = {}) { this.ws.send(JSON.stringify({ type: 'status', nowPlaying: 'Idle', ...extra })); }
  close() { try { this.ws.close(); } catch {} }
}

const isState = m => m.type === 'state';
const playing = n => m => m.type === 'state' && m.approved && m.playlist.length === n && !m.override && m.power === 'on';

let token = null;
const run = async () => {
  console.log(`Lifecycle check: venue on ${BASE}, TVs enter through ${ENTRY}`);
  const up = await http(BASE, null, 'POST', '/api/signup', { venue: VENUE, name: 'Lifecycle', email: EMAIL, password: PASSWORD });
  token = up.data.token;
  if (!check('throwaway venue created', up.status === 200 && !!token)) return;
  // Safety: a server whose main venue has no account yet hands it to the first
  // signup. If that happened, touch nothing — remove only our own account.
  const me = (await http(BASE, token, 'GET', '/api/me')).data;
  const mine = (await http(BASE, token, 'GET', '/api/state')).data;
  if (me.platformAdmin || mine.tvs?.length || mine.media?.length) {
    console.log('ABORT: this signup landed in an existing venue — removing only the test account, changing nothing else.');
    await http(BASE, token, 'DELETE', '/api/me', { password: PASSWORD });
    token = null;
    failures++;
    return;
  }
  check('it is a separate, empty venue', mine.tvs.length === 0 && mine.media.length === 0 && !me.platformAdmin);

  // ---- pairing, the way a freshly installed TV does it ----
  const tvs = await Promise.all(['Room A', 'Room B', 'Room C'].map(l => new VirtualTV(l).register()));
  check('every TV registers', tvs.every(t => !!t.id));
  if (ENTRY !== BASE) check('TVs entering through the app default are handed to the live server', tvs.every(t => t.home === BASE));
  await Promise.all(tvs.map(t => t.connect()));
  const codes = await Promise.all(tvs.map(t => t.waitFor(m => isState(m) && m.approved === false && /^\d{6}$/.test(m.pairCode))));
  check('every TV shows a 6-digit code', codes.every(Boolean));
  for (const [i, t] of tvs.entries()) {
    const c = await http(BASE, token, 'POST', '/api/tvs/claim', { code: codes[i].pairCode });
    check(`${t.label}: code adds the screen`, c.status === 200);
    await http(BASE, token, 'PATCH', `/api/tvs/${t.id}`, { name: t.label });
  }
  const approved = await Promise.all(tvs.map(t => t.waitFor(m => isState(m) && m.approved === true)));
  check('every TV leaves pairing on its own (no refresh)', approved.every(Boolean));

  // ---- content ----
  const media = [];
  for (const n of [1, 2]) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(2048)], { type: 'image/png' }), `lifecycle-${n}.png`);
    const up = await http(BASE, token, 'POST', '/api/media', form);
    if (up.data.media) media.push(up.data.media.id);
  }
  check('media uploads', media.length === 2);
  const pl = (await http(BASE, token, 'POST', '/api/playlists', {
    name: 'Lifecycle loop', transition: 'fade', items: media.map(id => ({ mediaId: id, enabled: true }))
  })).data.playlist;
  check('playlist created', !!pl?.id);
  for (const t of tvs) await http(BASE, token, 'POST', `/api/tvs/${t.id}/playlist`, { playlistId: pl.id });
  const two = await Promise.all(tvs.map(t => t.waitFor(playing(2))));
  check('every TV receives the 2-item playlist', two.every(Boolean));
  const url = two[0]?.playlist[0]?.url;
  check('the TV can download what it is told to play', !!url && (await fetch(BASE + url)).status === 200);

  // live edit: drop an item, every TV updates without reconnecting
  const waits = tvs.map(t => t.next(playing(1)));
  await http(BASE, token, 'POST', '/api/playlists', { id: pl.id, name: pl.name, transition: 'fade', items: [{ mediaId: media[0], enabled: true }] });
  check('a playlist edit reaches every TV live', (await Promise.all(waits)).every(Boolean));

  // ---- party: only the party room changes ----
  const [a, b, c] = tvs;
  const ev = (await http(BASE, token, 'POST', '/api/events', {
    tvId: b.id, name: 'Lifecycle', age: 9, startsAt: new Date(Date.now() + 3600e3).toISOString(), durationMin: 15, theme: 'party'
  })).data.event;
  check('party scheduled', !!ev?.id);
  const bTake = b.next(m => isState(m) && m.override && m.override.name === 'Lifecycle');
  const aTake = a.next(m => isState(m) && !!m.override, 3000);
  await http(BASE, token, 'POST', `/api/events/${ev.id}/start-now`, {});
  check('the party room takes over with the name', !!(await bTake));
  check('other rooms keep playing', !(await aTake) && !a.state.override);
  const bBack = b.next(playing(1));
  await http(BASE, token, 'POST', `/api/tvs/${b.id}/clear-override`, {});
  check('stopping the takeover restores the loop', !!(await bBack));

  // ---- screen off / on ----
  const cOff = c.next(m => isState(m) && m.power === 'off');
  await http(BASE, token, 'POST', `/api/tvs/${c.id}/power`, { power: 'off' });
  check('screen off reaches the TV', !!(await cOff));
  const cOn = c.next(playing(1));
  await http(BASE, token, 'POST', `/api/tvs/${c.id}/power`, { power: 'on' });
  check('screen on resumes the loop', !!(await cOn));

  // ---- the dashboard sees what each TV reports ----
  a.status({ clockSkewMs: -82 * 86400000, device: { ua: 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633; wv) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' } });
  await sleep(1200);
  let st = (await http(BASE, token, 'GET', '/api/state')).data;
  const sa = st.tvs.find(t => t.id === a.id);
  check('dashboard shows which device a screen is', /Fire TV · AFTMM · Android 9/.test(sa?.device?.label || ''));
  check('dashboard sees a wrong TV clock', (sa?.clockSkewMs || 0) < -80 * 86400000);
  check('every screen shows online', st.tvs.length === 3 && st.tvs.every(t => t.online));

  // ---- a TV that drops off and comes back keeps its identity ----
  a.close();
  await sleep(1500);
  st = (await http(BASE, token, 'GET', '/api/state')).data;
  check('a dropped TV shows offline', st.tvs.find(t => t.id === a.id)?.online === false);
  await a.connect();
  check('the same TV reconnects straight into its playlist', !!(await a.next(playing(1))));

  // ---- Replace TV: a new device takes over Room B, keeping its party ----
  const party2 = (await http(BASE, token, 'POST', '/api/events', {
    tvId: b.id, name: 'Keeps', age: 7, startsAt: new Date(Date.now() + 7200e3).toISOString(), durationMin: 15
  })).data.event;
  const fresh = await new VirtualTV('replacement').register();
  await fresh.connect();
  const fc = await fresh.waitFor(m => isState(m) && /^\d{6}$/.test(m.pairCode || ''));
  const oldBack = b.next(m => m.type === 'reregister');
  const rep = await http(BASE, token, 'POST', `/api/tvs/${b.id}/replace`, { code: fc?.pairCode });
  check('Replace TV accepts the new TV’s code', rep.status === 200);
  check('the new TV takes over the screen and its playlist', !!(await fresh.waitFor(playing(1))) && fresh.id === b.id);
  check('the old device is released back to pairing', !!(await oldBack));
  st = (await http(BASE, token, 'GET', '/api/state')).data;
  check('still three screens, same name', st.tvs.length === 3 && st.tvs.some(t => t.id === b.id && t.name === 'Room B'));
  check('the screen keeps its scheduled party', st.events.some(e => e.id === party2?.id && e.tvId === b.id && e.status === 'scheduled'));
  b.close();

  // ---- removing a screen sends its TV back to pairing ----
  const closed = new Promise(r => c.ws.once('close', () => r(true)));
  await http(BASE, token, 'DELETE', `/api/tvs/${c.id}`);
  check('removing a screen disconnects that TV', await Promise.race([closed, sleep(5000).then(() => false)]));

  [a, fresh].forEach(t => t.close());
};

const cleanup = async () => {
  if (!token) return;
  const del = await http(BASE, token, 'DELETE', '/api/venue', { password: PASSWORD, confirmName: VENUE });
  check('throwaway venue deleted (files and screens gone)', del.status === 200);
};

run()
  .catch(err => { console.error('Lifecycle check crashed:', err); failures++; })
  .finally(async () => {
    await cleanup().catch(() => { failures++; });
    console.log(failures === 0 ? '\nFull lifecycle passed.' : `\n${failures} FAILURES`);
    process.exit(failures === 0 ? 0 : 1);
  });
