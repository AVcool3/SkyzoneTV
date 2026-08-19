/* Skyzone TV player.
 * Registers itself with the server, then plays whatever the dashboard assigns.
 * Handles: playlist looping, birthday/event takeovers, power off (black screen),
 * reconnect with backoff, and keeps playing its current loop if the server
 * connection drops so one broken link never blanks a TV.
 */
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('fit') === 'cover') document.body.classList.add('fit-cover');
  const AUDIO = params.get('audio') === '1';

  const videoA = document.getElementById('videoA');
  const videoB = document.getElementById('videoB');
  const idle = document.getElementById('idle');
  const idleName = document.getElementById('idleName');
  const idleConn = document.getElementById('idleConn');
  const off = document.getElementById('off');
  const overrideEl = document.getElementById('override');
  const overrideVideo = document.getElementById('overrideVideo');
  const overrideHeadline = document.getElementById('overrideHeadline');
  const netdot = document.getElementById('netdot');

  let tvId = localStorage.getItem('skyzone.tvId') || null;
  let ws = null;
  let reconnectDelay = 1000;
  let state = null;           // last state from server
  let playlist = [];          // [{id,label,url}]
  let playlistKey = '';
  let current = 0;            // index in playlist
  const imageA = document.getElementById('imageA');
  const imageB = document.getElementById('imageB');
  const slotA = { video: videoA, image: imageA };
  const slotB = { video: videoB, image: imageB };
  let activeSlot = slotA, standbySlot = slotB;
  let imageTimer = null;      // advances image slides after their duration
  let transitionMode = 'none';
  let overrideTimer = null;
  let errorStreak = 0;        // consecutive unplayable items
  let errorRetryTimer = null;

  function clearSlotHandlers(slot) {
    slot.video.onended = slot.video.onerror = slot.video.onplaying = null;
    slot.image.onerror = slot.image.onload = null;
  }
  function hideSlot(slot) {
    slot.video.classList.remove('visible');
    slot.image.classList.remove('visible');
  }

  for (const v of [videoA, videoB, overrideVideo]) v.muted = !AUDIO;

  // --- registration ------------------------------------------------------
  async function register() {
    try {
      const res = await fetch('/api/player/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ existingId: tvId })
      });
      const data = await res.json();
      tvId = data.tvId;
      localStorage.setItem('skyzone.tvId', tvId);
      idleName.textContent = data.name;
      return true;
    } catch {
      return false;
    }
  }

  // --- websocket ---------------------------------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      reconnectDelay = 1000;
      netdot.classList.remove('visible');
      ws.send(JSON.stringify({ type: 'hello', role: 'player', tvId }));
    };
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'state') applyState(msg);
      else if (msg.type === 'reregister') {
        localStorage.removeItem('skyzone.tvId');
        tvId = null;
        register().then(ok => { if (ok) ws.send(JSON.stringify({ type: 'hello', role: 'player', tvId })); });
      }
    };
    ws.onclose = () => {
      netdot.classList.add('visible');
      idleConn.textContent = 'Reconnecting to server…';
      idleConn.classList.add('bad');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.7, 15000);
    };
    ws.onerror = () => ws.close();
  }

  function reportStatus() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let nowPlaying = null;
    if (state && state.power === 'off') nowPlaying = 'Screen off';
    else if (state && state.override) nowPlaying = `🎂 ${state.override.name}`;
    else if (playlist[current]) nowPlaying = playlist[current].label;
    else nowPlaying = 'Idle';
    ws.send(JSON.stringify({ type: 'status', nowPlaying }));
  }
  setInterval(reportStatus, 10000);

  // --- rendering ---------------------------------------------------------
  function show(layer) {
    idle.classList.toggle('visible', layer === 'idle');
    off.classList.toggle('visible', layer === 'off');
    overrideEl.classList.toggle('visible', layer === 'override');
    if (layer !== 'playlist') {
      hideSlot(slotA);
      hideSlot(slotB);
      stopPlayback();
    }
    if (layer !== 'override') {
      overrideVideo.onerror = null;
      overrideVideo.pause();
      overrideVideo.removeAttribute('src');
      overrideVideo.load();
      BirthdayScene.stop();
    }
  }

  function stopPlayback() {
    clearTimeout(imageTimer);
    imageTimer = null;
    for (const s of [slotA, slotB]) s.video.pause();
  }

  function applyState(msg) {
    state = msg;
    if (msg.tv && msg.tv.name) idleName.textContent = msg.tv.name;
    idleConn.textContent = '';
    idleConn.classList.remove('bad');

    // Any pending error-retry must not survive into a different mode — it
    // would tear down a birthday screen or relight a powered-off TV.
    clearTimeout(errorRetryTimer);
    errorRetryTimer = null;

    if (msg.power === 'off') {
      show('off');
      reportStatus();
      return;
    }
    if (msg.override) {
      showOverride(msg.override);
      reportStatus();
      return;
    }
    clearTimeout(overrideTimer);
    overrideTimer = null;
    transitionMode = msg.transition === 'fade' ? 'fade' : 'none';
    document.body.dataset.transition = transitionMode;
    setPlaylist(msg.playlist || []);
    reportStatus();
  }

  // --- playlist playback --------------------------------------------------
  // Two stacked "slots" (each a video element + an image element). The active
  // slot shows the current item; the standby slot preloads the next one, so
  // item changes are instant — or a crossfade when the playlist uses fade.
  function setPlaylist(list) {
    const key = JSON.stringify(list.map(x => [x.url, x.type, x.durationSec])) + '|' + transitionMode;
    if (key === playlistKey && !overrideEl.classList.contains('visible') && !off.classList.contains('visible')) {
      // Same playlist, already playing — don't restart mid-item.
      if (list.length > 0) { playlist = list; show('playlist'); resume(); return; }
    }
    playlistKey = key;
    playlist = list;
    current = 0;
    if (playlist.length === 0) { show('idle'); return; }
    show('playlist');
    startCurrent();
  }

  function resume() {
    if (playlist.length === 0) { show('idle'); return; }
    const item = playlist[current];
    if (!item) { current = 0; startCurrent(); return; }
    if (item.type === 'image') {
      if (activeSlot.image.src) {
        activeSlot.image.classList.add('visible');
        clearTimeout(imageTimer);
        if (playlist.length > 1) imageTimer = setTimeout(next, (item.durationSec || 8) * 1000);
      } else startCurrent();
    } else {
      if (activeSlot.video.src) {
        activeSlot.video.classList.add('visible');
        activeSlot.video.play().catch(() => {});
      } else startCurrent();
    }
  }

  function startCurrent() {
    const item = playlist[current];
    if (!item) { show('idle'); return; }
    clearTimeout(errorRetryTimer);
    errorRetryTimer = null;
    clearTimeout(imageTimer);
    imageTimer = null;
    // The standby slot keeps handlers from its last active stint; a preload
    // failure there must not be mistaken for the ACTIVE item failing.
    clearSlotHandlers(standbySlot);
    clearSlotHandlers(activeSlot);
    hideSlot(standbySlot);
    standbySlot.video.pause();
    const slot = activeSlot;

    if (item.type === 'image') {
      slot.video.pause();
      slot.video.classList.remove('visible');
      const armed = () => {
        slot.image.classList.add('visible');
        errorStreak = 0;
        if (playlist.length > 1) imageTimer = setTimeout(next, (item.durationSec || 8) * 1000);
      };
      slot.image.onerror = onItemError;
      const abs = new URL(item.url, location.href).href;
      if (slot.image.src === abs && slot.image.complete && slot.image.naturalWidth > 0) armed();
      else { slot.image.onload = armed; slot.image.src = item.url; }
    } else {
      slot.image.classList.remove('visible');
      slot.video.src = item.url;
      slot.video.loop = playlist.length === 1;
      slot.video.classList.add('visible');
      slot.video.play().catch(() => {
        // Autoplay refused or file unreadable: retry shortly, skip after repeated failures.
        setTimeout(() => slot.video.play().catch(() => onItemError()), 2000);
      });
      slot.video.onplaying = () => { errorStreak = 0; };
      slot.video.onended = next;
      slot.video.onerror = onItemError;
    }
    preloadNext();
    reportStatus();
  }

  // A video that can't be decoded/loaded: skip it. If EVERY item in the
  // playlist fails, show the idle screen (instead of a silent black loop)
  // and retry in 30s — the file may still be uploading or being replaced.
  function onItemError() {
    errorStreak++;
    if (playlist.length > 0 && errorStreak >= playlist.length) {
      errorStreak = 0;
      show('idle');
      idleConn.textContent = 'Assigned media failed to play — check the files in the dashboard. Retrying…';
      idleConn.classList.add('bad');
      errorRetryTimer = setTimeout(() => {
        // Retry only if we're still in normal playlist mode by then.
        if (playlist.length > 0 && state && state.power !== 'off' && !state.override) {
          show('playlist');
          startCurrent();
        }
      }, 30000);
      return;
    }
    setTimeout(next, 1500);
  }

  function preloadNext() {
    if (playlist.length < 2) return;
    const nextItem = playlist[(current + 1) % playlist.length];
    const abs = new URL(nextItem.url, location.href).href;
    if (nextItem.type === 'image') {
      if (standbySlot.image.src !== abs) standbySlot.image.src = nextItem.url;
    } else if (standbySlot.video.src !== abs) {
      standbySlot.video.src = nextItem.url;
      standbySlot.video.load();
    }
  }

  function next() {
    clearTimeout(imageTimer);
    imageTimer = null;
    if (playlist.length === 0) { show('idle'); return; }
    current = (current + 1) % playlist.length;
    if (playlist.length >= 2) {
      // Swap slots: standby already has the next item preloaded.
      const t = activeSlot; activeSlot = standbySlot; standbySlot = t;
    }
    startCurrent();
  }

  // --- birthday / event takeover -----------------------------------------
  // Rebuild the headline as letter spans (staggered comic pop-in) — but only
  // when the text actually changes, so repeated state pushes don't restart it.
  let lastHeadline = null;
  function setHeadline(text) {
    if (text === lastHeadline) return;
    lastHeadline = text;
    overrideHeadline.textContent = '';
    let i = 0;
    const words = String(text).split(' ');
    words.forEach((word, wi) => {
      const w = document.createElement('span');
      w.className = 'word';
      for (const ch of word) {
        const l = document.createElement('span');
        l.className = 'letter';
        l.textContent = ch;
        l.style.animationDelay = (i++ * 0.05) + 's';
        w.appendChild(l);
      }
      overrideHeadline.appendChild(w);
      if (wi < words.length - 1) overrideHeadline.appendChild(document.createTextNode(' '));
    });
  }

  function showOverride(o) {
    setHeadline(o.message || `Happy Birthday, ${o.name}!`);
    overrideEl.dataset.theme = o.theme || 'party';
    // Custom themes carry their headline colors in the spec.
    if (o.theme === 'custom' && o.themeSpec && o.themeSpec.headline) {
      overrideEl.style.setProperty('--hl-fill', o.themeSpec.headline.fill);
      overrideEl.style.setProperty('--hl-stroke', o.themeSpec.headline.stroke);
      overrideEl.style.setProperty('--hl-glow', o.themeSpec.headline.fill + '88');
    } else {
      overrideEl.style.removeProperty('--hl-fill');
      overrideEl.style.removeProperty('--hl-stroke');
      overrideEl.style.removeProperty('--hl-glow');
    }
    let videoBehind = false;
    if (o.mediaUrl) {
      overrideEl.classList.add('has-video');
      videoBehind = true;
      // If the birthday video can't play, fall back to the built-in comic
      // background rather than showing black behind the hero.
      overrideVideo.onerror = () => {
        overrideEl.classList.remove('has-video');
        BirthdayScene.start(canvas, o.theme || 'party', false, o.themeSpec);
      };
      const abs = new URL(o.mediaUrl, location.href).href;
      if (overrideVideo.src !== abs) {
        overrideVideo.src = o.mediaUrl;
        overrideVideo.play().catch(() => setTimeout(() => overrideVideo.play().catch(() => {}), 1500));
      } else if (overrideVideo.paused) {
        overrideVideo.play().catch(() => {});
      }
    } else {
      overrideEl.classList.remove('has-video');
    }
    stopPlayback();
    show('override');
    BirthdayScene.start(canvas, o.theme || 'party', videoBehind, o.themeSpec);

    // Local fallback: if the server connection is down when the event should
    // end, clear it ourselves so a TV never gets stuck on a birthday screen.
    clearTimeout(overrideTimer);
    const msLeft = Date.parse(o.endsAt) - Date.now();
    if (Number.isFinite(msLeft)) {
      overrideTimer = setTimeout(() => {
        if (state) { state.override = null; applyState(state); }
      }, Math.max(msLeft, 0) + 2000);
    }
  }

  // --- birthday scene canvas (rendering lives in birthday.js) -------------
  const canvas = document.getElementById('confetti');

  // Keep the screen awake where the platform allows it (Fully Kiosk / native
  // wrapper also enforce this on their side).
  async function keepAwake() {
    try { await navigator.wakeLock.request('screen'); } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });

  // --- boot --------------------------------------------------------------
  (async function boot() {
    show('idle');
    idleName.textContent = 'Connecting…';
    keepAwake();
    let ok = await register();
    while (!ok) {
      idleConn.textContent = 'Cannot reach server — retrying…';
      idleConn.classList.add('bad');
      await new Promise(r => setTimeout(r, 3000));
      ok = await register();
    }
    connect();
  })();
})();
