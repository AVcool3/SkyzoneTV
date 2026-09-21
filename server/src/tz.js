// Timezone-correct wall-clock parsing, no dependencies.
//
// Booking CSVs and ROLLER feeds carry wall-clock times ("14:30 in the
// venue's timezone"), but the cloud server runs in UTC — building a Date
// from raw parts there fires parties hours off. Each venue stores an IANA
// timezone (venue.tz); these helpers materialize wall-clock parts into the
// correct UTC instant for that zone.

// Wall-clock reading of instant `ts` in `tz`, expressed as UTC ms.
function wallClockOf(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ts));
  const v = {};
  for (const p of parts) v[p.type] = p.value;
  return Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute, +v.second);
}

// The UTC Date at which `tz` shows the given wall-clock parts.
// Two correction passes converge everywhere except inside a DST spring-
// forward gap, where the result lands on the nearest valid instant.
export function zonedTimeToUtc(y, mo, d, h = 0, min = 0, tz = null) {
  if (!tz) return new Date(y, mo - 1, d, h, min, 0, 0); // server-local fallback
  const target = Date.UTC(y, mo - 1, d, h, min, 0);
  let ts = target;
  for (let i = 0; i < 2; i++) ts = target - (wallClockOf(ts, tz) - ts);
  return new Date(ts);
}

// Today's calendar date (YYYY-MM-DD) as the venue sees it.
export function dateInZone(tz, offsetDays = 0) {
  const ts = Date.now() + offsetDays * 86_400_000;
  if (!tz) return new Date(ts).toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(ts));
  return parts; // en-CA formats as YYYY-MM-DD
}

export function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}
