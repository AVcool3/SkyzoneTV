/* ParkCast control dashboard */
(() => {
  const $ = id => document.getElementById(id);
  // Read the current key, falling back to (and migrating) the pre-rename one
  // so the rebrand never logs anyone out.
  let token = localStorage.getItem('parkcast.token') || localStorage.getItem('skyzone.token') || null;
  if (token) { try { localStorage.setItem('parkcast.token', token); } catch {} }
  let state = null;   // latest server snapshot
  let ws = null;
  let wsDelay = 1000;

  // ---------- helpers ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        Authorization: 'Bearer ' + token,
        ...(opts.headers || {})
      }
    });
    if (res.status === 401) { logout(); throw new Error('Logged out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  let toastTimer = null;
  function toast(msg, bad = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('bad', bad);
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  function fmtSize(b) {
    if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
    return Math.round(b / 1e3) + ' KB';
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- auth ----------
  function logout() {
    token = null;
    localStorage.removeItem('parkcast.token');
    localStorage.removeItem('skyzone.token');
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  }

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('loginError').textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('password').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      token = data.token;
      localStorage.setItem('parkcast.token', token);
      enterApp();
    } catch (err) {
      $('loginError').textContent = err.message;
    }
  });

  async function enterApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('playerUrl').textContent = location.origin + '/player/';
    try {
      state = await api('/api/state');
      render();
    } catch { return; }
    connectWs();
    refreshRollerCard();
  }

  function connectWs() {
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      wsDelay = 1000;
      ws.send(JSON.stringify({ type: 'hello', role: 'dashboard', token }));
      $('connDot').className = 'dot on';
    };
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'state') { state = msg; render(); }
    };
    ws.onclose = ev => {
      $('connDot').className = 'dot off';
      if (ev.code === 4001) { logout(); return; }
      setTimeout(connectWs, wsDelay);
      wsDelay = Math.min(wsDelay * 1.7, 15000);
    };
    ws.onerror = () => ws.close();
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tabpane').forEach(p => p.classList.add('hidden'));
      $('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  // ---------- render ----------
  // Live pushes re-render the whole UI; hold off while the user is typing in
  // an inline rename field so their input isn't clobbered mid-keystroke.
  let renderHeld = false, renderPending = false;
  document.addEventListener('focusin', e => {
    if (e.target.matches?.('.tv-name, .m-label, .ev-edit')) renderHeld = true;
  });
  document.addEventListener('focusout', e => {
    if (e.target.matches?.('.tv-name, .m-label, .ev-edit')) {
      renderHeld = false;
      if (renderPending) { renderPending = false; setTimeout(render, 50); }
    }
  });

  function render() {
    if (!state) return;
    if (renderHeld) { renderPending = true; return; }
    $('tvCount').textContent = state.tvs.length;
    $('mediaCount').textContent = state.media.length;
    $('playlistCount').textContent = (state.playlists || []).length;
    $('eventCount').textContent = state.events.filter(e => e.status !== 'done').length;
    $('themeCount').textContent = 5 + (state.settings.customThemes || []).length;
    $('dayState').textContent = state.settings.dayStarted ? 'Day running' : 'Day ended — screens off';
    renderTvs();
    renderMedia();
    renderPlaylists();
    renderEvents();
    renderThemes();
  }

  // Media grouped for pickers: root items first, then one group per folder.
  function mediaGroups() {
    const groups = [];
    const root = state.media.filter(m => !m.folderId);
    if (root.length) groups.push({ name: null, items: root });
    for (const f of state.folders || []) {
      const items = state.media.filter(m => m.folderId === f.id);
      if (items.length) groups.push({ name: f.name, items });
    }
    return groups;
  }

  function thumbHtml(m, cls = 'thumb') {
    // Photos show themselves; videos show their first frame; slides render live.
    if (m.type === 'slide') {
      const s = m.slide || {};
      return `<div class="${cls} slide-thumb" style="background:linear-gradient(135deg, ${esc(s.bg?.[0] || '#333')}, ${esc(s.bg?.[1] || '#111')});color:${esc(s.textColor || '#fff')}">
        ${s.badge ? `<span class="sp-badge">${esc(s.badge)}</span>` : ''}
        <span class="sp-headline">${esc(s.headline || m.label)}</span>
        ${s.subtext ? `<span class="sp-sub">${esc(s.subtext)}</span>` : ''}
      </div>`;
    }
    return m.type === 'image'
      ? `<img class="${cls}" src="${esc(m.url)}" loading="lazy" alt="">`
      : `<video class="${cls}" src="${esc(m.url)}" preload="metadata" muted playsinline></video>`;
  }

  function themeDisplayName(key) {
    if (!key) return 'party';
    if (key.startsWith('custom:')) {
      const ct = (state.settings.customThemes || []).find(c => `custom:${c.id}` === key);
      return ct ? ct.name : 'party';
    }
    return key;
  }

  function renderTvs() {
    const grid = $('tvGrid');
    grid.innerHTML = '';
    if (state.tvs.length === 0) {
      grid.innerHTML = '<p class="hint">No TVs yet. Open the player URL on a TV and it will show up here.</p>';
      return;
    }
    for (const tv of state.tvs) {
      if (tv.approved === false) {
        // Screen waiting for approval (cloud pairing)
        const pend = document.createElement('div');
        pend.className = 'tv-card' + (tv.online ? '' : ' offline');
        pend.innerHTML = `
          <div class="tv-head"><span class="tv-name" style="flex:1">📺 New screen</span></div>
          <div class="tv-badges">
            <span class="badge ${tv.online ? 'online' : 'offline'}">${tv.online ? 'ONLINE' : 'OFFLINE'}</span>
            <span class="badge bday">WAITING FOR APPROVAL</span>
          </div>
          <div class="tv-now">Pairing code on its screen: <strong>${esc(tv.pairCode || '?')}</strong></div>
          <div class="tv-actions">
            <button class="btn tiny primary" data-act="approve">✓ Approve</button>
            <button class="btn tiny danger" data-act="reject">✕ Reject</button>
          </div>`;
        pend.querySelector('[data-act="approve"]').addEventListener('click', () =>
          api(`/api/tvs/${tv.id}/approve`, { method: 'POST' })
            .then(() => toast('Screen approved — name it and give it content')).catch(e => toast(e.message, true)));
        pend.querySelector('[data-act="reject"]').addEventListener('click', () =>
          api(`/api/tvs/${tv.id}`, { method: 'DELETE' }).then(() => toast('Screen rejected')).catch(e => toast(e.message, true)));
        grid.appendChild(pend);
        continue;
      }
      const card = document.createElement('div');
      card.className = 'tv-card' + (tv.online ? '' : ' offline');
      const pl = tv.playlistId ? (state.playlists || []).find(p => p.id === tv.playlistId) : null;
      const playlistNames = pl
        ? [`Playlist: ${pl.name}`]
        : tv.assignedMediaIds.map(id => state.media.find(m => m.id === id)?.label).filter(Boolean);
      card.innerHTML = `
        <div class="tv-head">
          <input class="tv-name" value="${esc(tv.name)}" title="Click to rename">
          <div class="tv-head-actions">
            <button class="btn tiny" data-act="power">${tv.power === 'on' ? 'Screen off' : 'Screen on'}</button>
            <button class="btn tiny danger" data-act="forget" title="Forget this TV">✕</button>
          </div>
        </div>
        <div class="tv-badges">
          <span class="badge ${tv.online ? 'online' : 'offline'}">${tv.online ? 'ONLINE' : 'OFFLINE'}</span>
          ${tv.power === 'off' ? '<span class="badge off">SCREEN OFF</span>' : ''}
          ${tv.override ? `<span class="badge bday">🎂 ${esc(tv.override.name)}</span>` : ''}
        </div>
        <div class="tv-now">${tv.power === 'off' ? 'Screen off' :
          tv.override ? `Birthday takeover until ${fmtTime(tv.override.endsAt)}` :
          pl ? `Playlist: <span class="playing">${esc(pl.name)}</span>` :
          playlistNames.length ? `Loop: <span class="playing">${esc(playlistNames.join(' → '))}</span>` :
          'No media assigned'}</div>
        <div class="tv-actions">
          <button class="btn tiny" data-act="bday">🎂 Test</button>
          ${tv.override ? '<button class="btn tiny" data-act="clear">Stop takeover</button>' : ''}
        </div>
        <button class="btn content-btn" data-act="media">Content…</button>`;

      const nameInput = card.querySelector('.tv-name');
      nameInput.addEventListener('change', () => {
        api(`/api/tvs/${tv.id}`, { method: 'PATCH', body: JSON.stringify({ name: nameInput.value }) })
          .then(() => toast('Renamed')).catch(e => toast(e.message, true));
      });
      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });

      card.querySelector('[data-act="media"]').addEventListener('click', () => openContentModal(tv));

      card.querySelector('[data-act="power"]').addEventListener('click', () =>
        api(`/api/tvs/${tv.id}/power`, { method: 'POST', body: JSON.stringify({ power: tv.power === 'on' ? 'off' : 'on' }) })
          .catch(e => toast(e.message, true)));

      card.querySelector('[data-act="bday"]').addEventListener('click', () => {
        const name = prompt('Name to show (1-minute test):', 'Aiden');
        if (!name) return;
        const customNames = (state.settings.customThemes || []).map(c => c.name);
        const theme = prompt('Theme: ' + ['party', 'superhero', 'princess', 'space', 'ninja'].concat(customNames).join(' / '), 'party') || 'party';
        api(`/api/tvs/${tv.id}/test-birthday`, { method: 'POST', body: JSON.stringify({ name, theme, durationMin: 1 }) })
          .then(() => toast('Birthday test running')).catch(e => toast(e.message, true));
      });

      const clearBtn = card.querySelector('[data-act="clear"]');
      if (clearBtn) clearBtn.addEventListener('click', () =>
        api(`/api/tvs/${tv.id}/clear-override`, { method: 'POST' }).catch(e => toast(e.message, true)));

      card.querySelector('[data-act="forget"]').addEventListener('click', () => {
        if (!confirm(`Forget "${tv.name}"? The TV will re-pair as a new entry if its player is still running.`)) return;
        api(`/api/tvs/${tv.id}`, { method: 'DELETE' }).catch(e => toast(e.message, true));
      });

      grid.appendChild(card);
    }
  }

  // Which library folder is open ('all' = everything). Uploads and new
  // slides land in the open folder.
  let currentFolder = 'all';

  function renderFolderBar() {
    const bar = $('folderBar');
    bar.innerHTML = '';
    const folders = state.folders || [];
    if (currentFolder !== 'all' && !folders.some(f => f.id === currentFolder)) currentFolder = 'all';

    const mkChip = (label, active, onClick) => {
      const chip = document.createElement('button');
      chip.className = 'chip' + (active ? ' on' : '');
      chip.textContent = label;
      chip.addEventListener('click', onClick);
      bar.appendChild(chip);
      return chip;
    };

    mkChip(`🗂 All media (${state.media.length})`, currentFolder === 'all', () => { currentFolder = 'all'; renderMedia(); });
    for (const f of folders) {
      const count = state.media.filter(m => m.folderId === f.id).length;
      const active = currentFolder === f.id;
      mkChip(`📁 ${f.name} (${count})`, active, () => { currentFolder = f.id; renderMedia(); });
      if (active) {
        const ren = document.createElement('button');
        ren.className = 'btn tiny';
        ren.textContent = '✏';
        ren.title = 'Rename folder';
        ren.addEventListener('click', () => {
          const name = prompt('Folder name:', f.name);
          if (!name) return;
          api('/api/folders', { method: 'POST', body: JSON.stringify({ id: f.id, name }) })
            .then(() => toast('Folder renamed')).catch(e => toast(e.message, true));
        });
        bar.appendChild(ren);
        const del = document.createElement('button');
        del.className = 'btn tiny danger';
        del.textContent = '✕';
        del.title = 'Delete folder (media moves back to All)';
        del.addEventListener('click', () => {
          if (!confirm(`Delete folder "${f.name}"? Its media moves back to the library — nothing is deleted.`)) return;
          api(`/api/folders/${f.id}`, { method: 'DELETE' })
            .then(() => { currentFolder = 'all'; toast('Folder deleted'); }).catch(e => toast(e.message, true));
        });
        bar.appendChild(del);
      }
    }
    const add = document.createElement('button');
    add.className = 'btn tiny';
    add.textContent = '＋ New folder';
    add.addEventListener('click', () => {
      const name = prompt('Folder name:', 'Promotions');
      if (!name) return;
      api('/api/folders', { method: 'POST', body: JSON.stringify({ name }) })
        .then(r => { currentFolder = r.folder.id; toast(`Folder "${r.folder.name}" created — uploads now land in it`); })
        .catch(e => toast(e.message, true));
    });
    bar.appendChild(add);
  }

  function renderMedia() {
    renderFolderBar();
    const list = $('mediaList');
    list.innerHTML = '';
    if (state.media.length === 0) {
      list.innerHTML = '<p class="hint">No media yet. Upload videos or photos, or create a slide to get started.</p>';
      return;
    }
    const visible = currentFolder === 'all' ? state.media : state.media.filter(m => m.folderId === currentFolder);
    if (visible.length === 0) {
      list.innerHTML = '<p class="hint">This folder is empty — uploads and new slides land here while it\'s open.</p>';
      return;
    }
    for (const m of visible) {
      // Count TVs showing this media directly OR through their playlist.
      const usedBy = state.tvs.filter(t =>
        t.assignedMediaIds.includes(m.id) ||
        (t.playlistId && (state.playlists || []).find(p => p.id === t.playlistId)?.items.some(it => it.mediaId === m.id))
      ).length;
      const inPlaylists = (state.playlists || []).filter(p => p.items.some(it => it.mediaId === m.id)).length;
      const card = document.createElement('div');
      card.className = 'media-card';
      const typeBadge = m.type === 'slide' ? '📝 SLIDE' : m.type === 'image' ? '🖼 PHOTO' : '🎬 VIDEO';
      card.innerHTML = `
        <div class="thumb-wrap">${thumbHtml(m)}<span class="type-badge">${typeBadge}</span></div>
        <input class="m-label" value="${esc(m.label)}" title="Click to rename">
        <div class="m-meta">${m.type === 'slide' ? 'made in the dashboard' : `${fmtSize(m.size)} · uploaded ${fmtTime(m.uploadedAt)}`} · ${usedBy} TV${usedBy === 1 ? '' : 's'} · ${inPlaylists} playlist${inPlaylists === 1 ? '' : 's'}</div>
        ${m.type !== 'video' ? `<div class="m-duration">Shows for <input type="number" class="m-dur" value="${m.durationSec}" min="1" max="3600" step="1"> seconds</div>` : ''}
        <div class="m-actions">
          ${m.type === 'slide' ? '<button class="btn tiny" data-act="editslide">✏ Edit slide</button>' :
            `<button class="btn tiny" data-act="preview">${m.type === 'image' ? '🔍 View' : '▶ Preview'}</button>`}
          ${m.type !== 'slide' ? '<button class="btn tiny" data-act="replace">↻ Replace file</button>' : ''}
          <button class="btn tiny" data-act="all">Apply to all TVs</button>
          <button class="btn tiny danger" data-act="del">Delete</button>
        </div>
        ${(state.folders || []).length ? `<div class="m-duration">📁 <select class="m-folder">
          <option value="">No folder</option>
          ${(state.folders || []).map(f => `<option value="${esc(f.id)}" ${m.folderId === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
        </select></div>` : ''}`;

      const label = card.querySelector('.m-label');
      label.addEventListener('change', () =>
        api(`/api/media/${m.id}`, { method: 'PATCH', body: JSON.stringify({ label: label.value }) })
          .then(() => toast('Renamed')).catch(e => toast(e.message, true)));
      label.addEventListener('keydown', e => { if (e.key === 'Enter') label.blur(); });

      const durInput = card.querySelector('.m-dur');
      if (durInput) durInput.addEventListener('change', () =>
        api(`/api/media/${m.id}`, { method: 'PATCH', body: JSON.stringify({ durationSec: parseFloat(durInput.value) }) })
          .then(() => toast('Slide timing updated')).catch(e => toast(e.message, true)));

      const folderSel = card.querySelector('.m-folder');
      if (folderSel) folderSel.addEventListener('change', () =>
        api(`/api/media/${m.id}`, { method: 'PATCH', body: JSON.stringify({ folderId: folderSel.value || null }) })
          .then(() => toast(folderSel.value ? 'Moved to folder' : 'Moved out of folder'))
          .catch(e => toast(e.message, true)));

      const editSlideBtn = card.querySelector('[data-act="editslide"]');
      if (editSlideBtn) editSlideBtn.addEventListener('click', () => openSlideModal(m));

      const replaceBtn = card.querySelector('[data-act="replace"]');
      if (replaceBtn) replaceBtn.addEventListener('click', () => {
        replaceTargetId = m.id;
        $('replaceFile').click();
      });

      const previewBtn = card.querySelector('[data-act="preview"]');
      if (previewBtn) previewBtn.addEventListener('click', () => {
        $('previewTitle').textContent = m.label;
        const v = $('previewVideo'), img = $('previewImage');
        if (m.type === 'image') {
          v.classList.add('hidden'); img.classList.remove('hidden');
          img.src = m.url;
        } else {
          img.classList.add('hidden'); v.classList.remove('hidden');
          v.src = m.url;
          v.play().catch(() => {});
        }
        $('previewModal').classList.remove('hidden');
      });

      card.querySelector('[data-act="all"]').addEventListener('click', () => {
        if (!confirm(`Replace every TV's playlist with just "${m.label}"?`)) return;
        api('/api/assign-all', { method: 'POST', body: JSON.stringify({ mediaIds: [m.id] }) })
          .then(() => toast('Now playing on all TVs')).catch(e => toast(e.message, true));
      });

      card.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm(`Delete "${m.label}"? It will be removed from every TV.`)) return;
        api(`/api/media/${m.id}`, { method: 'DELETE' }).then(() => toast('Deleted')).catch(e => toast(e.message, true));
      });

      list.appendChild(card);
    }
  }

  const THEME_ICONS = { party: '🎉', superhero: '🦸', princess: '👑', space: '🚀', ninja: '🥷' };
  function themeOptionsHtml(selected) {
    const builtins = ['party', 'superhero', 'princess', 'space', 'ninja']
      .map(t => `<option value="${t}" ${selected === t ? 'selected' : ''}>${THEME_ICONS[t]} ${t}</option>`);
    const customs = (state.settings.customThemes || [])
      .map(c => `<option value="custom:${c.id}" ${selected === `custom:${c.id}` ? 'selected' : ''}>🎨 ${esc(c.name)}</option>`);
    return builtins.concat(customs).join('');
  }

  // Save one edited field of a party row. Every field is editable on purpose:
  // the byline parse only pre-fills — the operator always has the final word.
  function saveEventField(ev, patch, okMsg) {
    api(`/api/events/${ev.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      .then(() => toast(okMsg || 'Saved'))
      .catch(e => { toast(e.message, true); render(); });
  }

  function renderEvents() {
    const rows = $('eventRows');
    rows.innerHTML = '';
    if (state.events.length === 0) {
      rows.innerHTML = '<tr><td colspan="9" class="hint">No parties yet. They arrive from ROLLER (or the temporary test import), or add one manually.</td></tr>';
      return;
    }
    for (const ev of state.events) {
      const editable = ev.status !== 'done';
      const needsCheck = ev.parsed && (ev.parsed.confidence !== 'high' || !ev.parsed.name);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtTime(ev.startsAt)}</td>
        <td>${esc(ev.tvName)}</td>
        <td class="byline-cell" title="${esc(ev.byline || '')}">
          <span class="byline-text">${ev.byline ? esc(ev.byline) : '<span class="hint">manual</span>'}</span>
          ${needsCheck ? '<span class="parse-chip warn" title="The booking text was unclear — check the name and age">⚠ check</span>'
            : (ev.parsed ? '<span class="parse-chip" title="Read automatically from the booking text — still editable">auto</span>' : '')}</td>
        <td>${editable
          ? `<input class="ev-edit ev-name" value="${esc(ev.name)}" maxlength="60" aria-label="Birthday name">`
          : `<strong>${esc(ev.name)}</strong>`}</td>
        <td>${editable
          ? `<input class="ev-edit ev-age" type="number" min="1" max="99" value="${ev.age ?? ''}" placeholder="—" aria-label="Age">`
          : `${ev.age ?? '—'}`}</td>
        <td>${editable
          ? `<select class="ev-edit ev-theme" aria-label="Theme">${themeOptionsHtml(ev.theme || 'party')}</select>`
          : `${THEME_ICONS[ev.theme] || '🎨'} ${esc(themeDisplayName(ev.theme))}`}</td>
        <td>${ev.durationMin} min</td>
        <td><span class="status-tag ${ev.status}">${ev.status.toUpperCase()}</span></td>
        <td style="white-space:nowrap">
          ${ev.status === 'scheduled' ? '<button class="btn tiny" data-act="now">Start now</button>' : ''}
          <button class="btn tiny danger" data-act="del" title="Delete">✕</button>
        </td>`;
      if (editable) {
        const nameInput = tr.querySelector('.ev-name');
        nameInput.addEventListener('change', () => {
          if (!nameInput.value.trim()) { nameInput.value = ev.name; return; }
          saveEventField(ev, { name: nameInput.value }, `Name saved — screen will show "${nameInput.value.trim()}"`);
        });
        nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });
        const ageInput = tr.querySelector('.ev-age');
        ageInput.addEventListener('change', () =>
          saveEventField(ev, { age: ageInput.value === '' ? null : ageInput.value }, 'Age saved'));
        ageInput.addEventListener('keydown', e => { if (e.key === 'Enter') ageInput.blur(); });
        tr.querySelector('.ev-theme').addEventListener('change', e =>
          saveEventField(ev, { theme: e.target.value }, 'Theme saved'));
      }
      const nowBtn = tr.querySelector('[data-act="now"]');
      if (nowBtn) nowBtn.addEventListener('click', () =>
        api(`/api/events/${ev.id}/start-now`, { method: 'POST' })
          .then(() => toast(`Showing ${ev.name} now`)).catch(e => toast(e.message, true)));
      tr.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm(`Delete ${ev.name}'s party (${fmtTime(ev.startsAt)}, ${ev.tvName})?`)) return;
        api(`/api/events/${ev.id}`, { method: 'DELETE' }).catch(e => toast(e.message, true));
      });
      rows.appendChild(tr);
    }
  }

  // ---------- slide editor ----------
  let editingSlideId = null;
  function slidePreviewRefresh() {
    const p = $('slPreview');
    p.style.background = `linear-gradient(135deg, ${$('slBg1').value}, ${$('slBg2').value})`;
    p.style.color = $('slText').value;
    p.innerHTML = '';
    if ($('slBadge').value.trim()) {
      const b = document.createElement('span'); b.className = 'sp-badge';
      b.textContent = $('slBadge').value.trim(); p.appendChild(b);
    }
    const h = document.createElement('span'); h.className = 'sp-headline';
    h.textContent = $('slHeadline').value.trim() || 'Headline'; p.appendChild(h);
    if ($('slSub').value.trim()) {
      const s = document.createElement('span'); s.className = 'sp-sub';
      s.textContent = $('slSub').value.trim(); p.appendChild(s);
    }
  }
  for (const id of ['slBadge', 'slHeadline', 'slSub', 'slBg1', 'slBg2', 'slText']) {
    $(id).addEventListener('input', slidePreviewRefresh);
  }

  function openSlideModal(m) {
    editingSlideId = m ? m.id : null;
    $('slideModalTitle').textContent = m ? `Edit "${m.label}"` : 'Create slide';
    const s = m ? m.slide : {};
    $('slLabel').value = m ? m.label : '';
    $('slBadge').value = s.badge || '';
    $('slHeadline').value = s.headline || '';
    $('slSub').value = s.subtext || '';
    $('slBg1').value = s.bg?.[0] || '#ff6a00';
    $('slBg2').value = s.bg?.[1] || '#d92b6a';
    $('slText').value = s.textColor || '#ffffff';
    $('slDur').value = m ? m.durationSec : 8;
    $('slideError').textContent = '';
    slidePreviewRefresh();
    $('slideModal').classList.remove('hidden');
  }
  $('addSlideBtn').addEventListener('click', () => openSlideModal(null));
  $('slideCancel').addEventListener('click', () => $('slideModal').classList.add('hidden'));
  $('slideSave').addEventListener('click', async () => {
    try {
      await api('/api/slides', {
        method: 'POST',
        body: JSON.stringify({
          id: editingSlideId,
          label: $('slLabel').value,
          folderId: editingSlideId ? undefined : (currentFolder !== 'all' ? currentFolder : null),
          durationSec: parseFloat($('slDur').value) || 8,
          slide: {
            bg: [$('slBg1').value, $('slBg2').value],
            headline: $('slHeadline').value,
            subtext: $('slSub').value,
            badge: $('slBadge').value,
            textColor: $('slText').value
          }
        })
      });
      $('slideModal').classList.add('hidden');
      toast(editingSlideId ? 'Slide updated — live on every screen using it' : 'Slide created');
    } catch (err) { $('slideError').textContent = err.message; }
  });

  // ---------- replace file ----------
  let replaceTargetId = null;
  $('replaceFile').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !replaceTargetId) return;
    const form = new FormData();
    form.append('file', file);
    toast('Replacing file…');
    fetch(`/api/media/${replaceTargetId}/replace`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form
    }).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Replace failed');
      toast('File replaced — screens updated');
    }).catch(err => toast(err.message, true))
      .finally(() => { replaceTargetId = null; });
  });

  // ---------- playlists ----------
  function renderPlaylists() {
    const list = $('playlistList');
    list.innerHTML = '';
    const playlists = state.playlists || [];
    if (playlists.length === 0) {
      list.innerHTML = '<p class="hint">No playlists yet. Create one, add a mix of videos and photos, then assign it to your TVs.</p>';
      return;
    }
    for (const p of playlists) {
      const enabled = p.items.filter(it => it.enabled !== false).length;
      const card = document.createElement('div');
      card.className = 'pl-card';
      const thumbs = p.items.slice(0, 4).map(it => {
        const m = state.media.find(x => x.id === it.mediaId);
        return m ? thumbHtml(m, 'row-thumb') : '';
      }).join('');
      card.innerHTML = `
        <div class="pl-name">📋 ${esc(p.name)}</div>
        <div style="display:flex;gap:6px">${thumbs}</div>
        <div class="m-meta">${enabled} of ${p.items.length} item${p.items.length === 1 ? '' : 's'} playing ·
          ${p.transition === 'fade' ? 'fade transition' : 'no transition'} · on ${p.usedBy} TV${p.usedBy === 1 ? '' : 's'}</div>
        <div class="m-actions">
          <button class="btn tiny" data-act="edit">✏ Edit</button>
          <button class="btn tiny" data-act="all">Apply to ALL TVs</button>
          <button class="btn tiny danger" data-act="del">Delete</button>
        </div>`;
      card.querySelector('[data-act="edit"]').addEventListener('click', () => openPlaylistModal(p));
      card.querySelector('[data-act="all"]').addEventListener('click', () => {
        if (!confirm(`Play "${p.name}" on every TV?`)) return;
        api(`/api/playlists/${p.id}/assign-all`, { method: 'POST' })
          .then(() => toast(`"${p.name}" is now on all TVs`)).catch(e => toast(e.message, true));
      });
      card.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm(`Delete playlist "${p.name}"? TVs using it fall back to their custom selection.`)) return;
        api(`/api/playlists/${p.id}`, { method: 'DELETE' }).then(() => toast('Playlist deleted')).catch(e => toast(e.message, true));
      });
      list.appendChild(card);
    }
  }

  // Playlist editor: works on a local copy of items until Save Changes.
  let plEditing = { id: null, items: [] };
  let plDragIdx = null;

  function renderPlRows() {
    const box = $('plRows');
    box.innerHTML = '';
    if (plEditing.items.length === 0) {
      box.innerHTML = '<p class="hint">No slides yet — click “+ Add media”.</p>';
      return;
    }
    plEditing.items.forEach((it, idx) => {
      const m = state.media.find(x => x.id === it.mediaId);
      if (!m) return;
      const row = document.createElement('div');
      row.className = 'pl-row' + (it.enabled === false ? ' disabled' : '');
      row.innerHTML = `
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        ${thumbHtml(m, 'row-thumb')}
        <span class="row-name">${esc(m.label)}</span>
        <label class="switch" title="Play this slide">
          <input type="checkbox" ${it.enabled !== false ? 'checked' : ''}>
          <span class="knob"></span>
        </label>
        <span class="row-timing">${m.type !== 'video'
          ? `<input type="number" value="${it.durationSec || m.durationSec || 8}" min="1" max="3600"> s`
          : 'full video'}</span>
        <span class="row-actions">
          <button class="btn tiny" data-act="up" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn tiny" data-act="down" ${idx === plEditing.items.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn tiny danger" data-act="rm">✕</button>
        </span>`;
      row.querySelector('.switch input').addEventListener('change', e => {
        it.enabled = e.target.checked;
        row.classList.toggle('disabled', !it.enabled);
      });
      const timing = row.querySelector('.row-timing input');
      if (timing) timing.addEventListener('change', () => { it.durationSec = parseFloat(timing.value) || 8; });
      // drag-and-drop reorder (handle-initiated so inputs stay usable);
      // the ↑↓ arrows remain as the touch-screen fallback
      const handle = row.querySelector('.drag-handle');
      handle.addEventListener('mousedown', () => { row.draggable = true; });
      handle.addEventListener('mouseup', () => { row.draggable = false; });
      row.addEventListener('dragstart', e => {
        plDragIdx = idx;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
      });
      row.addEventListener('dragend', () => {
        row.draggable = false;
        row.classList.remove('dragging');
        box.querySelectorAll('.pl-row').forEach(r => r.classList.remove('drop-before', 'drop-after'));
      });
      row.addEventListener('dragover', e => {
        if (plDragIdx === null || plDragIdx === idx) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = row.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        row.classList.toggle('drop-before', before);
        row.classList.toggle('drop-after', !before);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', e => {
        if (plDragIdx === null || plDragIdx === idx) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        let to = idx + (before ? 0 : 1);
        const [moved] = plEditing.items.splice(plDragIdx, 1);
        if (plDragIdx < to) to--;
        plEditing.items.splice(to, 0, moved);
        plDragIdx = null;
        renderPlRows();
      });

      row.querySelector('[data-act="up"]').addEventListener('click', () => {
        plEditing.items.splice(idx - 1, 0, plEditing.items.splice(idx, 1)[0]);
        renderPlRows();
      });
      row.querySelector('[data-act="down"]').addEventListener('click', () => {
        plEditing.items.splice(idx + 1, 0, plEditing.items.splice(idx, 1)[0]);
        renderPlRows();
      });
      row.querySelector('[data-act="rm"]').addEventListener('click', () => {
        plEditing.items.splice(idx, 1);
        renderPlRows();
      });
      box.appendChild(row);
    });
  }

  function openPlaylistModal(p) {
    plEditing = p
      ? { id: p.id, items: p.items.map(it => ({ ...it })) }
      : { id: null, items: [] };
    $('playlistModalTitle').textContent = p ? 'Edit Playlist' : 'New Playlist';
    $('plName').value = p ? p.name : '';
    document.querySelectorAll('[name="plTransition"]').forEach(r => {
      r.checked = r.value === ((p && p.transition) || 'none');
    });
    $('playlistError').textContent = '';
    renderPlRows();
    $('playlistModal').classList.remove('hidden');
  }

  $('addPlaylistBtn').addEventListener('click', () => openPlaylistModal(null));
  $('playlistCancel').addEventListener('click', () => $('playlistModal').classList.add('hidden'));

  $('plAddMedia').addEventListener('click', () => {
    const list = $('plMediaList');
    list.innerHTML = state.media.length ? '' : '<p class="hint">Upload media first.</p>';
    const groups = mediaGroups();
    for (const g of groups) {
      if (g.name && groups.length > 1) {
        const head = document.createElement('div');
        head.className = 'sheet-label';
        head.style.margin = '8px 0 2px';
        head.textContent = `📁 ${g.name}`;
        list.appendChild(head);
      }
      for (const m of g.items) {
        const item = document.createElement('div');
        item.className = 'picker-item';
        item.innerHTML = `${thumbHtml(m, 'row-thumb')}<span class="p-label">${esc(m.label)}</span>
          <span class="hint">${m.type}</span>`;
        item.addEventListener('click', () => {
          plEditing.items.push({ mediaId: m.id, enabled: true, durationSec: m.durationSec || 8 });
          renderPlRows();
          toast(`Added "${m.label}"`);
        });
        list.appendChild(item);
      }
    }
    $('plMediaModal').classList.remove('hidden');
  });
  $('plMediaClose').addEventListener('click', () => $('plMediaModal').classList.add('hidden'));

  $('playlistSave').addEventListener('click', async () => {
    try {
      await api('/api/playlists', {
        method: 'POST',
        body: JSON.stringify({
          id: plEditing.id,
          name: $('plName').value,
          transition: document.querySelector('[name="plTransition"]:checked')?.value || 'none',
          items: plEditing.items
        })
      });
      $('playlistModal').classList.add('hidden');
      toast('Playlist saved');
    } catch (err) { $('playlistError').textContent = err.message; }
  });

  // ---------- TV content panel ----------
  // A visual sub-UI: playlist cards with previews, apply-to-many-TVs chips,
  // and per-TV screen fit. Selection state lives here until Apply.
  function openContentModal(tv) {
    let choice = tv.playlistId || 'custom';
    let fit = tv.fit || 'contain';
    const extraTvs = new Set();

    $('contentTitle').textContent = `Content for ${tv.name}`;
    const currentPl = tv.playlistId ? (state.playlists || []).find(p => p.id === tv.playlistId) : null;
    $('contentNow').textContent = 'Currently: ' + (currentPl ? `playlist "${currentPl.name}"` :
      tv.assignedMediaIds.length ? `custom selection (${tv.assignedMediaIds.length} items)` : 'nothing (idle screen)');

    const cards = $('contentCards');
    cards.innerHTML = '';

    function makeCard({ key, ribbon, strip, big, name, meta, actions }) {
      const card = document.createElement('div');
      card.className = 'content-card' + (choice === key ? ' selected' : '');
      card.dataset.key = key;
      card.innerHTML = `
        ${ribbon ? '<span class="cc-ribbon">NOW PLAYING</span>' : ''}
        <span class="cc-check">✓</span>
        ${strip ? `<div class="cc-strip">${strip}</div>` : `<div class="cc-big">${big}</div>`}
        <div class="cc-name">${esc(name)}</div>
        <div class="cc-meta">${meta}</div>
        ${actions ? `<div class="cc-actions">${actions}</div>` : ''}`;
      card.addEventListener('click', e => {
        if (e.target.closest('.cc-actions')) return;
        choice = key;
        cards.querySelectorAll('.content-card').forEach(c => c.classList.toggle('selected', c === card));
        updateSummary();
      });
      cards.appendChild(card);
      return card;
    }

    for (const p of state.playlists || []) {
      const strip = p.items.slice(0, 4).map(it => {
        const m = state.media.find(x => x.id === it.mediaId);
        return m ? thumbHtml(m, 'row-thumb') : '';
      }).join('') || '<div class="cc-big" style="flex:1">📋</div>';
      const counts = { video: 0, image: 0, slide: 0 };
      for (const it of p.items) {
        const t = (state.media.find(m => m.id === it.mediaId) || {}).type;
        if (counts[t] !== undefined) counts[t]++;
      }
      const parts = [];
      if (counts.video) parts.push(`${counts.video} video${counts.video === 1 ? '' : 's'}`);
      if (counts.image) parts.push(`${counts.image} photo${counts.image === 1 ? '' : 's'}`);
      if (counts.slide) parts.push(`${counts.slide} slide${counts.slide === 1 ? '' : 's'}`);
      const card = makeCard({
        key: p.id,
        ribbon: tv.playlistId === p.id,
        strip,
        name: `📋 ${p.name}`,
        meta: `${p.items.length} item${p.items.length === 1 ? '' : 's'}${parts.length ? ' — ' + parts.join(', ') : ''}<br>` +
          `${p.transition === 'fade' ? 'fade transition' : 'no transition'} · on ${p.usedBy} TV${p.usedBy === 1 ? '' : 's'}`,
        actions: '<button class="btn tiny" data-edit>✏ Edit playlist</button>'
      });
      card.querySelector('[data-edit]').addEventListener('click', () => {
        $('contentModal').classList.add('hidden');
        openPlaylistModal(p);
      });
    }

    makeCard({
      key: 'custom',
      ribbon: !tv.playlistId && tv.assignedMediaIds.length > 0,
      big: '🎛',
      name: 'Custom selection…',
      meta: 'Hand-pick individual media for the chosen TVs — good for one-off setups.'
    });

    makeCard({
      key: 'blank',
      ribbon: !tv.playlistId && tv.assignedMediaIds.length === 0,
      big: '🌙',
      name: 'Idle screen',
      meta: 'Show the standby screen — no media plays.'
    });

    const newCard = makeCard({
      key: 'new',
      big: '➕',
      name: 'New playlist…',
      meta: 'Build a fresh mix and come back to assign it.'
    });
    newCard.addEventListener('click', () => {
      $('contentModal').classList.add('hidden');
      document.querySelector('.tab[data-tab="playlists"]').click();
      openPlaylistModal(null);
    });

    // chips for pushing the same choice to more TVs at once
    const chips = $('contentTvChips');
    chips.innerHTML = state.tvs.length > 1 ? '' : '<span class="hint">No other TVs paired yet.</span>';
    for (const other of state.tvs) {
      if (other.id === tv.id) continue;
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.innerHTML = `<span class="dot ${other.online ? 'on' : 'off'}"></span>${esc(other.name)}`;
      chip.addEventListener('click', () => {
        if (extraTvs.has(other.id)) extraTvs.delete(other.id); else extraTvs.add(other.id);
        chip.classList.toggle('on', extraTvs.has(other.id));
        updateSummary();
      });
      chips.appendChild(chip);
    }

    // screen fit
    const fitChips = $('fitChips').querySelectorAll('.chip');
    fitChips.forEach(c => {
      c.classList.toggle('on', c.dataset.fit === fit);
      c.onclick = () => {
        fit = c.dataset.fit;
        fitChips.forEach(x => x.classList.toggle('on', x.dataset.fit === fit));
      };
    });

    function updateSummary() {
      const n = 1 + extraTvs.size;
      const what = choice === 'custom' ? 'a custom selection' :
        choice === 'blank' ? 'the idle screen' :
        choice === 'new' ? 'a new playlist' :
        `"${(state.playlists.find(p => p.id === choice) || {}).name}"`;
      $('contentSummary').textContent = `Applying ${what} to ${n} TV${n === 1 ? '' : 's'}`;
    }
    updateSummary();

    $('contentSave').onclick = async () => {
      const targets = [tv.id, ...extraTvs];
      $('contentModal').classList.add('hidden');
      try {
        for (const id of targets) {
          await api(`/api/tvs/${id}`, { method: 'PATCH', body: JSON.stringify({ fit }) });
        }
        if (choice === 'blank') {
          for (const id of targets) {
            await api(`/api/tvs/${id}/assign`, { method: 'POST', body: JSON.stringify({ mediaIds: [] }) });
          }
          toast(`Idle screen on ${targets.length} TV${targets.length === 1 ? '' : 's'}`);
        } else if (choice === 'custom') {
          openPicker(`Custom selection for ${targets.length} TV${targets.length === 1 ? '' : 's'}`, tv.assignedMediaIds, async ids => {
            for (const id of targets) {
              await api(`/api/tvs/${id}/assign`, { method: 'POST', body: JSON.stringify({ mediaIds: ids }) });
            }
            toast(`Custom selection applied to ${targets.length} TV${targets.length === 1 ? '' : 's'}`);
          });
        } else if (choice !== 'new') {
          for (const id of targets) {
            await api(`/api/tvs/${id}/playlist`, { method: 'POST', body: JSON.stringify({ playlistId: choice }) });
          }
          toast(`Playlist applied to ${targets.length} TV${targets.length === 1 ? '' : 's'}`);
        }
      } catch (e) { toast(e.message, true); }
    };
    $('contentCancel').onclick = () => $('contentModal').classList.add('hidden');
    $('contentModal').classList.remove('hidden');
  }

  // ---------- custom themes ----------
  function renderThemes() {
    const list = $('themeList');
    list.innerHTML = '';
    const themes = state.settings.customThemes || [];
    if (themes.length === 0) {
      list.innerHTML = '<p class="hint">No custom themes yet. Click “+ New theme” — pick colors, type some emojis, done.</p>';
      return;
    }
    for (const th of themes) {
      const card = document.createElement('div');
      card.className = 'media-card';
      const swatches = [...th.bg, th.headline.fill, th.headline.stroke]
        .map(c => `<span class="sw" style="background:${esc(c)}"></span>`).join('');
      card.innerHTML = `
        <strong>🎨 ${esc(th.name)}</strong>
        <div class="theme-swatches">${swatches}</div>
        <div class="theme-emojis">${esc(th.emojis || '')}</div>
        <div class="m-meta">${(th.elements || []).join(', ') || 'no extra effects'}</div>
        <div class="m-actions">
          <button class="btn tiny" data-act="edit">Edit</button>
          <button class="btn tiny danger" data-act="del">Delete</button>
        </div>`;
      card.querySelector('[data-act="edit"]').addEventListener('click', () => openThemeModal(th));
      card.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm(`Delete theme "${th.name}"? Parties using it switch to the party theme.`)) return;
        api(`/api/themes/${th.id}`, { method: 'DELETE' }).then(() => toast('Theme deleted')).catch(e => toast(e.message, true));
      });
      list.appendChild(card);
    }
  }

  let editingThemeId = null;
  function openThemeModal(th) {
    editingThemeId = th ? th.id : null;
    $('themeModalTitle').textContent = th ? `Edit "${th.name}"` : 'New theme';
    $('thName').value = th ? th.name : '';
    $('thBg1').value = th ? th.bg[0] : '#1d7a3e';
    $('thBg2').value = th ? (th.bg[1] || th.bg[0]) : '#0b3d20';
    $('thFill').value = th ? th.headline.fill : '#ffffff';
    $('thStroke').value = th ? th.headline.stroke : '#1d7a3e';
    const conf = th ? th.confetti : [];
    $('thC1').value = conf[0] || '#ffffff';
    $('thC2').value = conf[1] || '#ffd93b';
    $('thC3').value = conf[2] || '#2ecc71';
    $('thEmojis').value = th ? (th.emojis || '') : '';
    const els = th ? (th.elements || []) : [];
    $('thSparkles').checked = els.includes('sparkles');
    $('thBalloons').checked = els.includes('balloons');
    $('thDots').checked = els.includes('dots');
    $('thBursts').checked = els.includes('bursts');
    $('themeError').textContent = '';
    $('themeModal').classList.remove('hidden');
  }
  $('addThemeBtn').addEventListener('click', () => openThemeModal(null));
  $('themeCancel').addEventListener('click', () => $('themeModal').classList.add('hidden'));
  $('themeSave').addEventListener('click', async () => {
    const elements = [];
    if ($('thSparkles').checked) elements.push('sparkles');
    if ($('thBalloons').checked) elements.push('balloons');
    if ($('thDots').checked) elements.push('dots');
    if ($('thBursts').checked) elements.push('bursts');
    try {
      await api('/api/themes', {
        method: 'POST',
        body: JSON.stringify({
          id: editingThemeId,
          name: $('thName').value,
          bg: [$('thBg1').value, $('thBg2').value],
          headline: { fill: $('thFill').value, stroke: $('thStroke').value },
          confetti: [$('thC1').value, $('thC2').value, $('thC3').value],
          emojis: $('thEmojis').value,
          elements
        })
      });
      $('themeModal').classList.add('hidden');
      toast('Theme saved — try it with 🎂 Test on any TV');
    } catch (err) { $('themeError').textContent = err.message; }
  });

  // ---------- media picker modal ----------
  let pickerSave = null;
  function openPicker(title, selectedIds, onSave) {
    $('pickerTitle').textContent = title;
    const list = $('pickerList');
    list.innerHTML = '';
    let order = [...selectedIds];   // selection order = play order
    if (state.media.length === 0) list.innerHTML = '<p class="hint">Upload media first.</p>';
    const groups = mediaGroups();
    for (const g of groups) {
      if (g.name && groups.length > 1) {
        const head = document.createElement('div');
        head.className = 'sheet-label';
        head.style.margin = '8px 0 2px';
        head.textContent = `📁 ${g.name}`;
        list.appendChild(head);
      }
      for (const m of g.items) {
      const item = document.createElement('label');
      item.className = 'picker-item';
      item.innerHTML = `
        <input type="checkbox" ${order.includes(m.id) ? 'checked' : ''}>
        <span class="order"></span>
        <span class="p-label">${esc(m.label)}</span>
        <span class="hint">${fmtSize(m.size)}</span>`;
      const cb = item.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) order.push(m.id);
        else order = order.filter(id => id !== m.id);
        refreshOrders();
      });
      item.dataset.mediaId = m.id;
      list.appendChild(item);
      }
    }
    function refreshOrders() {
      for (const item of list.querySelectorAll('.picker-item')) {
        const idx = order.indexOf(item.dataset.mediaId);
        item.classList.toggle('checked', idx !== -1);
        item.querySelector('.order').textContent = idx + 1;
      }
    }
    refreshOrders();
    pickerSave = () => onSave(order);
    $('pickerModal').classList.remove('hidden');
  }
  $('pickerSave').addEventListener('click', () => { if (pickerSave) pickerSave(); $('pickerModal').classList.add('hidden'); });
  $('pickerCancel').addEventListener('click', () => $('pickerModal').classList.add('hidden'));

  $('assignAllBtn').addEventListener('click', () => {
    // Pre-check items that are currently on every TV.
    const common = state.media.filter(m => state.tvs.length > 0 &&
      state.tvs.every(t => t.assignedMediaIds.includes(m.id))).map(m => m.id);
    openPicker('Playlist for ALL TVs', common, ids =>
      api('/api/assign-all', { method: 'POST', body: JSON.stringify({ mediaIds: ids }) })
        .then(() => toast('All TVs updated')).catch(e => toast(e.message, true)));
  });

  // ---------- uploads ----------
  // One shared queue: files dropped while an upload is running join it instead
  // of racing a second chain over the same progress bar.
  const uploadQueue = [];
  let uploadActive = false, uploadDone = 0, uploadFailed = [];

  function uploadFiles(files) {
    const accepted = [...files].filter(f => /\.(mp4|m4v|webm|mov|jpg|jpeg|png|gif|webp)$/i.test(f.name));
    if (accepted.length === 0) { toast('Accepted: video (.mp4, .webm, .mov) or photos (.jpg, .png, .gif, .webp)', true); return; }
    uploadQueue.push(...accepted);
    if (!uploadActive) { uploadActive = true; uploadDone = 0; uploadFailed = []; uploadNext(); }
  }

  function uploadNext() {
    const progressBox = $('uploadProgress');
    const file = uploadQueue.shift();
    if (!file) {
      uploadActive = false;
      progressBox.classList.add('hidden');
      if (uploadFailed.length === 0) toast(`Uploaded ${uploadDone} file${uploadDone === 1 ? '' : 's'}`);
      else toast(`Uploaded ${uploadDone}, FAILED ${uploadFailed.length}: ${uploadFailed.join('; ')}`, true);
      return;
    }
    progressBox.classList.remove('hidden');
    $('uploadLabel').textContent = `${file.name} (${uploadQueue.length} more queued)`;
    const form = new FormData();
    // folder must precede the file so the server sees it during upload parsing
    if (currentFolder !== 'all') form.append('folderId', currentFolder);
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) $('uploadBar').style.width = (e.loaded / e.total * 100).toFixed(1) + '%';
    };
    xhr.onload = () => {
      if (xhr.status === 200) uploadDone++;
      else {
        let msg = 'upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        uploadFailed.push(`${file.name} (${msg})`);
      }
      $('uploadBar').style.width = '0%';
      uploadNext();
    };
    xhr.onerror = () => { uploadFailed.push(`${file.name} (network error)`); uploadNext(); };
    xhr.send(form);
  }

  $('mediaFile').addEventListener('change', e => { uploadFiles(e.target.files); e.target.value = ''; });

  let dragDepth = 0;
  addEventListener('dragenter', e => { e.preventDefault(); if (token && ++dragDepth === 1) $('dropHint').classList.remove('hidden'); });
  addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.add('hidden'); } });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').classList.add('hidden');
    if (token && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  // ---------- ROLLER connection card ----------
  async function refreshRollerCard() {
    try {
      const s = await api('/api/roller/status');
      $('rollerStatusText').textContent = s.configured
        ? `Connected (${s.baseUrl}) — bookings sync into this list`
        : 'Not connected yet — add ROLLER_CLIENT_ID and ROLLER_CLIENT_SECRET to the server environment. Until then, use the test import below.';
      $('rollerCard').classList.toggle('connected', !!s.configured);
      $('rollerSyncBtn').disabled = !s.configured;
    } catch { /* card stays in its checking state; next login retries */ }
  }
  $('rollerSyncBtn').addEventListener('click', async () => {
    try {
      const r = await api('/api/roller/sync', { method: 'POST' });
      toast(`ROLLER sync: ${r.imported} new, ${r.updated} updated` +
        (r.errors?.length ? ` — ${r.errors.length} problem(s)` : ''));
    } catch (err) { toast(err.message, true); }
  });

  // ---------- TEMPORARY test-booking import (stand-in for ROLLER) ----------
  $('testCsvFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await api('/api/test-bookings/csv', { method: 'POST', body: form });
      const box = $('csvReport');
      box.classList.remove('hidden');
      const head = res.imported > 0
        ? `<span class="ok">Imported ${res.imported} part${res.imported === 1 ? 'y' : 'ies'} from the booking text.</span>`
        : '<span class="warn">Nothing imported — the existing schedule was left untouched.</span>';
      const parsedLines = (res.parsed || []).map(p =>
        `<span class="${p.confidence === 'high' ? 'ok' : 'warn'}">“${esc(p.byline)}” → ${esc(p.name)}${p.age ? ', turning ' + p.age : ''}` +
        `${p.confidence === 'high' ? '' : ' — ⚠ check this one'}</span>`).join('<br>');
      const errLines = res.errors.map(er => `<span class="warn">Line ${er.line}: ${esc(er.error)}</span>`).join('<br>');
      box.innerHTML = head + (parsedLines ? '<br>' + parsedLines : '') + (errLines ? '<br>' + errLines : '');
      toast(res.imported > 0 ? `Imported ${res.imported} — review names below` : 'Nothing imported', res.imported === 0);
    } catch (err) { toast(err.message, true); }
  });

  // ---------- manual event modal ----------
  $('addEventBtn').addEventListener('click', () => {
    const tvSel = $('evTv');
    tvSel.innerHTML = state.tvs.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    const customOpts = (state.settings.customThemes || [])
      .map(c => `<option value="custom:${c.id}">🎨 ${esc(c.name)}</option>`).join('');
    $('evTheme').innerHTML = `
      <option value="party">🎉 Party (default)</option>
      <option value="superhero">🦸 Superhero</option>
      <option value="princess">👑 Princess</option>
      <option value="space">🚀 Space</option>
      <option value="ninja">🥷 Ninja</option>` + customOpts;
    const mediaSel = $('evMedia');
    mediaSel.innerHTML = '<option value="">Use the theme above</option>' +
      state.media.filter(m => m.type === 'video')
        .map(m => `<option value="${esc(m.label)}">${esc(m.label)}</option>`).join('');
    $('evTheme').value = 'party';
    const now = new Date(Date.now() + 10 * 60000);
    now.setSeconds(0, 0);
    $('evStart').value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('evName').value = '';
    $('evAge').value = '';
    $('evMessage').value = '';
    $('evDuration').value = '5';
    $('eventError').textContent = '';
    $('eventModal').classList.remove('hidden');
  });
  $('eventCancel').addEventListener('click', () => $('eventModal').classList.add('hidden'));
  $('eventSave').addEventListener('click', async () => {
    try {
      await api('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          tvId: $('evTv').value,
          name: $('evName').value,
          age: $('evAge').value || null,
          message: $('evMessage').value || null,
          startsAt: new Date($('evStart').value).toISOString(),
          durationMin: parseFloat($('evDuration').value) || 5,
          theme: $('evTheme').value,
          mediaLabel: $('evMedia').value || null
        })
      });
      $('eventModal').classList.add('hidden');
      toast('Party added');
    } catch (err) { $('eventError').textContent = err.message; }
  });

  $('clearDoneBtn').addEventListener('click', () =>
    api('/api/events/clear-done', { method: 'POST' }).then(() => toast('Cleared')).catch(e => toast(e.message, true)));

  // ---------- preview modal ----------
  $('previewClose').addEventListener('click', () => {
    $('previewVideo').pause();
    $('previewVideo').removeAttribute('src');
    $('previewVideo').load();
    $('previewImage').removeAttribute('src');
    $('previewModal').classList.add('hidden');
  });

  // ---------- day start / end ----------
  $('startDayBtn').addEventListener('click', () =>
    api('/api/day/start', { method: 'POST' }).then(() => toast('Day started — all screens on')).catch(e => toast(e.message, true)));
  $('endDayBtn').addEventListener('click', () => {
    if (!confirm(`End the day? All ${state?.tvs.length ?? ''} screens go dark until you start the day again.`)) return;
    api('/api/day/end', { method: 'POST' }).then(() => toast('Day ended — screens off')).catch(e => toast(e.message, true));
  });

  // ---------- boot ----------
  if (token) enterApp(); else $('login').classList.remove('hidden');
})();
