// Unit tests for the booking-byline parser. Run: node scripts/test-byline.js
import { parseByline } from '../src/byline.js';

const cases = [
  // [byline, expected name, expected age, minimum confidence]
  ["Nathan's 10th birthday party", 'Nathan', 10, 'high'],
  ["Nathan’s 10th Birthday Party", 'Nathan', 10, 'high'],   // curly apostrophe
  ["Sophia's 7th Bday", 'Sophia', 7, 'high'],
  ["Liam's birthday party", 'Liam', null, 'high'],
  ["Mia Rodriguez's 6th b-day", 'Mia Rodriguez', 6, 'high'],
  ['Birthday party - Marcus (9)', 'Marcus', 9, 'high'],
  ['Birthday: Ava', 'Ava', null, 'high'],
  ['10th bday – Emma', 'Emma', 10, 'high'],
  ['Birthday party for Noah age 8', 'Noah', 8, 'high'],
  ['Glow party for Zoe', 'Zoe', null, 'high'],
  ['Jackson 12th birthday', 'Jackson', 12, 'medium'],
  ['Olivia birthday party', 'Olivia', null, 'medium'],
  ["Deluxe party package - Harper's 5th", 'Harper', 5, null], // any confidence, name+age right
  ['Emma and Ava twin party', null, null, 'low'],             // ambiguous -> low, name optional
  ['Corporate team event', null, null, 'low'],
  ['', null, null, 'low'],
  ["D'Angelo's 9th birthday", "D'Angelo", 9, 'high'],
  ['Party turning 6 - Lucas', 'Lucas', 6, 'high'],
];

const RANK = { low: 0, medium: 1, high: 2 };
let failed = 0;
for (const [byline, wantName, wantAge, minConf] of cases) {
  const got = parseByline(byline);
  const problems = [];
  // Name: exact when expected; when expected null we accept any suggestion
  // as long as confidence is low (the UI flags it for review).
  if (wantName !== null && got.name !== wantName) problems.push(`name ${JSON.stringify(got.name)} != ${JSON.stringify(wantName)}`);
  if (wantAge !== got.age) problems.push(`age ${got.age} != ${wantAge}`);
  if (minConf && RANK[got.confidence] < RANK[minConf]) problems.push(`confidence ${got.confidence} < ${minConf}`);
  if (wantName === null && got.confidence !== 'low') problems.push(`expected low confidence, got ${got.confidence}`);
  if (problems.length) {
    failed++;
    console.error(`FAIL  ${JSON.stringify(byline)} -> ${JSON.stringify(got)}\n      ${problems.join('; ')}`);
  } else {
    console.log(`ok    ${JSON.stringify(byline)} -> ${got.name ?? '—'}${got.age ? ', ' + got.age : ''} (${got.confidence})`);
  }
}
if (failed) { console.error(`\n${failed} byline test(s) failed`); process.exit(1); }
console.log('\nAll byline tests passed.');
