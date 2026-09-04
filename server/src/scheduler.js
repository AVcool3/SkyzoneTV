// Event scheduler: activates birthday/event takeovers at their start time and
// clears them when their duration elapses. Only the targeted TV is touched —
// every other TV keeps playing its own loop.

export function startScheduler(store, { onTvChanged, onStateChanged }) {
  function tick() {
    const now = Date.now();
    let stateChanged = false;
    const touchedTvs = new Set();

    for (const ev of store.data.events) {
      const startMs = Date.parse(ev.startsAt);
      if (!Number.isFinite(startMs)) continue;
      const endMs = startMs + ev.durationMin * 60_000;

      if (ev.status === 'scheduled' && now >= startMs) {
        if (now >= endMs) {
          // Missed entirely (server was down past the whole window) — don't flash it late.
          ev.status = 'done';
          stateChanged = true;
          continue;
        }
        const tv = store.tv(ev.tvId);
        ev.status = 'active';
        stateChanged = true;
        if (tv) {
          tv.override = {
            eventId: ev.id,
            name: ev.name,
            message: ev.message || null,
            mediaId: ev.mediaId || store.data.settings.birthdayMediaId || null,
            endsAt: new Date(endMs).toISOString(),
            theme: ev.theme || 'party',
            // A blanked screen wakes for its scheduled party and re-blanks
            // after — a birthday must never play invisibly onto a black TV.
            restorePowerOff: tv.power === 'off'
          };
          tv.power = 'on';
          touchedTvs.add(tv.id);
        }
      } else if (ev.status === 'active' && now >= endMs) {
        ev.status = 'done';
        stateChanged = true;
        const tv = store.tv(ev.tvId);
        if (tv && tv.override && tv.override.eventId === ev.id) {
          if (tv.override.restorePowerOff) tv.power = 'off';
          tv.override = null;
          touchedTvs.add(tv.id);
        }
      }
    }

    // Safety net: clear any expired override not tied to a live event
    // (manual tests, deleted events, clock jumps).
    for (const tv of store.data.tvs) {
      if (tv.override && Date.parse(tv.override.endsAt) <= now) {
        if (tv.override.restorePowerOff) tv.power = 'off';
        tv.override = null;
        touchedTvs.add(tv.id);
        stateChanged = true;
      }
    }

    if (stateChanged) store.save();
    for (const tvId of touchedTvs) onTvChanged(tvId);
    if (stateChanged) onStateChanged();
  }

  const interval = setInterval(tick, 1000);
  tick();
  return { stop: () => clearInterval(interval), tick };
}
