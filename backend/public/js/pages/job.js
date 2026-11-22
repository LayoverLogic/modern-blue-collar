/*
 * job.html — one job: status, field actions (Navigate / Call / Text / On My Way),
 * schedule & assign (staff), notes, photos, activity log (GET /api/jobs/:id/activity,
 * paged), quotes + invoices with line items — several per job, newest first (staff
 * read, admin edit / email / convert / push to QuickBooks; js/documents.js), print links (print.html), live "who else is viewing"
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
  let docs = { quote: [], invoice: [] };       // full documents (GET /api/quotes|invoices/:id), newest first
  let editing = null;                          // { type, doc } while the editor is open
  let emailing = null;                         // { type, d } while the email modal is open
  const qbo = { status: null, links: {}, msgs: {}, busy: false }; // QuickBooks (admin): GET /api/quickbooks/status + /invoice/:id

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
    $('c-contact').textContent = fmt.contactLine(c);
    $('row-contact').hidden = !fmt.contactLine(c);
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

  // ── Quotes & invoices (several per job; the newest of each is the "primary") ─
  // The primary (newest) quote / invoice keeps the stable element ids (quote-number,
  // btn-edit-invoice, btn-convert, …); every card's buttons also carry data-act, and
  // the card carries data-doc-type / data-doc-id, so any document can be acted on.
  const D = () => MBC.docs;
  const findDoc = (type, id) => (docs[type] || []).find((d) => String(d.id) === String(id)) || null;
  const liveInvoiceFor = (q) => docs.invoice.find((i) => i.quoteId != null && String(i.quoteId) === String(q.id) && i.status !== 'void') || null;
  function btn(primary, id, act, cls, label) {
    return '<button class="btn ' + cls + '" type="button"' + (primary && id ? ' id="' + id + '"' : '') + ' data-act="' + act + '">' + label + '</button>';
  }
  function docCard(type, d, primary) {
    const admin = auth.isAdmin();
    const L = D().label(type);
    const pid = (name) => (primary ? ' id="' + name + '"' : '');
    let head = '<div class="doc-head"><h4><span class="doc-number"' + pid(type + '-number') + '>' + fmt.esc(d.number || ('#' + d.id)) + '</span> <span class="muted">' + L + '</span></h4>';
    if (admin) {
      const sts = type === 'quote' ? ['draft', 'sent', 'approved', 'declined'] : ['unpaid', 'paid', 'overdue', 'void'];
      const sid = type + '-status' + (primary ? '' : '-' + d.id);
      head += '<span><label for="' + sid + '" class="sr-only">' + L + ' ' + fmt.esc(d.number || d.id) + ' status</label><select id="' + sid + '" data-status="' + type + '">' +
        sts.map((st) => '<option value="' + st + '"' + (st === d.status ? ' selected' : '') + '>' + fmt.statusLabel(st) + '</option>').join('') + '</select></span>';
    } else head += fmt.badge(d.status);
    head += '</div>';
    const meta = ['Issued ' + fmt.date(d.issuedAt || d.createdAt)];
    if (type === 'invoice' && d.dueDate) meta.push('due ' + fmt.date(String(d.dueDate).slice(0, 10)));
    if (d.sentAt) meta.push('emailed ' + fmt.dateTime(d.sentAt));
    if (type === 'invoice' && d.paidAt) meta.push('paid ' + fmt.date(d.paidAt));
    if (type === 'invoice' && d.quoteId != null) { const q = findDoc('quote', d.quoteId); meta.push('from ' + (q && q.number ? q.number : 'quote #' + d.quoteId)); }
    if (d.reverseCharge) meta.push('reverse charge');
    let html = '<article class="doc-item' + (primary ? ' primary' : '') + '" data-doc-type="' + type + '" data-doc-id="' + fmt.esc(d.id) + '">' + head +
      '<div class="muted small doc-meta">' + fmt.esc(meta.join(' · ')) + (d.locked ? ' <span class="lock-tag" title="Sent or no longer a draft: only the status can change">Locked</span>' : '') + '</div>';
    html += D().linesHtml(d, { jobTitle: job.title });
    if (d.notes && (d.lines || []).length) html += '<p class="doc-notes small">' + fmt.esc(d.notes) + '</p>';
    html += '<div class="doc-actions">';
    html += '<a class="btn btn-outline btn-sm"' + pid('lnk-print-' + type) + ' href="print.html?type=' + type + '&id=' + encodeURIComponent(d.id) + '" target="_blank" rel="noopener">Print / PDF</a>';
    if (admin) {
      if (!d.locked && !editing) html += btn(primary, 'btn-edit-' + type, 'edit', 'btn-outline btn-sm', 'Edit lines');
      if (d.status !== 'void' && d.status !== 'declined') html += btn(primary, 'btn-email-' + type, 'email', 'btn-sm', d.sentAt ? 'Email again' : 'Email to customer');
      if (type === 'invoice' && d.status !== 'paid' && d.status !== 'void') html += btn(primary, 'btn-mark-paid', 'paid', 'btn-outline btn-sm', 'Mark paid');
      if (type === 'quote' && d.status !== 'declined' && !liveInvoiceFor(d) && !editing) html += btn(primary, 'btn-convert', 'convert', 'btn-sm', 'Convert to invoice');
    }
    html += '</div>';
    if (admin && type === 'quote') { const inv = liveInvoiceFor(d); if (inv) html += '<div class="muted small mt-s">Invoiced as ' + fmt.esc(inv.number || '#' + inv.id) + '</div>'; }
    if (admin && type === 'invoice') html += qboLine(d, primary);
    return html + '</article>';
  }
  function section(type) {
    const list = docs[type];
    const admin = auth.isAdmin();
    const L = D().label(type);
    let html = '<div class="doc-section-head"><h4>' + (type === 'quote' ? 'Quotes' : 'Invoices') + (list.length > 1 ? ' <span class="muted small">(' + list.length + ')</span>' : '') + '</h4>';
    if (admin && !editing) {
      html += type === 'quote'
        ? '<button class="btn btn-sm" type="button" id="btn-build-quote" data-act="new">' + (list.length ? '+ New quote' : 'Build quote') + '</button>'
        : '<button class="btn btn-outline btn-sm" type="button" id="btn-create-invoice" data-act="new">' + (list.length || docs.quote.length ? '+ Blank invoice' : 'Create invoice') + '</button>';
    }
    html += '</div>';
    if (!list.length) return html + '<p class="muted small">No ' + L.toLowerCase() + ' yet.' + (type === 'invoice' && docs.quote.length && admin ? ' Use “Convert to invoice” on a quote, or start a blank one.' : '') + '</p>';
    return html + list.map((d, i) => docCard(type, d, i === 0)).join('');
  }

  // ── QuickBooks link badge + "Push to QuickBooks" (admin) ────────────────────
  function qboLine(d, primary) {
    const st = qbo.status;
    if (!st) return '';
    const link = qbo.links[d.id] || null;
    const pid = (name) => (primary ? ' id="' + name + '"' : '');
    let html = '<div class="qbo-line"' + pid('qbo-line') + '>';
    if (link && link.linked) {
      html += '<span class="badge badge-active"' + pid('qbo-badge') + '>In QuickBooks #' + fmt.esc(link.qboId) + '</span>' +
        '<span class="muted small">synced ' + fmt.esc(fmt.dateTime(link.syncedAt)) + (link.balance != null ? ' · balance ' + fmt.esc(fmt.money(link.balance, d.currency)) : '') + '</span>';
    } else html += '<span class="badge"' + pid('qbo-badge') + '>Not in QuickBooks</span>';
    const busy = qbo.busy === d.id;
    if (d.status !== 'void') {
      if (st.enabled && !st.connected) html += '<a class="btn btn-outline btn-sm" href="settings.html#quickbooks">Connect QuickBooks</a>';
      else html += '<button class="btn btn-outline btn-sm" type="button"' + pid('btn-qbo-push') + ' data-act="qbo-push"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Pushing…' : (link && link.linked ? 'Update in QuickBooks' : 'Push to QuickBooks')) + '</button>';
    }
    const warnings = (link && link.warnings) || [];
    if (warnings.length) html += '<ul class="notes-list small qbo-msg">' + warnings.map((w) => '<li>' + fmt.esc(typeof w === 'string' ? w : (w && w.message) || '') + '</li>').join('') + '</ul>';
    const msg = qbo.msgs[d.id];
    if (msg) html += '<div class="qbo-msg notice ' + msg.kind + ' small"' + pid('qbo-msg') + '>' + fmt.esc(msg.text) + '</div>';
    else if (!st.enabled && primary) html += '<div class="qbo-msg muted small">' + fmt.esc(api.disabledText({ integration: 'quickbooks', reason: st.disabledReason }).replace(' — no request was sent.', ': pushing sends nothing to Intuit.')) + '</div>';
    return html + '</div>';
  }
  async function loadQboLinks() {
    if (!auth.isAdmin()) return;
    if (!qbo.status) qbo.status = await api.get('/api/quickbooks/status').catch(() => null);
    qbo.links = {};
    if (!qbo.status) return;
    const got = await Promise.all(docs.invoice.slice(0, 10).map((inv) => api.get('/api/quickbooks/invoice/' + encodeURIComponent(inv.id)).catch(() => null)));
    docs.invoice.slice(0, 10).forEach((inv, i) => { if (got[i]) qbo.links[inv.id] = got[i]; });
  }
  async function pushQbo(inv) {
    if (!inv || qbo.busy) return;
    qbo.busy = inv.id; delete qbo.msgs[inv.id]; renderBilling();
    try {
      const r = await api.post('/api/quickbooks/sync-invoice/' + encodeURIComponent(inv.id), {});
      const verb = r.action === 'created' ? 'added to' : (r.action === 'updated' ? 'updated in' : 'already up to date in');
      const ws = (r.warnings || []).map((w) => (typeof w === 'string' ? w : (w && w.message) || ''));
      qbo.msgs[inv.id] = { kind: ws.length ? 'warn' : 'ok', text: D().ref(inv, 'invoice') + ' ' + verb + ' QuickBooks' + (r.qbo && r.qbo.id ? ' (#' + r.qbo.id + ')' : '') + '.' + (ws.length ? ' Check: ' + ws.join(' ') : '') };
      await loadQboLinks();
    } catch (e) {
      qbo.msgs[inv.id] = { kind: e.status === 503 ? 'warn' : 'error', text: e.message };
    } finally { qbo.busy = false; renderBilling(); }
  }

  function renderBilling() {
    $('quote-card').innerHTML = section('quote');
    $('invoice-card').innerHTML = section('invoice');
    // Reverse-charge wording that is still the placeholder: never printed; admins are told why.
    const t = fmt.tax();
    const all = docs.quote.concat(docs.invoice);
    const rc = all.some((d) => d.reverseCharge);
    const ph = rc && (t.reverseChargeNoteIsPlaceholder || all.some((d) => d.print && d.print.reverseChargeNoteIsPlaceholder));
    $('rc-banner').hidden = !(auth.isAdmin() && ph);
    $('rc-banner').textContent = ph ? 'Reverse charge is on, but the reverse-charge wording is still the placeholder text. It is NOT printed or emailed as compliant wording: set BRAND_RCT_NOTE to wording confirmed by an accountant.' : '';
  }
  // Job responses list every document (quotes[] / invoices[], newest first); older
  // servers only send quote / invoice.
  const MAX_DOCS = 20;
  async function loadDocs() {
    const refs = (type) => {
      const many = job[type + 's'];
      return Array.isArray(many) ? many.slice(0, MAX_DOCS) : (job[type] ? [job[type]] : []);
    };
    const get = (type, ref) => api.get('/api/' + type + 's/' + encodeURIComponent(ref.id)).catch(() => Object.assign({ lines: [] }, ref));
    const [qs, is] = await Promise.all([Promise.all(refs('quote').map((r) => get('quote', r))), Promise.all(refs('invoice').map((r) => get('invoice', r)))]);
    docs.quote = qs; docs.invoice = is;
    await loadQboLinks();
    renderBilling();
  }

  // ── Editor (quote or invoice) ───────────────────────────────────────────────
  async function openEditor(type, doc) {
    if (pricebook === null) {
      try { const pb = await api.get('/api/pricebook'); pricebook = Array.isArray(pb) ? pb : (pb.items || []); }
      catch (e) { pricebook = []; ui.toast('Could not load the pricebook: ' + e.message, 'error'); }
    }
    editing = { type, doc: doc || null };
    $('de-title').textContent = doc ? 'Edit ' + D().ref(doc, type) : (type === 'quote' ? (docs.quote.length ? 'Build another quote' : 'Build a quote') : 'Create an invoice');
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
    const d = (saved && findDoc(type, saved.id)) || saved;
    ui.toast(D().ref(d, type) + ' saved: ' + fmt.money(d.amount, d.currency) + '.', 'ok');
  }

  async function setStatus(type, d, status) {
    if (!d) return;
    try { await api.patch('/api/' + type + 's/' + d.id, { status, version: d.version }); ui.toast(D().ref(d, type) + ' marked ' + fmt.statusLabel(status).toLowerCase() + '.', 'ok'); }
    catch (e) { ui.toast(e.message, 'error'); }
    await load();
  }

  // ── Convert quote → invoice ─────────────────────────────────────────────────
  let converting = null; // the quote being converted
  function openConvert(q) {
    if (!q) return;
    converting = q;
    $('convert-title').textContent = 'Convert ' + D().ref(q, 'quote') + ' to an invoice';
    $('convert-summary').textContent = 'The invoice copies the quote\'s ' + ((q.lines || []).length || 1) + ' line(s) and its total of ' + fmt.money(q.amount, q.currency) + '.' +
      (q.status === 'approved' ? '' : ' The quote is ' + fmt.statusLabel(q.status).toLowerCase() + ', not approved — check before converting.');
    $('convert-due').value = fmt.addDays(fmt.todayISO(), 14);
    $('convert-notes').value = '';
    ui.openModal('convert-modal');
  }
  async function confirmConvert(e) {
    e.preventDefault();
    const q = converting; if (!q) return;
    $('btn-convert-confirm').disabled = true;
    try {
      const inv = await api.post('/api/invoices/from-quote/' + encodeURIComponent(q.id), { dueDate: $('convert-due').value || undefined, notes: $('convert-notes').value.trim() || undefined });
      ui.closeModal('convert-modal');
      ui.toast(D().ref(inv, 'invoice') + ' created from ' + (q.number || 'the quote') + ' for ' + fmt.money(inv.amount, inv.currency) + '.', 'ok');
      await load();
    } catch (ex) {
      if (ex.code === 'DUPLICATE') { ui.closeModal('convert-modal'); ui.toast(q.number ? q.number + ' already has a live invoice — void it first to bill this quote again.' : 'This quote already has a live invoice.', 'error'); await load(); }
      else ui.formError('convert-error', ex.code === 'INVALID_AMOUNT' ? 'The quote total is 0, so there is nothing to invoice.' : ex);
    } finally { $('btn-convert-confirm').disabled = false; }
  }

  // ── Email to customer ───────────────────────────────────────────────────────
  function openEmail(type, d) {
    if (!d) return;
    emailing = { type, d };
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
    if (!emailing) return;
    const { type, d } = emailing;
    $('btn-email-send').disabled = true; $('btn-email-send').textContent = 'Sending…';
    try {
      const r = await api.post('/api/' + type + 's/' + encodeURIComponent(d.id) + '/email', { message: $('email-message').value.trim() || undefined });
      ui.closeModal('email-modal');
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
    const known = to && to[kind + 'Id'] != null ? findDoc(kind, to[kind + 'Id']) : null;
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
      job = Object.assign({}, job, updated, { quote: job.quote, invoice: job.invoice, quotes: job.quotes, invoices: job.invoices, jobParts: job.jobParts });
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
          const b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          const card = b.closest('[data-doc-type]');
          const sec = b.closest('#quote-card') ? 'quote' : 'invoice';
          const type = card ? card.getAttribute('data-doc-type') : sec;
          const d = card ? findDoc(type, card.getAttribute('data-doc-id')) : null;
          switch (b.getAttribute('data-act')) {
            case 'new': openEditor(sec, null); break;
            case 'edit': openEditor(type, d); break;
            case 'email': openEmail(type, d); break;
            case 'paid': setStatus('invoice', d, 'paid'); break;
            case 'convert': openConvert(d); break;
            case 'qbo-push': pushQbo(d); break;
            default: break;
          }
        });
        $('billing-card').addEventListener('change', (e) => {
          const t = e.target.getAttribute('data-status'); if (!t) return;
          const card = e.target.closest('[data-doc-id]');
          setStatus(t, card && findDoc(t, card.getAttribute('data-doc-id')), e.target.value);
        });
        $('convert-form').addEventListener('submit', confirmConvert);
        $('email-form').addEventListener('submit', sendEmail);
        // quote-invoice.html → "New quote" lands here with #quote: open a new quote.
        if (location.hash === '#quote') { history.replaceState({}, '', location.pathname + location.search); openEditor('quote', null); }
        if (location.hash === '#invoice') { history.replaceState({}, '', location.pathname + location.search); openEditor('invoice', null); }
      }
    },
  });
})();
