/* communications.html — per-customer timeline (calls, emails, texts, notes + quotes/invoices). All text escaped. */
(function () {
  'use strict';
  const { fmt, api, ui } = window.MBC;
  const $ = ui.$;
  let items = [];

  function render() {
    const type = $('type-filter').value;
    const list = type ? items.filter((t) => t.type === type) : items;
    const el = $('timeline');
    if (!list.length) { el.innerHTML = '<div class="card"><div class="empty">No communications found.</div></div>'; return; }
    el.innerHTML = list.map((t) => {
      const cls = String(t.type || '').replace(/[^a-z]/gi, '');
      return '<div class="timeline-item ' + cls + '"><div class="timeline-header"><span><span class="timeline-type">' + fmt.esc(t.type) + '</span>' +
        (t.direction ? ' · ' + fmt.esc(t.direction) : '') + (t.customerName ? ' · ' + fmt.esc(t.customerName) : '') + '</span>' +
        '<span>' + fmt.esc(fmt.dateTime(t.createdAt)) + '</span></div>' +
        (t.subject ? '<div class="timeline-subject">' + fmt.esc(t.subject) + '</div>' : '') +
        (t.body ? '<div class="timeline-body">' + fmt.esc(t.body) + '</div>' : '') +
        (t.jobId ? '<div class="small"><a href="job.html?id=' + encodeURIComponent(t.jobId) + '">Job #' + fmt.esc(t.jobId) + '</a></div>' : '') + '</div>';
    }).join('');
  }

  async function load() {
    const cid = $('customer-filter').value;
    try {
      if (cid) {
        const d = await api.get('/api/communications?customerId=' + encodeURIComponent(cid));
        items = (d && d.timeline) || [];
      } else {
        const d = await api.get('/api/communications');
        items = (Array.isArray(d) ? d : (d.communications || [])).slice(0, 100).map((c) => Object.assign({}, c, { customerName: fmt.name(c.customer) }));
      }
      render();
    } catch (e) { $('timeline').innerHTML = '<div class="card"><div class="empty error-text">' + fmt.esc(e.message) + '</div></div>'; }
  }

  async function save(e) {
    e.preventDefault();
    const customerId = $('f-customer').value;
    if (!customerId) { ui.formError('modal-error', 'Choose a customer.'); return; }
    const body = { customerId: Number(customerId), type: $('f-type').value, direction: $('f-direction').value, subject: $('f-subject').value.trim() || undefined, body: $('f-body').value.trim() || undefined };
    if (!body.subject && !body.body) { ui.formError('modal-error', 'Add a subject or some details.'); return; }
    $('btn-save').disabled = true;
    try {
      await api.post('/api/communications', body);
      ui.closeModal('modal'); $('comm-form').reset();
      ui.toast('Communication logged.', 'ok');
      await load();
    } catch (ex) { ui.formError('modal-error', ex); }
    finally { $('btn-save').disabled = false; }
  }

  MBC.page({
    active: 'communications', title: 'Communications', roles: 'staff',
    async run() {
      const custs = await api.get('/api/customers').catch(() => []);
      const opts = custs.map((c) => '<option value="' + fmt.esc(c.id) + '">' + fmt.esc(fmt.name(c)) + '</option>').join('');
      $('customer-filter').innerHTML = '<option value="">All customers (recent)</option>' + opts;
      $('f-customer').innerHTML = '<option value="">Select customer…</option>' + opts;
      const preset = new URLSearchParams(location.search).get('customerId');
      if (preset) { $('customer-filter').value = preset; $('f-customer').value = preset; }
      $('customer-filter').addEventListener('change', () => { $('f-customer').value = $('customer-filter').value; load(); });
      $('type-filter').addEventListener('change', render);
      $('btn-new').addEventListener('click', () => ui.openModal('modal'));
      $('comm-form').addEventListener('submit', save);
      await load();
    },
  });
})();
