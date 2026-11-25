/* OsMike Meetings — the page. Views: home (start/join/schedule/upcoming/previous), /past (all previous meetings),
   /m/<id> (one past meeting: summary + transcript), /r/<id> (join screen, then the call). Times are shown in the
   viewer's own time zone (the browser's), always with an absolute date. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app'), toast = $('#toast');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const showToast = (m, ms = 2800) => { toast.textContent = m; toast.hidden = false; clearTimeout(showToast.t); showToast.t = setTimeout(() => { toast.hidden = true; }, ms); };
  const TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time');
  const fDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const fTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const fClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const when = (ms) => { const d = new Date(ms); return isNaN(d) ? '' : `${fDate.format(d)}, ${fTime.format(d)}`; };
  const span = (a, b) => { if (!a) return ''; const s = new Date(a), e = b ? new Date(b) : null;
    return e && fDate.format(s) === fDate.format(e) ? `${fDate.format(s)}, ${fTime.format(s)}–${fTime.format(e)}` : when(a) + (e ? ` – ${when(b)}` : ''); };
  const dur = (s) => { if (s == null) return ''; const m = Math.round(s / 60); return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  let me = { authenticated: false };

  async function api(url, opts = {}) {
    const o = { ...opts, headers: { ...(opts.headers || {}) } };
    if (o.method && o.method !== 'GET') { o.headers['X-CSRF'] = me.csrf || ''; }
    if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers['Content-Type'] = 'application/json'; delete o.json; }
    const r = await fetch(url, o);
    let j = {}; try { j = await r.json(); } catch { /* empty */ }
    j._status = r.status; return j;
  }

  const ICONS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="i-video" viewBox="0 0 24 24"><rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.5l5-3v9l-5-3"/></symbol>
