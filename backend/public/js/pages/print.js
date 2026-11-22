/*
 * print.html?type=quote|invoice&id=N — printable quote / invoice from the `print`
 * block of GET /api/quotes/:id or /api/invoices/:id (Phase 2b): logo, seller
 * details and tax number, document number, issue / due dates (already formatted
 * in the brand locale by the server), customer address lines in the locale
 * format, lines, subtotal / tax breakdown / total, reverse-charge note.
 *
 * "Print / Save as PDF" opens the browser's print dialog (no PDF library).
 * Paper: A4 outside the US / Canada (css/page-a4.css), else US Letter.
 *
 * Reverse charge: the note is printed only when the server says the wording is
 * NOT the placeholder. With placeholder wording nothing is printed, and admins
 * see an on-screen banner (never printed) that the wording needs an accountant.
 */
(function () {
  'use strict';
  const { fmt, api, auth, ui } = window.MBC;
  const $ = ui.$;
  const q = new URLSearchParams(location.search);
  const type = q.get('type') === 'invoice' ? 'invoice' : (q.get('type') === 'quote' ? 'quote' : null);
  const id = q.get('id');

  function fail(msg) { $('loading-msg').hidden = true; $('sheet').hidden = true; $('error-msg').textContent = msg; $('error-msg').hidden = false; }
  const txt = (el, v) => { $(el).textContent = v == null ? '' : String(v); };
  const div = (cls, v) => '<div' + (cls ? ' class="' + cls + '"' : '') + '>' + fmt.esc(v) + '</div>';

  function paper(country) {
    const letter = ['US', 'CA'].includes(String(country || '').toUpperCase());
    $('page-size').href = letter ? 'css/page-letter.css' : 'css/page-a4.css';
    txt('paper-note', letter ? 'Paper: US Letter' : 'Paper: A4');
  }

  function render(doc) {
    const p = doc.print || {};
    const f = p.formatted || {};
    const cur = p.currency || doc.currency;
    const money = (n, formatted) => formatted || fmt.money(n, cur);
    const title = p.title || MBC.docs.label(type);
    const number = p.number || doc.number || ('#' + doc.id);
    document.title = [number, title, p.seller && p.seller.companyName].filter(Boolean).join(' – ');

    // Seller
    const s = p.seller || {};
    txt('p-seller-name', s.companyName || (MBC.brand.current.companyName || ''));
    const sl = [];
    if (s.address) String(s.address).split(/\n/).forEach((x) => sl.push(x));
    if (s.phone) sl.push(fmt.phone(s.phone));
    if (s.email) sl.push(s.email);
    if (s.taxNumber) sl.push((s.taxLabel ? s.taxLabel + ' no. ' : 'Tax no. ') + s.taxNumber);
    $('p-seller-lines').innerHTML = sl.map((x) => div('', x)).join('');
    const logo = s.logoUrl || MBC.brand.current.logoUrl;
    if (logo) {
      const img = $('p-logo');
      img.addEventListener('error', () => { img.hidden = true; }, { once: true });
      img.alt = s.companyName || 'Logo'; img.src = logo; img.hidden = false;
    }

    // Document facts
    txt('p-title', title);
    const facts = [[type === 'quote' ? 'Quote no.' : 'Invoice no.', number], ['Issue date', f.issuedAt || fmt.dateShort(p.issuedAt || doc.issuedAt)]];
    // dueDate is a calendar date (stored at UTC midnight): format its date part, never
    // shifted by the brand time zone (the server's formatted.dueDate shifts it west of UTC).
    if (type === 'invoice') facts.push(['Due date', p.dueDate ? fmt.dateShort(String(p.dueDate).slice(0, 10)) : 'On receipt']);
    if (type === 'quote') facts.push(['Status', fmt.statusLabel(p.status || doc.status)]);
    $('p-facts').innerHTML = facts.map((x) => '<dt>' + fmt.esc(x[0]) + '</dt><dd id="p-fact-' + fmt.esc(x[0].toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')) + '">' + fmt.esc(x[1]) + '</dd>').join('');
    const st = String(p.status || doc.status || '');
    const stamp = type === 'invoice' && (st === 'paid' || st === 'void') ? st : (type === 'quote' && st === 'declined' ? 'declined' : '');
    $('p-stamp').hidden = !stamp; $('p-stamp').textContent = stamp.toUpperCase(); $('p-stamp').className = 'stamp' + (stamp === 'paid' ? ' paid' : '');

    // Customer (address lines are already in the locale format)
    const c = p.customer || {};
    txt('p-to-label', type === 'quote' ? 'Prepared for' : 'Bill to');
    const cl = [];
    if (c.company && c.company !== c.name) cl.push(c.company);
    (c.addressLines || []).forEach((x) => cl.push(x));
    if (c.email) cl.push(c.email);
    if (c.phone) cl.push(fmt.phone(c.phone));
    if (c.taxNumber) cl.push((p.taxLabel ? p.taxLabel + ' no. ' : 'Tax no. ') + c.taxNumber);
    $('p-customer').innerHTML = div('p-name', c.name || fmt.name(doc.customer) || '—') + cl.map((x) => div('', x)).join('');
    $('p-job-box').hidden = !p.jobTitle;
    $('p-job').textContent = p.jobTitle ? p.jobTitle + (doc.jobId ? ' (job #' + doc.jobId + ')' : '') : '';

    // Lines
    const lines = Array.isArray(p.lines) ? p.lines : [];
    const withTax = !!p.taxEnabled || lines.some((l) => Number(l.taxRate) > 0);
    const taxLabel = p.taxLabel || fmt.tax().label;
    $('p-lines-head').innerHTML = '<tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th>' +
      (withTax ? '<th class="num">' + fmt.esc(taxLabel) + '</th>' : '') + '<th class="num">Amount</th></tr>';
    const rows = lines.length ? lines : [{ description: p.notes || p.jobTitle || 'Work as agreed', quantity: 1, unitPrice: p.total, lineTotal: p.total, taxRate: 0, legacy: true }];
    $('p-lines-body').innerHTML = rows.map((l) => {
      const lf = l.formatted || {};
      return '<tr><td>' + fmt.esc(l.description) + '</td><td class="num">' + fmt.esc(fmt.num(l.quantity)) + '</td>' +
        '<td class="num">' + fmt.esc(money(l.unitPrice, lf.unitPrice)) + '</td>' +
        (withTax ? '<td class="num">' + fmt.esc(l.taxRateKey || Number(l.taxRate) ? fmt.percent(l.taxRate) : '—') + '</td>' : '') +
        '<td class="num">' + fmt.esc(money(l.lineTotal, lf.lineTotal)) + '</td></tr>';
    }).join('');

    // Totals — the server's numbers and formatting.
    const subtotal = lines.length || Number(p.subtotal) > 0 ? p.subtotal : p.total;
    const tr = [['Subtotal', lines.length ? money(p.subtotal, f.subtotal) : money(subtotal), 'p-subtotal']];
    if (withTax && lines.length) {
      const bd = Array.isArray(f.taxBreakdown) && f.taxBreakdown.length ? f.taxBreakdown
        : (p.taxBreakdown || []).map((g) => ({ label: MBC.docs.taxName(g.taxRateKey, g.rate), net: fmt.money(g.net, cur), tax: fmt.money(g.tax, cur), rate: g.rate }));
      const raw = p.taxBreakdown || [];
      bd.forEach((g, i) => {
        if (raw[i] && !(Number(raw[i].rate) > 0) && !(Number(raw[i].tax) > 0)) return; // 0% groups: no row
        tr.push([(g.label || taxLabel) + (g.net ? ' on ' + g.net : ''), g.tax, 'p-tax']);
      });
      tr.push([taxLabel + ' total', money(p.taxTotal, f.taxTotal), 'p-taxtotal']);
    }
    tr.push(['Total' + (cur ? ' (' + cur + ')' : ''), money(p.total, f.total), 'p-total']);
    $('p-totals').innerHTML = tr.map((r) => '<div class="' + r[2] + '"><span>' + fmt.esc(r[0]) + '</span><span>' + fmt.esc(r[1]) + '</span></div>').join('');

    // Reverse charge.
    const placeholder = !!p.reverseChargeNoteIsPlaceholder;
    const showNote = !!p.reverseCharge && !!p.reverseChargeNote && !placeholder;
    $('p-rc-note').hidden = !showNote;
    $('p-rc-note').textContent = showNote ? p.reverseChargeNote : '';
    const banner = $('rc-placeholder-banner');
    banner.hidden = !(p.reverseCharge && placeholder && auth.isAdmin());
    banner.textContent = banner.hidden ? '' : 'This ' + type + ' is marked reverse charge, but the reverse-charge wording is still the placeholder text, so NO reverse-charge note is printed. ' +
      'Ask an accountant for the correct wording and set BRAND_RCT_NOTE; it will then print here. (This banner is not printed.)';

    const notes = lines.length ? p.notes : '';
    $('p-notes').hidden = !notes; $('p-notes').textContent = notes || '';
    $('p-foot').textContent = [s.companyName, type === 'quote' ? 'Thank you for the opportunity to quote.' : 'Thank you for your business.'].filter(Boolean).join(' · ');

    $('loading-msg').hidden = true;
    $('sheet').hidden = false;
  }

  MBC.page({
    active: null, title: 'Print', roles: 'staff',
    async run(user) {
      MBC.nav.render(auth.isAdmin() ? 'billing' : 'dispatch', user);
      paper(fmt.country());
      $('btn-print').addEventListener('click', () => window.print());
      if (!type || !id || !/^\d+$/.test(id)) { fail('Open this page from a quote or invoice (print.html?type=quote|invoice&id=…).'); return; }
      let doc;
      try { doc = await api.get('/api/' + type + 's/' + encodeURIComponent(id)); }
      catch (e) { fail(e.status === 404 ? MBC.docs.label(type) + ' not found.' : e.message); return; }
      if (doc.jobId) { $('back-link').href = 'job.html?id=' + encodeURIComponent(doc.jobId); }
      if (!doc.print) { fail('This server does not provide a print view yet.'); return; }
      render(doc);
      if (q.get('autoprint') === '1') setTimeout(() => window.print(), 300);
    },
  });
})();
