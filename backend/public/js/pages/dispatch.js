/* dispatch.html — job board, filters, new job, export. */
(function () {
  'use strict';
  const { fmt, api, ui } = window.MBC;
  const $ = ui.$;
  const OPEN = ['pending', 'scheduled', 'in-progress'];
  let all = [];

  function render(list) {
    const tb = $('jobs-tbody');
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">' + (all.length ? 'No jobs match these filters.' : 'No jobs yet.') + '</td></tr>'; return; }
    tb.innerHTML = list.map((j) => {
      const href = 'job.html?id=' + encodeURIComponent(j.id);
      return '<tr class="clickable" data-href="' + href + '">' +
        '<td data-label="#"><a class="row-link" href="' + href + '">#' + fmt.esc(j.id) + '</a></td>' +
        '<td data-label="Customer">' + fmt.text(fmt.name(j.customer)) + '</td>' +
        '<td data-label="Job">' + fmt.text(j.title) + '<div class="muted small">' + fmt.esc(j.type || '') + '</div></td>' +
        '<td data-label="' + fmt.esc(MBC.brand.techLabel) + '">' + (j.technician ? fmt.esc(fmt.name(j.technician)) : '<span class="muted">Unassigned</span>') + '</td>' +
        '<td data-label="Status">' + fmt.badge(j.status) + '</td>' +
        '<td data-label="Scheduled">' + fmt.esc(fmt.schedule(j)) + '</td>' +
        '<td data-label="Priority">' + (j.priority && j.priority !== 'normal' ? fmt.badge(j.priority) : '<span class="muted">Normal</span>') + '</td></tr>';
    }).join('');
  }

  function filter() {
    const st = $('status-filter').value, tech = $('tech-filter').value, type = $('type-filter').value;
    const q = $('search-input').value.trim().toLowerCase();
    render(all.filter((j) =>
      (!st || (st === 'open' ? OPEN.includes(j.status) : j.status === st)) &&
      (!tech || (tech === 'none' ? !j.technicianId : String(j.technicianId) === tech)) &&
      (!type || j.type === type) &&
      (!q || [fmt.name(j.customer), j.title, j.notes, j.description, '#' + j.id].join(' ').toLowerCase().includes(q))));
  }

  async function loadJobs() {
    try { all = await api.get('/api/jobs'); filter(); }
    catch (e) { $('jobs-tbody').innerHTML = '<tr><td colspan="7" class="empty error-text">' + fmt.esc(e.message) + '</td></tr>'; }
  }

  async function loadLookups() {
    const b = MBC.brand.current;
    const types = (b.jobTypes || []);
    $('f-type').innerHTML = types.map((t) => '<option>' + fmt.esc(t) + '</option>').join('') || '<option value="Service">Service</option>';
    $('type-filter').innerHTML = '<option value="">All types</option>' + types.map((t) => '<option>' + fmt.esc(t) + '</option>').join('');
    const [techRes, custs] = await Promise.all([
      api.get('/api/users/technicians').catch(() => null),
      api.get('/api/customers').catch(() => []),
    ]);
    const techs = Array.isArray(techRes) ? techRes : ((techRes && techRes.technicians) || []);
    const tl = (techRes && techRes.technicianLabel) || MBC.brand.techLabel;
    $('tech-filter').innerHTML = '<option value="">All ' + fmt.esc(tl) + 's</option><option value="none">Unassigned</option>' +
      techs.map((t) => '<option value="' + fmt.esc(t.id) + '">' + fmt.esc(fmt.name(t)) + '</option>').join('');
    $('f-tech').innerHTML = '<option value="">Unassigned</option>' + techs.map((t) => '<option value="' + fmt.esc(t.id) + '">' + fmt.esc(fmt.name(t)) + '</option>').join('');
    $('f-customer').innerHTML = '<option value="">Select customer&hellip;</option>' +
      custs.map((c) => '<option value="' + fmt.esc(c.id) + '">' + fmt.esc(fmt.name(c)) + (fmt.contactLine(c) ? ' (' + fmt.esc(fmt.contactLine(c)) + ')' : '') + (c.city ? ' – ' + fmt.esc(c.city) : '') + '</option>').join('');
  }

  function openNew(customerId) {
    $('job-form').reset();
    $('f-duration').value = '1.5';
    if (customerId) $('f-customer').value = customerId;
    ui.openModal('modal');
  }

  async function create(e) {
    e.preventDefault();
    const customerId = $('f-customer').value;
    const type = $('f-type').value;
    const title = $('f-title').value.trim() || type;
    if (!customerId) { ui.formError('modal-error', 'Choose a customer.'); return; }
    if (!title) { ui.formError('modal-error', 'Give the job a title.'); return; }
    const date = $('f-date').value, time = $('f-time').value;
    if (time && !date) { ui.formError('modal-error', 'Pick a date for the time you entered.'); return; }
    const body = {
      customerId: Number(customerId), title, type,
      priority: $('f-priority').value,
      technicianId: $('f-tech').value ? Number($('f-tech').value) : undefined,
      scheduledDate: date || undefined, scheduledTime: time || undefined,
      duration: Number($('f-duration').value) || undefined,
      description: $('f-notes').value.trim() || undefined,
      status: date ? 'scheduled' : 'pending',
    };
    $('btn-save').disabled = true;
    try {
      const job = await api.post('/api/jobs', body);
      ui.closeModal('modal');
      ui.toast('Job #' + job.id + ' created.', 'ok');
      await loadJobs();
    } catch (ex) { ui.formError('modal-error', ex); }
    finally { $('btn-save').disabled = false; }
  }

  MBC.page({
    active: 'dispatch', title: 'Dispatch', roles: 'staff',
    async run() {
      ui.applyRoleVisibility();
      ['status-filter', 'tech-filter', 'type-filter'].forEach((id) => $(id).addEventListener('change', filter));
      $('search-input').addEventListener('input', filter);
      $('btn-new').addEventListener('click', () => openNew());
      $('job-form').addEventListener('submit', create);
      $('btn-export').addEventListener('click', () => api.download('/api/exports/jobs', 'jobs.csv').catch((e) => ui.toast(e.message, 'error')));
      await Promise.all([loadLookups(), loadJobs()]);
      const p = new URLSearchParams(location.search);
      if (p.get('new')) openNew(p.get('customerId'));
    },
  });
})();
