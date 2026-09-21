/* Store migration unit test (no server needed): node scripts/test-migrate.js
 * Guards the two behaviors a restart must get right:
 *  - pre-multi-tenant rows (no venueId key) are adopted by the default venue
 *  - unclaimed cloud screens (venueId: null) are NOT adopted — a deploy must
 *    never steal a screen that is showing its pairing code
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${name}`);
  if (!cond) failures++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parkcast-migrate-'));
const file = path.join(dir, 'db.json');

// A pre-multi-tenant database, as production looked before the upgrade.
fs.writeFileSync(file, JSON.stringify({
  tvs: [{ id: 'tv-legacy', name: 'Main Court', power: 'on', assignedMediaIds: [], playlistId: null, override: null }],
  media: [{ id: 'm1', label: 'promo', ext: '.mp4', size: 1 }],
  folders: [], playlists: [], events: [],
  settings: {
    adminPassword: 'pw', venueName: 'Sky Zone Schaumburg', dayStarted: true,
    customThemes: [{ id: 'ct1', name: 'Glow' }],
    tokens: ['legacy-token-string']
  }
}));

let store = new Store(file);
check('legacy db creates one venue', store.data.venues.length === 1);
check('venue keeps its stored name', store.data.venues[0].name === 'Sky Zone Schaumburg');
check('legacy custom themes move onto the venue', store.data.venues[0].customThemes[0]?.name === 'Glow');
check('legacy tv adopted by default venue', store.tv('tv-legacy')?.venueId === store.defaultVenueId());
check('legacy media adopted by default venue', store.medium('m1')?.venueId === store.defaultVenueId());
const tok = store.data.settings.tokens[0];
check('legacy token becomes a session object', tok?.token === 'legacy-token-string' && tok.userId === 'legacy-admin');
check('legacy token gets an age for expiry', typeof tok?.createdAt === 'number');
check('per-venue settings leave the global object',
  store.data.settings.venueName === undefined && store.data.settings.customThemes === undefined);

// Now an unclaimed cloud screen appears (venueId: null, showing a pair code)
// and the server restarts — it must still be claimable afterwards.
store.data.tvs.push({
  id: 'tv-unclaimed', venueId: null, name: 'New screen', approved: false,
  pairCode: '123456', pairCodeAt: Date.now(), lastSeen: new Date().toISOString(),
  power: 'on', assignedMediaIds: [], playlistId: null, override: null
});
store.saveNow();

store = new Store(file); // simulated deploy/restart
check('restart keeps unclaimed screen unclaimed', store.tv('tv-unclaimed')?.venueId === null);
check('restart keeps its pairing code', store.tv('tv-unclaimed')?.pairCode === '123456');
check('restart still adopts legacy rows', store.tv('tv-legacy')?.venueId === store.defaultVenueId());

// A brand-new empty database must not carry the pilot customer's branding.
const freshFile = path.join(dir, 'fresh.json');
const fresh = new Store(freshFile);
check('fresh install is not branded Sky Zone', fresh.data.venues[0].name === 'My Venue');

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll migration tests passed.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
