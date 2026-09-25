/* ParkCast screen player.
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

  // Read the current key, falling back to (and migrating) the pre-rename
  // key so no installed TV loses its identity over the rebrand.
  let tvId = null;
  try {
    tvId = localStorage.getItem('parkcast.tvId') || localStorage.getItem('skyzone.tvId') || null;
    if (tvId) localStorage.setItem('parkcast.tvId', tvId);
  } catch {} // blocked storage: the TV still boots, it just re-pairs each launch
  let ws = null;
  let reconnectDelay = 1000;
  let assetVersion = null;   // player build fingerprint from the server
  let state = null;           // last state from server
  let playlist = [];          // [{id,label,url}]
  let playlistKey = '';
  let current = 0;            // index in playlist
  const imageA = document.getElementById('imageA');
  const imageB = document.getElementById('imageB');
  const slotA = { video: videoA, image: imageA, slide: document.getElementById('slideA') };
  const slotB = { video: videoB, image: imageB, slide: document.getElementById('slideB') };
  let activeSlot = slotA, standbySlot = slotB;
  let imageTimer = null;      // advances image slides after their duration
  let transitionMode = 'none';
  let overrideTimer = null;
  let errorStreak = 0;        // consecutive unplayable items
  let errorRetryTimer = null;
  let videoRetryTimer = null; // pending play() retry for the active video
  let videoRevealTimer = null; // fallback reveal if 'playing' never fires

  function clearSlotHandlers(slot) {
    slot.video.onended = slot.video.onerror = slot.video.onplaying = null;
    slot.image.onerror = slot.image.onload = null;
  }
  function hideSlot(slot) {
    slot.video.classList.remove('visible');
    slot.image.classList.remove('visible');
    slot.slide.classList.remove('visible');
  }

  // Build a dashboard-made slide safely (text via textContent, never HTML).
  function renderSlide(el, s) {
    el.textContent = '';
    el.style.padding = ''; // restore the stylesheet padding a design may have zeroed
    el.style.background = `linear-gradient(135deg, ${s.bg[0]}, ${s.bg[1]})`;
    el.style.color = s.textColor || '#ffffff';
    if (s.badge) {
      const b = document.createElement('div');
      b.className = 's-badge';
      b.textContent = s.badge;
      el.appendChild(b);
    }
    const h = document.createElement('div');
    h.className = 's-headline';
    h.textContent = s.headline || '';
    el.appendChild(h);
    if (s.subtext) {
      const sub = document.createElement('div');
      sub.className = 's-sub';
      sub.textContent = s.subtext;
      el.appendChild(sub);
    }
  }

  // Build a layout design: positioned text/image/video/box elements over a
  // background, all validated server-side and rendered via DOM (never HTML
  // strings). Font sizes are stored as % of screen height -> vh here.
  function renderComp(el, comp) {
    el.textContent = '';
    el.style.padding = '0';
    const colors = (comp.bg && comp.bg.colors) || ['#000000'];
    el.style.background = colors.length > 1
      ? `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`
      : colors[0];
    const els = (comp.elements || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const e of els) {
      let node = null;
      if (e.type === 'text') {
        node = document.createElement('div');
        node.textContent = e.text || '';
        node.style.fontSize = (e.size || 6) + 'vh';
        node.style.fontWeight = e.weight || 700;
        node.style.color = e.color || '#ffffff';
        node.style.textAlign = e.align || 'center';
        node.style.lineHeight = '1.15';
        node.style.overflowWrap = 'anywhere';
        node.style.display = 'flex';
        node.style.flexDirection = 'column';
        node.style.justifyContent = 'center';
        node.style.alignItems = e.align === 'left' ? 'flex-start' : e.align === 'right' ? 'flex-end' : 'center';
        if (e.boxBg) { node.style.background = e.boxBg; node.style.borderRadius = '1vh'; node.style.padding = '0 1.5vh'; }
      } else if (e.type === 'image' && e.url) {
        node = document.createElement('img');
        node.src = e.url;
        node.style.objectFit = e.fit || 'cover';
        node.style.borderRadius = (e.radius || 0) + 'vh';
        node.onerror = () => { node.style.display = 'none'; };
      } else if (e.type === 'video' && e.url) {
        node = document.createElement('video');
        node.src = e.url;
        node.muted = !AUDIO;
        node.loop = true;
        node.autoplay = true;
        node.playsInline = true;
        node.style.objectFit = e.fit || 'cover';
        node.style.borderRadius = (e.radius || 0) + 'vh';
        // Invisible until frames render: old TV WebViews paint a play glyph
        // over visible paused videos (fallback reveal keeps a stalled decode
        // from leaving a hole in the design).
        node.style.opacity = '0';
        const revealEl = () => { node.style.opacity = '1'; };
        node.onplaying = revealEl;
        setTimeout(revealEl, 1200);
        // A broken video hides itself; the rest of the design keeps playing.
        node.onerror = () => { node.style.display = 'none'; };
        node.play().catch(() => {});
      } else if (e.type === 'box') {
        node = document.createElement('div');
        node.style.background = e.color || '#000000';
        node.style.borderRadius = (e.radius || 0) + 'vh';
      }
      if (!node) continue;
      node.style.position = 'absolute';
      node.style.left = e.x + '%';
      node.style.top = e.y + '%';
      node.style.width = e.w + '%';
      node.style.height = e.h + '%';
      if (e.rot) node.style.transform = `rotate(${e.rot}deg)`;
      el.appendChild(node);
    }
  }

  // Stop any videos playing inside a composed design in this slot.
  function stopCompVideos(el) {
    for (const v of el.querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); v.load(); }
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
      try { localStorage.setItem('parkcast.tvId', tvId); } catch {}
      idleName.textContent = data.name;
      return true;
    } catch {
      return false;
    }
  }

  // --- websocket ---------------------------------------------------------
  let stableTimer = null;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.7, 15000);
      return;
    }
    ws.onopen = () => {
      // The backoff only resets once the link has proven stable — a whole
      // fleet reconnecting to a crash-looping server must keep backing off.
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => { reconnectDelay = 1000; }, 30000);
      netdot.classList.remove('visible');
      ws.send(JSON.stringify({ type: 'hello', role: 'player', tvId }));
    };
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'state') {
        // A deploy changed the player files: reload once so the fix runs
        // here too. The baseline is whatever the first push after page load
        // reports; only a CHANGE afterwards triggers the reload.
        if (msg.assetVersion) {
          if (assetVersion && assetVersion !== msg.assetVersion) { location.reload(); return; }
          assetVersion = msg.assetVersion;
        }
        applyState(msg);
      }
      else if (msg.type === 'reregister') {
        try {
          localStorage.removeItem('parkcast.tvId');
          localStorage.removeItem('skyzone.tvId');
        } catch {}
        tvId = null;
        const attempt = () => register().then(ok => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return; // reconnect will redo the hello
          if (ok) ws.send(JSON.stringify({ type: 'hello', role: 'player', tvId }));
          else setTimeout(attempt, 5000);
        });
        attempt();
      }
    };
    ws.onclose = () => {
      clearTimeout(stableTimer);
      netdot.classList.add('visible');
      idleConn.textContent = 'Reconnecting to server…';
      idleConn.classList.add('bad');
      // Jitter spreads a venue's screens out instead of stampeding together.
      setTimeout(connect, reconnectDelay * (1 + Math.random() * 0.4));
      reconnectDelay = Math.min(reconnectDelay * 1.7, 15000);
    };
    ws.onerror = () => ws.close();
  }

  function reportStatus() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let nowPlaying = null;
    if (state && state.power === 'off') nowPlaying = 'Screen off';
    // Deliberately name-free: the heartbeat leaves the device, and the
    // dashboard already knows whose party it is from its own server data.
    else if (state && state.override) nowPlaying = 'Party takeover';
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
    for (const s of [slotA, slotB]) { s.video.pause(); stopCompVideos(s.slide); }
  }

  function applyState(msg) {
    state = msg;
    // Screen fit is set per TV in the dashboard (URL ?fit=cover still wins).
    document.body.classList.toggle('fit-cover',
      params.get('fit') === 'cover' || (msg.fit === 'cover' && params.get('fit') !== 'contain'));
    if (msg.tv && msg.tv.name) idleName.textContent = msg.tv.name;
    idleConn.textContent = '';
    idleConn.classList.remove('bad');

    // Any pending error-retry must not survive into a different mode — it
    // would tear down a birthday screen or relight a powered-off TV.
    clearTimeout(errorRetryTimer);
    errorRetryTimer = null;

    if (msg.approved === false) {
      // Waiting for dashboard approval (cloud mode): show the pairing code.
      show('idle');
      idleName.textContent = msg.pairCode ? `Code ${msg.pairCode}` : (msg.tv && msg.tv.name) || '';
      // The pairing screen is the app's only lasting UI, so the privacy
      // policy link lives here (Play policy: reachable from within the app).
      idleConn.textContent = `Privacy policy: ${location.origin}/privacy`;
      document.getElementById('idleHint').textContent =
        'Open your ParkCast dashboard, press "+ Add screen", and type in this code.';
      reportStatus();
      return;
    }
    // A paired screen's idle state is deliberately quiet: logo + name only.
    document.getElementById('idleHint').textContent = '';
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
    const key = JSON.stringify(list.map(x => [x.url, x.type, x.durationSec, x.slide || x.comp || 0])) + '|' + transitionMode;
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
    if (item.type === 'slide' || item.type === 'comp') {
      startCurrent();
    } else if (item.type === 'image') {
      if (activeSlot.image.src) {
        activeSlot.image.classList.add('visible');
        // Keep the running clock: re-arming here on every push would let a
        // busy dashboard hold one image on screen indefinitely.
        if (playlist.length > 1 && !imageTimer) imageTimer = setTimeout(next, (item.durationSec || 8) * 1000);
      } else startCurrent();
    } else {
      if (activeSlot.video.src) {
        const v = activeSlot.video;
        if (!v.paused && !v.ended) v.classList.add('visible');
        else v.onplaying = () => { errorStreak = 0; v.classList.add('visible'); };
        v.play().catch(() => {});
      } else startCurrent();
    }
  }

  function startCurrent() {
    const item = playlist[current];
    if (!item) { show('idle'); return; }
    clearTimeout(errorRetryTimer);
    errorRetryTimer = null;
    clearTimeout(videoRetryTimer);
    videoRetryTimer = null;
    clearTimeout(videoRevealTimer);
    videoRevealTimer = null;
    clearTimeout(imageTimer);
    imageTimer = null;
    // The standby slot keeps handlers from its last active stint; a preload
    // failure there must not be mistaken for the ACTIVE item failing.
    clearSlotHandlers(standbySlot);
    clearSlotHandlers(activeSlot);
    hideSlot(standbySlot);
    standbySlot.video.pause();
    stopCompVideos(standbySlot.slide); // a design's video must not keep decoding hidden
    const slot = activeSlot;

    if (item.type === 'slide' || item.type === 'comp') {
      slot.video.pause();
      slot.video.classList.remove('visible');
      slot.image.classList.remove('visible');
      stopCompVideos(slot.slide);
      if (item.type === 'comp') renderComp(slot.slide, item.comp || { bg: { colors: ['#000000'] }, elements: [] });
      else renderSlide(slot.slide, item.slide || { bg: ['#222222', '#000000'], headline: item.label });
      slot.slide.classList.add('visible');
      errorStreak = 0;
      if (playlist.length > 1) imageTimer = setTimeout(next, (item.durationSec || 8) * 1000);
    } else if (item.type === 'image') {
      slot.video.pause();
      slot.video.classList.remove('visible');
      slot.slide.classList.remove('visible');
      stopCompVideos(slot.slide);
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
      slot.slide.classList.remove('visible');
      stopCompVideos(slot.slide);
      slot.video.src = item.url;
      slot.video.loop = playlist.length === 1;
      // Reveal only once frames are actually rendering: a VISIBLE paused
      // video makes old Android/Fire TV WebViews paint a big play glyph
      // that CSS cannot remove there. Fallback reveal after 1.2s so a slow
      // decode never leaves the screen black.
      const reveal = () => {
        clearTimeout(videoRevealTimer);
        videoRevealTimer = null;
        slot.video.classList.add('visible');
      };
      videoRevealTimer = setTimeout(() => {
        if (slot === activeSlot && playlist[current] === item) reveal();
      }, 1200);
      // A failing file can report through BOTH onerror and the play() chain;
      // it must only count once or a single bad file trips the all-failed
      // breaker and blanks a healthy loop.
      let failed = false;
      const failOnce = () => { if (!failed) { failed = true; onItemError(); } };
      slot.video.play().catch(() => {
        // Autoplay refused or file unreadable: retry shortly, skip after repeated failures.
        videoRetryTimer = setTimeout(() => {
          if (slot !== activeSlot || playlist[current] !== item) return; // moved on
          slot.video.play().catch(failOnce);
        }, 2000);
      });
      slot.video.onplaying = () => { errorStreak = 0; reveal(); };
      slot.video.onended = next;
      slot.video.onerror = failOnce;
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
    if (!nextItem.url) return; // slides/designs render live — nothing to fetch
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
    // The venue name is configurable per instance so a second venue never
    // shows another park's brand on its most photographed screen.
    const sub = document.getElementById('overrideSubline');
    if (sub) sub.textContent = (state && state.venueName) ? `from your friends at ${state.venueName}!` : '';
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
      videoBehind = true;
      overrideVideo.onplaying = () => overrideEl.classList.add('has-video');
      if (!overrideVideo.paused && !overrideVideo.ended) overrideEl.classList.add('has-video');
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
    // msRemaining is computed on the server at push time, so a TV whose
    // clock runs minutes fast no longer cuts the birthday short.
    const msLeft = Number.isFinite(o.msRemaining) ? o.msRemaining : Date.parse(o.endsAt) - Date.now();
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

