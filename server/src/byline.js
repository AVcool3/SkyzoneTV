// Byline parsing: extract the birthday kid's name and age from a raw booking
// title ("byline") such as "Nathan's 10th birthday party".
//
// Booking systems (ROLLER, and the temporary test CSV that stands in for it)
// carry this information as free text typed by whoever took the booking, so
// extraction is best-effort. The result always carries a confidence level and
// the UI keeps name and age editable regardless — even a "high" confidence
// parse can be wrong ("Jordan's 5th birthday" might be the parent's name).
//
//   parseByline("Nathan's 10th birthday party")
//     -> { name: "Nathan", age: 10, confidence: "high" }
//
// confidence: 'high'   — an explicit possessive-or-labelled name was found
//             'medium' — a name was found but from a weaker pattern
//             'low'    — nothing usable; name/age may be null. Needs review.

const APOS = "['’ʼ]"; // straight, curly, modifier apostrophes
const NOISE_WORDS = new Set([
  'birthday', 'bday', 'bdays', 'day', 'party', 'parties', 'celebration',
  'event', 'booking', 'package', 'room', 'the', 'a', 'an', 'for', 'and',
  'with', 'happy', 'kids', 'kid', 'group', 'private', 'deluxe', 'basic',
  'premium', 'ultimate', 'glow', 'jump', 'super', 'mega', 'turning', 'turns',
  'age', 'years', 'year', 'old', 'yo', 'yr', 'yrs',
  'st', 'nd', 'rd', 'th' // ordinal remnants once digits are stripped ("5th" -> "th")
]);

function toAge(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : null;
}

// Pull an age out of anywhere in the text: "10th birthday", "(10)", "age 10",
// "turning 10", "10 yo", "10 years old".
function findAge(text) {
  let m = text.match(new RegExp(`(\\d{1,2})\\s*(?:st|nd|rd|th)\\s+b(?:irth)?[\\s-]?day`, 'i'));
  if (m) return toAge(m[1]);
  m = text.match(/\((\d{1,2})\)/);
  if (m) return toAge(m[1]);
  m = text.match(/\b(?:age|turning|turns)\s*[:\s]\s*?(\d{1,2})\b/i);
  if (m) return toAge(m[1]);
  m = text.match(/\b(\d{1,2})\s*(?:yo|y\/o|yr|yrs|years?)(?:\s+old)?\b/i);
  if (m) return toAge(m[1]);
  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (m) return toAge(m[1]);
  return null;
}

// Reduce a captured fragment to something that plausibly IS a name:
// strip noise words, digits and punctuation, keep at most three words,
// title-case the result. Returns null when nothing name-like survives.
function cleanName(fragment) {
  if (!fragment) return null;
  const words = String(fragment)
    .replace(/\(\d{1,2}\)/g, ' ')
    .replace(/[^\p{L}\p{M}\s.'’-]/gu, ' ')
    .split(/\s+/)
    .map(w => w.replace(new RegExp(`${APOS}s?$`, 'i'), '')) // trailing possessive
    .filter(w => w && /\p{L}/u.test(w) && !NOISE_WORDS.has(w.toLowerCase()) && !/\d/.test(w));
  if (words.length === 0 || words.length > 4) return null;
  const name = words.slice(0, 3)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 40);
  // A lone initial or stray punctuation isn't a name.
  return /\p{L}{2}/u.test(name) ? name : null;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// The headline a takeover shows when the operator hasn't typed a custom one.
// Age-aware: "Happy 10th Birthday, Nathan!" beats the generic line.
export function defaultBirthdayMessage(ev) {
  return ev.age
    ? `Happy ${ordinal(ev.age)} Birthday, ${ev.name}!`
    : `Happy Birthday, ${ev.name}!`;
}

export function parseByline(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { name: null, age: null, confidence: 'low' };
  const age = findAge(text);
  let m;

  // "Nathan's 10th birthday party" / "Nathan's birthday" — the possessive is
  // the strongest signal that the words before it are the kid's name.
  m = text.match(new RegExp(`^(.{1,40}?)${APOS}s\\s+(?:\\d{1,2}\\s*(?:st|nd|rd|th)?\\s+)?b(?:irth)?[\\s-]?day`, 'i'));
  if (m) {
    const name = cleanName(m[1]);
    if (name) return { name, age, confidence: 'high' };
  }

  // "Birthday party - Nathan (10)" / "Birthday: Nathan" / "10th bday – Emma"
  m = text.match(new RegExp(`b(?:irth)?[\\s-]?day[^\\-–—:]*[\\-–—:]\\s*(.{1,40})$`, 'i'));
  if (m) {
    const name = cleanName(m[1]);
    if (name) return { name, age, confidence: 'high' };
  }

  // "Birthday party for Nathan" / "party for Nathan age 8"
  m = text.match(/\bfor\s+(.{1,40})$/i);
  if (m) {
    const name = cleanName(m[1]);
    if (name) return { name, age, confidence: 'high' };
  }

  // "Deluxe party package - Harper's 5th" — a possessive followed by an
  // ordinal, with no birthday word at all. The 's + Nth combination is
  // still an unmistakable birthday-kid signal.
  m = text.match(new RegExp(`(\\S.{0,38}?)${APOS}s\\s+\\d{1,2}\\s*(?:st|nd|rd|th)\\b`, 'i'));
  if (m) {
    const name = cleanName(m[1].split(/[\-–—:]/).pop());
    if (name) return { name, age, confidence: 'high' };
  }

  // "Party turning 6 - Lucas" — a trailing dash-name where the front half is
  // clearly party context (party/turning/age/celebration wording).
  m = text.match(/^(.*[\p{L}\d])\s*[\-–—:]\s*(.{1,40})$/u);
  if (m && /\b(part(?:y|ies)|celebration|turning|age|b(?:irth)?[\s-]?day)\b/i.test(m[1])) {
    const name = cleanName(m[2]);
    if (name) return { name, age, confidence: 'high' };
  }

  // "Nathan 10th birthday" / "Nathan birthday party" — name(s) directly
  // before the birthday words, no possessive. Good but a notch weaker.
  m = text.match(new RegExp(`^(.{1,40}?)\\s+(?:\\d{1,2}\\s*(?:st|nd|rd|th)?\\s+)?b(?:irth)?[\\s-]?day`, 'i'));
  if (m) {
    const name = cleanName(m[1]);
    if (name) return { name, age, confidence: 'medium' };
  }

  // Last resort: if the whole byline reduces to something name-like
  // ("Emma and Ava twin party" -> "Emma Ava"), offer it at low confidence
  // so the operator sees a starting point rather than a blank.
  const name = cleanName(text);
  return { name, age, confidence: 'low' };
}
