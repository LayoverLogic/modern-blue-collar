/*
 * pricebook.html — trade pricebook (API: { industry, items[] }, price, sku, PATCH). Editing is admin-only.
 * Import CSV (admin): GET /api/pricebook/import/template.csv; POST /api/pricebook/import?dryRun=true
 * (multipart file) → counts + problem rows + changes; then dryRun=false to write.
 */
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
    const list = items.filter((i) => (!q || [i.name, i.sku, i.description, i.category].join(' ').toLowerCase().includes(q)) && (!cat || i.category === cat));
    const admin = auth.isAdmin();
    $('items-tbody').innerHTML = list.length ? list.map((i) =>
      '<tr><td data-label="Item"><strong>' + fmt.text(i.name) + '</strong>' + (i.sku ? '<div class="muted small">' + fmt.esc(i.sku) + '</div>' : '') + '</td>' +
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
    $('f-sku').value = item ? item.sku || '' : '';
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
    const body = { name: $('f-name').value.trim(), sku: $('f-sku').value.trim() || null, category: $('f-category').value.trim(), description: $('f-desc').value.trim() || null, price, unit: $('f-unit').value.trim() || 'each' };
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
    } catch (ex) { ui.formError('modal-error', ex.code === 'DUPLICATE' ? 'Another item already uses that SKU.' : ex); }
    finally { $('btn-save').disabled = false; }
  }

  // ── Import CSV ──────────────────────────────────────────────────────────────
  let pbFile = null;
  let pbReport = null;
  const PB_COUNTS = [['rows', 'Rows'], ['created', 'New'], ['updated', 'Updated'], ['skipped', 'Unchanged'], ['errored', 'Problems']];
  function openImport() {
    $('pb-import-form').reset(); pbFile = null; pbReport = null;
    $('pb-report').hidden = true; $('btn-pb-commit').hidden = true;
    ui.formError('pb-import-error', null);
    ui.openModal('import-modal');
  }
  function showReport(r) {
    pbReport = r;
    const c = r.counts || {};
    const commit = r.mode === 'commit';
    const banner = $('pb-banner');
    banner.className = 'notice small ' + (commit ? (r.committed ? 'ok' : 'error') : 'info');
    banner.innerHTML = commit
      ? (r.committed ? '<strong>Imported.</strong> ' + fmt.esc(c.created || 0) + ' new and ' + fmt.esc(c.updated || 0) + ' updated item(s).' : '<strong>Nothing was imported.</strong> Fix the problems and try again.')
      : '<strong>Dry run — nothing has been changed.</strong> ' + fmt.esc((r.file && r.file.rows) || 0) + ' row(s) checked.';
    $('pb-counts').innerHTML = PB_COUNTS.map(([k, l]) => '<div class="count-tile' + (k === 'errored' && c[k] ? ' warn' : '') + '" data-count="' + k + '"><div class="label">' + l + '</div><div class="value">' + fmt.esc(Number(c[k] || 0)) + '</div></div>').join('');
    const cols = r.columns || {};
    $('pb-columns').textContent = (cols.unknown && cols.unknown.length ? 'Columns not used: ' + cols.unknown.join(', ') + '. ' : '') + (cols.recognised ? 'Columns read: ' + cols.recognised.join(', ') + '.' : '');
    const rows = r.rows || [];
    const errs = [];
    rows.filter((x) => x.outcome === 'errored').forEach((x) => (x.errors && x.errors.length ? x.errors : [{ field: '', error: x.reason || 'not valid' }]).forEach((e) => errs.push([x, e])));
    $('pb-errors-wrap').hidden = !errs.length;
    $('pb-errors').querySelector('tbody').innerHTML = errs.slice(0, 200).map(([x, e]) =>
      '<tr><td data-label="Row">' + fmt.esc(x.row) + (x.line ? '<div class="muted small">line ' + fmt.esc(x.line) + '</div>' : '') + '</td>' +
      '<td data-label="Item">' + fmt.text(x.key) + '</td><td data-label="Field">' + fmt.text(e.field) + '</td>' +
      '<td data-label="Problem" class="wrap">' + fmt.text(e.error || e.code) + '</td></tr>').join('');
    const changed = rows.filter((x) => x.outcome === 'created' || x.outcome === 'updated');
    $('pb-changes-wrap').hidden = !changed.length;
    $('pb-changes').querySelector('tbody').innerHTML = changed.slice(0, 100).map((x) =>
      '<tr><td data-label="Row">' + fmt.esc(x.row) + '</td><td data-label="Item">' + fmt.text(x.key) + '</td>' +
      '<td data-label="Outcome">' + (x.outcome === 'created' ? 'New' : 'Updated') + '</td>' +
      '<td data-label="Changes" class="wrap small">' + (x.changes ? Object.entries(x.changes).map(([f, ch]) => fmt.esc(f) + ': ' + fmt.esc(ch && ch.from != null ? ch.from : '—') + ' → ' + fmt.esc(ch ? ch.to : '')).join('<br>') : '') + '</td></tr>').join('');
    $('pb-report').hidden = false;
    const n = Number(c.created || 0) + Number(c.updated || 0);
    $('btn-pb-commit').hidden = commit || !n;
    $('btn-pb-commit').textContent = 'Import ' + n + ' row' + (n === 1 ? '' : 's') + (c.errored ? ' (skip ' + c.errored + ' with problems)' : '');
  }
  async function pbRun(dryRun) {
    const inp = $('pb-file');
    if (dryRun && inp.files && inp.files[0]) pbFile = inp.files[0];
    if (!pbFile) { ui.formError('pb-import-error', 'Choose a CSV file first.'); return; }
    ui.formError('pb-import-error', null);
    const btn = dryRun ? $('btn-pb-dry') : $('btn-pb-commit');
    btn.disabled = true;
    try {
      const fd = new FormData(); fd.append('file', pbFile, pbFile.name);
      const r = await api.upload('/api/pricebook/import?dryRun=' + (dryRun ? 'true' : 'false'), fd);
      showReport(r);
      if (!dryRun) await load();
    } catch (ex) { ui.formError('pb-import-error', ex); }
    finally { btn.disabled = false; }
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
      $('btn-import').addEventListener('click', openImport);
      $('pb-import-form').addEventListener('submit', (e) => { e.preventDefault(); pbRun(true); });
      $('btn-pb-commit').addEventListener('click', () => pbRun(false));
      $('pb-file').addEventListener('change', () => { $('btn-pb-commit').hidden = true; });
      $('btn-pb-template').addEventListener('click', () => api.download('/api/pricebook/import/template.csv', 'pricebook_template.csv').catch((e) => ui.toast(ui.errMsg(e), 'error')));
      $('items-tbody').addEventListener('click', (e) => {
        const b = e.target.closest('[data-edit]');
        if (b) open(items.find((i) => String(i.id) === b.dataset.edit));
      });
      await load();
    },
  });
})();
