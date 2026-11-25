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

  const pendingOf = (m) => m.status === 'queued' || m.status === 'processing' || (m.status === 'live' && m.live_state !== 'running');
  const statusBadge = (m) => {
    if (m.status === 'done') return m.has_summary && m.lines !== 0 ? '<span class="badge ok">Summary ready</span>' : '<span class="badge">No speech recorded</span>';
    if (m.status === 'live') return m.live_state === 'running' ? '<span class="badge live">In progress</span>' : '<span class="badge live">Transcribing…</span>';
    if (m.status === 'failed') return '<span class="badge warn"><span aria-hidden="true">!</span> Transcription failed</span>';
    if (m.stage === 'summarizing') return '<span class="badge live">Writing summary…</span>';
    if (m.status === 'processing') return '<span class="badge live">Transcribing…</span>';
    return '<span class="badge live">Transcribing…</span>';
  };
  // While a listed meeting is still being transcribed the list reloads itself until it is done (no manual reload).
  function pollPast(load, list) {
    clearTimeout(pollPast.t);
    if (!list.some(pendingOf) && !list.some((m) => m.status === 'live')) return;
    const at = location.pathname;
    pollPast.t = setTimeout(() => { if (location.pathname === at && document.querySelector('#past')) load(); }, 6000);
  }
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
    const loadPast = async () => { const p = await api('/api/past'); const ms = (p.meetings || []).slice(0, 6);
      if (!$('#past')) return; $('#past').innerHTML = pastRows(ms); pollPast(loadPast, ms); };
    loadPast();
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
    const load = async () => { const r = await api('/api/past?q=' + encodeURIComponent($('#q').value)); if (!$('#past')) return;
      $('#past').innerHTML = pastRows(r.meetings || []); pollPast(load, r.meetings || []); };
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
    // Before the transcript is done the page never says "No speech": 'live' (still going, or everyone just left and it
    // closes in under a minute), 'queued' and 'processing' all show progress and the page reloads itself until done.
    const running = m.status === 'live' && m.live_state === 'running';
    const pending = running || pendingOf(m);
    const prog = m.progress && m.progress.total ? ` (part ${Math.min(m.progress.done + 1, m.progress.total)} of ${m.progress.total})` : '';
    const stateNote = m.status === 'failed' ? `<p class="error" role="alert"><span aria-hidden="true">!</span>The transcription failed (${esc(m.error)}). It will not be retried automatically.</p>`
      : running ? `<p class="notice" role="status">This meeting is still going on. The transcript and summary come when it has ended. <a href="/r/${esc(m.room)}">Rejoin</a></p>`
      : pending ? `<p class="notice pending" role="status"><span class="spin" aria-hidden="true"></span><span><strong>${m.stage === 'summarizing' ? 'Writing the summary…' : 'Transcribing…' + esc(prog)}</strong>
          The transcript and summary are usually ready within a few minutes. This page updates by itself.</span></p>`
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
    clearTimeout(renderMeeting.t);
    if (pending) renderMeeting.t = setTimeout(() => { if (location.pathname === '/m/' + id) renderMeeting(id); }, running ? 15000 : 4000);
  }

  // ===================== join screen + call =====================
  // The SFU client (LiveKit, Apache-2.0, vendored and pinned) loads only for rooms that use the SFU.
  const LK_SRC = '/static/vendor/livekit-client-2.23.0.umd.js';
  let lkLoading = null;
  const loadLK = () => lkLoading || (lkLoading = new Promise((res, rej) => {
    if (window.LivekitClient) return res(window.LivekitClient);
    const s = document.createElement('script'); s.src = LK_SRC; s.async = true;
    s.onload = () => (window.LivekitClient ? res(window.LivekitClient) : rej(new Error('no LivekitClient')));
    s.onerror = () => { lkLoading = null; rej(new Error('load failed')); }; document.head.appendChild(s); }));
  const ROOM_Q = new URLSearchParams(location.search);
  const WANT_MEDIA = ['mesh', 'sfu'].includes(ROOM_Q.get('media')) ? ROOM_Q.get('media') : null;   // test only: ?media=mesh|sfu

  async function renderJoin(roomId, err) {
    const info = await api('/api/room/' + encodeURIComponent(roomId));
    if ((WANT_MEDIA || info.media) === 'sfu') loadLK().catch(() => {});
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
      renderRoom(roomId, name, (WANT_MEDIA || info.media) === 'sfu');
    };
  }

  async function renderRoom(roomId, guestName, sfuLikely) {
    app.innerHTML = `${ICONS}<div class="room">
      <div class="roomtop"><a class="brand light" href="/" aria-label="Meetings home"><span class="mark" aria-hidden="true"></span></a>
        <span class="rec" id="recst" role="status" title="This meeting is recorded and transcribed">${icon('rec')}<span class="rt">Rec</span></span>
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
    let localStream, iceServers = [], ws, meetingId = null, ended = false, mode = 'mesh', lkRoom = null;
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
    const others = () => (mode === 'sfu' ? (lkRoom ? lkRoom.remoteParticipants.size : 0) : pcs.size);
    const updCnt = () => { cnt.textContent = (others() + 1) + ' in call'; layout(); };
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

    // ~640x360 at 24 fps: every browser sends its camera to every other one (mesh), so a small picture keeps 6–10
    // people smooth. "ideal" lets phones (iPhone Safari) pick their nearest mode; the second try is the plain camera.
    const AUDIO = { echoCancellation: true, noiseSuppression: true };
    // SFU: one upload per browser, so the camera can be 960x540 (simulcast sends 180p/360p/540p, each viewer gets what fits).
    const VIDEO = sfuLikely ? { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' }
      : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' };
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: VIDEO }); }
    catch { try { localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: true }); } catch { try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); showToast('No camera — joining with sound only'); }
      catch { localStream = new MediaStream(); showToast('Camera and microphone are blocked — check the browser permissions'); } } }
    localStream.getVideoTracks().forEach((t) => { try { t.contentHint = 'motion'; } catch { /* */ } });
    tile('self', myName + ' (you)').querySelector('video').srcObject = localStream;
    updCnt();
    iceServers = (await api('/api/ice')).iceServers || [];

    const wsSend = (o) => { try { if (ws.readyState === 1) ws.send(typeof o === 'string' || o instanceof ArrayBuffer ? o : JSON.stringify(o)); } catch { /* */ } };

    // ---------- recording ----------
    // Each browser records only its own microphone (MediaRecorder, 4 s chunks) and streams it over the meeting socket.
    // A MediaRecorder is bound to one microphone track and ends silently when that track ends or is swapped (LiveKit
    // re-acquires the microphone when it ends or the default device changes; a headset is plugged in; the OS takes the
    // device). So: the recorder restarts whenever the microphone track changes or ends, when the recorder stops by itself,
    // when no chunk came for 10 s while unmuted, and when the server says it gets no audio. While the socket is away the
    // chunks are kept (in order) and sent into the same recording when it is back; a muted microphone records silence.
    const R = { rec: null, track: null, seg: null, startPending: false, out: [], outBytes: 0, chain: Promise.resolve(), lastChunk: 0,
      restarts: 0, state: 'off', why: '', restarting: false, ready: false, log: [] };
    const OUT_MAX = 24 * 1024 * 1024;         // ~1.5 h of 32 kbit/s audio held while the socket is away
    const recNote = (t) => { R.log.push(new Date().toISOString().slice(11, 19) + ' ' + t); if (R.log.length > 40) R.log.shift(); note('rec', t); };
    function micTrack() {      // the microphone track that is live now (LiveKit may have replaced ours)
      if (mode === 'sfu' && lkRoom && window.LivekitClient) {
        const pub = lkRoom.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Microphone);
        const t = pub && pub.track && pub.track.mediaStreamTrack;
        if (t && t.readyState === 'live') return t;
      }
      return localStream.getAudioTracks().find((t) => t.readyState === 'live') || null;
    }
    function flushRec() {
      if (!R.ready || !ws || ws.readyState !== 1) return;
      while (R.out.length) {
        const x = R.out.shift();
        try { ws.send(x instanceof ArrayBuffer ? x : JSON.stringify(x)); } catch { R.out.unshift(x); return; }
        if (x instanceof ArrayBuffer) R.outBytes -= x.byteLength;
        else if (x.type === 'rec-start') { R.seg = null; R.startPending = true; }   // the next chunks belong to a recording the server will name
      }
    }
    const recOut = (item) => { R.chain = R.chain.then(async () => {          // keeps chunks and control messages in order
      const x = typeof item === 'function' ? await item() : item;
      if (!x) return;
      if (x instanceof ArrayBuffer) { if (R.outBytes + x.byteLength > OUT_MAX) return; R.outBytes += x.byteLength; }
      R.out.push(x); flushRec();
    }).catch(() => {}); };
    function setRec(state, why) {
      R.state = state; if (why !== undefined) R.why = why;
      const el = $('#recst'); if (!el) return;
      const on = state === 'on' && (ws && ws.readyState === 1 && R.ready);
      el.classList.toggle('on', on); el.classList.toggle('warn', !on);
      el.querySelector('.rt').textContent = state === 'none' ? 'Not recording' : on ? 'Rec' : 'Rec…';
      el.title = state === 'none' ? `Your microphone is not being recorded (${R.why}). The others are still recorded.`
        : on ? 'You are being recorded and transcribed' : 'Reconnecting the recording…';
    }
    function stopRecorder() {
      const rec = R.rec; R.rec = null; R.track = null;
      return new Promise((res) => { if (!rec || rec.state === 'inactive') return res();
        rec._stopping = true; const t = setTimeout(res, 2000);
        rec.onstop = () => setTimeout(() => { clearTimeout(t); res(); }, 50); try { rec.stop(); } catch { res(); } });
    }
    async function startRecording(why) {
      if (ended) return;
      await stopRecorder();      // the old recorder's last chunk is queued before the new recording starts
      const a = micTrack();
      const mime = window.MediaRecorder && ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      let rec = null;
      if (a && mime) { try { rec = new MediaRecorder(new MediaStream([a]), { mimeType: mime, audioBitsPerSecond: 32000 }); } catch { rec = null; } }
      if (!rec) { const w = !a ? 'no microphone' : 'this browser cannot record'; recNote('cannot record: ' + w); setRec('none', w); recOut({ type: 'rec-none', why: w }); return; }
      R.rec = rec; R.track = a; R.lastChunk = Date.now();
      recOut({ type: 'rec-start', mime, why: why || '' });
      rec.ondataavailable = (e) => { if (!e.data || !e.data.size) return; if (rec === R.rec) R.lastChunk = Date.now(); recOut(() => e.data.arrayBuffer()); };
      rec.onstop = () => { if (!rec._stopping && rec === R.rec) restartSoon('the recorder stopped'); };
      rec.onerror = () => { if (rec === R.rec) restartSoon('recorder error'); };
      a.addEventListener('ended', () => { if (a === R.track) restartSoon('the microphone ended', 3000); }, { once: true });
      try { rec.start(4000); } catch { R.rec = null; restartSoon('recorder did not start', 3000); return; }
      recNote('recording ' + (why || 'started') + ' on ' + (a.label || a.id).slice(0, 40));
      setRec('on', '');
    }
    function stopRecording() { return stopRecorder().then(() => new Promise((r) => { recOut(null); R.chain.then(() => setTimeout(r, 250)); })); }
    function restartSoon(why, delay = 0) {
      if (R.restarting || ended || leaving) return;
      R.restarting = true; setRec('restarting', why);
      setTimeout(async () => {
        try {
          if (ended) return;
          // SFU: LiveKit re-acquires an ended microphone itself; taking one at the same time makes it stop ours and mute
          if (mode === 'sfu' && lkRoom) for (let i = 0; i < 16 && !micTrack(); i++) await new Promise((r) => setTimeout(r, 500));
          if (ended || leaving) return;
          if (!micTrack() && localStream.getAudioTracks().length) await reacquireMic(why);   // nobody brought a new microphone back
          syncMute();
          R.restarts++; recNote('restart: ' + why);
          await startRecording(why);
        } finally { R.restarting = false; }
      }, delay);
    }
    // A new microphone track (the old one ended, or a switch of device): into the stream, the call and the recording.
    async function reacquireMic(why) {
      let t = null;
      try { t = (await navigator.mediaDevices.getUserMedia({ audio: AUDIO })).getAudioTracks()[0] || null; } catch { t = null; }
      if (!t) { recNote('could not get the microphone back (' + why + ')'); return null; }
      t.enabled = micOn;
      localStream.getAudioTracks().forEach((o) => { localStream.removeTrack(o); try { o.stop(); } catch { /* */ } });
      localStream.addTrack(t);
      if (mode === 'sfu' && lkRoom && window.LivekitClient) {
        const pub = lkRoom.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Microphone);
        if (pub && pub.track) { try { await pub.track.replaceTrack(t, true); if (!micOn) await pub.mute(); } catch (e) { recNote('replace in SFU failed: ' + e.message); } }
      } else pcs.forEach((pc) => pc.getSenders().forEach((sn) => { if (sn.track && sn.track.kind === 'audio') sn.replaceTrack(t).catch(() => {}); }));
      recNote('microphone re-acquired (' + why + ')');
      return t;
    }
    // The microphone must be on exactly when the person has it on: LiveKit mutes the publication when it cannot restart
    // a track, and a new track can come back disabled. Either would record silence for the rest of the meeting.
    function syncMute() {
      const t = micTrack(); if (!t) return;
      if (mode === 'sfu' && lkRoom && window.LivekitClient) {
        const pub = lkRoom.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Microphone);
        if (pub && pub.track && micOn && pub.isMuted) { recNote('microphone was muted without you: unmuted'); pub.unmute().catch(() => {}); return; }
      }
      if (t.enabled !== micOn) { if (micOn) recNote('microphone was disabled without you: enabled'); t.enabled = micOn; }
    }
    let leaving = false;
    setInterval(() => {             // watchdog
      if (ended || leaving || !joined || R.restarting) return;
      syncMute();
      const cur = micTrack();
      if (mode === 'sfu' && cur && !localStream.getAudioTracks().includes(cur)) {   // LiveKit brought a new track: keep the stream in step
        localStream.getAudioTracks().forEach((o) => { if (o.readyState === 'ended') localStream.removeTrack(o); });
        localStream.addTrack(cur);
      }
      if (R.state === 'none') { if (cur && window.MediaRecorder) restartSoon('a microphone is available'); return; }
      if (!R.rec || R.rec.state === 'inactive') return restartSoon('the recorder was not running');
      if (cur && cur !== R.track) return restartSoon('the microphone changed');
      if (R.track && R.track.readyState === 'ended') return restartSoon('the microphone ended', 1500);
      if (R.rec.state === 'paused') { try { R.rec.resume(); } catch { /* */ } }
      if (micOn && Date.now() - R.lastChunk > 10_000) return restartSoon('no audio for 10 s');
      setRec('on');
    }, 2000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && R.rec && R.rec.state === 'inactive' && !ended) restartSoon('the tab came back'); });
    // Upload budget. Each browser encodes its camera once per other person, so the per-person bitrate falls as the
    // room grows: total upload stays around 2–3 Mbps. Audio (Opus) is never touched.
    function videoTier(n) {
      if (n <= 2) return { maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1 };
      if (n <= 4) return { maxBitrate: 600_000, maxFramerate: 24, scaleResolutionDownBy: 1 };
      if (n <= 7) return { maxBitrate: 350_000, maxFramerate: 20, scaleResolutionDownBy: 1.333 };
      return { maxBitrate: 200_000, maxFramerate: 15, scaleResolutionDownBy: 1.5 };
    }
    async function tuneSender(sender, tier) {
      if (!sender.track || sender.track.kind !== 'video' || !sender.getParameters || !sender.setParameters) return;
      try {
        const p = sender.getParameters();             // Safari refuses setParameters without a fresh getParameters
        if (!p.encodings || !p.encodings.length) return; // not negotiated yet: tuned again when connected
        const e = p.encodings[0], same = e.maxBitrate === tier.maxBitrate && e.maxFramerate === tier.maxFramerate && e.scaleResolutionDownBy === tier.scaleResolutionDownBy;
        if (same) return;
        Object.assign(e, tier);
        p.degradationPreference = 'balanced';
        try { await sender.setParameters(p); }
        catch { const q = sender.getParameters(); if (!q.encodings || !q.encodings.length) return;   // a browser that rejects a field
          q.encodings[0].maxBitrate = tier.maxBitrate; try { await sender.setParameters(q); } catch { /* unsupported: browser default */ } }
      } catch { /* no setParameters support */ }
    }
    let tuneT = null;
    function retune() { clearTimeout(tuneT); tuneT = setTimeout(() => { const tier = videoTier(pcs.size);
      pcs.forEach((pc) => pc.getSenders().forEach((s) => tuneSender(s, tier))); }, 250); }

    // A dropped network (Wi-Fi switch, a short outage, a frozen picture) gets one ICE restart before the tile goes.
    // Only the side that sent the first offer restarts, so the two never offer at the same time; the other side asks.
    function heal(peerId, why) {
      const pc = pcs.get(peerId); if (!pc || pc.connectionState === 'closed') return;
      note(peerId, 'heal:' + why); if (pc._healing) { if (why === 'failed') dropPeer(peerId, 'failed again after restart'); return; }
      pc._healing = Date.now();
      if (!pc._initiator) { wsSend({ type: 'signal', to: peerId, data: { restart: true } }); setTimeout(() => { const p = pcs.get(peerId);
        if (p !== pc) return; if (['connected', 'completed'].includes(pc.connectionState)) pc._healing = 0; else dropPeer(peerId, 'no restart from the other side'); }, 20000); return; }
      restartIce(peerId);
    }
    async function restartIce(peerId) {
      const pc = pcs.get(peerId); if (!pc) return;
      if (pc.signalingState !== 'stable') { if ((pc._rt = (pc._rt || 0) + 1) < 6) setTimeout(() => restartIce(peerId), 1500); else pc._healing = 0; return; }
      pc._rt = 0; pc._healing = pc._healing || Date.now(); note(peerId, 'ice-restart');
      try { if (pc.restartIce) pc.restartIce();
        const o = await pc.createOffer({ iceRestart: true }); await pc.setLocalDescription(o);
        wsSend({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } }); } catch (e) { dropPeer(peerId, 'restart offer failed: ' + e); return; }
      setTimeout(() => { const p = pcs.get(peerId); if (p !== pc) return; if (['connected', 'completed'].includes(pc.connectionState)) pc._healing = 0; else dropPeer(peerId, 'restart did not reconnect'); }, 20000);
    }
    const dbg = [];   // last connection events, for diagnostics (window.osmikeMeeting.log)
    const note = (id, e) => { dbg.push([new Date().toISOString().slice(11, 23), String(id).slice(0, 5), e]); if (dbg.length > 400) dbg.shift(); };
    const FORCE_RELAY = ROOM_Q.get('relay') === '1' || ROOM_Q.get('tcp') === '1'; // test only: TURN path (tcp=1: TURN over TCP only)
    const turnList = () => (ROOM_Q.get('tcp') === '1' ? iceServers.filter((x) => String(x.urls).includes('transport=tcp')) : iceServers);
    function makePC(peerId, name, initiator) {
      const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all' });
      pc._initiator = initiator;
      pcs.set(peerId, pc);
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      pc.onicecandidate = (e) => { if (e.candidate) wsSend({ type: 'signal', to: peerId, data: { candidate: e.candidate } }); };
      pc.ontrack = (e) => { tile(peerId, name).querySelector('video').srcObject = e.streams[0]; updCnt(); };
      let discT = null;
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState; note(peerId, st);
        clearTimeout(discT);
        if (st === 'connected') { retune(); if (pc._healing) setTimeout(() => { if (pc.connectionState === 'connected') pc._healing = 0; }, 15000); }
        else if (st === 'disconnected') discT = setTimeout(() => { if (pc.connectionState === 'disconnected') heal(peerId, 'disconnected'); }, 3000);
        else if (st === 'failed') heal(peerId, 'failed');
        else if (st === 'closed') dropPeer(peerId, 'closed');
      };
      if (initiator) pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => wsSend({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } })).catch(() => {});
      updCnt(); retune(); return pc;
    }
    // A picture that stops moving while the connection still says "connected" (no frames decoded for ~10 s).
    const freezeT = setInterval(() => { if (ended) return clearInterval(freezeT);
      pcs.forEach((pc, id) => { if (pc.connectionState !== 'connected' || pc._healing) return;
        pc.getStats().then((st) => { let f = null, a = 0; st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') f = (f || 0) + (r.framesDecoded || 0);
            if (r.type === 'inbound-rtp' && r.kind === 'audio') a += r.packetsReceived || 0; });
          if (f == null) return;
          // a camera switched off still lets sound through: only picture AND sound standing still counts as frozen
          const moving = f > (pc._frames ?? -1) || a > (pc._audio ?? -1);
          pc._frames = f; pc._audio = a;
          if (moving) pc._still = 0; else if (++pc._still >= 3) { pc._still = 0; heal(id, 'frozen'); } }).catch(() => {}); }); }, 3500);
    window.osmikeMeeting = { pcs, tier: () => videoTier(pcs.size), heal, log: dbg, mode: () => mode, room: () => lkRoom, stats: () => sfuStats(), dropSocket: () => ws && ws.close(),   // diagnostics + load tests
      rec: () => ({ state: R.state, why: R.why, seg: R.seg, restarts: R.restarts, queued: R.out.length, lastChunkAgo: Date.now() - R.lastChunk, track: R.track && R.track.id, recorder: R.rec && R.rec.state, log: R.log.slice(-15) }),
      endMic: () => { const t = micTrack(); if (t) { t.stop(); t.dispatchEvent(new Event('ended')); } return !!t; },   // a microphone that goes away
      swapMic: () => reacquireMic('test swap').then((t) => !!t),                                                        // a switch of device
      killRecorder: () => { if (R.rec) { R.rec.ondataavailable = null; R.rec.onstop = null; try { R.rec.stop(); } catch { /* */ } } } };   // a recorder that dies silently
    async function onSignal(from, name, data) {
      let pc = pcs.get(from);
      if (data.restart) { if (pc && pc._initiator && !pc._healing) heal(from, 'asked'); return; }
      if (data.sdp) {
        if (!pc) pc = makePC(from, name, false);
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') { const a = await pc.createAnswer(); await pc.setLocalDescription(a); wsSend({ type: 'signal', to: from, data: { sdp: pc.localDescription } }); }
      } else if (data.candidate && pc) { try { await pc.addIceCandidate(data.candidate); } catch { /* */ } }
    }
    function dropPeer(id, why) { note(id, 'drop:' + (why || 'left')); const pc = pcs.get(id); if (pc) { pcs.delete(id); pc.close(); } grid.querySelector(`[data-p="${id}"]`)?.remove(); updCnt(); retune(); }
    function cleanup() { pcs.forEach((pc) => pc.close()); if (lkRoom) { const r = lkRoom; lkRoom = null; r.disconnect().catch(() => {}); } localStream.getTracks().forEach((t) => t.stop()); }

    // ---------- SFU (LiveKit): one upload per browser (simulcast 180p/360p/540p), the server forwards it to everyone.
    // The /ws socket above stays the authority for who is in the meeting, recording and the end of the meeting.
    let lkTries = 0;
    const tileEl = (id) => grid.querySelector(`[data-p="${CSS.escape(id)}"]`);
    function speakSound(blocked) {
      let b = $('#sound');
      if (!blocked) { if (b) b.remove(); return; }
      if (b) return;
      b = document.createElement('button'); b.id = 'sound'; b.type = 'button'; b.className = 'btn primary soundbtn'; b.textContent = 'Tap to turn on sound';
      b.onclick = () => lkRoom && lkRoom.startAudio().then(() => speakSound(!lkRoom.canPlaybackAudio)).catch(() => {});
      $('.room').appendChild(b);
    }
    async function startSfu(info) {
      mode = 'sfu';
      let LK; try { LK = await loadLK(); } catch { cnt.textContent = 'video could not load — reload to rejoin'; return; }
      const { Room, RoomEvent, Track, VideoPresets } = LK;
      const flags = (p) => { const t = tileEl(p.identity); if (!t) return;
        const mic = p.getTrackPublication(Track.Source.Microphone), cam = p.getTrackPublication(Track.Source.Camera);
        t.classList.toggle('ismuted', !mic || mic.isMuted); t.classList.toggle('camoff', !cam || cam.isMuted || !cam.track); };
      const tileOf = (p) => { const t = tile(p.identity, p.name || 'Guest'); return t; };
      const room = new Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true,
        publishDefaults: { simulcast: true, videoCodec: 'vp8', videoEncoding: { maxBitrate: 1_000_000, maxFramerate: 24 },
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360], dtx: true, red: true } });
      lkRoom = room;
      room.on(RoomEvent.ParticipantConnected, (p) => { tileOf(p); flags(p); updCnt(); note(p.identity, 'joined'); })
        .on(RoomEvent.ParticipantDisconnected, (p) => { tileEl(p.identity)?.remove(); updCnt(); note(p.identity, 'left'); })
        .on(RoomEvent.TrackSubscribed, (track, pub, p) => { const t = tileOf(p);
          if (track.kind === 'video') track.attach(t.querySelector('video'));
          else if (track.kind === 'audio') { const a = track.attach(); a.className = 'lkaudio'; t.appendChild(a); }
          flags(p); updCnt(); })
        .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => { track.detach().forEach((el) => { if (el.tagName === 'AUDIO') el.remove(); }); flags(p); })
        .on(RoomEvent.TrackMuted, (pub, p) => { if (!p.isLocal) flags(p); })
        .on(RoomEvent.TrackUnmuted, (pub, p) => { if (!p.isLocal) flags(p); })
        .on(RoomEvent.TrackPublished, (pub, p) => flags(p))
        .on(RoomEvent.TrackUnpublished, (pub, p) => flags(p))
        .on(RoomEvent.ActiveSpeakersChanged, (sp) => { const ids = new Set(sp.map((x) => (x.isLocal ? 'self' : x.identity)));
          grid.querySelectorAll('.tile').forEach((t) => t.classList.toggle('speaking', ids.has(t.dataset.p))); })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => speakSound(!room.canPlaybackAudio))
        .on(RoomEvent.Reconnecting, () => { cnt.textContent = 'reconnecting…'; note('lk', 'reconnecting'); })
        .on(RoomEvent.Reconnected, () => { updCnt(); note('lk', 'reconnected'); })
        .on(RoomEvent.Disconnected, (why) => { note('lk', 'disconnected:' + why); if (lkRoom === room) lkLost(); });
      try {
        await room.connect(info.url, info.token, { autoSubscribe: true, rtcConfig: { iceServers: turnList(), iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all' } });
      } catch (e) { note('lk', 'connect failed: ' + (e && e.message)); if (lkRoom === room) lkLost(); return; }
      if (lkRoom !== room || ended) { room.disconnect(); return; }
      lkTries = 0; note('lk', 'connected');
      room.remoteParticipants.forEach((p) => { tileOf(p); flags(p); });
      for (const t of localStream.getTracks()) {
        try { const pub = await room.localParticipant.publishTrack(t, { source: t.kind === 'audio' ? Track.Source.Microphone : Track.Source.Camera,
          name: t.kind === 'audio' ? 'microphone' : 'camera' });
          if ((t.kind === 'audio' && !micOn) || (t.kind === 'video' && !camOn)) await pub.mute();
        } catch (e) { note('lk', 'publish ' + t.kind + ' failed: ' + e.message); }
      }
      speakSound(!room.canPlaybackAudio); updCnt();
    }
    function lkLost() {      // the SFU connection is gone for good (LiveKit's own resume gave up): new token, new connection
      lkRoom = null; grid.querySelectorAll('.tile:not(.self)').forEach((t) => t.remove()); updCnt();
      if (ended) return;
      if (lkTries++ < 5) { cnt.textContent = 'reconnecting…'; setTimeout(() => { if (!ended) wsSend({ type: 'media-token' }); }, 1500 * lkTries); }
      else cnt.textContent = 'video disconnected — reload to rejoin';
    }
    function sfuMute(kind, on) {
      if (mode !== 'sfu' || !lkRoom || !window.LivekitClient) return false;
      const S = window.LivekitClient.Track.Source;
      const pub = lkRoom.localParticipant.getTrackPublication(kind === 'audio' ? S.Microphone : S.Camera);
      if (pub && pub.track) { (on ? pub.unmute() : pub.mute()).catch(() => {}); }
      return true;
    }
    async function sfuStats() {          // diagnostics + the load test (scripts/load_sfu.py)
      const r = lkRoom, LKc = window.LivekitClient; if (!r || !LKc) return { mode, connected: false };
      const S = LKc.Track.Source, out = { mode, state: r.state, peers: r.remoteParticipants.size, tiles: document.querySelectorAll('.tile:not(.self) video').length, remotes: [], up: { layers: [], audio: 0 } };
      const pairOf = (st) => { let pair = null; st.forEach((x) => { if (x.type === 'transport' && x.selectedCandidatePairId) pair = st.get(x.selectedCandidatePairId); });
        if (!pair) st.forEach((x) => { if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair = x; });
        return pair ? { lt: st.get(pair.localCandidateId)?.candidateType, proto: st.get(pair.localCandidateId)?.protocol, relayProto: st.get(pair.localCandidateId)?.relayProtocol, rtt: pair.currentRoundTripTime } : null; };
      for (const p of r.remoteParticipants.values()) {
        const pub = p.getTrackPublication(S.Camera), o = { id: p.identity, name: p.name, frames: 0, w: 0, h: 0, fps: 0, inBytes: 0, quality: pub ? pub.videoQuality : null };
        if (pub && pub.track && pub.track.getRTCStatsReport) {
          const st = await pub.track.getRTCStatsReport().catch(() => null);
          if (st) { st.forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'video') { o.frames = x.framesDecoded || 0; o.w = x.frameWidth || 0; o.h = x.frameHeight || 0; o.fps = x.framesPerSecond || 0; o.inBytes = x.bytesReceived || 0; } });
            if (!out.down) out.down = pairOf(st); }
        }
        out.remotes.push(o);
      }
      const v = r.localParticipant.getTrackPublication(S.Camera), a = r.localParticipant.getTrackPublication(S.Microphone);
      if (v && v.track && v.track.getRTCStatsReport) { const st = await v.track.getRTCStatsReport().catch(() => null);
        if (st) { st.forEach((x) => { if (x.type === 'outbound-rtp' && x.kind === 'video') out.up.layers.push({ rid: x.rid || '', w: x.frameWidth || 0, h: x.frameHeight || 0, fps: x.framesPerSecond || 0, bytes: x.bytesSent || 0, active: x.active, limit: x.qualityLimitationReason }); });
          out.upPath = pairOf(st); } }
      if (a && a.track && a.track.getRTCStatsReport) { const st = await a.track.getRTCStatsReport().catch(() => null); if (st) st.forEach((x) => { if (x.type === 'outbound-rtp' && x.kind === 'audio') out.up.audio = x.bytesSent || 0; }); }
      return out;
    }
    function endedScreen(by) {
      ended = true; cleanup();
      shell(`<section class="card auth"><p class="eyebrow">Meeting ended</p><h1>${by ? esc(by.charAt(0).toUpperCase() + by.slice(1)) : 'The meeting has ended'}</h1>
        ${me.authenticated && meetingId ? `<p>When the meeting has ended for everyone, the transcript and summary are ready within a few minutes.</p><a class="btn primary wide" href="/m/${esc(meetingId)}">Open the meeting notes</a>`
          : '<p class="muted">Thanks for joining. The people with an OsMike Account get the transcript and summary.</p>'}
        <a class="btn secondary" href="/r/${esc(roomId)}">Rejoin</a></section>`);
    }

    // The meeting socket. If it drops without a Leave (network blip, a proxy reload) it reconnects and resumes the same
    // place for ~30 s (same peer id, same SFU identity); the pictures keep running meanwhile. Recording restarts.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let resumeKey = null, selfId = null, wsTries = 0, joined = false;
    function connectWs() {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => wsSend(resumeKey ? { type: 'join', room: roomId, name: myName, resume: resumeKey, pid: selfId }
        : { type: 'join', room: roomId, name: myName, ...(WANT_MEDIA ? { media: WANT_MEDIA } : {}) });
      ws.onclose = () => {
        if (ended) return;
        R.ready = false; setRec(R.state);
        if (!joined || !resumeKey || wsTries >= 7) { cnt.textContent = 'disconnected — reload to rejoin'; stopRecorder(); return; }
        // keep recording: the chunks wait and go into the same recording when the socket is back (if the server had
        // confirmed it; otherwise a new recording starts)
        cnt.textContent = 'reconnecting…'; note('ws', 'closed, retry ' + (wsTries + 1));
        setTimeout(() => { if (!ended) connectWs(); }, [500, 1000, 2000, 3000, 4000, 5000, 5000][wsTries++]);
      };
      ws.onmessage = onWsMessage;
    }
    function onWsMessage(ev) { let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'welcome') {
        meetingId = m.meeting; resumeKey = m.resume || null; selfId = m.self; wsTries = 0; if (m.is_host) $('#endall').hidden = false;
        if (m.resumed) {       // back in the same place: keep the pictures and the recording (same file on the server)
          note('ws', 'resumed'); updCnt();
          const firstStart = R.out.findIndex((x) => !(x instanceof ArrayBuffer) && x.type === 'rec-start');
          if (R.seg) R.out.unshift({ type: 'rec-resume', seg: R.seg });
          else if (firstStart > 0) { R.out.splice(0, firstStart); R.outBytes = R.out.reduce((n, x) => n + (x instanceof ArrayBuffer ? x.byteLength : 0), 0); }
          else if (firstStart < 0) { R.out = []; R.outBytes = 0; }
          const resumable = !!R.seg;
          R.ready = true; flushRec();
          if (firstStart < 0 && !resumable && R.state !== 'none') restartSoon('socket back, recording unconfirmed');
          setRec(R.state);
          if (mode === 'sfu') { if (!lkRoom && m.sfu) startSfu(m.sfu); }
          else (m.peers || []).forEach((p) => { if (!pcs.has(p.id)) makePC(p.id, p.name, true); });
          return;
        }
        joined = true; R.ready = true;
        if (m.media === 'sfu' && m.sfu) startSfu(m.sfu); else (m.peers || []).forEach((p) => makePC(p.id, p.name, true));
        startRecording('join'); }
      else if (m.type === 'rec-ok') { R.seg = m.seg; R.startPending = false; setRec(R.state); }
      else if (m.type === 'rec-restart') { recNote('server asked to restart (' + (m.why || '') + ')'); R.seg = null; restartSoon('server: ' + (m.why || 'restart')); }
      else if (m.type === 'resume-failed') { ended = true; cleanup(); location.reload(); }
      else if (m.type === 'media-token') { if (mode === 'sfu' && !ended) startSfu({ url: m.url, token: m.token }); }
      else if (m.type === 'signal') { if (mode === 'mesh') onSignal(m.from, m.name, m.data); }
      else if (m.type === 'peer-left') { if (mode === 'mesh') dropPeer(m.id); else { tileEl(m.id)?.remove(); updCnt(); } }
      else if (m.type === 'ended') { stopRecording(); endedScreen(m.by && m.by.startsWith('ended by') ? `ended by ${m.by.slice(9)}` : ''); }
      else if (m.type === 'error' && m.error === 'name_required') { ended = true; cleanup(); renderJoin(roomId, 'Type your name to join.'); }
      else if (m.type === 'error' && m.error === 'only_the_host_can_end') showToast('Only the host can end the meeting for everyone');
    }
    connectWs();

    let micOn = true, camOn = true;
    $('#mic').onclick = () => { micOn = !micOn; if (!sfuMute('audio', micOn)) localStream.getAudioTracks().forEach((t) => { t.enabled = micOn; }); $('#mic').classList.toggle('off', !micOn); $('#mic').setAttribute('aria-pressed', String(!micOn)); $('#mic').textContent = micOn ? '🎙️' : '🔇'; tile('self', undefined, !micOn); };
    $('#cam').onclick = () => { camOn = !camOn; if (!sfuMute('video', camOn)) localStream.getVideoTracks().forEach((t) => { t.enabled = camOn; }); $('#cam').classList.toggle('off', !camOn); $('#cam').setAttribute('aria-pressed', String(!camOn)); $('#cam').textContent = camOn ? '🎥' : '🚫'; };
    $('#leave').onclick = async () => { leaving = true; await stopRecording(); wsSend({ type: 'leave' }); try { ws.close(); } catch { /* */ } ended = true; cleanup();
      if (me.authenticated && meetingId) endedScreen('you left the meeting'); else location.href = '/'; };
    $('#endall').onclick = async () => { if (!confirm('End the meeting for everyone? The recording is then transcribed.')) return; leaving = true; await stopRecording(); wsSend({ type: 'end-meeting' }); };
    window.addEventListener('beforeunload', () => { try { if (R.rec && R.rec.state !== 'inactive') R.rec.stop(); wsSend({ type: 'leave' }); } catch { /* */ } });
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
