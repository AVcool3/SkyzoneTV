/* Comic-book superhero birthday scene.
 *
 * Every kid gets their OWN generated superhero — suit colors, mask style,
 * cape, hair and skin tone are all seeded from the name (same name → same
 * hero every year), and the chest emblem carries the kid's initial.
 * The hero does super-jumps over a city skyline in comic style: halftone
 * dots, starbursts, speed lines and confetti.
 *
 * API: BirthdayScene.start(canvas, name, hasVideo)  /  BirthdayScene.stop()
 * When hasVideo is true (a custom birthday MP4 plays behind), the painted
 * sky/skyline/halftone are skipped so the video shows through; the hero,
 * bursts and confetti still render on top.
 */
(() => {
  // --- seeded randomness: djb2 hash -> mulberry32 --------------------------
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SUITS = [
    ['#e63946', '#1d4ed8'], ['#111827', '#fbbf24'], ['#7c3aed', '#14b8a6'],
    ['#16a34a', '#e5e7eb'], ['#ea580c', '#1e3a8a'], ['#db2777', '#111827'],
    ['#0891b2', '#c026d3'], ['#dc2626', '#facc15'], ['#2563eb', '#f97316']
  ];
  const SKINS = ['#8d5524', '#c68642', '#e0ac69', '#f1c27d', '#ffdbac', '#6b4423'];
  const HAIRS = ['#111111', '#4a2c17', '#8b4513', '#d4a017', '#b91c1c', '#3d3d3d'];
  const CONFETTI_COLORS = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#ffffff', '#ff9f1c'];

  function makeHero(name) {
    const r = rng(hash(String(name).trim().toLowerCase() || 'hero'));
    const [primary, secondary] = SUITS[(r() * SUITS.length) | 0];
    return {
      primary, secondary,
      skin: SKINS[(r() * SKINS.length) | 0],
      hair: HAIRS[(r() * HAIRS.length) | 0],
      mask: ['full', 'half', 'domino'][(r() * 3) | 0],
      cape: r() < 0.65,
      emblem: ['circle', 'shield', 'star', 'diamond'][(r() * 4) | 0],
      initial: (String(name).trim()[0] || '★').toUpperCase(),
      burstSeed: r() * 1e9
    };
  }

  // --- module state --------------------------------------------------------
  let canvas = null, ctx = null, raf = null;
  let hero = null, heroName = null, hasVideo = false;
  let confetti = [], skyline = [], t0 = 0;

  function resize() {
    if (!canvas) return;
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    buildSkyline();
  }

  function buildSkyline() {
    const W = canvas.width, H = canvas.height;
    const r = rng(20260813);
    skyline = [];
    let x = -20;
    while (x < W + 40) {
      const w = (0.04 + r() * 0.07) * W;
      const h = (0.10 + r() * 0.16) * H;
      skyline.push({ x, w, h, windows: r() < 0.8 });
      x += w + 4;
    }
  }

  function buildConfetti() {
    const W = canvas.width, H = canvas.height;
    confetti = Array.from({ length: 120 }, () => ({
      x: Math.random() * W, y: Math.random() * -H,
      w: 6 + Math.random() * 9, h: 10 + Math.random() * 14,
      vy: 1.2 + Math.random() * 2.4, vx: -0.8 + Math.random() * 1.6,
      rot: Math.random() * Math.PI, vrot: -0.06 + Math.random() * 0.12,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0]
    }));
  }

  // --- background layers ---------------------------------------------------
  function drawHalftone(W, H) {
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = '#000';
    const step = Math.max(14, W / 90);
    for (let y = 0; y < H * 0.55; y += step) {
      const rr = 1 + (y / (H * 0.55)) * (step * 0.16);
      for (let x = (y / step % 2) * step / 2; x < W; x += step) {
        ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawSkyline(W, H) {
    ctx.save();
    const base = H * 0.995;
    ctx.fillStyle = 'rgba(12, 14, 40, 0.88)';
    for (const b of skyline) {
      ctx.fillRect(b.x, base - b.h, b.w, b.h);
    }
    ctx.fillStyle = 'rgba(255, 220, 120, 0.75)';
    const r = rng(777);
    for (const b of skyline) {
      if (!b.windows) continue;
      for (let wy = base - b.h + 8; wy < base - 8; wy += 14) {
        for (let wx = b.x + 5; wx < b.x + b.w - 6; wx += 12) {
          if (r() < 0.28) ctx.fillRect(wx, wy, 5, 7);
        }
      }
    }
    ctx.restore();
  }

  function drawBurst(x, y, R, phase) {
    const s = 0.85 + 0.15 * Math.sin(phase);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.rotate(phase * 0.05);
    ctx.beginPath();
    const spikes = 12;
    for (let i = 0; i < spikes * 2; i++) {
      const rad = i % 2 === 0 ? R : R * 0.55;
      const a = (i / (spikes * 2)) * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fillStyle = '#ffd93b';
    ctx.strokeStyle = '#d62828';
    ctx.lineWidth = R * 0.09;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // --- hero ----------------------------------------------------------------
  // Skeleton keyframes in local units (y up = negative), hero ~170 units tall.
  // Interpolated between crouch (on the ground) and flight (mid-air) poses.
  const CROUCH = {
    hipY: -34, chestY: -74, headY: -102,
    lKnee: [-24, -20], lFoot: [-30, 0], rKnee: [22, -20], rFoot: [30, 0],
    lElb: [-34, -62], lFist: [-24, -34], rElb: [34, -62], rFist: [26, -34],
    lean: 0.10
  };
  const FLIGHT = {
    hipY: -60, chestY: -104, headY: -134,
    lKnee: [-14, -34], lFoot: [-24, -6], rKnee: [18, -30], rFoot: [10, 2],
    lElb: [-30, -96], lFist: [-40, -128], rFist: [34, -166], rElb: [30, -128],
    lean: -0.06
  };
  function lerp(a, b, k) { return a + (b - a) * k; }
  function lerpP(a, b, k) { return [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]; }

  function limb(from, to1, to2, width, color) {
    // black outline pass, then color pass
    for (const [w, c] of [[width + 7, '#101010'], [width, color]]) {
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to1[0], to1[1]);
      ctx.lineTo(to2[0], to2[1]);
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = c;
      ctx.stroke();
    }
  }

  function drawHero(x, groundY, scale, air) {
    // air: 0 = crouched on ground, 1 = full flight pose
    const k = Math.max(0, Math.min(1, air));
    const P = {
      hipY: lerp(CROUCH.hipY, FLIGHT.hipY, k),
      chestY: lerp(CROUCH.chestY, FLIGHT.chestY, k),
      headY: lerp(CROUCH.headY, FLIGHT.headY, k),
      lKnee: lerpP(CROUCH.lKnee, FLIGHT.lKnee, k), lFoot: lerpP(CROUCH.lFoot, FLIGHT.lFoot, k),
      rKnee: lerpP(CROUCH.rKnee, FLIGHT.rKnee, k), rFoot: lerpP(CROUCH.rFoot, FLIGHT.rFoot, k),
      lElb: lerpP(CROUCH.lElb, FLIGHT.lElb, k), lFist: lerpP(CROUCH.lFist, FLIGHT.lFist, k),
      rElb: lerpP(CROUCH.rElb, FLIGHT.rElb, k), rFist: lerpP(CROUCH.rFist, FLIGHT.rFist, k),
      lean: lerp(CROUCH.lean, FLIGHT.lean, k)
    };
    const h = hero;
    ctx.save();
    ctx.translate(x, groundY);
    ctx.scale(scale, scale);
    ctx.rotate(P.lean);

    // cape (behind everything), fluttering more in flight
    if (h.cape) {
      const flap = Math.sin(performance.now() / 140) * (6 + 16 * k);
      ctx.beginPath();
      ctx.moveTo(-16, P.chestY + 6);
      ctx.quadraticCurveTo(-46 - k * 24, P.chestY + 50, -34 - k * 30 + flap, 6 - k * 10);
      ctx.quadraticCurveTo(-6, P.hipY + 26, 16, P.chestY + 8);
      ctx.closePath();
      ctx.fillStyle = h.secondary;
      ctx.strokeStyle = '#101010';
      ctx.lineWidth = 5;
      ctx.fill();
      ctx.stroke();
    }

    // legs (boots in secondary)
    limb([0, P.hipY], P.lKnee, P.lFoot, 13, h.primary);
    limb([0, P.hipY], P.rKnee, P.rFoot, 13, h.primary);
    for (const f of [P.lFoot, P.rFoot]) {
      ctx.beginPath(); ctx.ellipse(f[0], f[1], 12, 8, 0, 0, 7);
      ctx.fillStyle = h.secondary; ctx.strokeStyle = '#101010'; ctx.lineWidth = 4;
      ctx.fill(); ctx.stroke();
    }

    // torso
    ctx.beginPath();
    ctx.moveTo(-24, P.chestY);
    ctx.quadraticCurveTo(-28, P.chestY + 16, -13, P.hipY);
    ctx.lineTo(13, P.hipY);
    ctx.quadraticCurveTo(28, P.chestY + 16, 24, P.chestY);
    ctx.quadraticCurveTo(0, P.chestY - 10, -24, P.chestY);
    ctx.closePath();
    ctx.fillStyle = h.primary;
    ctx.strokeStyle = '#101010';
    ctx.lineWidth = 5;
    ctx.fill(); ctx.stroke();

    // belt
    ctx.beginPath(); ctx.rect(-14, P.hipY - 7, 28, 8);
    ctx.fillStyle = h.secondary; ctx.fill(); ctx.lineWidth = 3.5; ctx.stroke();

    // chest emblem with the kid's initial
    const ex = 0, ey = P.chestY + 15, er = 13;
    ctx.beginPath();
    if (h.emblem === 'circle') ctx.arc(ex, ey, er, 0, 7);
    else if (h.emblem === 'diamond') { ctx.moveTo(ex, ey - er); ctx.lineTo(ex + er, ey); ctx.lineTo(ex, ey + er); ctx.lineTo(ex - er, ey); }
    else if (h.emblem === 'shield') { ctx.moveTo(ex - er, ey - er * 0.7); ctx.lineTo(ex + er, ey - er * 0.7); ctx.quadraticCurveTo(ex + er, ey + er * 0.5, ex, ey + er); ctx.quadraticCurveTo(ex - er, ey + er * 0.5, ex - er, ey - er * 0.7); }
    else for (let i = 0; i < 10; i++) { const rr = i % 2 ? er * 0.5 : er; const a = -Math.PI / 2 + (i / 10) * Math.PI * 2; ctx.lineTo(ex + Math.cos(a) * rr, ey + Math.sin(a) * rr); }
    ctx.closePath();
    ctx.fillStyle = h.secondary; ctx.strokeStyle = '#101010'; ctx.lineWidth = 3.5;
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = h.primary;
    ctx.font = '900 15px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(hero.initial, ex, ey + 1);

    // arms (gloves in secondary)
    limb([-18, P.chestY + 8], P.lElb, P.lFist, 11, h.primary);
    limb([18, P.chestY + 8], P.rElb, P.rFist, 11, h.primary);
    for (const f of [P.lFist, P.rFist]) {
      ctx.beginPath(); ctx.arc(f[0], f[1], 9, 0, 7);
      ctx.fillStyle = h.secondary; ctx.strokeStyle = '#101010'; ctx.lineWidth = 4;
      ctx.fill(); ctx.stroke();
    }

    // head
    const hy = P.headY, hr = 17;
    ctx.beginPath(); ctx.arc(0, hy, hr, 0, 7);
    ctx.fillStyle = h.mask === 'full' ? h.primary : h.skin;
    ctx.strokeStyle = '#101010'; ctx.lineWidth = 5;
    ctx.fill(); ctx.stroke();

    if (h.mask === 'half') {
      // cowl over the top half of the face
      ctx.beginPath(); ctx.arc(0, hy, hr, Math.PI, 0);
      ctx.closePath(); ctx.fillStyle = h.primary; ctx.fill();
      ctx.lineWidth = 3; ctx.stroke();
    } else if (h.mask === 'domino') {
      // hair + eye band
      ctx.beginPath(); ctx.arc(0, hy - 4, hr * 0.98, Math.PI * 1.05, Math.PI * 1.95);
      ctx.quadraticCurveTo(0, hy - hr * 1.35, hr * 0.9, hy - 8);
      ctx.fillStyle = h.hair; ctx.fill();
      ctx.fillStyle = h.primary;
      ctx.fillRect(-hr, hy - 7, hr * 2, 10);
    }

    // eye lenses
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#101010';
    ctx.lineWidth = 2.5;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(sx * 7, hy - 2, 5.5, 4, sx * -0.35, 0, 7);
      ctx.fill(); ctx.stroke();
    }
    // smile on unmasked chins
    if (h.mask !== 'full') {
      ctx.beginPath(); ctx.arc(0, hy + 7, 5.5, 0.25 * Math.PI, 0.75 * Math.PI);
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#101010'; ctx.stroke();
    }
    ctx.restore();
  }

  // --- main loop -----------------------------------------------------------
  const JUMP_T = 2.4; // seconds per super-jump

  function frame(now) {
    const W = canvas.width, H = canvas.height;
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);

    if (!hasVideo) {
      drawHalftone(W, H);
      drawSkyline(W, H);
    }

    // starbursts in the upper corners, pulsing alternately
    drawBurst(W * 0.12, H * 0.20, Math.min(W, H) * 0.055, t * 2.2);
    drawBurst(W * 0.88, H * 0.16, Math.min(W, H) * 0.045, t * 2.2 + Math.PI);

    // super-jump cycle: brief crouch on the ground, big air time
    const p = (t % JUMP_T) / JUMP_T;
    const groundY = H * 0.97;
    const scale = (H * 0.42) / 170;
    let air = 0, yOff = 0;
    if (p < 0.16) {
      air = 0;
      const c = Math.sin((p / 0.16) * Math.PI);
      yOff = c * 6 * scale; // squashing into the jump
    } else {
      const pa = (p - 0.16) / 0.84;
      yOff = -(H * 0.44) * 4 * pa * (1 - pa);
      air = Math.min(1, Math.sin(Math.PI * pa) * 1.6);
      // speed lines while moving fast (start and end of the arc)
      const speed = Math.abs(1 - 2 * pa);
      if (speed > 0.45) {
        ctx.save();
        ctx.globalAlpha = (speed - 0.45) * 0.8;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        for (let i = 0; i < 5; i++) {
          const lx = W * 0.72 + (i - 2) * 30;
          const ly = groundY + yOff + 40 + i * 8;
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(lx, ly + 46 * (pa < 0.5 ? 1 : -1));
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    drawHero(W * 0.72, groundY + yOff, scale, air);

    // confetti on top
    for (const c of confetti) {
      c.y += c.vy; c.x += c.vx + Math.sin(c.y / 40) * 0.6; c.rot += c.vrot;
      if (c.y > H + 20) { c.y = -20; c.x = Math.random() * W; }
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }

    raf = requestAnimationFrame(frame);
  }

  window.BirthdayScene = {
    start(cnv, name, videoBehind) {
      if (raf && heroName === name && canvas === cnv && hasVideo === !!videoBehind) return; // already running for this kid
      this.stop();
      canvas = cnv;
      ctx = canvas.getContext('2d');
      hero = makeHero(name);
      heroName = name;
      hasVideo = !!videoBehind;
      resize();
      buildConfetti();
      t0 = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      heroName = null;
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    resize
  };

  addEventListener('resize', () => { if (raf) resize(); });
})();
