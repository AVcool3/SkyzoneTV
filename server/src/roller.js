// ROLLER booking-platform connector.
//
// Status: SCAFFOLD, wired but dormant. It activates the moment credentials
// appear in the environment; until then status reports configured:false, the
// dashboard shows a "connect" card, and the temporary test-CSV import (see
// /api/test-bookings/csv in index.js) stands in for it.
//
// Configuration (server environment variables):
//   ROLLER_CLIENT_ID     — from ROLLER's developer/API settings
//   ROLLER_CLIENT_SECRET
//   ROLLER_BASE_URL      — optional, defaults to https://api.roller.app
//
// The request shapes below follow ROLLER's published OAuth2 client-credentials
// + REST bookings pattern, but MUST be verified against the live API the day
// real credentials arrive (their endpoint paths and field names may differ by
// account/version). Everything downstream is insulated from that: this module
// hands back rows in one normalized shape and index.js turns them into the
// same party events the test CSV produces.
//
// Normalized booking row:
//   { externalRef, startsAt (ISO), durationMin, roomLabel, byline }

import { parseByline } from './byline.js';

const BASE = process.env.ROLLER_BASE_URL || 'https://api.roller.app';
const CLIENT_ID = process.env.ROLLER_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ROLLER_CLIENT_SECRET || '';

export function rollerConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

export function rollerStatus() {
  return {
    configured: rollerConfigured(),
    baseUrl: rollerConfigured() ? BASE : null,
    hint: rollerConfigured()
      ? null
      : 'Set ROLLER_CLIENT_ID and ROLLER_CLIENT_SECRET in the server environment to connect.'
  };
}

let cachedToken = null; // { token, expiresAt }

async function getToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  });
  if (!res.ok) throw new Error(`ROLLER auth failed (${res.status})`);
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 30 * 60_000)
  };
  return cachedToken.token;
}

// Fetch bookings for a calendar date (YYYY-MM-DD) and normalize them.
async function fetchBookingsForDate(date) {
  const token = await getToken();
  const res = await fetch(`${BASE}/bookings?date=${encodeURIComponent(date)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`ROLLER bookings fetch failed (${res.status})`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.items || data.bookings || []);
  const rows = [];
  for (const b of list) {
    // Field mapping is deliberately defensive — verify against live data.
    const startsAt = b.startTime || b.startsAt || b.start_date || null;
    if (!startsAt) continue;
    rows.push({
      externalRef: String(b.id ?? b.bookingId ?? b.reference ?? ''),
      startsAt: new Date(startsAt).toISOString(),
      durationMin: Number(b.durationMinutes ?? b.duration ?? 0) || null,
      roomLabel: String(b.resourceName ?? b.room ?? b.space ?? '').trim(),
      byline: String(b.name ?? b.title ?? b.description ?? '').trim()
    });
  }
  return rows;
}

// Sync today's (and optionally tomorrow's) bookings into the store's events.
// Mirrors the test-CSV semantics: parsed name/age with confidence, everything
// editable afterwards, and existing edits are never clobbered — a booking
// already imported (matched by externalRef) only has its time/room refreshed.
export async function rollerSync(store, { matchTv, days = 1 } = {}) {
  if (!rollerConfigured()) return { configured: false, imported: 0, updated: 0, errors: [] };
  const errors = [];
  let imported = 0, updated = 0;
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    dates.push(d.toISOString().slice(0, 10));
  }
  for (const date of dates) {
    let rows;
    try { rows = await fetchBookingsForDate(date); }
    catch (e) { errors.push({ date, error: e.message }); continue; }
    for (const row of rows) {
      if (!row.externalRef) continue;
      const tv = matchTv ? matchTv(store.data.tvs, row.roomLabel) : null;
      if (!tv) { errors.push({ date, error: `No TV matches room "${row.roomLabel}" (booking ${row.externalRef})` }); continue; }
      const existing = store.data.events.find(e => e.source === 'roller' && e.externalRef === row.externalRef);
      if (existing) {
        // Refresh schedule facts only; the operator's name/age/theme edits win.
        if (existing.status === 'scheduled') {
          existing.startsAt = row.startsAt;
          if (row.durationMin) existing.durationMin = Math.min(row.durationMin, 240);
          existing.tvId = tv.id;
          updated++;
        }
        continue;
      }
      const parsed = parseByline(row.byline);
      store.data.events.push({
        id: crypto.randomUUID(),
        tvId: tv.id,
        name: parsed.name || 'Birthday Star',
        age: parsed.age,
        message: null,
        startsAt: row.startsAt,
        durationMin: Math.min(row.durationMin || 5, 240),
        mediaId: null,
        theme: 'party',
        status: 'scheduled',
        source: 'roller',
        externalRef: row.externalRef,
        byline: row.byline,
        parsed
      });
      imported++;
    }
  }
  if (imported || updated) {
    store.data.events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    store.save();
  }
  return { configured: true, imported, updated, errors };
}
