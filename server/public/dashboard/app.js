/* Skyzone TV Control dashboard */
(() => {
  const $ = id => document.getElementById(id);
  let token = localStorage.getItem('skyzone.token') || null;
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
      localStorage.setItem('skyzone.token', token);
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
    if (e.target.matches?.('.tv-name, .m-label')) renderHeld = true;
  });
  document.addEventListener('focusout', e => {
    if (e.target.matches?.('.tv-name, .m-label')) {
      renderHeld = false;
      if (renderPending) { renderPending = false; setTimeout(render, 50); }
    }
  });

  function render() {
    if (!state) return;
    if (renderHeld) { renderPending = true; return; }
    $('tvCount').textContent = state.tvs.length;
    $('mediaCount').textContent = state.media.length;
    $('eventCount').textContent = state.events.filter(e => e.status !== 'done').length;
    $('themeCount').textContent = 5 + (state.settings.customThemes || []).length;
    $('dayState').textContent = state.settings.dayStarted ? 'Day running' : 'Day ended — screens off';
    renderTvs();
    renderMedia();
    renderEvents();
    renderThemes();
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
      const card = document.createElement('div');
      card.className = 'tv-card' + (tv.online ? '' : ' offline');
      const playlistNames = tv.assignedMediaIds
        .map(id => state.media.find(m => m.id === id)?.label).filter(Boolean);
      card.innerHTML = `
        <div class="tv-head">
          <input class="tv-name" value="${esc(tv.name)}" title="Click to rename">
        </div>
        <div class="tv-badges">
          <span class="badge ${tv.online ? 'online' : 'offline'}">${tv.online ? 'ONLINE' : 'OFFLINE'}</span>
          ${tv.power === 'off' ? '<span class="badge off">SCREEN OFF</span>' : ''}
          ${tv.override ? `<span class="badge bday">🎂 ${esc(tv.override.name)}</span>` : ''}
        </div>
        <div class="tv-now">${tv.power === 'off' ? 'Screen off' :
          tv.override ? `Birthday takeover until ${fmtTime(tv.override.endsAt)}` :
          playlistNames.length ? `Loop: <span class="playing">${esc(playlistNames.join(' → '))}</span>` :
          'No media assigned'}</div>
        <div class="tv-actions">
          <button class="btn tiny" data-act="media">Media…</button>
          <button class="btn tiny" data-act="power">${tv.power === 'on' ? 'Screen off' : 'Screen on'}</button>
          <button class="btn tiny" data-act="bday">🎂 Test</button>
          ${tv.override ? '<button class="btn tiny" data-act="clear">Stop takeover</button>' : ''}
          <button class="btn tiny danger" data-act="forget">✕</button>
        </div>`;

      const nameInput = card.querySelector('.tv-name');
      nameInput.addEventListener('change', () => {
        api(`/api/tvs/${tv.id}`, { method: 'PATCH', body: JSON.stringify({ name: nameInput.value }) })
          .then(() => toast('Renamed')).catch(e => toast(e.message, true));
      });
      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });

      card.querySelector('[data-act="media"]').addEventListener('click', () =>
        openPicker(`Playlist for ${tv.name}`, tv.assignedMediaIds, ids =>
          api(`/api/tvs/${tv.id}/assign`, { method: 'POST', body: JSON.stringify({ mediaIds: ids }) })
            .then(() => toast(`Updated ${tv.name}`)).catch(e => toast(e.message, true))));

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

  function renderMedia() {
    const list = $('mediaList');
    list.innerHTML = '';
    if (state.media.length === 0) {
      list.innerHTML = '<p class="hint">No media yet. Upload an MP4 to get started.</p>';
      return;
    }
    for (const m of state.media) {
      const isBday = state.settings.birthdayMediaId === m.id;
      const usedBy = state.tvs.filter(t => t.assignedMediaIds.includes(m.id)).length;
      const card = document.createElement('div');
      card.className = 'media-card';
      card.innerHTML = `
        <input class="m-label" value="${esc(m.label)}" title="Click to rename">
        <div class="m-meta">${fmtSize(m.size)} · uploaded ${fmtTime(m.uploadedAt)} · on ${usedBy} TV${usedBy === 1 ? '' : 's'}</div>
        ${isBday ? '<div class="m-bday">🎂 Default birthday video</div>' : ''}
        <div class="m-actions">
          <button class="btn tiny" data-act="preview">▶ Preview</button>
          <button class="btn tiny" data-act="all">Apply to all TVs</button>
          <button class="btn tiny" data-act="bday">${isBday ? 'Unset birthday' : 'Set as birthday'}</button>
          <button class="btn tiny danger" data-act="del">Delete</button>
        </div>`;

      const label = card.querySelector('.m-label');
      label.addEventListener('change', () =>
        api(`/api/media/${m.id}`, { method: 'PATCH', body: JSON.stringify({ label: label.value }) })
          .then(() => toast('Renamed')).catch(e => toast(e.message, true)));
      label.addEventListener('keydown', e => { if (e.key === 'Enter') label.blur(); });

      card.querySelector('[data-act="preview"]').addEventListener('click', () => {
        $('previewTitle').textContent = m.label;
        $('previewVideo').src = m.url;
        $('previewModal').classList.remove('hidden');
        $('previewVideo').play().catch(() => {});
      });

      card.querySelector('[data-act="all"]').addEventListener('click', () => {
        if (!confirm(`Replace every TV's playlist with just "${m.label}"?`)) return;
        api('/api/assign-all', { method: 'POST', body: JSON.stringify({ mediaIds: [m.id] }) })
          .then(() => toast('Now playing on all TVs')).catch(e => toast(e.message, true));
      });

      card.querySelector('[data-act="bday"]').addEventListener('click', () =>
        api('/api/settings', { method: 'POST', body: JSON.stringify({ birthdayMediaId: isBday ? null : m.id }) })
          .then(() => toast(isBday ? 'Birthday video unset' : `"${m.label}" is now the birthday video`))
          .catch(e => toast(e.message, true)));

      card.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm(`Delete "${m.label}"? It will be removed from every TV.`)) return;
        api(`/api/media/${m.id}`, { method: 'DELETE' }).then(() => toast('Deleted')).catch(e => toast(e.message, true));
      });

      list.appendChild(card);
    }
  }

  function renderEvents() {
    const rows = $('eventRows');
    rows.innerHTML = '';
    if (state.events.length === 0) {
      rows.innerHTML = '<tr><td colspan="9" class="hint">No events. Upload the day\'s CSV or add one manually.</td></tr>';
      return;
    }
    const themeIcons = { party: '🎉', superhero: '🦸', princess: '👑', space: '🚀', ninja: '🥷' };
    for (const ev of state.events) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtTime(ev.startsAt)}</td>
        <td>${esc(ev.tvName)}</td>
        <td><strong>${esc(ev.name)}</strong></td>
        <td>${esc(ev.message || `Happy Birthday, ${ev.name}!`)}</td>
        <td>${ev.durationMin} min</td>
        <td>${themeIcons[ev.theme] || '🎨'} ${esc(themeDisplayName(ev.theme))}</td>
        <td>${esc(ev.mediaLabel || '—')}</td>
        <td><span class="status-tag ${ev.status}">${ev.status.toUpperCase()}</span></td>
        <td style="white-space:nowrap">
          ${ev.status === 'scheduled' ? '<button class="btn tiny" data-act="now">Start now</button>' : ''}
          <button class="btn tiny danger" data-act="del">✕</button>
        </td>`;
      const nowBtn = tr.querySelector('[data-act="now"]');
      if (nowBtn) nowBtn.addEventListener('click', () =>
        api(`/api/events/${ev.id}/start-now`, { method: 'POST' })
          .then(() => toast(`Showing ${ev.name} now`)).catch(e => toast(e.message, true)));
      tr.querySelector('[data-act="del"]').addEventListener('click', () =>
        api(`/api/events/${ev.id}`, { method: 'DELETE' }).catch(e => toast(e.message, true)));
      rows.appendChild(tr);
    }
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
        if (!confirm(`Delete theme "${th.name}"? Events using it switch to the party theme.`)) return;
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
    for (const m of state.media) {
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
    const accepted = [...files].filter(f => /\.(mp4|m4v|webm|mov)$/i.test(f.name));
    if (accepted.length === 0) { toast('Only .mp4, .m4v, .webm or .mov files', true); return; }
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

  // ---------- events csv ----------
  $('csvFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await api('/api/events/csv', { method: 'POST', body: form });
      const box = $('csvReport');
      box.classList.remove('hidden');
      const head = res.imported > 0
        ? `<span class="ok">Imported ${res.imported} event${res.imported === 1 ? '' : 's'}.</span>`
        : '<span class="warn">No events imported — the existing schedule was left untouched.</span>';
      box.innerHTML = head +
        (res.errors.length ? '<br>' + res.errors.map(er => `<span class="warn">Line ${er.line}: ${esc(er.error)}</span>`).join('<br>') : '');
      toast(res.imported > 0 ? `Imported ${res.imported} events` : 'No events imported', res.imported === 0);
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
      state.media.map(m => `<option value="${esc(m.label)}">${esc(m.label)}</option>`).join('');
    $('evTheme').value = 'party';
    const now = new Date(Date.now() + 10 * 60000);
    now.setSeconds(0, 0);
    $('evStart').value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('evName').value = '';
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
          message: $('evMessage').value || null,
          startsAt: new Date($('evStart').value).toISOString(),
          durationMin: parseFloat($('evDuration').value) || 5,
          theme: $('evTheme').value,
          mediaLabel: $('evMedia').value || null
        })
      });
      $('eventModal').classList.add('hidden');
      toast('Event added');
    } catch (err) { $('eventError').textContent = err.message; }
  });

  $('clearDoneBtn').addEventListener('click', () =>
    api('/api/events/clear-done', { method: 'POST' }).then(() => toast('Cleared')).catch(e => toast(e.message, true)));

  // ---------- preview modal ----------
  $('previewClose').addEventListener('click', () => {
    $('previewVideo').pause();
    $('previewVideo').removeAttribute('src');
    $('previewVideo').load();
    $('previewModal').classList.add('hidden');
  });

  // ---------- day start / end ----------
  $('startDayBtn').addEventListener('click', () =>
    api('/api/day/start', { method: 'POST' }).then(() => toast('Day started — all screens on')).catch(e => toast(e.message, true)));
  $('endDayBtn').addEventListener('click', () => {
    if (!confirm('End the day? All 12 screens go dark until you start the day again.')) return;
    api('/api/day/end', { method: 'POST' }).then(() => toast('Day ended — screens off')).catch(e => toast(e.message, true));
  });

  // ---------- boot ----------
  if (token) enterApp(); else $('login').classList.remove('hidden');
})();
