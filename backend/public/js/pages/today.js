/*
 * today.html — the technician's day on a phone: their jobs for today in time
 * order with big Navigate / Call / Text Customer / On My Way buttons and a
 * one-tap "Start job" / "Mark complete". Office users see everyone's day and
 * can filter by technician.
 */
(function () {
  'use strict';
  const { fmt, api, auth, ui } = window.MBC;
  const $ = ui.$;
  let me = null;
  let jobs = [];

  function nextStatus(j) {
    if (j.status === 'scheduled' || j.status === 'pending') return { status: 'in-progress', label: 'Start job' };
    if (j.status === 'in-progress') return { status: 'completed', label: 'Mark complete' };
    return null;
  }

  function render() {
    const day = $('day-picker').value || fmt.todayISO();
    const isToday = day === fmt.todayISO();
    $('today-heading').textContent = isToday ? (auth.isTech() ? 'My jobs today' : 'Today') : 'Jobs on ' + fmt.dateLong(day);
    $('today-date').textContent = fmt.date(day, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const tech = $('tech-filter').value;
    const list = jobs
      .filter((j) => j.scheduledDate === day && j.status !== 'cancelled')
      .filter((j) => !auth.isTech() || String(j.technicianId) === String(me.id))
      .filter((j) => !tech || String(j.technicianId) === tech)
      .sort((a, b) => String(a.scheduledTime || '99').localeCompare(String(b.scheduledTime || '99')));
    const el = $('today-list');
    if (!list.length) {
      el.innerHTML = '<div class="card"><div class="empty">' + (isToday ? 'No jobs scheduled for today.' : 'No jobs on this day.') +
        (auth.isTech() ? '<br><a href="schedule.html">See your schedule</a>' : '') + '</div></div>';
      return;
    }
    el.innerHTML = list.map((j) => {
      const c = j.customer || {};
      const nxt = nextStatus(j);
      return '<article class="today-card" data-job="' + fmt.esc(j.id) + '">' +
        '<div class="today-head"><span class="when">' + fmt.esc(j.scheduledTime ? fmt.time(j.scheduledTime) : 'Any time') + '</span>' + fmt.badge(j.status) + '</div>' +
        '<div class="title"><a href="job.html?id=' + encodeURIComponent(j.id) + '">#' + fmt.esc(j.id) + ' ' + fmt.esc(j.title || j.type || 'Job') + '</a></div>' +
        '<div class="who">' + fmt.text(fmt.name(c)) + (c.phone ? ' · ' + fmt.esc(fmt.phone(c.phone)) : '') + '</div>' +
        '<div class="addr">' + fmt.text(fmt.address(c)) + '</div>' +
        (!auth.isTech() ? '<div class="addr">' + fmt.esc(MBC.brand.techLabel) + ': ' + fmt.esc(fmt.name(j.technician) || 'Unassigned') + '</div>' : '') +
        '<div class="big-actions">' + MBC.field.actionsHtml(j, auth.isTech() ? me : (j.technician || me)) +
        (nxt ? '<button class="btn btn-outline wide" type="button" data-advance="' + fmt.esc(j.id) + '" data-status="' + nxt.status + '">' + nxt.label + '</button>' : '') +
        '<a class="btn btn-outline wide" href="job.html?id=' + encodeURIComponent(j.id) + '">Open job</a></div>' +
        '</article>';
    }).join('');
  }

  async function load() {
    try {
      const q = auth.isTech() ? '?technicianId=' + encodeURIComponent(me.id) : '';
      jobs = await api.get('/api/jobs' + q);
      render();
    } catch (e) { $('today-list').innerHTML = '<div class="card"><div class="empty error-text">' + fmt.esc(e.message) + '</div></div>'; }
  }

  async function advance(id, status) {
    const j = jobs.find((x) => String(x.id) === String(id));
    if (!j) return;
    try {
      const updated = await api.patch('/api/jobs/' + encodeURIComponent(id), { status, version: j.version });
      Object.assign(j, { status: updated.status, version: updated.version, completedAt: updated.completedAt });
      ui.toast('Job #' + id + ': ' + fmt.statusLabel(status).toLowerCase() + '.', 'ok');
      render();
    } catch (e) { ui.toast(e.message, 'error'); if (e.status === 409) await load(); }
  }

  MBC.page({
    active: 'today', title: 'Today', roles: 'all',
    async run(user) {
      me = user;
      $('day-picker').value = fmt.todayISO();
      $('day-picker').addEventListener('change', render);
      $('today-list').addEventListener('click', (e) => {
        const b = e.target.closest('[data-advance]');
        if (b) advance(b.getAttribute('data-advance'), b.getAttribute('data-status'));
      });
      if (!auth.isTech()) {
        $('tech-filter-row').hidden = false;
        $('tech-filter').addEventListener('change', render);
        api.get('/api/users/technicians').then((r) => {
          const techs = Array.isArray(r) ? r : ((r && r.technicians) || []);
          $('tech-filter').innerHTML = '<option value="">Everyone</option>' + techs.map((t) => '<option value="' + fmt.esc(t.id) + '">' + fmt.esc(fmt.name(t)) + '</option>').join('');
        }).catch(() => {});
      }
      await load();
    },
  });
})();
