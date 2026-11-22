/* customer-detail.html — edit contact info (optimistic locking), job + invoice history. */
(function () {
  'use strict';
  const { fmt, api, ui } = window.MBC;
  const $ = ui.$;
  const id = new URLSearchParams(location.search).get('id');
  let customer = null;
  let addrForm = null;

  function fail(msg) { $('loading-msg').hidden = true; $('customer-content').hidden = true; $('error-msg').textContent = msg; $('error-msg').hidden = false; }

  function fill(c) {
    customer = c;
    const name = fmt.name(c) || 'Customer #' + c.id;
    $('customer-name').textContent = name;
    MBC.brand.apply(MBC.brand.current, name);
    $('e-first').value = c.firstName || ''; $('e-last').value = c.lastName || '';
    $('e-phone').value = fmt.phone(c.phone) || ''; $('e-email').value = c.email || '';
    $('e-address').value = c.address || ''; $('e-address2').value = c.addressLine2 || ''; $('e-city').value = c.city || '';
    $('e-state').value = c.state || ''; $('e-zip').value = c.zip || ''; $('e-notes').value = c.notes || '';
    const digits = fmt.phoneDigits(c.phone);
    $('btn-call').hidden = !digits; $('btn-text').hidden = !digits;
    $('btn-call').href = 'tel:' + digits;
    $('btn-text').href = 'sms:' + digits;
    $('btn-comms').href = 'communications.html?customerId=' + encodeURIComponent(c.id);
    $('btn-new-job').href = 'dispatch.html?new=1&customerId=' + encodeURIComponent(c.id);

    const jobs = c.jobs || [];
    $('stat-jobs').textContent = jobs.length;
    $('stat-open').textContent = jobs.filter((j) => ['pending', 'scheduled', 'in-progress'].includes(j.status)).length;
    $('jobs-tbody').innerHTML = jobs.length ? jobs.map((j) => {
      const href = 'job.html?id=' + encodeURIComponent(j.id);
      return '<tr class="clickable" data-href="' + href + '"><td data-label="#"><a class="row-link" href="' + href + '">#' + fmt.esc(j.id) + '</a></td>' +
        '<td data-label="Job">' + fmt.text(j.title) + '<div class="muted small">' + fmt.esc(j.type || '') + '</div></td>' +
        '<td data-label="' + fmt.esc(MBC.brand.techLabel) + '">' + fmt.text(fmt.name(j.technician)) + '</td>' +
        '<td data-label="Status">' + fmt.badge(j.status) + '</td>' +
        '<td data-label="Scheduled">' + fmt.esc(fmt.schedule(j)) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No jobs yet.</td></tr>';

    const invoices = jobs.filter((j) => j.invoice).map((j) => Object.assign({ jobTitle: j.title }, j.invoice));
    $('stat-invoiced').textContent = fmt.money(invoices.filter((i) => i.status !== 'void').reduce((s, i) => s + (fmt.num(i.amount) || 0), 0));
    $('invoices-tbody').innerHTML = invoices.length ? invoices.map((i) => {
      const href = 'job.html?id=' + encodeURIComponent(i.jobId);
      return '<tr class="clickable" data-href="' + href + '"><td data-label="Number">' + fmt.esc(i.number || '#' + i.id) + '</td>' +
        '<td data-label="Job"><a class="row-link" href="' + href + '">' + fmt.text(i.jobTitle) + '</a></td>' +
        '<td data-label="Status">' + fmt.badge(i.status) + '</td>' +
        '<td data-label="Total" class="num">' + fmt.esc(fmt.money(i.amount, i.currency)) + '</td>' +
        '<td data-label="Due">' + fmt.esc(i.dueDate ? fmt.date(String(i.dueDate).slice(0, 10)) : fmt.DASH) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No invoices.</td></tr>';
    $('loading-msg').hidden = true;
    $('customer-content').hidden = false;
  }

  async function load() {
    try { fill(await api.get('/api/customers/' + encodeURIComponent(id))); }
    catch (e) { fail(e.status === 404 ? 'Customer not found.' : e.message); }
  }

  async function save(e) {
    e.preventDefault();
    const v = (k) => $(k).value.trim();
    const body = {
      firstName: v('e-first'), lastName: v('e-last'), phone: v('e-phone'), email: v('e-email') || null,
      address: v('e-address'), addressLine2: v('e-address2') || null, city: v('e-city') || null, state: v('e-state') || null, zip: v('e-zip') || null, notes: v('e-notes') || null,
      version: customer.version,
    };
    if (!body.firstName || !body.lastName || !body.phone) { ui.formError('edit-error', 'First name, last name and phone are required.'); return; }
    const bad = addrForm.check(addrForm.read());
    if (bad === 'BAD_POSTCODE') { ui.formError('edit-error', addrForm.postcodeMessage()); return; }
    if (bad) { ui.formError('edit-error', 'Please fill in: ' + bad.join(', ') + '.'); return; }
    ui.formError('edit-error', null);
    $('btn-save').disabled = true;
    try {
      const updated = await api.patch('/api/customers/' + encodeURIComponent(id), body);
      customer.version = updated.version;
      ui.toast('Customer saved.', 'ok');
      await load();
    } catch (ex) { ui.formError('edit-error', ex); }
    finally { $('btn-save').disabled = false; }
  }

  MBC.page({
    active: 'customers', title: 'Customer', roles: 'staff',
    async run() {
      addrForm = ui.addressForm('e');
      ui.applyRoleVisibility();
      if (!id) { fail('No customer selected.'); return; }
      $('edit-form').addEventListener('submit', save);
      await load();
    },
  });
})();
