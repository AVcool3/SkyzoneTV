/* Themed birthday scenes (all character-free).
 *
 * Themes: party (default), superhero, princess, space, ninja.
 * Picked per event via the CSV `theme` column, the Add-event form, or the
 * dashboard's test button. A licensed video (CSV `media` column / default
 * birthday video) always takes visual priority: with a video behind, only
 * confetti is drawn on top so the content stays unobstructed.
 *
 * API: BirthdayScene.start(canvas, theme, hasVideo)  /  BirthdayScene.stop()
 */
(() => {
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let canvas = null, ctx = null, raf = null;
  let themeKey = 'party', hasVideo = false;
  let confetti = [], t0 = 0;
  let W = 0, H = 0, M = 0; // M = min(W,H)

  // ---- shared shape helpers ----------------------------------------------
  function starburst(x, y, R, phase) {
    const s = 0.85 + 0.15 * Math.sin(phase);
    ctx.save();
    ctx.translate(x, y); ctx.scale(s, s); ctx.rotate(phase * 0.05);
    ctx.beginPath();
    for (let i = 0; i < 24; i++) {
      const rad = i % 2 === 0 ? R : R * 0.55;
      const a = (i / 24) * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fillStyle = '#ffd93b'; ctx.strokeStyle = '#d62828'; ctx.lineWidth = R * 0.09;
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function star4(x, y, R, rot, color, alpha) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const rad = i % 2 === 0 ? R : R * 0.32;
      const a = (i / 8) * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  function heart(x, y, s, color, alpha) {
    ctx.save();
    ctx.translate(x, y); ctx.scale(s, s); ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(0, 3);
    ctx.bezierCurveTo(-5, -2, -10, 1, -10, 5);
    ctx.bezierCurveTo(-10, 10, -4, 13, 0, 17);
    ctx.bezierCurveTo(4, 13, 10, 10, 10, 5);
    ctx.bezierCurveTo(10, 1, 5, -2, 0, 3);
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  function vGradient(stops) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    for (const [p, c] of stops) g.addColorStop(p, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ---- themes -------------------------------------------------------------
  const THEMES = {

    party: {
      confetti: ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#ffffff', '#ff9f1c'],
      draw(t) {
        const hue = (t * 6) % 360;
        vGradient([[0, `hsl(${hue}, 68%, 62%)`], [1, `hsl(${(hue + 60) % 360}, 70%, 48%)`]]);
        // soft drifting polka dots
        ctx.save();
        ctx.globalAlpha = 0.10; ctx.fillStyle = '#fff';
        const step = M / 7;
        for (let y = -step; y < H + step; y += step) {
          for (let x = -step; x < W + step; x += step) {
            const dx = Math.sin(t * 0.4 + y) * step * 0.15;
            ctx.beginPath(); ctx.arc(x + dx, y, step * 0.16, 0, 7); ctx.fill();
          }
        }
        ctx.restore();
        // rotating sun
        ctx.save();
        ctx.translate(W * 0.09, H * 0.14); ctx.rotate(t * 0.15);
        ctx.fillStyle = '#ffd93b';
        for (let i = 0; i < 12; i++) {
          ctx.rotate(Math.PI / 6);
          ctx.fillRect(M * 0.055, -M * 0.011, M * 0.05, M * 0.022);
        }
        ctx.beginPath(); ctx.arc(0, 0, M * 0.055, 0, 7); ctx.fill();
        ctx.restore();
        // rising balloons
        const r = rng(42);
        for (let i = 0; i < 8; i++) {
          const bx = (0.08 + r() * 0.84) * W + Math.sin(t * 0.8 + i * 2) * M * 0.02;
          const speed = 0.05 + r() * 0.05;
          const by = H * 1.15 - (((t * speed + r()) % 1.3) * H * 1.3);
          const col = `hsl(${(r() * 360) | 0}, 80%, 62%)`;
          const rx = M * (0.035 + r() * 0.012), ry = rx * 1.22;
          ctx.save();
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(bx, by + ry);
          ctx.quadraticCurveTo(bx + M * 0.015, by + ry + M * 0.05, bx, by + ry + M * 0.1);
          ctx.stroke();
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.ellipse(bx, by, rx, ry, 0, 0, 7); ctx.fill();
          ctx.beginPath();
          ctx.moveTo(bx, by + ry); ctx.lineTo(bx - 6, by + ry + 9); ctx.lineTo(bx + 6, by + ry + 9);
          ctx.closePath(); ctx.fill();
          ctx.globalAlpha = 0.45; ctx.fillStyle = '#fff';
          ctx.beginPath(); ctx.ellipse(bx - rx * 0.35, by - ry * 0.4, rx * 0.22, ry * 0.28, -0.5, 0, 7); ctx.fill();
          ctx.restore();
        }
      }
    },

    superhero: {
      confetti: ['#ffd166', '#ef476f', '#118ab2', '#ffffff', '#ff9f1c'],
      skyline: null,
      draw(t) {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#4a2bd9'); g.addColorStop(0.55, '#b52bd9'); g.addColorStop(1, '#d92b6a');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        // halftone dots
        ctx.save();
        ctx.globalAlpha = 0.10; ctx.fillStyle = '#000';
        const step = Math.max(14, W / 90);
        for (let y = 0; y < H * 0.55; y += step) {
          const rr = 1 + (y / (H * 0.55)) * (step * 0.16);
          for (let x = (y / step % 2) * step / 2; x < W; x += step) {
            ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fill();
          }
        }
        ctx.restore();
        // city skyline
        if (!this.skyline || this.skyW !== W) {
          const r = rng(20260813);
          this.skyline = []; this.skyW = W;
          let x = -20;
          while (x < W + 40) {
            const w = (0.04 + r() * 0.07) * W;
            const h = (0.10 + r() * 0.16) * H;
            this.skyline.push({ x, w, h });
            x += w + 4;
          }
        }
        const base = H * 0.995;
        ctx.fillStyle = 'rgba(12, 14, 40, 0.88)';
        for (const b of this.skyline) ctx.fillRect(b.x, base - b.h, b.w, b.h);
        ctx.fillStyle = 'rgba(255, 220, 120, 0.75)';
        const wr = rng(777);
        for (const b of this.skyline) {
          for (let wy = base - b.h + 8; wy < base - 8; wy += 14) {
            for (let wx = b.x + 5; wx < b.x + b.w - 6; wx += 12) {
              if (wr() < 0.28) ctx.fillRect(wx, wy, 5, 7);
            }
          }
        }
        starburst(W * 0.12, H * 0.22, M * 0.06, t * 2.2);
        starburst(W * 0.88, H * 0.18, M * 0.05, t * 2.2 + Math.PI);
        starburst(W * 0.80, H * 0.62, M * 0.045, t * 2.2 + Math.PI / 2);
      }
    },

    princess: {
      confetti: ['#ffd6ec', '#ffd93b', '#ffffff', '#e0b0ff', '#ff8fab'],
      draw(t) {
        vGradient([[0, '#ff9ff3'], [0.55, '#9b59b6'], [1, '#341f97']]);
        // twinkling sparkles
        const r = rng(7);
        for (let i = 0; i < 42; i++) {
          const x = r() * W, y = r() * H * 0.7, ph = r() * 7;
          const a = 0.25 + 0.75 * Math.abs(Math.sin(t * 1.6 + ph));
          star4(x, y, M * (0.006 + r() * 0.009), t * 0.4 + ph, i % 3 ? '#fff' : '#ffd93b', a);
        }
        // castle silhouette
        const base = H * 0.995, cw = M * 0.0016;
        ctx.save();
        ctx.fillStyle = '#2c2350';
        const cx = W * 0.5;
        ctx.fillRect(cx - 260 * cw, base - 200 * cw, 520 * cw, 200 * cw); // wall
        for (const [ox, tw, th] of [[-260, 90, 330], [-60, 120, 420], [170, 90, 330]]) {
          const tx = cx + ox * cw;
          ctx.fillRect(tx, base - th * cw, tw * cw, th * cw);
          ctx.beginPath(); // cone roof
          ctx.moveTo(tx - 12 * cw, base - th * cw);
          ctx.lineTo(tx + tw * cw / 2, base - (th + 110) * cw);
          ctx.lineTo(tx + tw * cw + 12 * cw, base - th * cw);
          ctx.closePath(); ctx.fill();
          // waving flag
          const fx = tx + tw * cw / 2, fy = base - (th + 110) * cw;
          ctx.strokeStyle = '#2c2350'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy - 34 * cw); ctx.stroke();
          ctx.fillStyle = '#ff8fab';
          const wob = Math.sin(t * 3 + ox) * 6 * cw;
          ctx.beginPath();
          ctx.moveTo(fx, fy - 34 * cw);
          ctx.quadraticCurveTo(fx + 22 * cw, fy - 30 * cw + wob, fx + 40 * cw, fy - 26 * cw);
          ctx.lineTo(fx, fy - 18 * cw);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#2c2350';
        }
        // gate
        ctx.beginPath();
        ctx.moveTo(cx - 40 * cw, base);
        ctx.lineTo(cx - 40 * cw, base - 90 * cw);
        ctx.arc(cx, base - 90 * cw, 40 * cw, Math.PI, 0);
        ctx.lineTo(cx + 40 * cw, base);
        ctx.closePath();
        ctx.fillStyle = '#1d173b'; ctx.fill();
        ctx.restore();
        // floating hearts
        const hr = rng(99);
        for (let i = 0; i < 10; i++) {
          const speed = 0.04 + hr() * 0.05;
          const hy = H * 1.1 - (((t * speed + hr()) % 1.2) * H * 1.2);
          const hx = (0.1 + hr() * 0.8) * W + Math.sin(t + i * 3) * M * 0.02;
          heart(hx, hy, M * 0.0022 * (1 + hr()), i % 2 ? '#ff8fab' : '#ffd6ec', 0.8);
        }
      }
    },

    space: {
      confetti: ['#ffffff', '#48dbfb', '#ffd93b', '#c8d6e5'],
      draw(t) {
        vGradient([[0, '#04051d'], [1, '#1b1f5e']]);
        // nebulae
        for (const [nx, ny, nr, c] of [
          [0.25, 0.3, 0.5, 'rgba(155, 89, 182, 0.16)'],
          [0.75, 0.55, 0.45, 'rgba(26, 188, 156, 0.12)'],
          [0.5, 0.85, 0.5, 'rgba(52, 31, 151, 0.25)']
        ]) {
          const g = ctx.createRadialGradient(nx * W, ny * H, 0, nx * W, ny * H, nr * M);
          g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        }
        // twinkling stars
        const r = rng(2001);
        for (let i = 0; i < 90; i++) {
          const x = r() * W, y = r() * H, ph = r() * 7;
          ctx.globalAlpha = 0.3 + 0.7 * Math.abs(Math.sin(t * 1.2 + ph));
          ctx.fillStyle = '#fff';
          ctx.fillRect(x, y, 2.2, 2.2);
        }
        ctx.globalAlpha = 1;
        // ringed planet
        const px = W * 0.82, py = H * 0.30 + Math.sin(t * 0.5) * M * 0.01, pr = M * 0.085;
        ctx.save();
        ctx.translate(px, py); ctx.rotate(-0.3);
        ctx.fillStyle = '#e17055';
        ctx.beginPath(); ctx.arc(0, 0, pr, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.beginPath(); ctx.ellipse(0, -pr * 0.35, pr * 0.9, pr * 0.22, 0, 0, 7); ctx.fill();
        ctx.strokeStyle = '#f6e58d'; ctx.lineWidth = pr * 0.14;
        ctx.beginPath(); ctx.ellipse(0, 0, pr * 1.65, pr * 0.5, 0, 0, 7); ctx.stroke();
        ctx.restore();
        // rocket flying across
        const cyc = (t % 7) / 7;
        const rx = -0.1 * W + cyc * 1.25 * W;
        const ry = H * 0.78 - cyc * H * 0.55 + Math.sin(t * 5) * M * 0.008;
        const s = M * 0.0009;
        ctx.save();
        ctx.translate(rx, ry); ctx.rotate(-0.42); ctx.scale(s, s);
        // flame
        const fl = 40 + Math.sin(t * 30) * 14;
        ctx.fillStyle = '#ff9f1c';
        ctx.beginPath(); ctx.moveTo(-60, -16); ctx.lineTo(-60 - fl, 0); ctx.lineTo(-60, 16); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffd93b';
        ctx.beginPath(); ctx.moveTo(-60, -8); ctx.lineTo(-60 - fl * 0.55, 0); ctx.lineTo(-60, 8); ctx.closePath(); ctx.fill();
        // fins
        ctx.fillStyle = '#e63946';
        ctx.beginPath(); ctx.moveTo(-60, -14); ctx.lineTo(-88, -40); ctx.lineTo(-38, -18); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-60, 14); ctx.lineTo(-88, 40); ctx.lineTo(-38, 18); ctx.closePath(); ctx.fill();
        // body + nose
        ctx.fillStyle = '#f1f2f6';
        ctx.beginPath();
        ctx.moveTo(-62, -16); ctx.lineTo(30, -16);
        ctx.quadraticCurveTo(86, 0, 30, 16);
        ctx.lineTo(-62, 16); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#e63946';
        ctx.beginPath(); ctx.moveTo(46, -11); ctx.quadraticCurveTo(86, 0, 46, 11); ctx.closePath(); ctx.fill();
        // window
        ctx.fillStyle = '#48dbfb'; ctx.strokeStyle = '#2f3542'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(-6, 0, 12, 0, 7); ctx.fill(); ctx.stroke();
        ctx.restore();
        // shooting star every few seconds
        const sc = (t % 4.5) / 4.5;
        if (sc < 0.18) {
          const sp = sc / 0.18;
          const sx = W * (0.15 + sp * 0.3), sy = H * (0.1 + sp * 0.18);
          ctx.save();
          ctx.globalAlpha = 1 - sp;
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - M * 0.09, sy - M * 0.045); ctx.stroke();
          ctx.restore();
        }
      }
    },

    ninja: {
      confetti: ['#e84118', '#ffffff', '#7f8fa6', '#2f3640'],
      draw(t) {
        vGradient([[0, '#10101c'], [1, '#232946']]);
        // moon with glow
        const mx = W * 0.82, my = H * 0.2, mr = M * 0.09;
        const g = ctx.createRadialGradient(mx, my, mr * 0.4, mx, my, mr * 2.6);
        g.addColorStop(0, 'rgba(245, 246, 250, 0.32)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#f5f6fa';
        ctx.beginPath(); ctx.arc(mx, my, mr, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        for (const [ox, oy, or2] of [[-0.3, -0.1, 0.22], [0.25, 0.2, 0.16], [0.05, -0.35, 0.12]]) {
          ctx.beginPath(); ctx.arc(mx + ox * mr, my + oy * mr, or2 * mr, 0, 7); ctx.fill();
        }
        // drifting cloud bands
        ctx.fillStyle = 'rgba(20, 22, 40, 0.65)';
        for (let i = 0; i < 2; i++) {
          const cy2 = H * (0.28 + i * 0.13);
          const off = ((t * (14 + i * 8)) % (W + 400)) - 200;
          ctx.beginPath();
          ctx.ellipse(off, cy2, 190, 26, 0, 0, 7);
          ctx.ellipse(off + 130, cy2 + 8, 150, 20, 0, 0, 7);
          ctx.fill();
        }
        // pagoda silhouette
        const base = H * 0.995, s = M * 0.0016, px = W * 0.24;
        ctx.fillStyle = '#0b0b14';
        let ty = base;
        const tiers = [[300, 70], [240, 64], [180, 58]];
        for (const [tw, th] of tiers) {
          ty -= th * s;
          ctx.fillRect(px - tw * s * 0.30, ty, tw * s * 0.60, th * s); // body
          // upturned roof
          ctx.beginPath();
          ctx.moveTo(px - tw * s * 0.5, ty);
          ctx.quadraticCurveTo(px - tw * s * 0.52, ty - 26 * s, px - tw * s * 0.62, ty - 34 * s);
          ctx.quadraticCurveTo(px - tw * s * 0.2, ty - 44 * s, px, ty - 46 * s);
          ctx.quadraticCurveTo(px + tw * s * 0.2, ty - 44 * s, px + tw * s * 0.62, ty - 34 * s);
          ctx.quadraticCurveTo(px + tw * s * 0.52, ty - 26 * s, px + tw * s * 0.5, ty);
          ctx.closePath(); ctx.fill();
          ty -= 46 * s;
        }
        ctx.fillRect(px - 4 * s, ty - 30 * s, 8 * s, 30 * s); // spire
        // swaying bamboo on the right
        for (let i = 0; i < 3; i++) {
          const bx = W * (0.9 + i * 0.035);
          const sway = Math.sin(t * 0.9 + i) * M * 0.008;
          ctx.strokeStyle = '#0e3d24'; ctx.lineWidth = M * 0.012;
          ctx.beginPath();
          ctx.moveTo(bx, H);
          ctx.quadraticCurveTo(bx + sway, H * 0.6, bx + sway * 2, H * (0.3 + i * 0.08));
          ctx.stroke();
        }
        // spinning shurikens drifting by
        const r = rng(13);
        for (let i = 0; i < 3; i++) {
          const speed = 0.05 + r() * 0.03;
          const sx = ((t * speed + r()) % 1.15) * W * 1.15 - W * 0.05;
          const sy = H * (0.18 + r() * 0.35) + Math.sin(t + i * 2) * M * 0.015;
          star4(sx, sy, M * 0.02, t * (4 + i), '#aab3c0', 0.9);
          ctx.save();
          ctx.globalAlpha = 0.9; ctx.fillStyle = '#2f3640';
          ctx.beginPath(); ctx.arc(sx, sy, M * 0.005, 0, 7); ctx.fill();
          ctx.restore();
        }
      }
    }
  };

  function buildConfetti(colors) {
    confetti = Array.from({ length: 120 }, () => ({
      x: Math.random() * W, y: Math.random() * -H,
      w: 6 + Math.random() * 9, h: 10 + Math.random() * 14,
      vy: 1.2 + Math.random() * 2.4, vx: -0.8 + Math.random() * 1.6,
      rot: Math.random() * Math.PI, vrot: -0.06 + Math.random() * 0.12,
      color: colors[(Math.random() * colors.length) | 0]
    }));
  }

  function frame(now) {
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    const theme = THEMES[themeKey] || THEMES.party;
    if (!hasVideo) theme.draw(t);
    for (const c of confetti) {
      c.y += c.vy; c.x += c.vx + Math.sin(c.y / 40) * 0.6; c.rot += c.vrot;
      if (c.y > H + 20) { c.y = -20; c.x = Math.random() * W; }
      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    if (!canvas) return;
    canvas.width = W = innerWidth;
    canvas.height = H = innerHeight;
    M = Math.min(W, H);
  }

  window.BirthdayScene = {
    start(cnv, theme, videoBehind) {
      const key = THEMES[theme] ? theme : 'party';
      if (raf && canvas === cnv && themeKey === key && hasVideo === !!videoBehind) return;
      this.stop();
      canvas = cnv;
      ctx = canvas.getContext('2d');
      themeKey = key;
      hasVideo = !!videoBehind;
      resize();
      buildConfetti((THEMES[key] || THEMES.party).confetti);
      t0 = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  addEventListener('resize', () => { if (raf) resize(); });
})();
