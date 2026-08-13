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
  let activeVideo = videoA, standbyVideo = videoB;
  let overrideTimer = null;
  let errorStreak = 0;        // consecutive unplayable items
  let errorRetryTimer = null;

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
      videoA.classList.remove('visible');
      videoB.classList.remove('visible');
      if (layer !== 'override') stopVideos();
    }
    if (layer !== 'override') {
      overrideVideo.onerror = null;
      overrideVideo.pause();
      overrideVideo.removeAttribute('src');
      overrideVideo.load();
      stopConfetti();
    }
  }

  function stopVideos() {
    for (const v of [videoA, videoB]) { v.pause(); }
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
    setPlaylist(msg.playlist || []);
    reportStatus();
  }

  // --- playlist playback (two stacked videos, preload next) --------------
  function setPlaylist(list) {
    const key = JSON.stringify(list.map(x => x.url));
    if (key === playlistKey && !overrideEl.classList.contains('visible') && !off.classList.contains('visible')) {
      // Same playlist, already playing — don't restart mid-video.
      if (list.length > 0) { show('playlist'); resume(); return; }
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
    if (activeVideo.paused && activeVideo.src) {
      activeVideo.play().catch(() => {});
      activeVideo.classList.add('visible');
    } else if (!activeVideo.src) {
      startCurrent();
    }
  }

  function startCurrent() {
    const item = playlist[current];
    if (!item) { show('idle'); return; }
    clearTimeout(errorRetryTimer);
    errorRetryTimer = null;
    // The standby element keeps handlers from its last active stint; a
    // preload failure there must not be mistaken for the ACTIVE item failing.
    standbyVideo.onended = standbyVideo.onerror = standbyVideo.onplaying = null;
    activeVideo.onended = null;
    activeVideo.src = item.url;
    activeVideo.loop = playlist.length === 1;
    activeVideo.classList.add('visible');
    standbyVideo.classList.remove('visible');
    activeVideo.play().catch(() => {
      // Autoplay refused or file unreadable: retry shortly, skip after repeated failures.
      setTimeout(() => activeVideo.play().catch(() => onItemError()), 2000);
    });
    activeVideo.onplaying = () => { errorStreak = 0; };
    activeVideo.onended = next;
    activeVideo.onerror = onItemError;
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
    if (standbyVideo.src !== new URL(nextItem.url, location.href).href) {
      standbyVideo.src = nextItem.url;
      standbyVideo.load();
    }
  }

  function next() {
    if (playlist.length === 0) { show('idle'); return; }
    current = (current + 1) % playlist.length;
    if (playlist.length >= 2) {
      // Swap layers: standby already has the next item preloaded.
      const t = activeVideo; activeVideo = standbyVideo; standbyVideo = t;
    }
    startCurrent();
  }

  // --- birthday / event takeover -----------------------------------------
  function showOverride(o) {
    overrideHeadline.textContent = o.message || `Happy Birthday, ${o.name}!`;
    if (o.mediaUrl) {
      overrideEl.classList.add('has-video');
      // If the birthday video can't play, fall back to the built-in animated
      // background rather than showing black behind the name.
      overrideVideo.onerror = () => overrideEl.classList.remove('has-video');
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
    stopVideos();
    show('override');
    startConfetti();

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

  // --- confetti ----------------------------------------------------------
  const canvas = document.getElementById('confetti');
  const ctx = canvas.getContext('2d');
  let confettiRaf = null;
  let pieces = [];
  const COLORS = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#ffffff', '#ff9f1c'];

  function startConfetti() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    pieces = Array.from({ length: 140 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * -canvas.height,
      w: 6 + Math.random() * 9,
      h: 10 + Math.random() * 14,
      vy: 1.2 + Math.random() * 2.4,
      vx: -0.8 + Math.random() * 1.6,
      rot: Math.random() * Math.PI,
      vrot: -0.06 + Math.random() * 0.12,
      color: COLORS[(Math.random() * COLORS.length) | 0]
    }));
    if (!confettiRaf) confettiRaf = requestAnimationFrame(drawConfetti);
  }

  function drawConfetti() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.y += p.vy; p.x += p.vx + Math.sin(p.y / 40) * 0.6; p.rot += p.vrot;
      if (p.y > canvas.height + 20) { p.y = -20; p.x = Math.random() * canvas.width; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    confettiRaf = requestAnimationFrame(drawConfetti);
  }

  function stopConfetti() {
    if (confettiRaf) { cancelAnimationFrame(confettiRaf); confettiRaf = null; }
    ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  addEventListener('resize', () => {
    if (overrideEl.classList.contains('visible')) { canvas.width = innerWidth; canvas.height = innerHeight; }
  });

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
