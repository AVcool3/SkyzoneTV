/* Freeze recovery, in a real browser.
 *
 * Boots its own throwaway server, generates two short WebM clips with
 * ffmpeg, plays them as a playlist in headless Chromium, then deliberately
 * freezes the picture and checks the player heals itself:
 *   - normal playback never trips the watchdog
 *   - a frozen video is skipped within ~30s, with no page reload
 *   - a second freeze soon after reloads the player
 *   - the dashboard's health counters see it (self-reloads are not crashes)
 *
 * Needs ffmpeg on PATH and Playwright (npm i -D playwright, or a global
 * install). Takes about 2.5 minutes. Not part of CI.
 *   node scripts/test-freeze-recovery.js
 */
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// require() so a globally installed Playwright (NODE_PATH) works too.
const { chromium } = createRequire(import.meta.url)('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8096);
const B = `http://localhost:${PORT}`;
const PASSWORD = 'freeze-test';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let token, failures = 0;
const check = (n, c) => { console.log(`${c ? '  ok ' : 'FAIL '} ${n}`); if (!c) failures++; };

async function api(m, p, body) {
  const r = await fetch(B + p, { method: m,
    headers: { ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined });
  return r.json().catch(() => ({}));
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'parkcast-freeze-'));
  for (const [name, src] of [['a.webm', 'testsrc'], ['b.webm', 'testsrc2']]) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${src}=size=640x360:rate=25`,
      '-t', '20', '-c:v', 'libvpx', '-b:v', '300k', path.join(work, name)]);
  }
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: PASSWORD, DATA_DIR: path.join(work, 'data'), REQUIRE_TV_APPROVAL: '' },
    stdio: 'ignore'
  });
  let browser;
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch (_err) {} await sleep(250); }
    token = (await api('POST', '/api/login', { password: PASSWORD })).token;
    const upload = async f => {
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(path.join(work, f))], { type: 'video/webm' }), f);
      return (await api('POST', '/api/media', fd)).media;
    };
    const a = await upload('a.webm'), b = await upload('b.webm');
    const pl = (await api('POST', '/api/playlists', { name: 'Freeze test', items: [{ mediaId: a.id }, { mediaId: b.id }] })).playlist;

    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const pg = await browser.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    await pg.goto(B + '/player/');
    let tvId = null;
    for (let i = 0; i < 40 && !tvId; i++) { await sleep(250); tvId = await pg.evaluate(() => localStorage.getItem('parkcast.tvId')); }
    check('player registered', !!tvId);
    await api('POST', `/api/tvs/${tvId}/playlist`, { playlistId: pl.id });

    const health = async () => ((await api('GET', '/api/state')).tvs.find(t => t.id === tvId) || {}).health;
    const activeVideo = () => pg.evaluate(() => {
      const v = [...document.querySelectorAll('video')].find(x => x.classList.contains('visible'));
      return v ? { t: v.currentTime, src: v.src.split('/').pop() } : null;
    });
    const freezeActive = () => pg.evaluate(() => {
      const v = [...document.querySelectorAll('video')].find(x => x.classList.contains('visible'));
      v.pause();
      v.play = () => Promise.resolve(); // the decoder "hangs": play() does nothing
    });

    await sleep(3000);
    const v0 = await activeVideo();
    check('a video is playing', !!v0);
    console.log('   normal playback for 50s (clips are 20s each)...');
    await sleep(50000);
    const v1 = await activeVideo();
    let h = await health();
    check('normal playback moves through the loop', !!v1 && (v1.src !== v0.src || v1.t !== v0.t));
    check('no false freeze during normal playback', !!h && h.freezes === 0);
    check('first start counted once', !!h && h.restarts === 1);

    await pg.evaluate(() => { window.__marker = 1; });
    await freezeActive();
    console.log('   froze the picture; waiting for the watchdog...');
    await sleep(42000);
    const v2 = await activeVideo();
    await sleep(2000);
    const v2b = await activeVideo();
    h = await health();
    check('frozen video recovered: picture moving again', !!v2 && !!v2b && v2b.t !== v2.t);
    check('freeze reported to the dashboard', !!h && h.freezes === 1);
    check('recovered without reloading the page', await pg.evaluate(() => window.__marker === 1));

    await freezeActive();
    console.log('   froze again; expecting a self-reload...');
    await sleep(45000);
    const reloaded = await pg.evaluate(() => window.__marker === undefined).catch(() => false);
    await sleep(8000);
    const v3 = await activeVideo();
    await sleep(2000);
    const v3b = await activeVideo();
    h = await health();
    check('second freeze reloads the player', reloaded);
    check('playing again after the reload', !!v3 && !!v3b && v3b.t !== v3.t);
    check('self-reload is not counted as a crash', !!h && h.restarts === 1 && h.freezes === 2);
    check('no page errors', errs.length === 0);
    if (errs.length) console.log(errs);
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILURES` : '\nFreeze recovery test passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
