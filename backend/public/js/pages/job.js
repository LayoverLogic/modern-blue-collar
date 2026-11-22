/*
 * job.html — one job: status, field actions (Navigate / Call / Text / On My Way),
 * schedule & assign (staff), notes, photos, activity log (GET /api/jobs/:id/activity,
 * paged), quote + invoice with line items (staff read, admin edit / email /
 * convert; js/documents.js), print links (print.html), live "who else is viewing"
 * presence (socket.io, authenticated with the token).
 */
(function () {
  'use strict';
  const { fmt, api, auth, ui } = window.MBC;
  const $ = ui.$;
  const jobId = new URLSearchParams(location.search).get('id');
  let job = null;
  let me = null;
  let socket = null;
  let pricebook = null;
  let docs = { quote: null, invoice: null }; // full documents (GET /api/quotes|invoices/:id)
  let editing = null;                          // { type, doc } while the editor is open
  let emailing = null;                         // 'quote' | 'invoice' while the email modal is open

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
    $('c-phone').textContent = fmt.phone(c.phone) || fmt.DASH;
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

  // ── Quote & invoice cards ───────────────────────────────────────────────────
  const D = () => MBC.docs;
  function docCard(type) {
    const d = docs[type];
    const admin = auth.isAdmin();
    const L = D().label(type);
    if (!d) {
      let html = '<h4>' + L + '</h4><p class="muted small">No ' + L.toLowerCase() + ' yet.</p>';
      if (admin && !editing) {
        if (type === 'quote' && !docs.invoice) html += '<div class="field-actions"><button class="btn" type="button" id="btn-build-quote">Build quote</button></div>';
        if (type === 'invoice') {
          const q = docs.quote;
          if (q && q.status !== 'declined') html += '<div class="field-actions"><button class="btn" type="button" id="btn-convert">Convert ' + fmt.esc(q.number || 'quote') + ' to invoice</button>' +
            '<button class="btn btn-outline" type="button" id="btn-create-invoice">Blank invoice</button></div>';
          else html += '<div class="field-actions"><button class="btn" type="button" id="btn-create-invoice">Create invoice</button></div>';
        }
      }
      return html;
    }
    const cur = d.currency;
    let head = '<div class="doc-head"><h4><span class="doc-number" id="' + type + '-number">' + fmt.esc(d.number || ('#' + d.id)) + '</span> <span class="muted">' + L + '</span></h4>';
    if (admin) {
      const sts = type === 'quote' ? ['draft', 'sent', 'approved', 'declined'] : ['unpaid', 'paid', 'overdue', 'void'];
      head += '<span><label for="' + type + '-status" class="sr-only">' + L + ' status</label><select id="' + type + '-status" data-status="' + type + '">' +
        sts.map((st) => '<option value="' + st + '"' + (st === d.status ? ' selected' : '') + '>' + fmt.statusLabel(st) + '</option>').join('') + '</select></span>';
    } else head += fmt.badge(d.status);
    head += '</div>';
    const meta = ['Issued ' + fmt.date(d.issuedAt || d.createdAt)];
    if (type === 'invoice' && d.dueDate) meta.push('due ' + fmt.date(String(d.dueDate).slice(0, 10)));
    if (d.sentAt) meta.push('emailed ' + fmt.dateTime(d.sentAt));
    if (type === 'invoice' && d.paidAt) meta.push('paid ' + fmt.date(d.paidAt));
    if (d.reverseCharge) meta.push('reverse charge');
    let html = head + '<div class="muted small doc-meta">' + fmt.esc(meta.join(' · ')) + (d.locked ? ' <span class="lock-tag" title="Sent or no longer a draft: only the status can change">Locked</span>' : '') + '</div>';
    html += D().linesHtml(d, { jobTitle: job.title });
    if (d.notes && (d.lines || []).length) html += '<p class="doc-notes small">' + fmt.esc(d.notes) + '</p>';
    html += '<div class="doc-actions">';
    html += '<a class="btn btn-outline btn-sm" id="lnk-print-' + type + '" href="print.html?type=' + type + '&id=' + encodeURIComponent(d.id) + '" target="_blank" rel="noopener">Print / PDF</a>';
    if (admin) {
      if (!d.locked && !editing) html += '<button class="btn btn-outline btn-sm" type="button" id="btn-edit-' + type + '">Edit lines</button>';
      if (d.status !== 'void' && d.status !== 'declined') html += '<button class="btn btn-sm" type="button" id="btn-email-' + type + '">' + (d.sentAt ? 'Email again' : 'Email to customer') + '</button>';
      if (type === 'invoice' && d.status !== 'paid' && d.status !== 'void') html += '<button class="btn btn-outline btn-sm" type="button" id="btn-mark-paid">Mark paid</button>';
    }
    html += '</div>';
    return html;
  }
  function renderBilling() {
    $('quote-card').innerHTML = docCard('quote');
    $('invoice-card').innerHTML = docCard('invoice');
    // Reverse-charge wording that is still the placeholder: never printed; admins are told why.
    const t = fmt.tax();
    const rc = ['quote', 'invoice'].some((k) => docs[k] && docs[k].reverseCharge);
    const ph = rc && (t.reverseChargeNoteIsPlaceholder || ['quote', 'invoice'].some((k) => docs[k] && docs[k].print && docs[k].print.reverseChargeNoteIsPlaceholder));
    $('rc-banner').hidden = !(auth.isAdmin() && ph);
    $('rc-banner').textContent = ph ? 'Reverse charge is on, but the reverse-charge wording is still the placeholder text. It is NOT printed or emailed as compliant wording: set BRAND_RCT_NOTE to wording confirmed by an accountant.' : '';
  }
  async function loadDocs() {
    const get = (type, ref) => (ref ? api.get('/api/' + type + 's/' + encodeURIComponent(ref.id)).catch(() => Object.assign({ lines: [] }, ref)) : Promise.resolve(null));
    [docs.quote, docs.invoice] = await Promise.all([get('quote', job.quote), get('invoice', job.invoice)]);
    renderBilling();
  }

  // ── Editor (quote or invoice) ───────────────────────────────────────────────
  async function openEditor(type, doc) {
    if (pricebook === null) {
      try { const pb = await api.get('/api/pricebook'); pricebook = Array.isArray(pb) ? pb : (pb.items || []); }
      catch (e) { pricebook = []; ui.toast('Could not load the pricebook: ' + e.message, 'error'); }
    }
    editing = { type, doc: doc || null };
    $('de-title').textContent = doc ? 'Edit ' + D().ref(doc, type) : (type === 'quote' ? 'Build a quote' : 'Create an invoice');
    $('doc-editor-wrap').hidden = false;
    renderBilling();
    D().editor($('doc-editor'), {
      type, doc, pricebook, currency: doc ? doc.currency : fmt.currency(), jobTitle: job.title,
      onCancel: closeEditor,
      onSave: (body) => saveDoc(type, doc, body),
    });
    $('doc-editor-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeEditor() { editing = null; $('doc-editor-wrap').hidden = true; $('doc-editor').innerHTML = ''; renderBilling(); }
  async function saveDoc(type, doc, body) {
    const base = '/api/' + type + 's';
    let saved;
    try {
      if (doc) saved = await api.patch(base + '/' + doc.id, Object.assign({ version: doc.version }, body));
      else saved = await api.post(base, Object.assign({ jobId: Number(jobId) }, body));
    } catch (e) {
      if (e.code === 'DOCUMENT_LOCKED' || e.code === 'VERSION_CONFLICT' || (e.code === 'DUPLICATE' && !doc)) {
        const msg = e.code === 'DUPLICATE' ? 'This job already has ' + (type === 'quote' ? 'a quote' : 'an invoice') + ' — it has been loaded below.' : e.message;
        closeEditor(); ui.toast(msg, 'error'); await load(); return;
      }
      throw e;
    }
    closeEditor();
    await load(); // re-render from the server's totals
    const d = docs[type] || saved;
    ui.toast(D().ref(d, type) + ' saved: ' + fmt.money(d.amount, d.currency) + '.', 'ok');
  }

  async function setStatus(type, status) {
    const d = docs[type]; if (!d) return;
    try { await api.patch('/api/' + type + 's/' + d.id, { status, version: d.version }); ui.toast(D().ref(d, type) + ' marked ' + fmt.statusLabel(status).toLowerCase() + '.', 'ok'); }
    catch (e) { ui.toast(e.message, 'error'); }
    await load();
  }

  // ── Convert quote → invoice ─────────────────────────────────────────────────
  function openConvert() {
    const q = docs.quote; if (!q) return;
    $('convert-title').textContent = 'Convert ' + D().ref(q, 'quote') + ' to an invoice';
    $('convert-summary').textContent = 'The invoice copies the quote\'s ' + ((q.lines || []).length || 1) + ' line(s) and its total of ' + fmt.money(q.amount, q.currency) + '.' +
      (q.status === 'approved' ? '' : ' The quote is ' + fmt.statusLabel(q.status).toLowerCase() + ', not approved — check before converting.');
    $('convert-due').value = fmt.addDays(fmt.todayISO(), 14);
    $('convert-notes').value = '';
    ui.openModal('convert-modal');
  }
  async function confirmConvert(e) {
    e.preventDefault();
    const q = docs.quote; if (!q) return;
    $('btn-convert-confirm').disabled = true;
    try {
      const inv = await api.post('/api/invoices/from-quote/' + encodeURIComponent(q.id), { dueDate: $('convert-due').value || undefined, notes: $('convert-notes').value.trim() || undefined });
      ui.closeModal('convert-modal');
      ui.toast(D().ref(inv, 'invoice') + ' created from ' + (q.number || 'the quote') + ' for ' + fmt.money(inv.amount, inv.currency) + '.', 'ok');
      await load();
    } catch (ex) {
      if (ex.code === 'DUPLICATE') { ui.closeModal('convert-modal'); ui.toast('This job already has an invoice — it has been loaded.', 'error'); await load(); }
      else ui.formError('convert-error', ex.code === 'INVALID_AMOUNT' ? 'The quote total is 0, so there is nothing to invoice.' : ex);
    } finally { $('btn-convert-confirm').disabled = false; }
  }

  // ── Email to customer ───────────────────────────────────────────────────────
  function openEmail(type) {
    const d = docs[type]; if (!d) return;
    emailing = type;
    const to = (job.customer && job.customer.email) || '';
    $('email-title').textContent = 'Email ' + D().ref(d, type) + ' to the customer';
    $('email-to').textContent = to || 'No email address on file';
    $('email-to').classList.toggle('error-text', !to);
    $('email-lock-note').textContent = d.locked ? 'A copy is logged in the customer\'s communications.'
      : 'Sending marks the ' + type + ' as sent: after that its lines can no longer be edited (only its status). A copy is logged in the customer\'s communications.';
    $('email-message').value = '';
    $('btn-email-send').disabled = !to;
    ui.openModal('email-modal');
    if (!to) ui.formError('email-error', MBC.api.friendly(400, '', 'NO_CUSTOMER_EMAIL'));
  }
  async function sendEmail(e) {
    e.preventDefault();
    const type = emailing; const d = type && docs[type]; if (!d) return;
    $('btn-email-send').disabled = true; $('btn-email-send').textContent = 'Sending…';
    try {
      const r = await api.post('/api/' + type + 's/' + encodeURIComponent(d.id) + '/email', { message: $('email-message').value.trim() || undefined });
      ui.closeModal('email-modal');
      if (r && r.document) { docs[type] = r.document; renderBilling(); }
      ui.toast(D().ref(d, type) + ' emailed to ' + (r && r.to ? r.to : 'the customer') + (r && r.driver === 'outbox' ? ' (sandbox outbox — nothing left this machine).' : '.'), 'ok');
      await load();
    } catch (ex) {
      ui.formError('email-error', ex);
      if (ex.code === 'VERSION_CONFLICT') await load();
    } finally { $('btn-email-send').disabled = false; $('btn-email-send').textContent = 'Send email'; }
  }

  // ── Activity log ────────────────────────────────────────────────────────────
  let activity = [];
  const ACT_PAGE = 20;
  function techName(x) { return x && (x.technicianName || (x.technicianId != null ? MBC.brand.techLabel + ' #' + x.technicianId : '')) || 'nobody'; }
  function schedText(x) {
    if (!x) return '';
    const parts = [];
    if ('scheduledDate' in x) parts.push(x.scheduledDate ? fmt.date(x.scheduledDate) : 'no date');
    if ('scheduledTime' in x) parts.push(x.scheduledTime ? fmt.time(x.scheduledTime) : 'no time');
    if ('duration' in x && x.duration != null) parts.push(x.duration + ' h');
    return parts.join(' ');
  }
  const FIELD_NAMES = { title: 'title', description: 'description', type: 'job type', priority: 'priority', customerId: 'customer' };
  function docRefText(kind, to) {
    const known = docs[kind] && to && String(docs[kind].id) === String(to[kind + 'Id']) ? docs[kind] : null;
    const n = to && (to.number || (known && known.number) || (to[kind + 'Id'] != null ? '#' + to[kind + 'Id'] : ''));
    return D().label(kind) + (n ? ' ' + n : '') + (to && to.amount != null ? ' · ' + fmt.money(to.amount, to.currency || (known && known.currency)) : '');
  }
  function activityText(a) {
    const f = a.from || {}, t = a.to || {};
    switch (a.type) {
      case 'created': return 'Job created' + (t.title ? ': ' + t.title : '');
      case 'status_changed': return 'Status ' + fmt.statusLabel(f.status) + ' → ' + fmt.statusLabel(t.status);
      case 'assigned': return t.technicianId == null ? 'Unassigned (was ' + techName(f) + ')' : 'Assigned to ' + techName(t) + (f.technicianId != null ? ' (was ' + techName(f) + ')' : '');
      case 'rescheduled': {
        const was = Object.keys(f).some((k) => f[k] != null);
        const now = Object.keys(t).some((k) => t[k] != null);
        if (!was) return 'Scheduled for ' + schedText(t);
        if (!now) return 'Unscheduled (was ' + schedText(f) + ')';
        return 'Rescheduled from ' + schedText(f) + ' to ' + schedText(t);
      }
      case 'note': return t.notes ? 'Notes updated' : 'Notes cleared';
      case 'updated': {
        // Document status change (Phase 2c): to/from { quoteId|invoiceId, number, status }.
        const kind = t.quoteId != null ? 'quote' : (t.invoiceId != null ? 'invoice' : null);
        if (kind) return D().label(kind) + ' ' + (t.number || '#' + t[kind + 'Id']) + (f.status && t.status ? ': ' + fmt.statusLabel(f.status) + ' → ' + fmt.statusLabel(t.status) : ' updated');
        const k = Object.keys(t).map((x) => FIELD_NAMES[x] || x); return 'Updated ' + (k.length ? k.join(', ') : 'details'); }
      case 'photo_added': return 'Photo added' + (t.originalName ? ': ' + t.originalName : '');
      case 'photo_removed': return 'Photo removed' + (f.originalName ? ': ' + f.originalName : '');
      case 'quote_created': return docRefText('quote', t) + ' created';
      case 'invoice_created': return docRefText('invoice', t) + ' created' + (t.fromQuoteNumber || t.fromQuote ? ' from quote ' + (t.fromQuoteNumber || (t.fromQuote && t.fromQuote.number) || '') : '');
      case 'deleted': return 'Job deleted';
      default: return String(a.type || 'Change').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    }
  }
  function actorText(a) {
    const x = a.actor || {};
    if (x.kind === 'system') return 'System';
    return x.name || (x.kind === 'apiKey' ? 'API key' : 'Someone');
  }
  function renderActivity(hasMore) {
    const el = $('activity-list');
    el.innerHTML = activity.length ? activity.map((a) =>
      '<li class="act act-' + fmt.esc(String(a.type || '').replace(/[^a-z_]/gi, '')) + '" data-type="' + fmt.esc(a.type) + '">' +
        '<div class="act-text">' + fmt.esc(activityText(a)) + '</div>' +
        (a.type === 'note' && a.to && a.to.notes ? '<div class="act-note small">' + fmt.esc(String(a.to.notes).slice(0, 240)) + '</div>' : '') +
        '<div class="act-meta small muted"><span class="act-actor">' + fmt.esc(actorText(a)) + '</span> · <time datetime="' + fmt.esc(a.createdAt) + '">' + fmt.esc(fmt.dateTime(a.createdAt)) + '</time></div></li>').join('')
      : '<li class="muted small">No activity recorded yet.</li>';
    $('activity-more').hidden = !hasMore;
  }
  async function loadActivity(more) {
    const before = more && activity.length ? '&before=' + encodeURIComponent(activity[activity.length - 1].id) : '';
    let page;
    try { page = await api.get('/api/jobs/' + encodeURIComponent(jobId) + '/activity?limit=' + ACT_PAGE + before); }
    catch (e) {
      if (!more) $('activity-list').innerHTML = '<li class="muted small">' + fmt.esc(e.status === 404 && !e.code ? 'The activity log is not available on this server.' : e.message) + '</li>';
      return;
    }
    page = Array.isArray(page) ? page : [];
    activity = more ? activity.concat(page) : page;
    renderActivity(page.length === ACT_PAGE);
  }

  // ── Load ────────────────────────────────────────────────────────────────────
  async function load() {
    try { job = await api.get('/api/jobs/' + encodeURIComponent(jobId)); }
    catch (e) { fail(e.status === 404 ? 'Job not found.' : e.message); return false; }
    $('loading-msg').hidden = true;
    $('job-content').hidden = false;
    render();
    if (auth.isStaff()) await loadDocs();
    loadActivity(false);
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
      $('activity-more').addEventListener('click', () => loadActivity(true));
      if (auth.isAdmin()) {
        $('billing-card').addEventListener('click', (e) => {
          const id = e.target.id;
          if (id === 'btn-build-quote') openEditor('quote', null);
          else if (id === 'btn-create-invoice') openEditor('invoice', null);
          else if (id === 'btn-edit-quote') openEditor('quote', docs.quote);
          else if (id === 'btn-edit-invoice') openEditor('invoice', docs.invoice);
          else if (id === 'btn-convert') openConvert();
          else if (id === 'btn-email-quote') openEmail('quote');
          else if (id === 'btn-email-invoice') openEmail('invoice');
          else if (id === 'btn-mark-paid') setStatus('invoice', 'paid');
        });
        $('billing-card').addEventListener('change', (e) => { const t = e.target.getAttribute('data-status'); if (t) setStatus(t, e.target.value); });
        $('convert-form').addEventListener('submit', confirmConvert);
        $('email-form').addEventListener('submit', sendEmail);
        if (location.hash === '#quote' && !job.quote && !job.invoice) openEditor('quote', null);
        if (location.hash === '#invoice' && !job.invoice) openEditor('invoice', null);
      }
    },
  });
})();
