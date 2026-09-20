/* ParkCast control dashboard */
(() => {
  const $ = id => document.getElementById(id);
  // Read the current key, falling back to (and migrating) the pre-rename one
  // so the rebrand never logs anyone out.
  let token = localStorage.getItem('parkcast.token') || localStorage.getItem('skyzone.token') || null;
  if (token) { try { localStorage.setItem('parkcast.token', token); } catch {} }
  let state = null;   // latest server snapshot
  let me = null;      // who is signed in: { email, name, role, venueName }
  // Staff run the day; deleting and replacing things is owner work. Until the
  // role is known we render as owner — the server enforces it regardless.
  const isOwner = () => !me || me.role !== 'staff';
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
    // A stale toast (or a filled signup form with a typed password) must not
    // survive into the next person's session on a shared front-desk computer.
    clearTimeout(toastTimer);
    $('toast').classList.add('hidden');
    $('signinForm').reset();
    $('signupForm').reset();
    showAuthTab('signin');
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  }

  // Sign in / Sign up tabs; /dashboard/#signup preselects the signup form.
  function showAuthTab(which) {
    $('tabSignin').classList.toggle('active', which === 'signin');
    $('tabSignup').classList.toggle('active', which === 'signup');
    $('signinForm').classList.toggle('hidden', which !== 'signin');
    $('signupForm').classList.toggle('hidden', which !== 'signup');
    $('loginError').textContent = '';
  }
  $('tabSignin').addEventListener('click', () => showAuthTab('signin'));
  $('tabSignup').addEventListener('click', () => showAuthTab('signup'));
  if (location.hash === '#signup') showAuthTab('signup');

  async function authenticate(path, body) {
    $('loginError').textContent = '';
    try {
      const res = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      token = data.token;
      localStorage.setItem('parkcast.token', token);
      // Drop the #signup/#signin entry hash so later reloads and sign-outs
      // start from the normal sign-in tab, not the landing-page deep link.
      if (location.hash) history.replaceState(null, '', location.pathname);
      enterApp();
    } catch (err) {
      $('loginError').textContent = err.message;
    }
  }
  $('signinForm').addEventListener('submit', e => {
    e.preventDefault();
    authenticate('/api/signin', { email: $('siEmail').value, password: $('siPassword').value });
  });
  $('signupForm').addEventListener('submit', e => {
    e.preventDefault();
    authenticate('/api/signup', {
      venue: $('suVenue').value, name: $('suName').value,
      email: $('suEmail').value, password: $('suPassword').value
    });
  });

  async function enterApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('playerUrl').textContent = location.origin + '/player/';
    try {
      state = await api('/api/state');
      render();
    } catch { return; }
    // The Team page (owner portal) only exists for owners.
    try { me = await api('/api/me'); } catch { me = null; }
    $('teamTab').classList.toggle('hidden', !(me && me.role === 'owner'));
    render(); // re-render now that the role is known (staff lose delete controls)
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
      if (btn.dataset.tab === 'team') renderTeam(); // not in the live snapshot — fetched on entry
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
    $('studioCount').textContent = state.media.filter(m => m.type === 'comp' || m.type === 'slide').length;
    $('dayState').textContent = state.settings.dayStarted ? 'Day running' : 'Day ended — screens off';
    $('venueTag').textContent = state.settings.venueName || '';
    $('venueTagTop').textContent = state.settings.venueName || '';
    renderTvs();
    renderMedia();
    renderStudio();
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
    // Photos show themselves; videos show their first frame; slides and
    // designs render live as scaled-down layouts.
    if (m.type === 'comp') {
      const c = m.comp || { bg: { colors: ['#333333'] }, elements: [] };
      const colors = c.bg.colors || ['#333333'];
      const bg = colors.length > 1 ? `linear-gradient(135deg, ${esc(colors[0])}, ${esc(colors[1])})` : esc(colors[0]);
      const inner = (c.elements || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0)).map(e => {
        const pos = `position:absolute;left:${+e.x}%;top:${+e.y}%;width:${+e.w}%;height:${+e.h}%;${+e.rot ? `transform:rotate(${+e.rot}deg);` : ''}`;
        if (e.type === 'text') {
          return `<div style="${pos}font-size:8px;font-weight:${+e.weight || 700};color:${esc(e.color)};overflow:hidden;text-align:${esc(e.align || 'center')};${e.boxBg ? `background:${esc(e.boxBg)};border-radius:2px;` : ''}">${esc(e.text)}</div>`;
        }
        if (e.type === 'box') return `<div style="${pos}background:${esc(e.color)};border-radius:2px"></div>`;
        const mm = state.media.find(x => x.id === e.mediaId);
        if (!mm || !mm.url) return '';
        const fit = e.fit === 'contain' ? 'contain' : 'cover';
        return e.type === 'image'
          ? `<img src="${esc(mm.url)}" style="${pos}object-fit:${fit}" loading="lazy" alt="">`
          : `<video src="${esc(mm.url)}" style="${pos}object-fit:${fit}" preload="metadata" muted playsinline></video>`;
      }).join('');
      return `<div class="${cls}" style="position:relative;overflow:hidden;background:${bg}">${inner}</div>`;
    }
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
          <div class="tv-head"><span class="tv-name" style="flex:1">New screen</span></div>
          <div class="tv-badges">
            <span class="badge ${tv.online ? 'online' : 'offline'}">${tv.online ? 'ONLINE' : 'OFFLINE'}</span>
            <span class="badge bday">WAITING FOR APPROVAL</span>
          </div>
          <div class="tv-now">Pairing code on its screen: <strong>${esc(tv.pairCode || '?')}</strong></div>
          <div class="tv-actions">
            <button class="btn tiny primary" data-act="approve">✓ Approve</button>
            ${isOwner() ? '<button class="btn tiny danger" data-act="reject">✕ Reject</button>' : ''}
          </div>`;
        pend.querySelector('[data-act="approve"]').addEventListener('click', () =>
          api(`/api/tvs/${tv.id}/approve`, { method: 'POST' })
            .then(() => toast('Screen approved — name it and give it content')).catch(e => toast(e.message, true)));
        const rejectBtn = pend.querySelector('[data-act="reject"]');
        if (rejectBtn) rejectBtn.addEventListener('click', () =>
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
            ${isOwner() ? '<button class="btn tiny danger" data-act="forget" title="Forget this TV">✕</button>' : ''}
          </div>
        </div>
        <div class="tv-badges">
          <span class="badge ${tv.online ? 'online' : 'offline'}">${tv.online ? 'ONLINE' : 'OFFLINE'}</span>
          ${tv.power === 'off' ? '<span class="badge off">SCREEN OFF</span>' : ''}
          ${tv.override ? `<span class="badge bday">PARTY · ${esc(tv.override.name)}</span>` : ''}
        </div>
        <div class="tv-now">${tv.power === 'off' ? 'Screen off' :
          tv.override ? `Birthday takeover until ${fmtTime(tv.override.endsAt)}` :
          pl ? `Playlist: <span class="playing">${esc(pl.name)}</span>` :
          playlistNames.length ? `Loop: <span class="playing">${esc(playlistNames.join(' → '))}</span>` :
          'No media assigned'}</div>
        ${tv.override ? '<div class="tv-actions"><button class="btn tiny" data-act="clear">Stop takeover</button></div>' : ''}
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

      const clearBtn = card.querySelector('[data-act="clear"]');
      if (clearBtn) clearBtn.addEventListener('click', () =>
        api(`/api/tvs/${tv.id}/clear-override`, { method: 'POST' }).catch(e => toast(e.message, true)));

      const forgetBtn = card.querySelector('[data-act="forget"]');
      if (forgetBtn) forgetBtn.addEventListener('click', () => {
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

    mkChip(`All media (${state.media.length})`, currentFolder === 'all', () => { currentFolder = 'all'; renderMedia(); });
    for (const f of folders) {
      const count = state.media.filter(m => m.folderId === f.id).length;
      const active = currentFolder === f.id;
      mkChip(`${f.name} (${count})`, active, () => { currentFolder = f.id; renderMedia(); });
      if (active) {
        const ren = document.createElement('button');
        ren.className = 'btn tiny';
        ren.textContent = 'Edit';
        ren.title = 'Rename folder';
        ren.addEventListener('click', () => {
          const name = prompt('Folder name:', f.name);
          if (!name) return;
          api('/api/folders', { method: 'POST', body: JSON.stringify({ id: f.id, name }) })
            .then(() => toast('Folder renamed')).catch(e => toast(e.message, true));
        });
        bar.appendChild(ren);
        if (isOwner()) {
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
    }
    const add = document.createElement('button');
    add.className = 'btn tiny';
    add.textContent = '+ New folder';
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
      const typeBadge = m.type === 'comp' ? 'DESIGN' : m.type === 'slide' ? 'SLIDE' : m.type === 'image' ? 'PHOTO' : 'VIDEO';
      const folderOpts = (state.folders || []).length
        ? `<label class="menu-row">Folder <select class="m-folder">
            <option value="">No folder</option>
            ${(state.folders || []).map(f => `<option value="${esc(f.id)}" ${m.folderId === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
          </select></label>` : '';
      card.innerHTML = `
        <div class="thumb-wrap">${thumbHtml(m)}<span class="type-badge">${typeBadge}</span></div>
        <div class="m-row">
          <input class="m-label" value="${esc(m.label)}" title="Click to rename">
          <div class="kebab">
            <button class="btn tiny kebab-btn" title="More actions" aria-label="More actions">⋯</button>
            <div class="menu hidden">
              ${m.type === 'comp' ? '<button class="menu-item" data-act="editcomp">Edit design</button>' :
                m.type === 'slide' ? '<button class="menu-item" data-act="editslide">Edit slide</button>' :
                `<button class="menu-item" data-act="preview">${m.type === 'image' ? 'View' : 'Preview'}</button>`}
              ${isOwner() && (m.type === 'image' || m.type === 'video') ? '<button class="menu-item" data-act="replace">Replace file</button>' : ''}
              <button class="menu-item" data-act="all">Apply to all screens</button>
              ${folderOpts}
              ${isOwner() ? '<button class="menu-item danger" data-act="del">Delete</button>' : ''}
            </div>
          </div>
        </div>
        <div class="m-meta">${(m.type === 'slide' || m.type === 'comp') ? 'made in the dashboard' : `${fmtSize(m.size)} · uploaded ${fmtTime(m.uploadedAt)}`} · ${usedBy} screen${usedBy === 1 ? '' : 's'} · ${inPlaylists} playlist${inPlaylists === 1 ? '' : 's'}</div>`;

      // Three-dot menu: hidden until clicked, one open at a time.
      const kebabBtn = card.querySelector('.kebab-btn');
      const menu = card.querySelector('.menu');
      kebabBtn.addEventListener('click', e => {
        e.stopPropagation();
        const wasOpen = !menu.classList.contains('hidden');
        closeAllMenus();
        if (!wasOpen) menu.classList.remove('hidden');
      });
      menu.addEventListener('click', e => {
        if (e.target.closest('.menu-item')) menu.classList.add('hidden');
        e.stopPropagation();
      });

      const label = card.querySelector('.m-label');
      label.addEventListener('change', () =>
        api(`/api/media/${m.id}`, { method: 'PATCH', body: JSON.stringify({ label: label.value }) })
          .then(() => toast('Renamed')).catch(e => toast(e.message, true)));
      label.addEventListener('keydown', e => { if (e.key === 'Enter') label.blur(); });

      const folderSel = card.querySelector('.m-folder');
      if (folderSel) folderSel.addEventListener('change', () =>
        api(`/api/media/${m.id}`, { method: 'PATCH', body: JSON.stringify({ folderId: folderSel.value || null }) })
          .then(() => toast(folderSel.value ? 'Moved to folder' : 'Moved out of folder'))
          .catch(e => toast(e.message, true)));

      const editSlideBtn = card.querySelector('[data-act="editslide"]');
      if (editSlideBtn) editSlideBtn.addEventListener('click', () => openSlideModal(m));

      const editCompBtn = card.querySelector('[data-act="editcomp"]');
      if (editCompBtn) editCompBtn.addEventListener('click', () => openCompModal(m));

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
        if (!confirm(`Replace every screen's playlist with just "${m.label}"?`)) return;
        api('/api/assign-all', { method: 'POST', body: JSON.stringify({ mediaIds: [m.id] }) })
          .then(() => toast('Now playing on all screens')).catch(e => toast(e.message, true));
      });

      const delBtn = card.querySelector('[data-act="del"]');
      if (delBtn) delBtn.addEventListener('click', () => {
        if (!confirm(`Delete "${m.label}"? It will be removed from every screen.`)) return;
        api(`/api/media/${m.id}`, { method: 'DELETE' }).then(() => toast('Deleted')).catch(e => toast(e.message, true));
      });

      list.appendChild(card);
    }
  }

  // Studio: everything made inside the system (designs + slides), minimal chrome.
  function renderStudio() {
    const list = $('studioList');
    list.innerHTML = '';
    const made = state.media.filter(m => m.type === 'comp' || m.type === 'slide');
    if (made.length === 0) {
      list.innerHTML = '<p class="hint">Nothing here yet.</p>';
      return;
    }
    for (const m of made) {
      const card = document.createElement('div');
      card.className = 'media-card studio-card';
      card.innerHTML = `
        ${thumbHtml(m)}
        <div class="m-row">
          <input class="m-label" value="${esc(m.label)}" title="Rename">
          <button class="btn small" data-act="edit">Edit</button>
        </div>`;
      const label = card.querySelector('.m-label');
      label.addEventListener('change', () =>
        api(`/api/media/${m.id}`, { method: 'PATCH', body: JSON.stringify({ label: label.value }) })
          .then(() => toast('Renamed')).catch(e => toast(e.message, true)));
      label.addEventListener('keydown', e => { if (e.key === 'Enter') label.blur(); });
      card.querySelector('[data-act="edit"]').addEventListener('click', () =>
        m.type === 'comp' ? openCompModal(m) : openSlideModal(m));
      list.appendChild(card);
    }
  }

  function closeAllMenus() {
    document.querySelectorAll('.kebab .menu').forEach(mn => mn.classList.add('hidden'));
  }
  document.addEventListener('click', closeAllMenus);

  function themeOptionsHtml(selected) {
    const builtins = ['party', 'superhero', 'princess', 'space', 'ninja']
      .map(t => `<option value="${t}" ${selected === t ? 'selected' : ''}>${t}</option>`);
    const customs = (state.settings.customThemes || [])
      .map(c => `<option value="custom:${c.id}" ${selected === `custom:${c.id}` ? 'selected' : ''}>${esc(c.name)}</option>`);
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
          ${needsCheck ? '<span class="parse-chip warn" title="The booking text was unclear — check the name and age">check</span>'
            : (ev.parsed ? '<span class="parse-chip" title="Read automatically from the booking text — still editable">auto</span>' : '')}</td>
        <td>${editable
          ? `<input class="ev-edit ev-name" value="${esc(ev.name)}" maxlength="60" aria-label="Birthday name">`
          : `<strong>${esc(ev.name)}</strong>`}</td>
        <td>${editable
          ? `<input class="ev-edit ev-age" type="number" min="1" max="99" value="${ev.age ?? ''}" placeholder="—" aria-label="Age">`
          : `${ev.age ?? '—'}`}</td>
        <td>${editable
          ? `<select class="ev-edit ev-theme" aria-label="Theme">${themeOptionsHtml(ev.theme || 'party')}</select>`
          : esc(themeDisplayName(ev.theme))}</td>
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

  // ---------- layout designer ----------
  // A design is positioned elements (text / photo / video / box) over a
  // background, edited on a 16:9 canvas that IS the live preview. Fonts are
  // stored as % of screen height so the TV render matches exactly.
  let compEditing = null;   // { id, label, durationSec, bg:[c1,c2], elements:[] }
  let compSel = -1;
  let compUndoStack = [];

  function compSnapshot() {
    compUndoStack.push(JSON.stringify(compEditing.elements));
    if (compUndoStack.length > 40) compUndoStack.shift();
  }
  function compUndo() {
    const prev = compUndoStack.pop();
    if (!prev) return;
    compEditing.elements = JSON.parse(prev);
    if (compSel >= compEditing.elements.length) compSel = compEditing.elements.length - 1;
    compRender();
  }

  function openCompModal(m) {
    compEditing = m
      ? { id: m.id, label: m.label, durationSec: m.durationSec || 10,
          bg: [...m.comp.bg.colors], elements: JSON.parse(JSON.stringify(m.comp.elements)) }
      : { id: null, label: '', durationSec: 10, bg: ['#18181b', '#3f3f46'], elements: [] };
    if (compEditing.bg.length < 2) compEditing.bg.push(compEditing.bg[0]);
    compSel = compEditing.elements.length ? 0 : -1;
    compUndoStack = [];
    $('compTitle').textContent = m ? `Edit "${m.label}"` : 'New design';
    $('compLabel').value = compEditing.label;
    $('compBg1').value = compEditing.bg[0];
    $('compBg2').value = compEditing.bg[1];
    $('compError').textContent = '';
    $('compModal').classList.remove('hidden');
    compRender();
  }

  function compCanvasBg() {
    const [a, b] = compEditing.bg;
    $('compCanvas').style.background = a === b ? a : `linear-gradient(135deg, ${a}, ${b})`;
  }

  function compRender() {
    const cnv = $('compCanvas');
    cnv.innerHTML = '';
    compCanvasBg();
    const H = cnv.getBoundingClientRect().height || 400;
    compEditing.elements.forEach((e, i) => {
      const d = document.createElement('div');
      d.className = 'comp-el' + (i === compSel ? ' sel' : '');
      d.dataset.idx = i;
      d.style.left = e.x + '%'; d.style.top = e.y + '%';
      d.style.width = e.w + '%'; d.style.height = e.h + '%';
      d.style.zIndex = 1 + (e.z || 0);
      if (e.rot) d.style.transform = `rotate(${e.rot}deg)`;
      if (e.type === 'text') {
        d.textContent = e.text;
        d.style.fontSize = (e.size / 100 * H) + 'px';
        d.style.fontWeight = e.weight;
        d.style.color = e.color;
        d.style.display = 'flex'; d.style.flexDirection = 'column'; d.style.justifyContent = 'center';
        d.style.textAlign = e.align;
        d.style.alignItems = e.align === 'left' ? 'flex-start' : e.align === 'right' ? 'flex-end' : 'center';
        d.style.lineHeight = '1.15'; d.style.overflow = 'hidden';
        if (e.boxBg) { d.style.background = e.boxBg; d.style.borderRadius = '6px'; d.style.padding = '0 8px'; }
      } else if (e.type === 'box') {
        d.style.background = e.color;
        d.style.borderRadius = (e.radius / 100 * H) + 'px';
      } else {
        const mm = state.media.find(x => x.id === e.mediaId);
        const media = document.createElement(e.type === 'image' ? 'img' : 'video');
        if (mm && mm.url) media.src = mm.url;
        if (e.type === 'video') { media.muted = true; media.preload = 'metadata'; }
        media.style.cssText = `width:100%;height:100%;object-fit:${e.fit};pointer-events:none;border-radius:${e.radius / 100 * H}px;display:block`;
        d.appendChild(media);
      }
      // Selecting and dragging never rebuilds the canvas — the pressed node
      // must survive its own drag.
      d.addEventListener('pointerdown', ev => {
        if (ev.target.classList.contains('resize')) return;
        if (compSel !== i) {
          compSel = i;
          cnv.querySelectorAll('.comp-el').forEach(x => x.classList.remove('sel'));
          d.classList.add('sel');
          compRenderPanel();
        }
        const rect = cnv.getBoundingClientRect();
        const startX = ev.clientX, startY = ev.clientY, ox = e.x, oy = e.y;
        let moved = false;
        const move = mv => {
          const dx = (mv.clientX - startX) / rect.width * 100;
          const dy = (mv.clientY - startY) / rect.height * 100;
          if (!moved && Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) return;
          if (!moved) { compSnapshot(); moved = true; }
          e.x = Math.min(Math.max(ox + dx, 0), 98);
          e.y = Math.min(Math.max(oy + dy, 0), 98);
          // Snap to the canvas center lines.
          if (Math.abs(e.x + e.w / 2 - 50) < 1.2) e.x = 50 - e.w / 2;
          if (Math.abs(e.y + e.h / 2 - 50) < 1.2) e.y = 50 - e.h / 2;
          d.style.left = e.x + '%'; d.style.top = e.y + '%';
        };
        const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
        ev.preventDefault();
        cnv.focus();
      });
      // Four mutable corners: each drags its own edge pair.
      const clampP = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
      for (const corner of ['nw', 'ne', 'sw', 'se']) {
        const rz = document.createElement('div');
        rz.className = 'resize rz-' + corner;
        rz.addEventListener('pointerdown', ev => {
          ev.stopPropagation(); ev.preventDefault();
          const rect = cnv.getBoundingClientRect();
          const startX = ev.clientX, startY = ev.clientY;
          const ox = e.x, oy = e.y, ow = e.w, oh = e.h;
          compSnapshot();
          const move = mv => {
            const dx = (mv.clientX - startX) / rect.width * 100;
            const dy = (mv.clientY - startY) / rect.height * 100;
            if (corner.includes('e')) e.w = clampP(ow + dx, 2, 100);
            if (corner.includes('s')) e.h = clampP(oh + dy, 2, 100);
            if (corner.includes('w')) { e.w = clampP(ow - dx, 2, 100); e.x = clampP(ox + (ow - e.w), 0, 98); }
            if (corner.includes('n')) { e.h = clampP(oh - dy, 2, 100); e.y = clampP(oy + (oh - e.h), 0, 98); }
            d.style.left = e.x + '%'; d.style.top = e.y + '%';
            d.style.width = e.w + '%'; d.style.height = e.h + '%';
          };
          const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
          addEventListener('pointermove', move);
          addEventListener('pointerup', up);
        });
        d.appendChild(rz);
      }
      cnv.appendChild(d);
    });
    compRenderPanel();
  }

  function compRenderPanel() {
    const p = $('compPanel');
    p.innerHTML = '';
    const e = compEditing.elements[compSel];
    if (!e) {
      p.innerHTML = '<span class="hint">Add an element with the buttons above, or click one on the canvas to edit it here.</span>';
      return;
    }
    const mk = html => { const w = document.createElement('div'); w.innerHTML = html; return w.firstElementChild; };
    const commit = () => { compRender(); };

    if (e.type === 'text') {
      const ta = mk(`<label>Text<textarea rows="2" maxlength="300"></textarea></label>`);
      ta.querySelector('textarea').value = e.text;
      // Live path: typing updates the canvas node directly, no rebuild.
      ta.querySelector('textarea').addEventListener('input', ev => {
        e.text = ev.target.value;
        const node = $('compCanvas').querySelector(`[data-idx="${compSel}"]`);
        if (node) { node.childNodes[0] && node.childNodes[0].nodeType === 3 ? node.childNodes[0].nodeValue = e.text : node.insertBefore(document.createTextNode(e.text), node.firstChild); }
      });
      ta.querySelector('textarea').addEventListener('focus', compSnapshot, { once: true });
      p.appendChild(ta);
      const size = mk(`<label>Text size <input type="range" min="2" max="25" step="0.5"></label>`);
      size.querySelector('input').value = e.size;
      size.querySelector('input').addEventListener('input', ev => {
        e.size = parseFloat(ev.target.value);
        const node = $('compCanvas').querySelector(`[data-idx="${compSel}"]`);
        if (node) node.style.fontSize = (e.size / 100 * $('compCanvas').getBoundingClientRect().height) + 'px';
      });
      p.appendChild(size);
      const row = mk(`<label>Style<div class="row2">
        <select data-k="weight"><option value="400">Regular</option><option value="700">Bold</option><option value="900">Heavy</option></select>
        <select data-k="align"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
      </div></label>`);
      row.querySelector('[data-k="weight"]').value = e.weight;
      row.querySelector('[data-k="align"]').value = e.align;
      row.querySelector('[data-k="weight"]').addEventListener('change', ev => { compSnapshot(); e.weight = +ev.target.value; commit(); });
      row.querySelector('[data-k="align"]').addEventListener('change', ev => { compSnapshot(); e.align = ev.target.value; commit(); });
      p.appendChild(row);
      const colors = mk(`<label>Text color / backing box<div class="row2">
        <input type="color" data-k="color"><input type="checkbox" data-k="hasbox" style="width:auto"><input type="color" data-k="boxbg">
      </div></label>`);
      colors.querySelector('[data-k="color"]').value = e.color;
      colors.querySelector('[data-k="hasbox"]').checked = !!e.boxBg;
      colors.querySelector('[data-k="boxbg"]').value = e.boxBg || '#000000';
      colors.querySelector('[data-k="color"]').addEventListener('change', ev => { compSnapshot(); e.color = ev.target.value; commit(); });
      colors.querySelector('[data-k="hasbox"]').addEventListener('change', ev => { compSnapshot(); e.boxBg = ev.target.checked ? colors.querySelector('[data-k="boxbg"]').value : null; commit(); });
      colors.querySelector('[data-k="boxbg"]').addEventListener('change', ev => { if (colors.querySelector('[data-k="hasbox"]').checked) { compSnapshot(); e.boxBg = ev.target.value; commit(); } });
      p.appendChild(colors);
    } else if (e.type === 'box') {
      const c = mk(`<label>Box color <input type="color"></label>`);
      c.querySelector('input').value = e.color;
      c.querySelector('input').addEventListener('change', ev => { compSnapshot(); e.color = ev.target.value; commit(); });
      p.appendChild(c);
      const r = mk(`<label>Rounded corners <input type="range" min="0" max="20" step="0.5"></label>`);
      r.querySelector('input').value = e.radius;
      r.querySelector('input').addEventListener('input', ev => { e.radius = parseFloat(ev.target.value); commit(); });
      p.appendChild(r);
    } else {
      const mm = state.media.find(x => x.id === e.mediaId);
      p.appendChild(mk(`<span class="hint">${e.type === 'image' ? 'Photo' : 'Video'}: <strong>${esc(mm ? mm.label : '(missing)')}</strong></span>`));
      const fit = mk(`<label>Fill <select><option value="cover">Fill the frame (crop)</option><option value="contain">Fit inside (bars)</option></select></label>`);
      fit.querySelector('select').value = e.fit;
      fit.querySelector('select').addEventListener('change', ev => { compSnapshot(); e.fit = ev.target.value; commit(); });
      p.appendChild(fit);
      const r = mk(`<label>Rounded corners <input type="range" min="0" max="20" step="0.5"></label>`);
      r.querySelector('input').value = e.radius;
      r.querySelector('input').addEventListener('input', ev => { e.radius = parseFloat(ev.target.value); commit(); });
      p.appendChild(r);
      const swap = mk(`<button class="btn small">Swap ${e.type === 'image' ? 'photo' : 'video'}</button>`);
      swap.addEventListener('click', () => compPick(e.type, mm2 => { compSnapshot(); e.mediaId = mm2.id; commit(); }));
      p.appendChild(swap);
    }

    const rot = mk(`<div class="row2">
      <button class="btn small" data-k="rot">Rotate</button>
      <button class="btn small" data-k="rot0">Straighten</button>
    </div>`);
    rot.querySelector('[data-k="rot"]').addEventListener('click', () => {
      compSnapshot(); e.rot = ((e.rot || 0) + 15) % 360; commit();
    });
    rot.querySelector('[data-k="rot0"]').addEventListener('click', () => {
      compSnapshot(); e.rot = 0; commit();
    });
    p.appendChild(rot);
    const layer = mk(`<label>Layer<div class="row2">
      <button class="btn small" data-k="back">Send back</button>
      <button class="btn small" data-k="fwd">Bring forward</button>
    </div></label>`);
    layer.querySelector('[data-k="back"]').addEventListener('click', () => { compSnapshot(); e.z = Math.max((e.z || 0) - 1, 0); commit(); });
    layer.querySelector('[data-k="fwd"]').addEventListener('click', () => { compSnapshot(); e.z = Math.min((e.z || 0) + 1, 20); commit(); });
    p.appendChild(layer);
    const acts = mk(`<div class="row2">
      <button class="btn small" data-k="dup">Duplicate</button>
      <button class="btn small danger" data-k="rm">Remove</button>
    </div>`);
    acts.querySelector('[data-k="dup"]').addEventListener('click', () => {
      compSnapshot();
      const copy = JSON.parse(JSON.stringify(e));
      copy.x = Math.min(copy.x + 3, 95); copy.y = Math.min(copy.y + 3, 95);
      compEditing.elements.push(copy);
      compSel = compEditing.elements.length - 1;
      compRender();
    });
    acts.querySelector('[data-k="rm"]').addEventListener('click', () => {
      compSnapshot();
      compEditing.elements.splice(compSel, 1);
      compSel = compEditing.elements.length ? Math.max(compSel - 1, 0) : -1;
      compRender();
    });
    p.appendChild(acts);
  }

  function compNextZ() {
    return Math.min(compEditing.elements.reduce((m2, e) => Math.max(m2, e.z || 0), 0) + 1, 20);
  }
  function compAdd(el) {
    compSnapshot();
    compEditing.elements.push(el);
    compSel = compEditing.elements.length - 1;
    compRender();
  }
  $('compAddText').addEventListener('click', () => compAdd({
    type: 'text', x: 10, y: 10, w: 80, h: 20, z: compNextZ(), rot: 0,
    text: 'Your text here', size: 8, weight: 700, color: '#ffffff', align: 'center', boxBg: null
  }));
  $('compAddBox').addEventListener('click', () => compAdd({
    type: 'box', x: 10, y: 10, w: 40, h: 30, z: compNextZ(), rot: 0, color: '#ea580c', radius: 2
  }));
  // Place media at its ORIGINAL aspect ratio: probe the file's natural size,
  // convert to canvas percentages (canvas is 16:9), scale to fit comfortably,
  // and center it — so it looks like the untouched original until edited.
  function compAddAtNaturalSize(mm, type) {
    const place = aspect => {
      let h = 55;
      let w = h * aspect * 9 / 16; // % width preserving real aspect on a 16:9 canvas
      if (w > 88) { h = h * 88 / w; w = 88; }
      if (h > 88) { w = w * 88 / h; h = 88; }
      w = Math.max(w, 4); h = Math.max(h, 4);
      compAdd({ type, x: 50 - w / 2, y: 50 - h / 2, w, h, z: compNextZ(), rot: 0,
        mediaId: mm.id, fit: 'cover', radius: 0 });
    };
    if (type === 'image') {
      const probe = new Image();
      probe.onload = () => place(probe.naturalWidth / probe.naturalHeight || 16 / 9);
      probe.onerror = () => place(16 / 9);
      probe.src = mm.url;
    } else {
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => place((probe.videoWidth / probe.videoHeight) || 16 / 9);
      probe.onerror = () => place(16 / 9);
      probe.src = mm.url;
    }
  }
  $('compAddImage').addEventListener('click', () =>
    compPick('image', mm => compAddAtNaturalSize(mm, 'image')));
  $('compAddVideo').addEventListener('click', () => {
    if (compEditing.elements.some(e => e.type === 'video')) { toast('One video per design — TV boxes can only decode one smoothly', true); return; }
    compPick('video', mm => compAddAtNaturalSize(mm, 'video'));
  });

  // Small picker for the designer: photos or videos only.
  function compPick(kind, cb) {
    const list = $('compPickList');
    list.innerHTML = '';
    $('compPickTitle').textContent = kind === 'image' ? 'Pick a photo' : 'Pick a video';
    const options = state.media.filter(m => m.type === kind);
    if (options.length === 0) {
      list.innerHTML = `<span class="hint">No ${kind === 'image' ? 'photos' : 'videos'} in the library yet — upload one first.</span>`;
    }
    for (const mm of options) {
      const item = document.createElement('div');
      item.className = 'picker-item';
      item.innerHTML = `${thumbHtml(mm, 'row-thumb')}<span class="p-label">${esc(mm.label)}</span>`;
      item.addEventListener('click', () => { $('compPickModal').classList.add('hidden'); cb(mm); });
      list.appendChild(item);
    }
    $('compPickModal').classList.remove('hidden');
  }
  $('compPickCancel').addEventListener('click', () => $('compPickModal').classList.add('hidden'));

  // Canvas keyboard: nudge, delete, undo.
  $('compCanvas').addEventListener('keydown', ev => {
    const e = compEditing && compEditing.elements[compSel];
    if (ev.key === 'z' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); compUndo(); return; }
    if (!e) return;
    const step = ev.shiftKey ? 2 : 0.5;
    let handled = true;
    if (ev.key === 'ArrowLeft') e.x = Math.max(e.x - step, 0);
    else if (ev.key === 'ArrowRight') e.x = Math.min(e.x + step, 98);
    else if (ev.key === 'ArrowUp') e.y = Math.max(e.y - step, 0);
    else if (ev.key === 'ArrowDown') e.y = Math.min(e.y + step, 98);
    else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      compSnapshot();
      compEditing.elements.splice(compSel, 1);
      compSel = compEditing.elements.length ? Math.max(compSel - 1, 0) : -1;
      compRender();
      return void ev.preventDefault();
    } else handled = false;
    if (handled) {
      ev.preventDefault();
      const node = $('compCanvas').querySelector(`[data-idx="${compSel}"]`);
      if (node) { node.style.left = e.x + '%'; node.style.top = e.y + '%'; }
    }
  });

  for (const id of ['compBg1', 'compBg2']) {
    $(id).addEventListener('input', () => {
      compEditing.bg = [$('compBg1').value, $('compBg2').value];
      compCanvasBg();
    });
  }
  $('addCompBtn').addEventListener('click', () => openCompModal(null));
  $('compCancel').addEventListener('click', () => $('compModal').classList.add('hidden'));
  $('compSave').addEventListener('click', async () => {
    try {
      await api('/api/comps', {
        method: 'POST',
        body: JSON.stringify({
          id: compEditing.id,
          label: $('compLabel').value,
          folderId: compEditing.id ? undefined : (currentFolder !== 'all' ? currentFolder : null),
          comp: { bg: { colors: compEditing.bg }, elements: compEditing.elements }
        })
      });
      $('compModal').classList.add('hidden');
      toast(compEditing.id ? 'Design updated — live on every screen using it' : 'Design created');
    } catch (err) { $('compError').textContent = err.message; }
  });

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
      card.innerHTML = `
        <div class="pl-name">${esc(p.name)}</div>
        <div class="m-meta">${enabled} of ${p.items.length} item${p.items.length === 1 ? '' : 's'} playing ·
          ${p.transition === 'fade' ? 'fade transition' : 'no transition'} · on ${p.usedBy} screen${p.usedBy === 1 ? '' : 's'}</div>
        <div class="m-actions">
          <button class="btn tiny" data-act="edit">Edit</button>
          <button class="btn tiny" data-act="all">Apply to ALL screens</button>
          ${isOwner() ? '<button class="btn tiny danger" data-act="del">Delete</button>' : ''}
        </div>`;
      card.querySelector('[data-act="edit"]').addEventListener('click', () => openPlaylistModal(p));
      card.querySelector('[data-act="all"]').addEventListener('click', () => {
        if (!confirm(`Play "${p.name}" on every TV?`)) return;
        api(`/api/playlists/${p.id}/assign-all`, { method: 'POST' })
          .then(() => toast(`"${p.name}" is now on all TVs`)).catch(e => toast(e.message, true));
      });
      const plDelBtn = card.querySelector('[data-act="del"]');
      if (plDelBtn) plDelBtn.addEventListener('click', () => {
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
        head.textContent = g.name;
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
      }).join('') || '<div class="cc-big" style="flex:1"></div>';
      const counts = { video: 0, image: 0, slide: 0 };
      for (const it of p.items) {
        let t = (state.media.find(m => m.id === it.mediaId) || {}).type;
        if (t === 'comp') t = 'slide'; // designs count as slides for the reader
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
        name: p.name,
        meta: `${p.items.length} item${p.items.length === 1 ? '' : 's'}${parts.length ? ' — ' + parts.join(', ') : ''}<br>` +
          `${p.transition === 'fade' ? 'fade transition' : 'no transition'} · on ${p.usedBy} TV${p.usedBy === 1 ? '' : 's'}`,
        actions: '<button class="btn tiny" data-edit>Edit playlist</button>'
      });
      card.querySelector('[data-edit]').addEventListener('click', () => {
        $('contentModal').classList.add('hidden');
        openPlaylistModal(p);
      });
    }

    makeCard({
      key: 'custom',
      ribbon: !tv.playlistId && tv.assignedMediaIds.length > 0,
      big: '',
      name: 'Custom selection…',
      meta: 'Hand-pick individual media for the chosen TVs — good for one-off setups.'
    });

    makeCard({
      key: 'blank',
      ribbon: !tv.playlistId && tv.assignedMediaIds.length === 0,
      big: '',
      name: 'Idle screen',
      meta: 'Show the standby screen — no media plays.'
    });

    const newCard = makeCard({
      key: 'new',
      big: '+',
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
        <strong>${esc(th.name)}</strong>
        <div class="theme-swatches">${swatches}</div>
        <div class="theme-emojis">${esc(th.emojis || '')}</div>
        <div class="m-meta">${(th.elements || []).join(', ') || 'no extra effects'}</div>
        <div class="m-actions">
          <button class="btn tiny" data-act="edit">Edit</button>
          ${isOwner() ? '<button class="btn tiny danger" data-act="del">Delete</button>' : ''}
        </div>`;
      card.querySelector('[data-act="edit"]').addEventListener('click', () => openThemeModal(th));
      const thDelBtn = card.querySelector('[data-act="del"]');
      if (thDelBtn) thDelBtn.addEventListener('click', () => {
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
      toast('Theme saved — pick it on any party');
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
        head.textContent = g.name;
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
      // Show the full sync report so problems are diagnosable, not hidden.
      const box = $('csvReport');
      box.classList.remove('hidden');
      const head = r.imported > 0
        ? `<span class="ok">Imported ${r.imported} booking${r.imported === 1 ? '' : 's'} from ROLLER.</span>`
        : '<span class="warn">Sync ran but imported nothing.</span>';
      const lines = (r.errors || []).map(er =>
        `<span class="warn">${esc(er.date ? er.date + ': ' : '')}${esc(er.error)}</span>`).join('<br>');
      box.innerHTML = head + (lines ? '<br>' + lines : '');
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
        `${p.confidence === 'high' ? '' : ' — check this one'}</span>`).join('<br>');
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
      .map(c => `<option value="custom:${c.id}">${esc(c.name)}</option>`).join('');
    $('evTheme').innerHTML = `
      <option value="party">Party (default)</option>
      <option value="superhero">Superhero</option>
      <option value="princess">Princess</option>
      <option value="space">Space</option>
      <option value="ninja">Ninja</option>` + customOpts;
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

  $('signoutBtn').addEventListener('click', () => logout());
  $('signoutBtnTop').addEventListener('click', () => logout());

  // ---------- Team (owner portal) ----------
  // Not part of the live snapshot: fetched when the page opens and after
  // every change, and only ever served to owners.
  async function renderTeam() {
    let members;
    try { members = (await api('/api/team')).members; }
    catch (err) { toast(err.message, true); return; }
    $('teamCount').textContent = members.length;
    const list = $('teamList');
    list.innerHTML = '';
    for (const m of members) {
      const row = document.createElement('div');
      row.className = 'team-row';
      row.innerHTML = `
        <div class="team-id">
          <b>${esc(m.name || m.email)}${m.you ? ' <span class="you-chip">you</span>' : ''}</b>
          <span class="team-mail">${esc(m.email)}</span>
        </div>
        <span class="role-chip ${m.role}">${m.role === 'owner' ? 'Owner' : 'Staff'}</span>
        ${m.you ? '' : `
        <div class="kebab">
          <button class="btn tiny kebab-btn" title="More actions" aria-label="More actions">⋯</button>
          <div class="menu hidden">
            <button class="menu-item" data-act="role">${m.role === 'owner' ? 'Make staff' : 'Make owner'}</button>
            <button class="menu-item" data-act="password">Reset password</button>
            <button class="menu-item danger" data-act="remove">Remove access</button>
          </div>
        </div>`}`;
      const kebabBtn = row.querySelector('.kebab-btn');
      if (kebabBtn) {
        const menu = row.querySelector('.menu');
        kebabBtn.addEventListener('click', e => {
          e.stopPropagation();
          const wasOpen = !menu.classList.contains('hidden');
          closeAllMenus();
          if (!wasOpen) menu.classList.remove('hidden');
        });
        menu.addEventListener('click', async e => {
          const act = e.target.dataset?.act;
          if (!act) return;
          closeAllMenus();
          try {
            if (act === 'role') {
              const next = m.role === 'owner' ? 'staff' : 'owner';
              await api(`/api/team/${m.id}`, { method: 'PATCH', body: JSON.stringify({ role: next }) });
              toast(`${m.name || m.email} is now ${next === 'owner' ? 'an owner' : 'staff'}`);
            } else if (act === 'password') {
              const pw = prompt(`New password for ${m.email} (8+ characters):`);
              if (!pw) return;
              await api(`/api/team/${m.id}`, { method: 'PATCH', body: JSON.stringify({ password: pw }) });
              toast('Password changed — they are signed out everywhere');
            } else if (act === 'remove') {
              if (!confirm(`Remove ${m.email}? They lose access immediately.`)) return;
              await api(`/api/team/${m.id}`, { method: 'DELETE' });
              toast('Access removed');
            }
          } catch (err) { toast(err.message, true); }
          renderTeam();
        });
      }
      list.appendChild(row);
    }
  }

  $('addMemberBtn').addEventListener('click', () => {
    $('memberForm').classList.toggle('hidden');
    if (!$('memberForm').classList.contains('hidden')) $('tmName').focus();
  });
  $('tmCancel').addEventListener('click', () => {
    $('memberForm').reset();
    $('memberForm').classList.add('hidden');
  });
  $('memberForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await api('/api/team', { method: 'POST', body: JSON.stringify({
        name: $('tmName').value, email: $('tmEmail').value,
        password: $('tmPassword').value, role: $('tmRole').value
      }) });
      $('memberForm').reset();
      $('memberForm').classList.add('hidden');
      toast(`${r.member.email} can sign in now`);
      renderTeam();
    } catch (err) { toast(err.message, true); }
  });

  $('claimBtn').addEventListener('click', () => {
    const code = prompt('Enter the 6-digit code shown on the TV:');
    if (!code) return;
    api('/api/tvs/claim', { method: 'POST', body: JSON.stringify({ code }) })
      .then(r => toast(`Screen added as ${r.tv.name} — rename it after its room`))
      .catch(e => toast(e.message, true));
  });

  // ---------- boot ----------
  if (token) enterApp(); else $('login').classList.remove('hidden');
})();
