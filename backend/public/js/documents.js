/*
 * js/documents.js — quotes & invoices with line items (Phase 2b), shared by
 * job.html (editor + cards) and print.html (read-only lines and totals).
 *
 *   MBC.docs.totals(lines, { reverseCharge })   display-only totals, same rules as
 *                                               the server (round half-up per line,
 *                                               tax per rate group, half-up)
 *   MBC.docs.linesHtml(doc)                     read-only lines + subtotal / tax / total
 *   MBC.docs.editor(host, opts)                 the line-item editor (see below)
 *   MBC.docs.label(type) / MBC.docs.ref(doc, type)   "Quote" / "Quote Q-0001"
 *
 * Totals shown while editing are a preview only: the server computes the stored
 * lineTotal / subtotal / taxTotal / amount, and pages re-render from the saved
 * document after every save.
 *
 * Tax rates come from GET /api/brand → locale.taxRates (MBC.fmt.tax()); with no
 * rates configured the tax column is hidden and lines are sent without a key.
 * Everything that reaches innerHTML goes through MBC.fmt.esc.
 */
(function () {
  'use strict';
  const MBC = (window.MBC = window.MBC || {});
  const fmt = MBC.fmt;
  const esc = (v) => fmt.esc(v);

  // ── Exact decimal maths in integers (quantity: 3 dp, price: 2 dp, rate: 3 dp) ─
  function scaled(v, dp) {
    const s = String(v == null ? '' : v).trim();
    const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (!m[2] && !m[3])) return null;
    const frac = (m[3] || '');
    if (frac.length > dp && /[1-9]/.test(frac.slice(dp))) return null; // too many decimals
    const n = Number((m[2] || '0') + (frac + '000000').slice(0, dp));
    return Number.isSafeInteger(n) ? (m[1] ? -n : n) : null;
  }
  // round half-up (away from zero) of a / b for integers, b > 0
  function divRound(a, b) { const s = a < 0 ? -1 : 1; return s * Math.floor((Math.abs(a) + b / 2) / b); }

  function rateFor(key) {
    if (key == null || key === '') return 0;
    const r = fmt.tax().rates.find((x) => x.key === String(key).toLowerCase());
    return r ? r.rate : 0;
  }

  /** lines: [{quantity, unitPrice, taxRateKey, taxRate?}] → totals in currency units. */
  function totals(lines, opts) {
    const reverseCharge = !!(opts && opts.reverseCharge);
    let subtotal = 0, ok = true;
    const groups = new Map();
    const out = (lines || []).map((l) => {
      const q = scaled(l.quantity, 3), p = scaled(l.unitPrice, 2);
      if (q == null || p == null) { ok = false; return { lineTotal: null }; }
      const cents = divRound(q * p, 1000);
      subtotal += cents;
      // Saved lines keep the rate they were saved with; editor lines use today's rate for their key.
      const rate = opts && opts.saved ? (Number(l.taxRate) || 0) : rateFor(l.taxRateKey);
      const k = (l.taxRateKey || '') + '|' + rate;
      if (!groups.has(k)) groups.set(k, { taxRateKey: l.taxRateKey || null, rate, net: 0 });
      groups.get(k).net += cents;
      return { lineTotal: cents / 100 };
    });
    let taxTotal = 0;
    const breakdown = [...groups.values()].map((g) => {
      const rm = scaled(g.rate, 3) || 0;
      const tax = reverseCharge ? 0 : divRound(g.net * rm, 100000);
      taxTotal += tax;
      return { taxRateKey: g.taxRateKey, rate: g.rate, net: g.net / 100, tax: tax / 100 };
    });
    return { ok, lines: out, subtotal: subtotal / 100, taxTotal: taxTotal / 100, total: (subtotal + taxTotal) / 100, breakdown };
  }

  const LABEL = { quote: 'Quote', invoice: 'Invoice' };
  function label(type) { return LABEL[type] || 'Document'; }
  function ref(doc, type) { return label(type) + ' ' + (doc && doc.number ? doc.number : '#' + (doc && doc.id)); }
  function taxName(key, rate) {
    const t = fmt.tax();
    const k = key ? String(key).charAt(0).toUpperCase() + String(key).slice(1) : '';
    return (k ? k + ' ' : '') + fmt.percent(rate) + (t.label ? ' ' + t.label : '');
  }
  function hasTax(doc) {
    return fmt.tax().enabled || (doc && (Number(doc.taxTotal) > 0 || (doc.lines || []).some((l) => Number(l.taxRate) > 0)));
  }

  /** Read-only lines + totals for a saved document (GET /api/quotes|invoices/:id). */
  function linesHtml(doc, opts) {
    opts = opts || {};
    const cur = doc.currency;
    const lines = doc.lines || [];
    const withTax = hasTax(doc);
    // Short "Tax" header (the column only holds a rate); the full label ("Sales tax", "VAT")
    // is in the title / accessible name and in each cell's data-label on phones.
    const taxLabel = fmt.tax().label;
    const taxHead = taxLabel.length > 4 ? '<th class="num" title="' + esc(taxLabel) + '"><span aria-hidden="true">Tax</span><span class="sr-only">' + esc(taxLabel) + '</span></th>'
      : '<th class="num">' + esc(taxLabel) + '</th>';
    const head = '<thead><tr><th class="desc">Description</th><th class="num">Qty</th><th class="num">Unit price</th>' +
      (withTax ? taxHead : '') + '<th class="num">Amount</th></tr></thead>';
    let body;
    if (lines.length) {
      body = lines.map((l) => '<tr><td data-label="Description" class="desc">' + esc(l.description) + '</td>' +
        '<td data-label="Qty" class="num">' + esc(fmt.num(l.quantity)) + '</td>' +
        '<td data-label="Unit price" class="num">' + esc(fmt.money(l.unitPrice, cur)) + '</td>' +
        (withTax ? '<td data-label="' + esc(fmt.tax().label) + '" class="num">' + esc(l.taxRateKey || Number(l.taxRate) ? fmt.percent(l.taxRate) : '—') + '</td>' : '') +
        '<td data-label="Amount" class="num">' + esc(fmt.money(l.lineTotal, cur)) + '</td></tr>').join('');
    } else {
      // Older single-amount document: one line from its notes.
      body = '<tr><td data-label="Description" class="desc">' + esc(doc.notes || (opts.jobTitle || 'Work as agreed')) + '</td><td data-label="Qty" class="num">1</td>' +
        '<td data-label="Unit price" class="num">' + esc(fmt.money(doc.amount, cur)) + '</td>' + (withTax ? '<td class="num" data-label="' + esc(fmt.tax().label) + '">—</td>' : '') +
        '<td data-label="Amount" class="num">' + esc(fmt.money(doc.amount, cur)) + '</td></tr>';
    }
    return '<table class="doc-lines responsive">' + head + '<tbody>' + body + '</tbody></table>' + totalsHtml(doc);
  }

  /** Subtotal / tax per rate / total of a saved document (server numbers). */
  function totalsHtml(doc) {
    const cur = doc.currency;
    const lines = doc.lines || [];
    // A single-amount document has subtotal = amount (older rows may say 0).
    const subtotal = lines.length || Number(doc.subtotal) > 0 ? doc.subtotal : doc.amount;
    const rows = [['Subtotal', fmt.money(subtotal, cur), 'doc-subtotal']];
    if (hasTax(doc) && lines.length) {
      // The server's breakdown (GET /:id print block) wins; else from the saved lines' own rates.
      const groups = doc.print && Array.isArray(doc.print.taxBreakdown) ? doc.print.taxBreakdown
        : totals(lines, { reverseCharge: doc.reverseCharge, saved: true }).breakdown;
      groups.filter((g) => Number(g.rate) > 0 || Number(g.tax) > 0).forEach((g) =>
        rows.push([taxName(g.taxRateKey, g.rate) + ' on ' + fmt.money(g.net, cur), fmt.money(g.tax, cur), 'doc-tax']));
      rows.push([fmt.tax().label + ' total', fmt.money(doc.taxTotal, cur), 'doc-taxtotal']);
    }
    rows.push(['Total', fmt.money(doc.amount, cur), 'doc-total']);
    return '<div class="doc-totals">' + rows.map((r) => '<div class="' + r[2] + '"><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>').join('') + '</div>';
  }

  // ── Editor ─────────────────────────────────────────────────────────────────
  /*
   * MBC.docs.editor(host, {
   *   type: 'quote'|'invoice', doc (saved document to edit, or null), pricebook: [items],
   *   currency, jobTitle,
   *   onSave(body) → Promise   body = { lines[], notes, reverseCharge?, dueDate? }
   *   onCancel()
   * })
   * Choosing a pricebook item in #de-item adds it as a line; #de-add adds an
 * empty free-text line. Element ids (stable, used by tests): de-item, de-add, de-lines, de-subtotal,
   * de-tax, de-total, de-notes, de-due, de-reverse, de-error, de-save, de-cancel.
   * Per line: [data-line=i] with [data-f=description|quantity|unitPrice|taxRateKey].
   */
  function editor(host, opts) {
    const type = opts.type;
    const tax = fmt.tax();
    // GAP-16: the reverse-charge box only where the brand says reverse charge applies (VAT with
    // RCT) — never for US sales tax. A saved reverse-charge document keeps its box so it can be undone.
    const rcBox = tax.enabled && (fmt.reverseChargeAvailable() || !!(opts.doc && opts.doc.reverseCharge));
    const cur = opts.currency || (opts.doc && opts.doc.currency) || fmt.currency();
    const pricebook = opts.pricebook || [];
    let lines = (opts.doc && opts.doc.lines || []).map((l) => ({
      description: l.description || '', quantity: String(fmt.num(l.quantity) == null ? 1 : fmt.num(l.quantity)),
      unitPrice: fmt.num(l.unitPrice) == null ? '' : Number(l.unitPrice).toFixed(2),
      taxRateKey: l.taxRateKey || '', pricebookItemId: l.pricebookItemId || null,
    }));
    // A legacy single-amount document becomes one editable line.
    if (opts.doc && !lines.length && fmt.num(opts.doc.amount) > 0) {
      lines.push({ description: (opts.doc.notes || opts.jobTitle || 'Work as agreed').split('\n')[0].slice(0, 300), quantity: '1', unitPrice: Number(opts.doc.amount).toFixed(2), taxRateKey: '', pricebookItemId: null });
    }
    let saving = false;

    const byCat = {};
    pricebook.forEach((p) => { (byCat[p.category || 'Other'] = byCat[p.category || 'Other'] || []).push(p); });
    const taxOpts = (sel) => '<option value="">No ' + esc(tax.label) + '</option>' + tax.rates.map((r) =>
      '<option value="' + esc(r.key) + '"' + (r.key === sel ? ' selected' : '') + '>' + esc(String(r.key).charAt(0).toUpperCase() + String(r.key).slice(1) + ' ' + fmt.percent(r.rate)) + '</option>').join('');

    host.innerHTML =
      '<div class="doc-editor">' +
        '<div class="de-add">' +
          '<label for="de-item" class="sr-only">Add from pricebook</label>' +
          '<select id="de-item"><option value="">Add from pricebook…</option>' +
            Object.keys(byCat).sort().map((c) => '<optgroup label="' + esc(c) + '">' + byCat[c].map((p) =>
              '<option value="' + esc(p.id) + '">' + esc(p.name) + ' – ' + esc(fmt.money(p.price, cur)) + (p.unit ? ' / ' + esc(p.unit) : '') + '</option>').join('') + '</optgroup>').join('') +
            '</select>' +
          '<button class="btn btn-outline" type="button" id="de-add">+ Free-text line</button>' +
        '</div>' +
        '<div class="de-head' + (tax.enabled ? ' with-tax' : '') + '" aria-hidden="true"><span>Description</span><span class="num">Qty</span><span class="num">Unit price</span>' +
          (tax.enabled ? '<span>' + esc(tax.label) + '</span>' : '') + '<span class="num">Amount</span><span></span></div>' +
        '<div id="de-lines" class="de-lines"></div>' +
        '<div class="doc-totals de-totals" aria-live="polite">' +
          '<div><span>Subtotal</span><span id="de-subtotal"></span></div>' +
          '<div id="de-tax" class="de-tax-rows"></div>' +
          '<div class="doc-total"><span>' + esc(label(type)) + ' total</span><span id="de-total"></span></div>' +
          '<p class="muted small">Preview — the saved totals are calculated by the server.</p>' +
        '</div>' +
        (rcBox ? '<label class="check"><input type="checkbox" id="de-reverse"' + (opts.doc && opts.doc.reverseCharge ? ' checked' : '') + '> Reverse charge (no ' + esc(tax.label) + ' charged; the customer accounts for it)</label>' : '') +
        (type === 'invoice' ? '<div class="form-group"><label for="de-due">Due date</label><input type="date" id="de-due"></div>' : '') +
        '<div class="form-group"><label for="de-notes">Notes for the customer</label><textarea id="de-notes" placeholder="Optional"></textarea></div>' +
        '<div id="de-error" class="form-error" hidden></div>' +
        '<div class="field-actions"><button class="btn btn-primary" type="button" id="de-save">Save ' + esc(label(type).toLowerCase()) + '</button>' +
          '<button class="btn btn-outline" type="button" id="de-cancel">Cancel</button></div>' +
      '</div>';
    const $ = (id) => host.querySelector('#' + id);
    if (opts.doc && opts.doc.notes && (opts.doc.lines || []).length) $('de-notes').value = opts.doc.notes;
    if (type === 'invoice') $('de-due').value = opts.doc && opts.doc.dueDate ? fmt.isoDate(String(opts.doc.dueDate).slice(0, 10)) : fmt.addDays(fmt.todayISO(), 14);

    function lineRow(l, i) {
      return '<div class="de-line' + (tax.enabled ? ' with-tax' : '') + '" data-line="' + i + '">' +
        '<label class="sr-only" for="de-d-' + i + '">Line ' + (i + 1) + ' description</label>' +
        '<input type="text" id="de-d-' + i + '" data-f="description" maxlength="300" placeholder="Description" value="' + esc(l.description) + '">' +
        '<label class="sr-only" for="de-q-' + i + '">Line ' + (i + 1) + ' quantity</label>' +
        '<input type="number" id="de-q-' + i + '" data-f="quantity" class="num" min="0.001" step="any" inputmode="decimal" value="' + esc(l.quantity) + '">' +
        '<label class="sr-only" for="de-p-' + i + '">Line ' + (i + 1) + ' unit price</label>' +
        '<input type="number" id="de-p-' + i + '" data-f="unitPrice" class="num" step="0.01" inputmode="decimal" placeholder="0.00" value="' + esc(l.unitPrice) + '">' +
        (tax.enabled ? '<label class="sr-only" for="de-t-' + i + '">Line ' + (i + 1) + ' ' + esc(tax.label) + '</label><select id="de-t-' + i + '" data-f="taxRateKey">' + taxOpts(l.taxRateKey) + '</select>' : '') +
        '<span class="de-amount num" data-amount="' + i + '"></span>' +
        '<button class="btn btn-danger btn-sm" type="button" data-remove="' + i + '" aria-label="Remove line ' + (i + 1) + '">&times;</button>' +
      '</div>';
    }
    function renderLines() {
      $('de-lines').innerHTML = lines.length ? lines.map(lineRow).join('') : '<div class="empty small">No lines yet. Add one from the pricebook or as free text.</div>';
      renderTotals();
    }
    function renderTotals() {
      const t = totals(lines, { reverseCharge: rcBox && $('de-reverse') && $('de-reverse').checked });
      t.lines.forEach((r, i) => { const el = host.querySelector('[data-amount="' + i + '"]'); if (el) el.textContent = r.lineTotal == null ? '—' : fmt.money(r.lineTotal, cur); });
      $('de-subtotal').textContent = fmt.money(t.subtotal, cur);
      $('de-tax').innerHTML = tax.enabled ? t.breakdown.filter((g) => g.rate > 0 || g.tax).map((g) =>
        '<div><span>' + esc(taxName(g.taxRateKey, g.rate)) + ' on ' + esc(fmt.money(g.net, cur)) + '</span><span>' + esc(fmt.money(g.tax, cur)) + '</span></div>').join('') : '';
      $('de-total').textContent = t.ok ? fmt.money(t.total, cur) : '—';
    }
    function error(msg, field) {
      host.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
      MBC.ui.formError($('de-error'), msg || null);
      const m = field && /^lines\[(\d+)\](?:\.(\w+))?$/.exec(field);
      if (m) {
        const el = host.querySelector('[data-line="' + m[1] + '"] [data-f="' + (m[2] || 'description') + '"]') || host.querySelector('[data-line="' + m[1] + '"] input');
        if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
      }
    }

    // Choosing a pricebook item adds it; the button adds an empty free-text line.
    function add(sel) {
      if (sel === 'free') lines.push({ description: '', quantity: '1', unitPrice: '', taxRateKey: tax.defaultKey || '', pricebookItemId: null });
      else {
        const p = pricebook.find((x) => String(x.id) === sel); if (!p) return;
        const key = p.taxRateKey && tax.rates.some((r) => r.key === String(p.taxRateKey).toLowerCase()) ? String(p.taxRateKey).toLowerCase() : (tax.defaultKey || '');
        lines.push({ description: p.name || '', quantity: '1', unitPrice: fmt.num(p.price) == null ? '' : Number(p.price).toFixed(2), taxRateKey: key, pricebookItemId: p.id });
      }
      error(null);
      $('de-item').value = '';
      renderLines();
      const last = host.querySelector('[data-line="' + (lines.length - 1) + '"] [data-f="' + (sel === 'free' ? 'description' : 'quantity') + '"]');
      if (last) last.focus();
    }

    function body() {
      if (!lines.length) return { error: 'Add at least one line.' };
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const d = String(l.description || '').trim();
        if (!d) return { error: 'Line ' + (i + 1) + ' needs a description.', field: 'lines[' + i + '].description' };
        if (scaled(l.quantity, 3) == null || !(Number(l.quantity) > 0)) return { error: 'Line ' + (i + 1) + ': quantity must be more than 0 (up to 3 decimals).', field: 'lines[' + i + '].quantity' };
        if (scaled(l.unitPrice, 2) == null) return { error: 'Line ' + (i + 1) + ': enter a unit price (up to 2 decimals; negative for a discount).', field: 'lines[' + i + '].unitPrice' };
        const line = { description: d, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) };
        if (tax.rates.length) line.taxRateKey = l.taxRateKey || null;
        if (l.pricebookItemId) line.pricebookItemId = Number(l.pricebookItemId);
        out.push(line);
      }
      const t = totals(lines, { reverseCharge: rcBox && $('de-reverse') && $('de-reverse').checked });
      if (type === 'invoice' && !(t.total > 0)) return { error: 'An invoice total must be more than 0.' };
      if (t.total < 0) return { error: 'The total cannot be negative.' };
      const b = { lines: out, notes: $('de-notes').value.trim() || null };
      if (rcBox) b.reverseCharge = !!$('de-reverse').checked;
      if (type === 'invoice') b.dueDate = $('de-due').value || null;
      return { body: b };
    }

    async function save() {
      if (saving) return;
      const r = body();
      if (r.error) { error(r.error, r.field); return; }
      error(null);
      saving = true; $('de-save').disabled = true;
      try { await opts.onSave(r.body); }
      catch (e) { error(MBC.ui.errMsg(e), e && e.data && e.data.field); }
      finally { saving = false; const b = $('de-save'); if (b) b.disabled = false; }
    }

    host.addEventListener('input', (e) => {
      const row = e.target.closest('[data-line]'); const f = e.target.getAttribute('data-f');
      if (!row || !f) return;
      lines[Number(row.getAttribute('data-line'))][f] = e.target.value;
      renderTotals();
    });
    host.addEventListener('change', (e) => {
      if (e.target.id === 'de-reverse') { renderTotals(); return; }
      const row = e.target.closest('[data-line]'); const f = e.target.getAttribute('data-f');
      if (row && f) { lines[Number(row.getAttribute('data-line'))][f] = e.target.value; renderTotals(); }
    });
    host.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) { lines.splice(Number(rm.getAttribute('data-remove')), 1); renderLines(); return; }
      if (e.target.id === 'de-add') add('free');
      else if (e.target.id === 'de-save') save();
      else if (e.target.id === 'de-cancel' && opts.onCancel) opts.onCancel();
    });
    $('de-item').addEventListener('change', () => { if ($('de-item').value) add($('de-item').value); });
    renderLines();
    return { get lines() { return lines; }, error, totals: () => totals(lines, { reverseCharge: rcBox && $('de-reverse') && $('de-reverse').checked }) };
  }

  MBC.docs = { totals, linesHtml, totalsHtml, editor, label, ref, taxName, hasTax, scaled };
})();
