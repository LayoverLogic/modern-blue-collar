/*
 * job.html — one job: status, field actions (Navigate / Call / Text / On My Way),
 * schedule & assign (staff), notes, photos, quote builder and invoice (admin),
 * live "who else is viewing" presence (socket.io, authenticated with the token).
 */
(function () {
  'use strict';
  const { fmt, api, auth, ui } = window.MBC;
  const $ = ui.$;
  const jobId = new URLSearchParams(location.search).get('id');
  let job = null;
  let me = null;
  let socket = null;
  let pricebook = [];
  let lines = [];

  function fail(msg) { $('loading-msg').hidden = true; $('job-content').hidden = true; $('error-msg').textContent = msg; $('error-msg').hidden = false; }

  // ── Render ──────────────────────────────────────────────────────────────────
  function render() {
    const c = job.customer || {};
    $('job-heading').textContent = 'Job #' + job.id + (job.title ? ' – ' + job.title : '');
    $('job-meta').textContent = [fmt.name(c), job.type, 'created ' + fmt.date(job.createdAt)].filter(Boolean).join(' · ');
    MBC.brand.apply(MBC.brand.current, 'Job #' + job.id);
    $('status-select').value = job.status || 'pending';
    $('d-customer').textContent = fmt.name(c) || fmt.DASH;
    $('d-type').textContent = job.type || fmt.DASH;
    $('d-tech').textContent = fmt.name(job.technician) || 'Unassigned';
    $('d-scheduled').textContent = fmt.schedule(job);
    $('d-duration').textContent = fmt.num(job.duration) ? job.duration + ' h' : fmt.DASH;
    $('d-priority').textContent = fmt.statusLabel(job.priority || 'normal');
    $('d-status').innerHTML = fmt.badge(job.status);
    $('row-completed').hidden = !job.completedAt;
    $('d-completed').textContent = fmt.dateTime(job.completedAt);
    $('d-description').textContent = job.description || '';
    $('d-version').textContent = job.version;
    if (document.activeElement !== $('job-notes')) $('job-notes').value = job.notes || '';

    $('c-name').textContent = fmt.name(c) || fmt.DASH;
    $('c-phone').textContent = c.phone || fmt.DASH;
    $('c-email').textContent = c.email || fmt.DASH;
    $('c-address').textContent = fmt.address(c) || fmt.DASH;
    if (c.id) $('c-link').href = 'customer-detail.html?id=' + encodeURIComponent(c.id);
    $('field-actions').innerHTML = MBC.field.actionsHtml(job, me);

    if (auth.isStaff()) {
      $('a-tech').value = job.technicianId ? String(job.technicianId) : '';
      $('a-date').value = job.scheduledDate || '';
      $('a-time').value = job.scheduledTime || '';
      $('a-duration').value = job.duration || '';
      $('a-priority').value = job.priority || 'normal';
      renderBilling();
    }
  }

  function renderBilling() {
    const q = job.quote, inv = job.invoice;
    let html = '';
    if (q) {
      html += '<div class="billing-item"><span><strong>Quote #' + fmt.esc(q.id) + '</strong> ' + fmt.money(q.amount) + '</span>' +
        (auth.isAdmin()
          ? '<span><label for="quote-status" class="sr-only">Quote status</label><select id="quote-status">' +
            ['draft', 'sent', 'approved', 'declined'].map((s) => '<option value="' + s + '"' + (s === q.status ? ' selected' : '') + '>' + fmt.statusLabel(s) + '</option>').join('') + '</select></span>'
          : fmt.badge(q.status)) + '</div>';
      if (q.notes) html += '<pre class="quote-notes">' + fmt.esc(q.notes) + '</pre>';
    }
    if (inv) {
      html += '<div class="billing-item"><span><strong>Invoice #' + fmt.esc(inv.id) + '</strong> ' + fmt.money(inv.amount) +
        (inv.dueDate ? ' <span class="muted">due ' + fmt.esc(fmt.date(inv.dueDate)) + '</span>' : '') + '</span><span>' + fmt.badge(inv.status) +
        (auth.isAdmin() && inv.status !== 'paid' && inv.status !== 'void' ? ' <button class="btn btn-sm" type="button" id="btn-mark-paid">Mark paid</button>' : '') + '</span></div>';
    }
    $('inv-list').innerHTML = html || '<span class="muted">No quote or invoice yet.</span>';
    // Create Invoice is hidden once an invoice exists; Build Quote becomes Revise Quote.
    $('btn-create-invoice').hidden = !!inv;
    $('btn-build-quote').hidden = !!inv;
    $('btn-build-quote').textContent = q ? 'Revise Quote' : 'Build Quote';
    $('billing-actions').hidden = !auth.isAdmin() || !!inv;
    if (inv) { $('invoice-panel').hidden = true; $('quote-builder').hidden = true; }
  }

  // ── Load ────────────────────────────────────────────────────────────────────
  async function load() {
    try { job = await api.get('/api/jobs/' + encodeURIComponent(jobId)); }
    catch (e) { fail(e.status === 404 ? 'Job not found.' : e.message); return false; }
    $('loading-msg').hidden = true;
    $('job-content').hidden = false;
    render();
    return true;
  }

  async function patchJob(body, okMsg) {
    try {
      const updated = await api.patch('/api/jobs/' + encodeURIComponent(jobId), Object.assign({ version: job.version }, body));
      job = Object.assign({}, job, updated, { quote: job.quote, invoice: job.invoice, jobParts: job.jobParts });
      render();
      if (okMsg) ui.toast(okMsg, 'ok');
      return true;
    } catch (e) {
      ui.toast(e.message, 'error');
      if (e.status === 409) await load();
      else render();
      return false;
    }
  }

  // ── Photos ──────────────────────────────────────────────────────────────────
  async function loadPhotos() {
    let photos = [];
    try { photos = await api.get('/api/jobs/' + encodeURIComponent(jobId) + '/photos'); } catch (e) { return; }
    const g = $('photo-gallery');
    if (!photos.length) { g.innerHTML = '<span class="muted small">No photos yet.</span>'; return; }
    g.innerHTML = '';
    for (const p of photos) {
      const wrap = document.createElement('div'); wrap.className = 'photo-thumb';
      const img = document.createElement('img'); img.alt = p.originalName || 'Job photo'; img.title = p.originalName || '';
      try { const r = await api.get(p.url, { raw: true }); img.src = URL.createObjectURL(await r.blob()); } catch (e) { /* leave blank */ }
      wrap.appendChild(img);
      if (auth.isStaff() || (me && p.uploadedById === me.id)) {
        const del = document.createElement('button'); del.type = 'button'; del.className = 'del'; del.textContent = '×'; del.title = 'Delete photo';
        del.setAttribute('aria-label', 'Delete photo'); del.addEventListener('click', () => deletePhoto(p.id));
        wrap.appendChild(del);
      }
      g.appendChild(wrap);
    }
  }
  async function uploadPhoto() {
    const inp = $('photo-input'), status = $('photo-status');
    if (!inp.files || !inp.files[0]) { status.textContent = 'Choose a photo first.'; return; }
    const fd = new FormData(); fd.append('photo', inp.files[0]);
    status.textContent = 'Uploading…'; $('btn-upload-photo').disabled = true;
    try {
      await api.upload('/api/jobs/' + encodeURIComponent(jobId) + '/photos', fd);
      inp.value = ''; status.textContent = 'Uploaded.';
      await loadPhotos();
    } catch (e) { status.textContent = e.message; }
    finally { $('btn-upload-photo').disabled = false; }
  }
  async function deletePhoto(id) {
    if (!confirm('Delete this photo?')) return;
    try { await api.del('/api/jobs/' + encodeURIComponent(jobId) + '/photos/' + encodeURIComponent(id)); await loadPhotos(); }
    catch (e) { ui.toast(e.message, 'error'); }
  }

  // ── Quote builder ─────────────────────────────────────────────────────────────
  const round2 = (n) => Math.round(n * 100) / 100;
  function lineTotal(l) { return round2(l.qty * l.price); }
  function quoteTotal() { return round2(lines.reduce((s, l) => s + lineTotal(l), 0)); }
  function renderLines() {
    const tb = $('qb-lines');
    tb.innerHTML = lines.length ? lines.map((l, i) =>
      '<tr><td>' + fmt.esc(l.name) + (l.unit ? ' <span class="muted small">/' + fmt.esc(l.unit) + '</span>' : '') + '</td>' +
      '<td class="num"><label class="sr-only" for="qb-q-' + i + '">Quantity</label><input type="number" min="0.25" step="0.25" value="' + fmt.esc(l.qty) + '" id="qb-q-' + i + '" data-line="' + i + '" class="qty-input"></td>' +
      '<td class="num">' + fmt.money(l.price) + '</td><td class="num">' + fmt.money(lineTotal(l)) + '</td>' +
      '<td><button class="btn btn-danger btn-sm" type="button" data-remove="' + i + '" aria-label="Remove line">&times;</button></td></tr>').join('')
      : '<tr><td colspan="5" class="empty">No lines yet.</td></tr>';
    $('qb-total').textContent = fmt.money(quoteTotal());
  }
  async function openBuilder() {
    $('invoice-panel').hidden = true;
    $('billing-actions').hidden = true;
    $('quote-builder').hidden = false;
    $('qb-title').textContent = job.quote ? 'Revise quote #' + job.quote.id : 'Build a quote';
    lines = [];
    $('qb-notes').value = '';
    ui.formError('qb-error', null);
    if (!pricebook.length) {
      try { const pb = await api.get('/api/pricebook'); pricebook = Array.isArray(pb) ? pb : (pb.items || []); }
      catch (e) { ui.formError('qb-error', 'Could not load the pricebook: ' + e.message); }
    }
    const byCat = {};
    pricebook.forEach((p) => { (byCat[p.category || 'Other'] = byCat[p.category || 'Other'] || []).push(p); });
    $('qb-item').innerHTML = '<option value="">Choose a pricebook item…</option>' +
      Object.keys(byCat).sort().map((cat) => '<optgroup label="' + fmt.esc(cat) + '">' +
        byCat[cat].map((p) => '<option value="' + fmt.esc(p.id) + '">' + fmt.esc(p.name) + ' – ' + fmt.esc(fmt.money(p.price)) + '</option>').join('') + '</optgroup>').join('') +
      '<option value="custom">Custom line…</option>';
    renderLines();
    $('quote-builder').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function addLine() {
    const sel = $('qb-item').value;
    const qty = Number($('qb-qty').value);
    if (!sel) { ui.formError('qb-error', 'Choose an item to add.'); return; }
    if (!(qty > 0)) { ui.formError('qb-error', 'Quantity must be more than 0.'); return; }
    if (sel === 'custom') {
      const name = $('qb-desc').value.trim(); const price = Number($('qb-price').value);
      if (!name || !(price >= 0) || $('qb-price').value === '') { ui.formError('qb-error', 'Enter a description and price for the custom line.'); return; }
      lines.push({ name, qty, price, unit: '' });
      $('qb-desc').value = ''; $('qb-price').value = '';
    } else {
      const p = pricebook.find((x) => String(x.id) === sel);
      if (!p) return;
      lines.push({ id: p.id, name: p.name, qty, price: fmt.num(p.price) || 0, unit: p.unit || '' });
    }
    ui.formError('qb-error', null);
    $('qb-qty').value = '1';
    renderLines();
  }
  function breakdownText() {
    return 'Line items:\n' + lines.map((l) => '- ' + l.qty + ' x ' + l.name + (l.unit ? ' (' + l.unit + ')' : '') + ' @ ' + fmt.money(l.price) + ' = ' + fmt.money(lineTotal(l))).join('\n') +
      '\nTotal: ' + fmt.money(quoteTotal());
  }
  async function saveQuote() {
    const total = quoteTotal();
    if (!lines.length || !(total > 0)) { ui.formError('qb-error', 'Add at least one line with a price before saving.'); return; }
    const extra = $('qb-notes').value.trim();
    const notes = breakdownText() + (extra ? '\n\n' + extra : '');
    $('qb-save').disabled = true;
    try {
      if (job.quote) await api.patch('/api/quotes/' + job.quote.id, { amount: total, notes, version: job.quote.version });
      else await api.post('/api/quotes', { jobId: Number(jobId), amount: total, notes });
      $('quote-builder').hidden = true;
      ui.toast('Quote saved: ' + fmt.money(total) + '.', 'ok');
      await load();
    } catch (e) { ui.formError('qb-error', e); if (e.status === 409) await load(); }
    finally { $('qb-save').disabled = false; }
  }
  async function setQuoteStatus(status) {
    try { await api.patch('/api/quotes/' + job.quote.id, { status, version: job.quote.version }); ui.toast('Quote marked ' + fmt.statusLabel(status).toLowerCase() + '.', 'ok'); }
    catch (e) { ui.toast(e.message, 'error'); }
    await load();
  }

  // ── Invoice ─────────────────────────────────────────────────────────────────
  function openInvoice() {
    if (job.invoice) return;
    $('quote-builder').hidden = true;
    const q = job.quote;
    const amount = q && fmt.num(q.amount) > 0 ? fmt.num(q.amount) : '';
    $('inv-amount').value = amount === '' ? '' : amount.toFixed(2);
    $('inv-due').value = fmt.addDays(fmt.todayISO(), 14);
    $('inv-notes').value = '';
    $('inv-source').textContent = q
      ? 'Amount taken from quote #' + q.id + (q.status === 'approved' ? ' (approved).' : ' (status: ' + fmt.statusLabel(q.status).toLowerCase() + '). Check it before confirming.')
      : 'There is no quote for this job. Enter the amount to invoice.';
    ui.formError('inv-error', null);
    $('billing-actions').hidden = true;
    $('invoice-panel').hidden = false;
    $('inv-amount').focus();
  }
  async function confirmInvoice() {
    const amount = Number($('inv-amount').value);
    if (!(amount > 0) || !Number.isFinite(amount)) { ui.formError('inv-error', 'Enter an amount greater than 0.'); return; }
    $('btn-confirm-invoice').disabled = true;
    try {
      const inv = await api.post('/api/invoices', { jobId: Number(jobId), amount: Math.round(amount * 100) / 100, dueDate: $('inv-due').value || undefined, notes: $('inv-notes').value.trim() || undefined });
      $('invoice-panel').hidden = true;
      ui.toast('Invoice #' + inv.id + ' created for ' + fmt.money(inv.amount) + '.', 'ok');
      await load();
    } catch (e) {
      ui.formError('inv-error', e.status === 409 ? 'This job already has an invoice. Reload to see it.' : e);
      if (e.status === 409) await load();
    } finally { $('btn-confirm-invoice').disabled = false; }
  }
  async function markPaid() {
    try { await api.patch('/api/invoices/' + job.invoice.id, { status: 'paid', version: job.invoice.version }); ui.toast('Invoice marked paid.', 'ok'); }
    catch (e) { ui.toast(e.message, 'error'); }
    await load();
  }

  // ── Presence (socket.io; token sent in the handshake) ──────────────────────
  function updatePresence(viewers) {
    const others = Object.values(viewers || {}).filter((v) => !me || String(v.userId) !== String(me.id));
    const banner = $('presence-banner');
    if (!others.length) { banner.style.display = 'none'; return; }
    $('presence-text').textContent = others.map((v) => fmt.name(v) || 'Someone').join(', ') + (others.length === 1 ? ' is' : ' are') + ' also viewing this job';
    banner.style.display = 'flex';
  }
  function startPresence() {
    if (typeof window.io !== 'function') return;
    try {
      socket = window.io({ auth: { token: auth.token() } });
      socket.on('connect', () => socket.emit('viewing-job', { jobId }));
      socket.on('presence-update', (d) => { if (String(d.jobId) === String(jobId)) updatePresence(d.viewers); });
      socket.on('connect_error', () => { /* presence is optional */ });
      window.addEventListener('pagehide', () => { try { socket.emit('leave-job'); socket.close(); } catch (e) { /* ignore */ } });
    } catch (e) { socket = null; }
    api.get('/api/presence/' + encodeURIComponent(jobId)).then((d) => updatePresence(d && d.viewers)).catch(() => {});
  }

  // ── Wire up ─────────────────────────────────────────────────────────────────
  MBC.page({
    active: null, title: 'Job', roles: 'all',
    async run(user) {
      me = user;
      MBC.nav.render(auth.isTech() ? 'today' : 'dispatch', user);
      $('back-link').href = auth.isTech() ? 'today.html' : 'dispatch.html';
      $('back-link').textContent = auth.isTech() ? '← Back to Today' : '← Back to Dispatch';
      ui.applyRoleVisibility();
      // Only the office can cancel a job; technicians change status and notes only.
      if (!auth.isStaff()) { const o = $('status-select').querySelector('option[value="cancelled"]'); if (o) o.remove(); }
      if (!jobId) { fail('No job selected.'); return; }
      if (auth.isStaff()) {
        // Fill the technician picker before the job is shown, so it is never empty.
        const techRes = await api.get('/api/users/technicians').catch(() => null);
        const techs = Array.isArray(techRes) ? techRes : ((techRes && techRes.technicians) || []);
        $('a-tech').innerHTML = '<option value="">Unassigned</option>' + techs.map((t) => '<option value="' + fmt.esc(t.id) + '">' + fmt.esc(fmt.name(t)) + '</option>').join('');
      }
      if (!(await load())) return;
      startPresence();
      loadPhotos();

      $('status-select').addEventListener('change', () => {
        const status = $('status-select').value;
        patchJob({ status }, 'Status set to ' + fmt.statusLabel(status).toLowerCase() + '.');
      });
      $('btn-save-notes').addEventListener('click', () => patchJob({ notes: $('job-notes').value }, 'Notes saved.'));
      $('btn-upload-photo').addEventListener('click', uploadPhoto);
      $('btn-sms-confirm').addEventListener('click', async () => {
        try { const r = await api.post('/api/sms/job-confirm/' + encodeURIComponent(jobId)); ui.toast(r && r.sent === false ? (r.message || 'SMS not sent (sandbox).') : 'Confirmation SMS sent.', 'ok'); }
        catch (e) { ui.toast(e.status === 503 ? 'Text messaging is not set up on this system. Use "Text Customer" to send from your phone.' : e.message, 'error'); }
      });

      if (auth.isStaff()) {
        $('assign-form').addEventListener('submit', (e) => {
          e.preventDefault();
          const date = $('a-date').value, time = $('a-time').value;
          if (time && !date) { ui.formError('assign-error', 'Pick a date for the time you entered.'); return; }
          ui.formError('assign-error', null);
          const body = {
            technicianId: $('a-tech').value ? Number($('a-tech').value) : null,
            scheduledDate: date || null, scheduledTime: time || null,
            priority: $('a-priority').value,
          };
          const dur = Number($('a-duration').value); if (dur > 0) body.duration = dur;
          if (date && job.status === 'pending') body.status = 'scheduled';
          patchJob(body, 'Schedule saved.');
        });
      }
      if (auth.isAdmin()) {
        $('btn-build-quote').addEventListener('click', openBuilder);
        $('btn-create-invoice').addEventListener('click', openInvoice);
        $('qb-add').addEventListener('click', addLine);
        $('qb-item').addEventListener('change', () => { $('qb-custom').hidden = $('qb-item').value !== 'custom'; });
        $('qb-save').addEventListener('click', saveQuote);
        $('qb-cancel').addEventListener('click', () => { $('quote-builder').hidden = true; renderBilling(); });
        $('qb-lines').addEventListener('input', (e) => {
          const i = e.target.getAttribute('data-line'); if (i == null) return;
          const q = Number(e.target.value); if (q > 0) { lines[i].qty = q; $('qb-total').textContent = fmt.money(quoteTotal()); }
        });
        $('qb-lines').addEventListener('change', (e) => { if (e.target.getAttribute('data-line') != null) renderLines(); });
        $('qb-lines').addEventListener('click', (e) => {
          const b = e.target.closest('[data-remove]'); if (!b) return;
          lines.splice(Number(b.getAttribute('data-remove')), 1); renderLines();
        });
        $('btn-confirm-invoice').addEventListener('click', confirmInvoice);
        $('btn-cancel-invoice').addEventListener('click', () => { $('invoice-panel').hidden = true; renderBilling(); });
        $('inv-list').addEventListener('change', (e) => { if (e.target.id === 'quote-status') setQuoteStatus(e.target.value); });
        $('inv-list').addEventListener('click', (e) => { if (e.target.id === 'btn-mark-paid') markPaid(); });
        if (location.hash === '#quote' && !job.invoice) openBuilder();
        if (location.hash === '#invoice' && !job.invoice) openInvoice();
      }
    },
  });
})();
