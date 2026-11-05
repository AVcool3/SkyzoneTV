/* The TV player runs inside whatever WebView a streaming stick ships, some
 * of them years old. Keep its scripts to ES2017 (Chrome 58): a single newer
 * construct makes the whole file fail to parse, and the TV sits on
 * "Connecting…" forever with no error anywhere. Run: node scripts/test-tv-syntax.js
 */
import fs from 'node:fs';

const FILES = ['public/player/player.js', 'public/player/birthday.js', 'public/player/sw.js'];
const BANNED = [
  [/\bcatch\s*\{/, 'optional catch binding — write catch (_err) {'],
  [/\?\.(?!\d)/, 'optional chaining ?.'],
  [/\?\?/, 'nullish coalescing ??'],
  [/\d_\d/, 'numeric separator (60_000)'],
  [/\.(replaceAll|flat|flatMap|matchAll|at)\(/, 'post-2018 array/string method'],
  [/\bObject\.fromEntries\b/, 'Object.fromEntries']
];

let failures = 0;
for (const f of FILES) {
  const lines = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const [re, what] of BANNED) {
      if (re.test(code)) { console.log(`FAIL ${f}:${i + 1} ${what}\n     ${line.trim()}`); failures++; }
    }
  });
}
console.log(failures === 0 ? 'TV player syntax: ES2017-safe.' : `\n${failures} construct(s) too new for older TV browsers`);
process.exit(failures === 0 ? 0 : 1);
