/* pricebook.html — trade pricebook (API: { industry, items[] }, price, PATCH). Editing is admin-only. */
(function () {
  'use strict';
  const { fmt, api, auth, ui } = window.MBC;
  const $ = ui.$;
  let items = [];
  let editId = null;

  function taxText(key) {
    const r = fmt.tax().rates.find((x) => x.key === String(key).toLowerCase());
    return r ? '+ ' + fmt.percent(r.rate) + ' ' + fmt.tax().label : '';
  }
  function render() {
    const q = $('search-input').value.trim().toLowerCase();
    const cat = $('category-filter').value;
    const list = items.filter((i) => (!q || [i.name, i.description, i.category].join(' ').toLowerCase().includes(q)) && (!cat || i.category === cat));
    const admin = auth.isAdmin();
    $('items-tbody').innerHTML = list.length ? list.map((i) =>
      '<tr><td data-label="Item"><strong>' + fmt.text(i.name) + '</strong></td>' +
      '<td data-label="Category">' + fmt.text(i.category) + '</td>' +
      '<td data-label="Description">' + fmt.text(i.description) + '</td>' +
      '<td data-label="Price" class="num">' + fmt.money(i.price) + (fmt.tax().enabled && i.taxRateKey ? '<div class="muted small">' + fmt.esc(taxText(i.taxRateKey)) + '</div>' : '') + '</td>' +
      '<td data-label="Unit">' + fmt.esc(i.unit || 'each') + '</td>' +
      (admin ? '<td data-label=""><button class="btn btn-outline btn-sm" type="button" data-edit="' + fmt.esc(i.id) + '">Edit</button></td>' : '') + '</tr>').join('')
      : '<tr><td colspan="6" class="empty">' + (items.length ? 'No items match.' : 'No items in the pricebook yet.') + '</td></tr>';
  }

  async function load() {
    try {
      const d = await api.get('/api/pricebook');
      items = Array.isArray(d) ? d : (d.items || []);
      if (d && d.industry) $('page-title').textContent = d.industry + ' Pricebook';
    } catch (e) { $('items-tbody').innerHTML = '<tr><td colspan="6" class="empty error-text">' + fmt.esc(e.message) + '</td></tr>'; return; }
    const cats = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
    const sel = $('category-filter'); const cur = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' + cats.map((c) => '<option>' + fmt.esc(c) + '</option>').join('');
    sel.value = cur;
    $('category-list').innerHTML = cats.map((c) => '<option value="' + fmt.esc(c) + '">').join('');
    render();
  }

  function open(item) {
    editId = item ? item.id : null;
    $('modal-title').textContent = item ? 'Edit Item' : 'Add Pricebook Item';
    $('f-name').value = item ? item.name || '' : '';
    $('f-category').value = item ? item.category || '' : '';
    $('f-desc').value = item ? item.description || '' : '';
    $('f-price').value = item && fmt.num(item.price) != null ? item.price : '';
    $('f-unit').value = item ? item.unit || '' : '';
    if (fmt.tax().enabled) $('f-tax').value = item && item.taxRateKey ? String(item.taxRateKey).toLowerCase() : '';
    $('btn-archive').hidden = !item;
    ui.openModal('modal');
  }

  async function save(e) {
    e.preventDefault();
    const price = $('f-price').value === '' ? NaN : Number($('f-price').value);
    const body = { name: $('f-name').value.trim(), category: $('f-category').value.trim(), description: $('f-desc').value.trim() || null, price, unit: $('f-unit').value.trim() || 'each' };
    if (fmt.tax().enabled) body.taxRateKey = $('f-tax').value || null;
    if (!body.name || !body.category) { ui.formError('modal-error', 'Name and category are required.'); return; }
    if (!(price >= 0)) { ui.formError('modal-error', 'Enter a price of 0 or more.'); return; }
    $('btn-save').disabled = true;
    try {
      if (editId) await api.patch('/api/pricebook/' + editId, body);
      else await api.post('/api/pricebook', body);
      ui.closeModal('modal');
      ui.toast('Pricebook updated.', 'ok');
      await load();
    } catch (ex) { ui.formError('modal-error', ex); }
    finally { $('btn-save').disabled = false; }
  }

  async function archive() {
    if (!editId || !confirm('Archive this item? It will no longer appear in the pricebook or quote builder.')) return;
    try { await api.del('/api/pricebook/' + editId); ui.closeModal('modal'); ui.toast('Item archived.', 'ok'); await load(); }
    catch (ex) { ui.formError('modal-error', ex); }
  }

  MBC.page({
    active: 'pricebook', title: 'Pricebook', roles: 'staff',
    async run() {
      if (MBC.brand.industry) $('page-title').textContent = MBC.brand.industry + ' Pricebook';
      ui.applyRoleVisibility();
      const tax = fmt.tax();
      if (tax.enabled) {
        $('tax-group').hidden = false;
        $('l-tax').textContent = tax.label + ' rate';
        $('f-tax').innerHTML = '<option value="">' + fmt.esc(tax.defaultKey ? 'Default (' + tax.defaultKey + ')' : 'No ' + tax.label) + '</option>' +
          tax.rates.map((r) => '<option value="' + fmt.esc(r.key) + '">' + fmt.esc(r.key.charAt(0).toUpperCase() + r.key.slice(1) + ' ' + fmt.percent(r.rate)) + '</option>').join('');
      }
      $('search-input').addEventListener('input', render);
      $('category-filter').addEventListener('change', render);
      $('btn-new').addEventListener('click', () => open(null));
      $('item-form').addEventListener('submit', save);
      $('btn-archive').addEventListener('click', archive);
      $('items-tbody').addEventListener('click', (e) => {
        const b = e.target.closest('[data-edit]');
        if (b) open(items.find((i) => String(i.id) === b.dataset.edit));
      });
      await load();
    },
  });
})();
