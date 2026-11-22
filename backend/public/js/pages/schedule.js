/*
 * schedule.html — day / week / month calendar. Dates are handled as LOCAL
 * calendar days ('YYYY-MM-DD'), so a job never lands a day early, and the date
 * picker jumps straight to the chosen day in every view. Technicians see only
 * their own jobs. Presence dots show jobs someone is viewing right now.
 */
(function () {
  'use strict';
  const { fmt, api, auth, ui } = window.MBC;
  const $ = ui.$;
  let jobs = [];
  let presence = {};
  let view = 'week';
  let cursor = fmt.todayISO();
  let me = null;

  function weekStartDay() {
    const b = MBC.brand.current || {};
    const ws = b.weekStart != null ? b.weekStart : (b.locale && b.locale.weekStart);
    if (typeof ws === 'string' && /^(sun|mon|sat)/i.test(ws)) return { sun: 0, mon: 1, sat: 6 }[ws.slice(0, 3).toLowerCase()];
    if (ws != null && Number.isFinite(Number(ws))) return Number(ws) % 7;
    return ['US', 'CA'].includes(fmt.addressLabels().country) ? 0 : 1;
  }
  const d = (iso) => fmt.parseDate(iso);
  const iso = (date) => fmt.isoDate(date);
  function startOfWeek(isoDay) { const x = d(isoDay); const diff = (x.getDay() - weekStartDay() + 7) % 7; x.setDate(x.getDate() - diff); return iso(x); }
  function dayNames() {
    const base = d(startOfWeek(fmt.todayISO()));
    return Array.from({ length: 7 }, (_, i) => { const x = new Date(base); x.setDate(x.getDate() + i); return x.toLocaleDateString(fmt.locale(), { weekday: 'short' }); });
  }

  function filtered() {
    const tech = $('tech-filter').value;
    return jobs.filter((j) => j.scheduledDate && (!tech || String(j.technicianId) === tech) && (!auth.isTech() || String(j.technicianId) === String(me.id)));
  }
  function onDay(list, day) { return list.filter((j) => j.scheduledDate === day).sort((a, b) => String(a.scheduledTime || '').localeCompare(String(b.scheduledTime || ''))); }
  const hasPresence = (id) => presence[String(id)] && Object.keys(presence[String(id)]).length > 0;
  const dot = (j) => (hasPresence(j.id) ? '<span class="presence-dot" title="Someone is viewing this job"></span>' : '');
  const chipTitle = (j) => fmt.esc([j.title, fmt.name(j.customer), fmt.name(j.technician) || 'Unassigned', j.scheduledTime ? fmt.time(j.scheduledTime) : ''].filter(Boolean).join(' · '));

  function render() {
    document.querySelectorAll('.view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $('date-picker').value = cursor;
    if (view === 'day') renderDay(); else if (view === 'week') renderWeek(); else renderMonth();
  }

  function renderDay() {
    $('nav-label').textContent = fmt.date(cursor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const list = onDay(filtered(), cursor);
    const untimed = list.filter((j) => !j.scheduledTime);
    let html = '<div class="day-view">';
    if (untimed.length) html += slot('Any time', untimed);
    for (let h = 6; h <= 20; h++) {
      const at = list.filter((j) => j.scheduledTime && parseInt(j.scheduledTime, 10) === h);
      html += slot(fmt.time(String(h).padStart(2, '0') + ':00'), at);
    }
    const late = list.filter((j) => j.scheduledTime && (parseInt(j.scheduledTime, 10) < 6 || parseInt(j.scheduledTime, 10) > 20));
    if (late.length) html += slot('Other', late);
    $('calendar-container').innerHTML = html + '</div>';
  }
  function slot(label, list) {
    return '<div class="time-slot"><div class="time-label">' + fmt.esc(label) + '</div><div class="time-content">' +
      list.map((j) => '<button type="button" class="day-job ' + fmt.esc(j.status) + '" data-job="' + fmt.esc(j.id) + '">' + dot(j) +
        (j.scheduledTime ? fmt.esc(fmt.time(j.scheduledTime)) + ' · ' : '') + '#' + fmt.esc(j.id) + ' ' + fmt.esc(j.title || j.type || '') +
        ' – ' + fmt.esc(fmt.name(j.customer)) + '<span class="job-tech">' + fmt.esc(fmt.name(j.technician) || 'Unassigned') + '</span></button>').join('') +
      '</div></div>';
  }

  // Initials of a person's name ("Matt Kessler" → "MK").
  function initials(p) {
    const n = fmt.name(p);
    const parts = String(n || '').trim().split(/\s+/).filter(Boolean);
    return parts.length ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() : '';
  }
  // Week chip: time + technician initials, customer, job title (type when there is no title).
  function weekChip(j) {
    const tech = fmt.name(j.technician);
    const what = j.title || j.type || '';
    return '<button type="button" class="job-chip week-chip ' + fmt.esc(j.status) + '" data-job="' + fmt.esc(j.id) + '" title="' + chipTitle(j) + '">' +
      '<span class="chip-top">' + dot(j) + '<span class="chip-time">' + fmt.esc(j.scheduledTime ? fmt.time(j.scheduledTime) : 'Any time') + '</span>' +
        (tech ? '<span class="chip-tech" aria-hidden="true">' + fmt.esc(initials(j.technician)) + '</span><span class="sr-only">, ' + fmt.esc(tech) + '</span>'
          : '<span class="chip-tech none" aria-hidden="true">?</span><span class="sr-only">, unassigned</span>') + '</span>' +
      '<span class="chip-cust">' + fmt.esc(fmt.name(j.customer) || ('Job #' + j.id)) + '</span>' +
      (what ? '<span class="chip-job">' + fmt.esc(what) + (j.title && j.type ? ' · ' + fmt.esc(j.type) : '') + '</span>' : '') +
      '</button>';
  }

  function renderWeek() {
    const ws = startOfWeek(cursor), we = fmt.addDays(ws, 6);
    $('nav-label').textContent = fmt.date(ws, { month: 'short', day: 'numeric' }) + ' – ' + fmt.date(we, { month: 'short', day: 'numeric', year: 'numeric' });
    const list = filtered();
    const today = fmt.todayISO();
    let html = '<div class="calendar-grid week">' + dayNames().map((n) => '<div class="day-header">' + fmt.esc(n) + '</div>').join('');
    for (let i = 0; i < 7; i++) {
      const day = fmt.addDays(ws, i);
      const dj = onDay(list, day);
      html += '<div class="day-cell"><div class="day-head"><div class="day-name">' + fmt.esc(fmt.date(day, { weekday: 'short' })) + '</div>' +
        '<div class="day-num' + (day === today ? ' today' : '') + '">' + d(day).getDate() + '</div></div><div class="day-jobs">' +
        (dj.length ? dj.map(weekChip).join('') : '<div class="no-jobs">No jobs</div>') + '</div></div>';
    }
    $('calendar-container').innerHTML = html + '</div>';
  }

  function renderMonth() {
    const c = d(cursor);
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    $('nav-label').textContent = first.toLocaleDateString(fmt.locale(), { month: 'long', year: 'numeric' });
    const gridStart = startOfWeek(iso(first));
    const list = filtered();
    const today = fmt.todayISO();
    let html = '<div class="calendar-grid month">' + dayNames().map((n) => '<div class="day-header">' + fmt.esc(n) + '</div>').join('');
    for (let i = 0; i < 42; i++) {
      const day = fmt.addDays(gridStart, i);
      const dd = d(day);
      if (i >= 35 && dd.getMonth() !== c.getMonth()) break;
      const other = dd.getMonth() !== c.getMonth();
      const dj = other ? [] : onDay(list, day);
      html += '<div class="day-cell' + (other ? ' other-month' : '') + '"><div class="day-num' + (day === today ? ' today' : '') + '">' + dd.getDate() + '</div>' +
        dj.slice(0, 3).map((j) => '<button type="button" class="job-chip ' + fmt.esc(j.status) + '" data-job="' + fmt.esc(j.id) + '" title="' + chipTitle(j) + '">' + dot(j) + '#' + fmt.esc(j.id) + '</button>').join('') +
        (dj.length > 3 ? '<button type="button" class="job-chip" data-day="' + day + '">+' + (dj.length - 3) + ' more</button>' : '') + '</div>';
    }
    $('calendar-container').innerHTML = html + '</div>';
  }

  function move(dir) {
    if (view === 'day') cursor = fmt.addDays(cursor, dir);
    else if (view === 'week') cursor = fmt.addDays(cursor, 7 * dir);
    else { const c = d(cursor); cursor = iso(new Date(c.getFullYear(), c.getMonth() + dir, 1)); }
    render();
  }

  MBC.page({
    active: 'schedule', title: 'Schedule', roles: 'all',
    async run(user) {
      me = user;
      document.querySelectorAll('.view-toggle button').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; render(); }));
      $('btn-prev').addEventListener('click', () => move(-1));
      $('btn-next').addEventListener('click', () => move(1));
      $('btn-today').addEventListener('click', () => { cursor = fmt.todayISO(); render(); });
      $('date-picker').addEventListener('change', (e) => { if (e.target.value) { cursor = e.target.value; render(); } });
      $('tech-filter').addEventListener('change', render);
      $('calendar-container').addEventListener('click', (e) => {
        const b = e.target.closest('[data-job]');
        if (b) { location.href = 'job.html?id=' + encodeURIComponent(b.dataset.job); return; }
        const more = e.target.closest('[data-day]');
        if (more) { cursor = more.dataset.day; view = 'day'; render(); }
      });
      if (window.matchMedia('(max-width: 600px)').matches) view = 'day';
      if (auth.isTech()) $('filter-row').hidden = true;
      else {
        const r = await api.get('/api/users/technicians').catch(() => null);
        const techs = Array.isArray(r) ? r : ((r && r.technicians) || []);
        $('tech-filter').innerHTML = '<option value="">All ' + fmt.esc((r && r.technicianLabel) || MBC.brand.techLabel) + 's</option>' +
          techs.map((t) => '<option value="' + fmt.esc(t.id) + '">' + fmt.esc(fmt.name(t)) + '</option>').join('');
      }
      const q = auth.isTech() ? '?technicianId=' + encodeURIComponent(me.id) : '';
      try { jobs = await api.get('/api/jobs' + q); } catch (e) { ui.toast(e.message, 'error'); }
      try { presence = (await api.get('/api/presence')) || {}; } catch (e) { presence = {}; }
      render();
    },
  });
})();
