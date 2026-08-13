// CSV parsing for the daily events file.
//
// Expected headers (case-insensitive, order-free):
//   date, time, tv, name  — required
//   message, duration, media — optional
//
// date:     2026-08-13  or  8/13/2026
// time:     14:30  or  2:30 PM
// tv:       TV label as shown in the dashboard ("Room 1" matches "room 1", "TV Room 1", ...)
// name:     birthday kid / event name shown on screen
// message:  optional custom headline (default "Happy Birthday, <name>!")
// duration: minutes on screen (default 5)
// media:    optional media label from the library to play behind the message

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);
    row = [];
  };
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') { pushField(); pushRow(); }
    else if (c !== '\r') field += c;
  }
  pushField(); pushRow();
  return rows;
}

function parseDate(str) {
  const t = String(str || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return { y, mo: +m[1], d: +m[2] };
  }
  return null;
}

function parseTime(str) {
  const t = String(str || '').trim();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|AM|PM|Am|Pm)?$/);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  const ap = m[3] ? m[3].toLowerCase() : null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, min };
}

export function normalizeLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Match a CSV "tv" value against the TV list: exact normalized match first,
// then substring either way ("room1" matches "TV Room 1").
export function matchTv(tvs, value) {
  const v = normalizeLabel(value);
  if (!v) return null;
  let hit = tvs.find(t => normalizeLabel(t.name) === v);
  if (hit) return hit;
  hit = tvs.find(t => normalizeLabel(t.name).includes(v) || v.includes(normalizeLabel(t.name)));
  return hit || null;
}

export function matchMedia(media, value) {
  const v = normalizeLabel(value);
  if (!v) return null;
  let hit = media.find(m => normalizeLabel(m.label) === v);
  if (hit) return hit;
  hit = media.find(m => normalizeLabel(m.label).includes(v) || v.includes(normalizeLabel(m.label)));
  return hit || null;
}

// Returns { events: [...], errors: [{line, error}] }
export function parseEventsCsv(text, tvs, media) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { events: [], errors: [{ line: 0, error: 'Empty file' }] };

  const headers = rows[0].map(h => normalizeLabel(h));
  const col = (...names) => {
    for (const n of names) {
      const i = headers.indexOf(normalizeLabel(n));
      if (i !== -1) return i;
    }
    return -1;
  };
  const iDate = col('date'), iTime = col('time', 'start', 'starttime'),
    iTv = col('tv', 'room', 'tvname', 'screen'), iName = col('name', 'birthdayname', 'kid', 'guest'),
    iMsg = col('message', 'headline'), iDur = col('duration', 'durationminutes', 'minutes'),
    iMedia = col('media', 'video', 'medialabel');

  const errors = [];
  if (iDate === -1 || iTime === -1 || iTv === -1 || iName === -1) {
    return {
      events: [],
      errors: [{ line: 1, error: 'Missing required headers. Need: date, time, tv, name (optional: message, duration, media)' }]
    };
  }

  const events = [];
  for (let r = 1; r < rows.length; r++) {
    const line = r + 1;
    const cells = rows[r];
    const get = i => (i >= 0 && i < cells.length ? cells[i].trim() : '');
    const date = parseDate(get(iDate));
    const time = parseTime(get(iTime));
    const name = get(iName);
    if (!date) { errors.push({ line, error: `Bad date "${get(iDate)}" (use YYYY-MM-DD or M/D/YYYY)` }); continue; }
    if (!time) { errors.push({ line, error: `Bad time "${get(iTime)}" (use HH:MM or h:mm AM/PM)` }); continue; }
    if (!name) { errors.push({ line, error: 'Missing name' }); continue; }

    const tv = matchTv(tvs, get(iTv));
    if (!tv) { errors.push({ line, error: `No TV matches "${get(iTv)}" — check TV names in the dashboard` }); continue; }

    let mediaId = null;
    const mediaLabel = get(iMedia);
    if (mediaLabel) {
      const m = matchMedia(media, mediaLabel);
      if (m) mediaId = m.id;
      else errors.push({ line, error: `Media "${mediaLabel}" not found — will use the default birthday screen` });
    }

    let durationMin = parseFloat(get(iDur));
    if (!Number.isFinite(durationMin) || durationMin <= 0) durationMin = 5;
    durationMin = Math.min(durationMin, 240);

    const startsAt = new Date(date.y, date.mo - 1, date.d, time.h, time.min, 0, 0);
    events.push({
      tvId: tv.id,
      name,
      message: get(iMsg) || null,
      startsAt: startsAt.toISOString(),
      durationMin,
      mediaId
    });
  }
  return { events, errors };
}