<symbol id="i-rec" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5" class="fill"/></symbol>
<symbol id="i-people" viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.6-3.4 3-5 6-5s5.4 1.6 6 5"/><circle cx="17" cy="9.5" r="2.6"/><path d="M16.5 14.6c2.3.2 4 1.6 4.5 4.4"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></symbol>
<symbol id="i-cal" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></symbol>
<symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></symbol>
</defs></svg>`;
  const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  function header() {
    const acct = me.authenticated ? `<details class="account">
      <summary aria-label="Account menu for ${esc(me.user.name)}"><span class="avatar" aria-hidden="true">${esc((me.user.name || me.user.email || '?')[0].toUpperCase())}</span><span class="who">${esc(me.user.name)}</span></summary>
      <div class="menu" role="menu"><p class="menu-id"><strong>${esc(me.user.name)}</strong><span>${esc(me.user.email)}</span></p>
      <a role="menuitem" href="/past">Previous meetings</a>
      <label class="menu-ap">Appearance <select id="appearance"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <button role="menuitem" type="button" class="linkish" id="signout">Sign out</button></div></details>`
      : `<a class="btn secondary" href="/auth/login?next=${encodeURIComponent(location.pathname)}">Sign in</a>`;
    return `${ICONS}<header class="top"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span><span class="wordmark">Meetings</span></a>${acct}</header>`;
  }
  function wireHeader() {
    const so = $('#signout'); if (so) so.onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/'; };
    const ap = $('#appearance');
    if (ap) {
      let p = 'system'; try { p = localStorage.getItem('osmike-appearance') || 'system'; } catch { /* */ }
      ap.value = p;
      ap.onchange = () => { try { localStorage.setItem('osmike-appearance', ap.value); } catch { /* */ }
        const dark = ap.value === 'dark' || (ap.value === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light'); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; };
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('details.account[open]').forEach((d) => d.removeAttribute('open')); });
  }
  function shell(inner) { app.innerHTML = `${header()}<main id="main" class="wrap">${inner}</main>`; wireHeader(); }

  const statusBadge = (m) => {
    if (m.status === 'done') return m.has_summary ? '<span class="badge ok">Summary ready</span>' : '<span class="badge">No speech recorded</span>';
    if (m.status === 'failed') return '<span class="badge warn"><span aria-hidden="true">!</span> Transcription failed</span>';
    if (m.stage === 'summarizing') return '<span class="badge live">Writing summary…</span>';
    if (m.status === 'processing') return '<span class="badge live">Transcribing…</span>';
    return '<span class="badge live">Waiting to transcribe</span>';
  };
  function pastRows(list) {
    if (!list.length) return '<p class="empty muted">No previous meetings yet. When a meeting you were in ends, its transcript and summary show up here.</p>';
    return `<ul class="rows">${list.map((m) => `<li><a class="row past" href="/m/${esc(m.id)}">
      <span class="row-title">${esc(m.title)}</span>
      <span class="meta"><span>${icon('clock')}${esc(when(m.started_at))}${m.duration_s != null ? ` · ${esc(dur(m.duration_s))}` : ''}</span>
      <span>${icon('people')}${esc(m.people.map((p) => p.name).join(', '))}</span></span>${statusBadge(m)}</a></li>`).join('')}</ul>`;
  }

  // ===================== home =====================
  async function renderHome() {
    if (!me.authenticated) {
      shell(`<div class="dawn" aria-hidden="true"></div><section class="card auth">
        <p class="eyebrow">OsMike Meetings</p><h1>Video meetings, with notes afterwards</h1>
        <p class="muted">Meetings are recorded and transcribed. Afterwards everyone who was in it with an OsMike Account gets the transcript and a summary with decisions and action items.</p>
        <a class="btn primary wide" href="/auth/login">Sign in with OsMike Account</a>
        <form class="stack" id="joinform"><label for="joincode">Got a room link or code?</label>
        <div class="inline"><input id="joincode" autocomplete="off" placeholder="meetings.osmike.com/r/…"><button class="btn secondary" type="submit">Join</button></div>
        <p class="small muted">No account needed to join: you type your name.</p></form></section>`);
      wireJoin(); return;
    }
    shell(`<h1 class="page-title">Meetings</h1>
      <div class="grid">
        <section class="card"><h2 class="card-title">Start now</h2><p class="muted">A room for right now. Share the link; guests type their name to join.</p>
          <button class="btn primary" id="instant">${icon('video')} Start a meeting</button></section>
        <section class="card"><h2 class="card-title">Join</h2>
          <form class="stack" id="joinform"><label for="joincode">Room link or code</label>
          <div class="inline"><input id="joincode" autocomplete="off" placeholder="meetings.osmike.com/r/…"><button class="btn secondary" type="submit">Join</button></div></form></section>
        <section class="card"><h2 class="card-title">Schedule</h2>
          <form class="stack" id="schedform"><label for="m-title">Title</label><input id="m-title" placeholder="Planning" maxlength="200">
          <div class="two"><div class="stack"><label for="m-start">Start</label><input id="m-start" type="datetime-local" required></div>
          <div class="stack"><label for="m-end">End (optional)</label><input id="m-end" type="datetime-local"></div></div>
          <p class="small muted">Times in ${esc(TZ)}. Saved in your OsMike calendar with a room link.</p>
          <button class="btn primary" type="submit" id="schedule">Schedule</button></form></section>
        <section class="card"><h2 class="card-title">Coming up</h2><div id="upcoming"><p class="muted">Loading…</p></div></section>
        <section class="card span2"><div class="card-head"><h2 class="card-title">Previous meetings</h2><a href="/past">All previous meetings</a></div>
          <div id="past"><p class="muted">Loading…</p></div></section>
      </div>`);
    wireJoin();
    $('#instant').onclick = async () => { const r = await api('/api/rooms', { method: 'POST', json: {} }); if (r.room_id) location.href = '/r/' + r.room_id; else showToast('Could not create a room'); };
    $('#schedform').onsubmit = async (e) => {
      e.preventDefault();
      const start = $('#m-start').value, end = $('#m-end').value;
      if (!start) { showToast('Pick a start time'); return; }
      const b = $('#schedule'); b.disabled = true; b.textContent = 'Saving…';
      const r = await api('/api/meetings', { method: 'POST', json: { title: $('#m-title').value.trim(), start: new Date(start).toISOString(), end: end ? new Date(end).toISOString() : '' } });
      b.disabled = false; b.textContent = 'Schedule';
      if (r.saved) { showToast('Scheduled — it is in your calendar'); e.target.reset(); loadUpcoming(); } else showToast('Could not save: ' + (r.error || 'error'));
    };
    loadUpcoming();
    const p = await api('/api/past');
    $('#past').innerHTML = pastRows((p.meetings || []).slice(0, 6));
  }
  function wireJoin() {
    $('#joinform').onsubmit = (e) => { e.preventDefault(); const v = $('#joincode').value.trim();
      const m = v.match(/\/r\/([A-Za-z0-9]+)/) || v.match(/^([A-Za-z0-9]+)$/); if (m) location.href = '/r/' + m[1]; else showToast('Enter a room link or code'); };
  }
  async function loadUpcoming() {
    const el = $('#upcoming'); if (!el) return;
    const r = await api('/api/meetings');
    const ms = r.meetings || [];
    el.innerHTML = r._status >= 400 ? '<p class="error"><span aria-hidden="true">!</span>The calendar did not answer. Try again later.</p>'
      : !ms.length ? '<p class="empty muted">Nothing scheduled.</p>'
      : `<ul class="rows">${ms.map((m) => `<li><a class="row" href="/r/${esc(m.room_id)}"><span class="row-title">${esc(m.title)}</span><span class="muted small">${esc(when(Date.parse(m.start)))}</span></a></li>`).join('')}</ul>`;
  }

  // ===================== all previous meetings =====================
  async function renderPast() {
    if (!me.authenticated) { location.href = '/auth/login?next=/past'; return; }
    shell(`<p class="crumbs"><a href="/">← Meetings</a></p><h1 class="page-title">Previous meetings</h1>
      <form class="search" id="sform" role="search"><label class="sr-only" for="q">Search titles, people and what was said</label>
      <input id="q" type="search" placeholder="Search titles, people and what was said"><button class="btn secondary" type="submit">Search</button></form>
      <p class="small muted">Only meetings you were in. Times in ${esc(TZ)}.</p><div id="past"><p class="muted">Loading…</p></div>`);
    const load = async () => { const r = await api('/api/past?q=' + encodeURIComponent($('#q').value)); $('#past').innerHTML = pastRows(r.meetings || []); };
    $('#sform').onsubmit = (e) => { e.preventDefault(); load(); };
    load();
  }

  // ===================== one past meeting =====================
  async function renderMeeting(id) {
    if (!me.authenticated) { location.href = '/auth/login?next=' + encodeURIComponent(location.pathname); return; }
    const m = await api('/api/past/' + encodeURIComponent(id));
    if (m._status === 404) {
      shell(`<section class="card narrow"><h1>Meeting not found</h1><p class="muted">There is no meeting here that you were in.</p><a class="btn secondary" href="/">Back to Meetings</a></section>`);
      return;
    }
    const s = m.summary;
    const list = (arr) => arr && arr.length ? `<ul class="bul">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted small">None.</p>';
    const pending = m.status === 'queued' || m.status === 'processing';
    const stateNote = m.status === 'failed' ? `<p class="error"><span aria-hidden="true">!</span>The transcription failed (${esc(m.error)}). It will not be retried automatically.</p>`
      : pending ? `<p class="notice" role="status">${m.stage === 'summarizing' ? 'Writing the summary…' : m.status === 'processing' ? 'Transcribing the recording…' : 'Waiting for its turn to be transcribed…'} This page updates by itself.</p>`
      : (!m.transcript.length ? '<p class="notice">No speech was recorded in this meeting.</p>' : '');
    const summary = s ? `<section class="card"><h2 class="card-title">Summary</h2>
        ${s.overview ? `<p class="lede">${esc(s.overview)}</p>` : ''}
        ${s.short ? '' : `<h3>Key points</h3>${list(s.key_points)}<h3>Decisions</h3>${list(s.decisions)}
        <h3>Action items</h3>${s.action_items.length ? `<ul class="actions-list">${s.action_items.map((a) => `<li><span class="task">${esc(a.task)}</span><span class="small muted">${esc(a.owner || 'No owner named')}${a.due ? ' · ' + esc(a.due) : ''}</span></li>`).join('')}</ul>` : '<p class="muted small">None.</p>'}`}
        <p class="small muted">Written by AI from the transcript on OsMike's own servers. Check important details against the transcript.</p></section>` : '';
    const tr = m.transcript.length ? `<section class="card"><div class="card-head"><h2 class="card-title">Transcript</h2><button class="btn secondary small-btn" id="copytr" type="button">Copy</button></div>
        <ol class="transcript">${m.transcript.map((l) => `<li><span class="t">${esc(fClock.format(new Date(l.at)))}</span><span class="sp">${esc(l.speaker)}</span><span class="tx">${esc(l.text)}</span></li>`).join('')}</ol></section>` : '';
    shell(`<p class="crumbs"><a href="/past">← Previous meetings</a></p>
      <h1 class="page-title">${esc(m.title)}</h1>
      <p class="facts"><span>${icon('clock')}${esc(span(m.started_at, m.ended_at))}${m.duration_s != null ? ` · ${esc(dur(m.duration_s))}` : ''}</span><span class="muted tz">Times in ${esc(TZ)}</span>
      <span>${icon('people')}${esc(m.people.map((p) => p.name + (p.guest ? ' (guest)' : '')).join(', '))}</span>
      <span>${icon('rec')}Recorded and transcribed${m.language ? ` · ${m.language === 'sv' ? 'Swedish' : m.language === 'en' ? 'English' : esc(m.language)}` : ''}</span>
      ${m.calendar ? `<span>${icon('cal')}<a href="${esc(m.calendar.url)}">${esc(m.calendar.title || 'Calendar event')}</a>${m.calendar.crm_url ? ` · <a href="${esc(m.calendar.crm_url)}">Customer in CRM</a>` : ''}</span>` : ''}</p>
      ${stateNote}<div class="detail">${summary}${tr}</div>
      ${m.is_host && !pending ? `<p class="host-actions"><button class="btn danger" type="button" id="del">Delete this meeting</button> <span class="small muted">Deletes the recording, transcript and summary for everyone.</span></p>` : ''}`);
    const ct = $('#copytr');
    if (ct) ct.onclick = () => { const txt = m.transcript.map((l) => `[${fClock.format(new Date(l.at))}] ${l.speaker}: ${l.text}`).join('\n');
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => showToast('Transcript copied'), () => showToast('Could not copy')); };
    const del = $('#del');
    if (del) del.onclick = async () => { if (!confirm('Delete this meeting, its recording, transcript and summary for everyone?')) return;
      const r = await api('/api/past/' + encodeURIComponent(id), { method: 'DELETE' }); if (r.deleted) location.href = '/past'; else showToast('Could not delete'); };
    if (pending) setTimeout(() => { if (location.pathname === '/m/' + id) renderMeeting(id); }, 8000);
  }

  // ===================== join screen + call =====================
  async function renderJoin(roomId, err) {
    const info = await api('/api/room/' + encodeURIComponent(roomId));
    let saved = ''; try { saved = localStorage.getItem('osmike-meetings-name') || ''; } catch { /* */ }
    shell(`<section class="card auth join">
      <p class="eyebrow">Join meeting</p><h1>${esc(info.title || 'Meeting')}</h1>
      <p class="muted small">Room ${esc(roomId)}${info.in_call ? ` · ${info.in_call} in the call now` : ''}${info.host_name ? ` · host ${esc(info.host_name)}` : ''}</p>
      <p class="recnote" role="note">${icon('rec')}<span><strong>This meeting is recorded and transcribed.</strong> When it ends, the people in it with an OsMike Account get the transcript and an AI summary.</span></p>
      <form class="stack" id="joinf">
      ${me.authenticated ? `<p>You join as <strong>${esc(me.user.name)}</strong>.</p>`
        : `<label for="gname">Your name</label><input id="gname" maxlength="60" autocomplete="name" value="${esc(saved)}" placeholder="First and last name" ${err ? 'aria-invalid="true"' : ''}>
           <p class="small muted">Shown to the others and in the transcript.</p>`}
      ${err ? `<p class="error"><span aria-hidden="true">!</span>${esc(err)}</p>` : ''}
      <button class="btn primary wide" type="submit">${icon('video')} Join with camera and microphone</button>
      ${me.authenticated ? '' : `<p class="small">Have an OsMike Account? <a href="/auth/login?next=${encodeURIComponent('/r/' + roomId)}">Sign in</a> to get the transcript afterwards.</p>`}
      </form></section>`);
    const g = $('#gname'); if (g && !g.value) g.focus();
    $('#joinf').onsubmit = (e) => {
      e.preventDefault();
      let name = '';
      if (!me.authenticated) {
        name = g.value.replace(/\s+/g, ' ').trim();
        if (!name) { renderJoin(roomId, 'Type your name to join.'); return; }
        try { localStorage.setItem('osmike-meetings-name', name); } catch { /* */ }
      }
      renderRoom(roomId, name);
    };
  }

  async function renderRoom(roomId, guestName) {
    app.innerHTML = `${ICONS}<div class="room">
      <div class="roomtop"><a class="brand light" href="/" aria-label="Meetings home"><span class="mark" aria-hidden="true"></span></a>
        <span class="rec" title="This meeting is recorded and transcribed">${icon('rec')}Recorded</span>
        <span class="cnt" id="cnt">connecting…</span><span class="grow"></span>
        <button class="btn ghostdark" id="copy" type="button">${icon('link')}<span class="hide-s">Copy link</span></button></div>
      <div class="stage" id="grid"></div>
      <div class="waiting" id="waiting" hidden>Waiting for others… share the link to invite someone.<br><button class="btn ghostdark" id="copy2" type="button">Copy link</button></div>
      <div class="controls">
        <button class="ctl" id="mic" type="button" aria-pressed="false" title="Mute">🎙️</button>
        <button class="ctl" id="cam" type="button" aria-pressed="false" title="Camera">🎥</button>
        <button class="ctl leave" id="leave" type="button">Leave</button>
        <button class="ctl leave end" id="endall" type="button" hidden>End for all</button>
      </div></div>`;
    const copy = () => { navigator.clipboard?.writeText(location.origin + '/r/' + roomId); showToast('Link copied'); };
    $('#copy').onclick = copy; $('#copy2').onclick = copy;
    let localStream, iceServers = [], ws, rec = null, meetingId = null, ended = false;
    const pcs = new Map();
    const grid = $('#grid'), cnt = $('#cnt');
    const myName = me.authenticated ? me.user.name : guestName;

    function tile(id, name, muted) {
      let t = grid.querySelector(`[data-p="${id}"]`);
      if (!t) { t = document.createElement('div'); t.className = 'tile'; t.dataset.p = id;
        t.innerHTML = `<video autoplay playsinline ${id === 'self' ? 'muted' : ''}></video><div class="nm"></div><div class="mutedic" aria-label="muted">🔇</div>`; grid.appendChild(t);
        if (id === 'self') t.classList.add('self'); layout(); }
      if (name !== undefined) t.querySelector('.nm').textContent = name || 'Guest';
      if (muted !== undefined) t.classList.toggle('ismuted', muted);
      return t;
    }
    const updCnt = () => { cnt.textContent = (pcs.size + 1) + ' in call'; layout(); };
    function layout() {
      const self = grid.querySelector('.tile.self'), others = [...grid.querySelectorAll('.tile:not(.self)')], wait = $('#waiting');
      if (self) { self.classList.toggle('solo', !others.length); self.classList.toggle('pip', others.length > 0); }
      if (wait) { wait.hidden = others.length > 0 || ended; if (!others.length && self) wait.style.top = (grid.offsetTop + grid.offsetHeight / 2 + self.offsetHeight / 2 + 14) + 'px'; }
      if (!others.length) return;
      const W = grid.clientWidth - 28, H = grid.clientHeight - 28, n = others.length, gap = 10;
      let best = 0;
      for (let cols = 1; cols <= n; cols++) { const rows = Math.ceil(n / cols); const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9); if (w > best) best = w; }
      best = Math.max(160, Math.min(best, W * 0.9));
      others.forEach((t) => { t.style.width = Math.floor(best) + 'px'; });
    }
    window.addEventListener('resize', layout);

    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: true }); }
    catch { try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); showToast('No camera — joining with sound only'); }
      catch { localStream = new MediaStream(); showToast('Camera and microphone are blocked — check the browser permissions'); } }
    tile('self', myName + ' (you)').querySelector('video').srcObject = localStream;
    updCnt();
    iceServers = (await api('/api/ice')).iceServers || [];

    const wsSend = (o) => { try { if (ws.readyState === 1) ws.send(typeof o === 'string' || o instanceof ArrayBuffer ? o : JSON.stringify(o)); } catch { /* */ } };
    function startRecording() {
      const a = localStream.getAudioTracks()[0];
      if (!a || !window.MediaRecorder) return;
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
      if (!mime) return;
      try { rec = new MediaRecorder(new MediaStream([a]), { mimeType: mime, audioBitsPerSecond: 32000 }); } catch { rec = null; return; }
      wsSend({ type: 'rec-start', mime });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) e.data.arrayBuffer().then((b) => wsSend(b)); };
      rec.start(4000);
    }
    function stopRecording() {
      return new Promise((res) => { if (!rec || rec.state === 'inactive') return res();
        const t = setTimeout(res, 2000); rec.onstop = () => setTimeout(() => { clearTimeout(t); res(); }, 300); try { rec.stop(); } catch { res(); } });
    }
    function makePC(peerId, name, initiator) {
      const pc = new RTCPeerConnection({ iceServers });
      pcs.set(peerId, pc);
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      pc.onicecandidate = (e) => { if (e.candidate) wsSend({ type: 'signal', to: peerId, data: { candidate: e.candidate } }); };
      pc.ontrack = (e) => { tile(peerId, name).querySelector('video').srcObject = e.streams[0]; updCnt(); };
      pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(peerId); };
      if (initiator) pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => wsSend({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } })).catch(() => {});
      updCnt(); return pc;
    }
    async function onSignal(from, name, data) {
      let pc = pcs.get(from);
      if (data.sdp) {
        if (!pc) pc = makePC(from, name, false);
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') { const a = await pc.createAnswer(); await pc.setLocalDescription(a); wsSend({ type: 'signal', to: from, data: { sdp: pc.localDescription } }); }
      } else if (data.candidate && pc) { try { await pc.addIceCandidate(data.candidate); } catch { /* */ } }
    }
    function dropPeer(id) { const pc = pcs.get(id); if (pc) { pc.close(); pcs.delete(id); } grid.querySelector(`[data-p="${id}"]`)?.remove(); updCnt(); }
    function cleanup() { pcs.forEach((pc) => pc.close()); localStream.getTracks().forEach((t) => t.stop()); }
    function endedScreen(by) {
      ended = true; cleanup();
      shell(`<section class="card auth"><p class="eyebrow">Meeting ended</p><h1>${by ? esc(by.charAt(0).toUpperCase() + by.slice(1)) : 'The meeting has ended'}</h1>
        ${me.authenticated && meetingId ? `<p>When the meeting has ended for everyone, the transcript and summary are ready within a few minutes.</p><a class="btn primary wide" href="/m/${esc(meetingId)}">Open the meeting notes</a>`
          : '<p class="muted">Thanks for joining. The people with an OsMike Account get the transcript and summary.</p>'}
        <a class="btn secondary" href="/r/${esc(roomId)}">Rejoin</a></section>`);
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => wsSend({ type: 'join', room: roomId, name: myName });
    ws.onclose = () => { if (!ended) { cnt.textContent = 'disconnected — reload to rejoin'; } };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'welcome') { meetingId = m.meeting; if (m.is_host) $('#endall').hidden = false; (m.peers || []).forEach((p) => makePC(p.id, p.name, true)); startRecording(); }
      else if (m.type === 'signal') onSignal(m.from, m.name, m.data);
      else if (m.type === 'peer-left') dropPeer(m.id);
      else if (m.type === 'ended') { stopRecording(); endedScreen(m.by && m.by.startsWith('ended by') ? `ended by ${m.by.slice(9)}` : ''); }
      else if (m.type === 'error' && m.error === 'name_required') { ended = true; cleanup(); renderJoin(roomId, 'Type your name to join.'); }
      else if (m.type === 'error' && m.error === 'only_the_host_can_end') showToast('Only the host can end the meeting for everyone');
    };

    let micOn = true, camOn = true;
    $('#mic').onclick = () => { micOn = !micOn; localStream.getAudioTracks().forEach((t) => { t.enabled = micOn; }); $('#mic').classList.toggle('off', !micOn); $('#mic').setAttribute('aria-pressed', String(!micOn)); $('#mic').textContent = micOn ? '🎙️' : '🔇'; tile('self', undefined, !micOn); };
    $('#cam').onclick = () => { camOn = !camOn; localStream.getVideoTracks().forEach((t) => { t.enabled = camOn; }); $('#cam').classList.toggle('off', !camOn); $('#cam').setAttribute('aria-pressed', String(!camOn)); $('#cam').textContent = camOn ? '🎥' : '🚫'; };
    $('#leave').onclick = async () => { await stopRecording(); wsSend({ type: 'leave' }); try { ws.close(); } catch { /* */ } ended = true; cleanup();
      if (me.authenticated && meetingId) endedScreen('you left the meeting'); else location.href = '/'; };
    $('#endall').onclick = async () => { if (!confirm('End the meeting for everyone? The recording is then transcribed.')) return; await stopRecording(); wsSend({ type: 'end-meeting' }); };
    window.addEventListener('beforeunload', () => { try { if (rec && rec.state !== 'inactive') rec.stop(); wsSend({ type: 'leave' }); } catch { /* */ } });
  }

  async function boot() {
    me = await api('/api/me').catch(() => ({ authenticated: false }));
    const p = location.pathname;
    let m;
    if ((m = p.match(/^\/r\/([A-Za-z0-9]{1,64})$/))) renderJoin(m[1]);
    else if ((m = p.match(/^\/m\/([A-Za-z0-9]{6,40})$/))) renderMeeting(m[1]);
    else if (p === '/past') renderPast();
    else if (p === '/') renderHome();
    else shell('<section class="card narrow"><h1>Page not found</h1><a class="btn secondary" href="/">Back to Meetings</a></section>');
  }
  boot();
})();
