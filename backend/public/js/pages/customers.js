/* customers.html — list, search, create, export. */
(function () {
  'use strict';
  const { fmt, api, ui } = window.MBC;
  const $ = ui.$;
  let all = [];

  function render(list) {
    const tb = $('customers-tbody');
    if (!list.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">' + (all.length ? 'No customers match.' : 'No customers yet.') + '</td></tr>'; return; }
    tb.innerHTML = list.map((c) => {
      const href = 'customer-detail.html?id=' + encodeURIComponent(c.id);
      return '<tr class="clickable" data-href="' + href + '">' +
        '<td data-label="Name"><a class="row-link" href="' + href + '">' + fmt.text(fmt.name(c)) + '</a></td>' +
        '<td data-label="Phone">' + fmt.text(c.phone) + '</td>' +
        '<td data-label="Email">' + fmt.text(c.email) + '</td>' +
        '<td data-label="Address">' + fmt.text(fmt.address(c)) + '</td>' +
        '<td data-label="Jobs" class="num">' + fmt.esc((c._count && c._count.jobs) || 0) + '</td></tr>';
    }).join('');
  }

  function filter() {
    const q = $('search-input').value.trim().toLowerCase();
    const region = $('region-filter').value;
    render(all.filter((c) => {
      const hay = [fmt.name(c), c.phone, c.email, fmt.address(c)].join(' ').toLowerCase();
      return (!q || hay.includes(q)) && (!region || c.state === region);
    }));
  }

  async function load() {
    try { all = await api.get('/api/customers'); }
    catch (e) { $('customers-tbody').innerHTML = '<tr><td colspan="5" class="empty error-text">' + fmt.esc(e.message) + '</td></tr>'; return; }
    const sel = $('region-filter');
    const current = sel.value;
    const regions = [...new Set(all.map((c) => c.state).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All areas</option>' + regions.map((r) => '<option>' + fmt.esc(r) + '</option>').join('');
    sel.value = current;
    filter();
  }

  async function create(e) {
    e.preventDefault();
    const v = (id) => $(id).value.trim();
    const labels = fmt.addressLabels();
    const body = {
      firstName: v('f-first'), lastName: v('f-last'), phone: v('f-phone'), email: v('f-email') || undefined,
      address: v('f-address'), city: v('f-city'), state: v('f-state') || undefined, zip: v('f-zip'),
      type: $('f-type').value, notes: v('f-notes') || undefined,
    };
    const missing = [['First name', body.firstName], ['Last name', body.lastName], ['Phone', body.phone], ['Street address', body.address], ['Town / City', body.city], [labels.postal, body.zip]]
      .filter((x) => !x[1]).map((x) => x[0]);
    if (missing.length) { ui.formError('modal-error', 'Please fill in: ' + missing.join(', ') + '.'); return; }
    $('btn-save').disabled = true;
    try {
      const c = await api.post('/api/customers', body);
      ui.closeModal('modal');
      $('customer-form').reset();
      ui.toast('Customer ' + fmt.name(c) + ' created.', 'ok');
      await load();
    } catch (ex) { ui.formError('modal-error', ex); }
    finally { $('btn-save').disabled = false; }
  }

  MBC.page({
    active: 'customers', title: 'Customers', roles: 'staff',
    async run() {
      const labels = fmt.addressLabels();
      $('l-state').textContent = labels.region;
      $('l-zip').textContent = labels.postal + ' *';
      $('f-state').placeholder = labels.country === 'US' ? (MBC.brand.current.defaultState || '') : '';
      ui.applyRoleVisibility();
      $('btn-new').addEventListener('click', () => ui.openModal('modal'));
      $('customer-form').addEventListener('submit', create);
      $('search-input').addEventListener('input', filter);
      $('region-filter').addEventListener('change', filter);
      $('btn-export').addEventListener('click', () => api.download('/api/exports/customers', 'customers.csv').catch((e) => ui.toast(e.message, 'error')));
      await load();
    },
  });
})();
