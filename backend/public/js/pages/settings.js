/*
 * settings.html — admin settings (admin / super-admin only).
 *
 *   Data tab
 *     Import customers   GET /api/imports/presets, GET /api/imports/templates/customers.csv,
 *                        POST /api/imports/customers?dryRun=true  → reconciliation (gate-3 counts,
 *                        possible duplicates with a decision per row, exceptions, spot check),
 *                        format=zip → report zip, dryRun=false&expectSha256=<dry run's sha256> → commit,
 *                        POST /api/imports/customers/undo (last committed import kept in localStorage
 *                        as a trimmed undo record, or a saved report.json)
 *     Export everything  GET /api/exports/all[?photos=false] (streamed zip, progress shown)
 *     Xero               GET /api/exports/xero-invoices?from&to&status&dateFormat (X-MBC-Xero-* headers)
 *     List exports       GET /api/exports/{customers,jobs,quotes,invoices}[?view=lines]
 *   QuickBooks tab       GET /api/quickbooks/status, POST connect (→ navigate to authUrl),
 *                        POST disconnect, POST sync-payments. 503 = disabled (sandbox / demo /
 *                        no credentials): shown as "disabled — no request was sent".
 */
(function () {
  'use strict';
  const { fmt, api, ui } = window.MBC;
  const $ = ui.$;
  const esc = fmt.esc;
  const UNDO_KEY = 'mbc.lastImport';

  // ── Tabs ────────────────────────────────────────────────────────────────────
  function showTab(name) {
    if (!['data', 'quickbooks'].includes(name)) name = 'data';
    document.querySelectorAll('.tabs .tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('tab-data').hidden = name !== 'data';
    $('tab-quickbooks').hidden = name !== 'quickbooks';
    if (name === 'quickbooks') loadQbo();
  }

  // ── Import customers ────────────────────────────────────────────────────────
  let presets = null;
  const imp = { file: null, report: null, decisions: {}, committed: null };

  function setStep(n) {
    document.querySelectorAll('#import-steps li').forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle('active', s === n); li.classList.toggle('done', s < n);
    });
  }
  function importOptions() {
    const o = { missingPhone: $('imp-missing-phone').value, undecided: $('imp-undecided').value };
    if ($('imp-exclude-archived').checked) o.excludeArchived = true;
    return o;
  }
  function importForm(withDecisions) {
    const fd = new FormData();
    fd.append('file', imp.file, imp.file.name);
    fd.append('options', JSON.stringify(importOptions()));
    const d = withDecisions ? decisionsPayload() : null;
    if (d) fd.append('decisions', JSON.stringify(d));
    return fd;
  }
  function decisionsPayload() {
    const out = {};
    for (const [k, v] of Object.entries(imp.decisions)) if (v) out[k] = { decision: v };
    return Object.keys(out).length ? out : null;
  }
  function importUrl(extra) {
    return '/api/imports/customers?source=' + encodeURIComponent($('imp-source').value) + (extra || '');
  }

  const COUNT_LABELS = [
    ['sourceRows', 'Rows in file'], ['created', 'New'], ['updated', 'Updated'], ['merged', 'Merged'],
    ['excluded', 'Left out'], ['errored', 'Problems'], ['unexplained', 'Unexplained'],
  ];
  function countsHtml(c) {
    return COUNT_LABELS.map(([k, label]) => {
      const v = Number(c[k] || 0);
      const cls = (k === 'errored' && v) || (k === 'unexplained' && v) ? ' warn' : (k === 'sourceRows' ? ' total' : '');
      const sub = k === 'updated' && c.updatedUnchanged ? '<div class="sub">' + esc(c.updatedUnchanged) + ' unchanged</div>' : '';
      return '<div class="count-tile' + cls + '" data-count="' + esc(k) + '"><div class="label">' + esc(label) + '</div><div class="value">' + esc(v) + '</div>' + sub + '</div>';
    }).join('');
  }
  // Plain-words check that every row is accounted for: "12 rows in the file = 9 new + 0 updated + …".
  // (The technical equation and the rule codes are in the downloadable report.)
  const EQ_WORDS = { sourceRows: 'rows in the file', created: 'new', updated: 'updated', merged: 'merged', excluded: 'left out', errored: 'with problems', unexplained: 'unexplained' };
  function gate3Html(r) {
    const g = r.gate3 || {};
    const c = r.counts || {};
    const eq = String(g.equation || 'sourceRows = created + updated + merged + excluded + errored');
    const words = eq.replace(/[A-Za-z]+/g, (w) => (w in EQ_WORDS ? Number(c[w] || 0) + ' ' + EQ_WORDS[w] : w));
    return '<span class="badge ' + (g.holds ? 'badge-active' : 'badge-overdue') + '" id="gate3-badge">' + (g.holds ? 'Every row is accounted for' : 'Rows do not add up') + '</span> ' +
      '<span class="small" id="gate3-eq">' + esc(words) + '</span>';
  }

  // ── End-user wording for importer rule codes (helpers/importer.js) ──────────
  // The server's "detail" text is written for whoever runs a migration (it names playbook
  // sections, option keys and record refs). On screen each row gets a plain reason + detail;
  // anything not listed falls back to the server text with that jargon removed.
  const RULE_TEXT = {
    auto_merge: 'Very likely the same customer', review: 'Possibly the same customer',
  };
  const OUTCOME_TEXT = { created: 'New', updated: 'Updated', merged: 'Merged', excluded: 'Left out', errored: 'Problem' };
  const quoted = (d) => { const m = /"([^"]*)"/.exec(String(d || '')); return m ? m[1] : ''; };
  function fieldWord(f) {
    const L = fmt.addressLabels();
    return ({ firstName: 'first name', lastName: 'last name', company: 'company name', email: 'email', phone: 'phone number', address: L.address.toLowerCase(),
      addressLine2: L.addressLine2.toLowerCase(), city: L.city.toLowerCase(), state: L.region.toLowerCase(), zip: L.postal, notes: 'notes',
      createdAt: 'created date', lifetimeValue: 'lifetime value', type: 'customer type' })[f] || String(f || 'value').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  }
  // Plain "why these look alike" for a possible duplicate.
  function matchWhy(why) {
    const pc = fmt.addressLabels().postal;
    const w = String(why || '');
    if (/same email/.test(w)) return 'Same email, and the same phone number or ' + pc;
    if (/same phone and same postcode/.test(w)) return 'Same phone number and ' + pc;
    if (/same display name and same postcode/.test(w)) return 'Same name and ' + pc;
    return plainText(w);
  }
  // Strip migration jargon from any leftover server text.
  function plainText(t) {
    return String(t || '')
      .replace(/\s*\(§[^)]*\)/g, '').replace(/§\s*[\d.]+(\s*rule\s*\d+)?/g, '')
      .replace(/\s*\(?options\.\w+\s*=\s*"?[\w-]*"?[^)]*\)?/g, '')
      .replace(/\s*[—-]?\s*needs client approval at Gate \d/gi, '').replace(/\bGate \d\b/g, 'review')
      .replace(/\b(customer|row):(\d+)/g, (m, k, n) => (k === 'row' ? 'row ' + n : 'an existing customer'))
      .replace(/decide in merge-candidates\.csv and re-run/g, 'choose what to do under Possible duplicates above, then re-check')
      .replace(/\(IntegrationLink\)/g, '').replace(/mapping\.typeMap/g, 'the import settings')
      .replace(/\s{2,}/g, ' ').trim();
  }
  function plainException(e) {
    const pc = fmt.addressLabels().postal;
    const v = quoted(e.detail);
    switch (e.rule) {
      case 'missing_name': return ['No name', 'The row has no first, last, full or company name.'];
      case 'missing_phone': return ['No phone number', 'Add a phone number in the file, or under Options choose to import rows with the phone left blank.'];
      case 'invalid_phone': return ['Phone number not valid', plainText(e.detail)];
      case 'invalid_email': return ['Email not valid', v ? '"' + v + '" is not a valid email address.' : 'The email address is not valid.'];
      case 'unknown_type': return ['Unknown customer type', v ? 'The type "' + v + '" is not one this system knows (residential or commercial).' : 'The customer type is not recognised.'];
      case 'invalid_postcode': return [pc + ' not valid', plainText(e.detail)];
      case 'address_required': return ['Address incomplete', plainText(e.detail)];
      case 'invalid_date': return ['Date not valid', plainText(e.detail)];
      case 'date_format_required': return ['Date format unclear', (v ? '"' + v + '" could be day/month or month/day. ' : '') + 'Use YYYY-MM-DD dates in the file, or ask us to set the date format for this import.'];
      case 'invalid_amount': return ['Amount not valid', plainText(e.detail)];
      case 'too_long': return ['Too long', 'The ' + fieldWord(e.field) + ' is longer than this system allows.'];
      case 'archived_out_of_scope': return ['Archived', 'Marked archived in the file, and you chose to leave archived customers out.'];
      case 'pending_merge_decision': return ['Waiting for your decision', 'Looks like a customer you already have. Choose what to do under Possible duplicates above, then re-check.'];
      case 'decision_exclude': return ['Left out by you', 'You chose to leave this row out.'];
      case 'duplicate_source_id_conflict': return ['Same ID as another row', 'Another row in the file has the same ID with a different name.'];
      case 'same_source_id_extra_row': return ['Extra address', 'Same customer as an earlier row; this address is added to that customer’s notes.'];
      case 'merge_without_target': case 'merge_target_missing': case 'merge_target_not_loaded':
        return ['Could not merge', 'The customer to merge into could not be found. Choose another option and re-check.'];
      default: return [String(e.rule || '').replace(/_/g, ' '), plainText(e.detail)];
    }
  }
  function who(x) {
    if (!x) return '';
    return [x.name, x.email, x.phone ? fmt.phone(x.phone) : '', x.address, x.postcode].filter(Boolean).map((v) => esc(v)).join('<br>');
  }
  // "customer:19" → a link to that customer (the ref itself is never shown).
  function existingLink(c) {
    const m = c && /^customer:(\d+)$/.exec(String(c.ref || ''));
    return m ? '<a class="small" href="customer-detail.html?id=' + esc(m[1]) + '" target="_blank" rel="noopener">View this customer</a>' : '';
  }
  function renderMerge(r) {
    const list = r.mergeCandidates || [];
    $('dr-merge-wrap').hidden = !list.length;
    $('dr-pending').textContent = list.length ? '(' + list.length + ' found, ' + (r.pendingDecisions || 0) + ' still to decide)' : '';
    $('dr-undecided-word').textContent = $('imp-undecided').value === 'create' ? 'imported as new customers' : 'held back (not imported)';
    const opts = [['', 'Undecided'], ['merge', 'Same customer: merge'], ['create', 'Different: add as new'], ['exclude', 'Leave out']];
    $('dr-merge').querySelector('tbody').innerHTML = list.map((m, i) => {
      const cur = imp.decisions[m.key] != null ? imp.decisions[m.key] : (m.decision || '');
      const id = 'dec-' + i;
      return '<tr data-key="' + esc(m.key) + '">' +
        '<td data-label="Row">' + esc(m.row) + '<div class="muted small">' + esc(m.key) + '</div></td>' +
        '<td data-label="Match"><span class="badge ' + (m.rule === 'auto_merge' ? 'badge-approved' : 'badge-sent') + '">' + esc(RULE_TEXT[m.rule] || 'Possibly the same customer') + '</span><div class="muted small">' + esc(matchWhy(m.why)) + '</div></td>' +
        '<td data-label="In the file">' + who(m.source) + '</td>' +
        '<td data-label="Existing">' + who(m.candidate) + '<div>' + existingLink(m.candidate) + '</div></td>' +
        '<td data-label="Decision"><label for="' + id + '" class="sr-only">Decision for row ' + esc(m.row) + '</label><select id="' + id + '" class="merge-decision" data-key="' + esc(m.key) + '">' +
          opts.map((o) => '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></td></tr>';
    }).join('');
  }
  const EXC_MAX = 100;
  function renderExceptions(r) {
    const list = r.exceptions || [];
    $('dr-exceptions-wrap').hidden = !list.length;
    $('dr-exc-count').textContent = list.length ? '(' + list.length + (list.length > EXC_MAX ? ', first ' + EXC_MAX + ' shown — the report has them all' : '') + ')' : '';
    $('dr-exceptions').querySelector('tbody').innerHTML = list.slice(0, EXC_MAX).map((e) => {
      const [reason, detail] = plainException(e);
      return '<tr data-rule="' + esc(e.rule) + '"><td data-label="Row">' + esc(e.row) + (e.line ? '<div class="muted small">line ' + esc(e.line) + '</div>' : '') + '</td>' +
        '<td data-label="ID in the file">' + fmt.text(e.source_id) + '</td>' +
        '<td data-label="Outcome">' + esc(OUTCOME_TEXT[e.outcome] || e.outcome) + '</td>' +
        '<td data-label="Reason">' + esc(reason) + '</td>' +
        '<td data-label="Detail" class="wrap">' + fmt.text(detail) + '</td></tr>';
    }).join('');
  }
  function valuesHtml(obj, keys) {
    const ks = keys || Object.keys(obj || {});
    // Saved fields get their screen names (keys given); the file's own column names stay as they are.
    const lab = (k) => (keys ? fieldWord(k).replace(/^./, (c) => c.toUpperCase()) : k);
    return ks.filter((k) => obj && obj[k] != null && obj[k] !== '').slice(0, 8)
      .map((k) => '<div><span class="muted">' + esc(lab(k)) + ':</span> ' + esc(k === 'phone' ? fmt.phone(obj[k]) : obj[k]) + '</div>').join('') || fmt.DASH;
  }
  const STRATUM_TEXT = { top_by_lifetime_value: 'Top customer', commercial: 'Commercial', multiple_sites: 'Several addresses', random: 'Random pick', merged: 'Merged', updated: 'Updated', errored: 'Problem', excluded: 'Left out', created: 'New' };
  const MBC_KEYS = ['company', 'firstName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zip', 'type'];
  function renderSpot(r) {
    const s = r.spotCheck || {};
    const list = s.sample || [];
    $('dr-spot-wrap').hidden = !list.length;
    $('dr-spot-count').textContent = list.length ? '(' + list.length + ' rows)' : '';
    $('dr-spot').querySelector('tbody').innerHTML = list.map((x) =>
      '<tr><td data-label="#">' + esc(x.sample) + '<div class="muted small">' + esc(STRATUM_TEXT[x.stratum] || String(x.stratum || '').replace(/_/g, ' ')) + '</div></td>' +
      '<td data-label="Row">' + esc(x.row) + '<div class="muted small">' + esc(x.sourceId) + '</div></td>' +
      '<td data-label="Outcome">' + esc(OUTCOME_TEXT[x.outcome] || x.outcome) + '</td>' +
      '<td data-label="In the file" class="wrap small">' + valuesHtml(x.sourceValues) + '</td>' +
      '<td data-label="Saved as" class="wrap small">' + valuesHtml(x.mbcValues, MBC_KEYS) + '</td></tr>').join('');
    $('dr-spot-notes').innerHTML = (s.notes || []).map((n) => '<li>' + esc(plainSpotNote(n)) + '</li>').join('');
  }
  function plainSpotNote(n) {
    if (/no lifetime value column/.test(n)) return 'The file has no lifetime value column, so the "top customers" in this sample are picked at random.';
    return plainText(n);
  }
  function writesOf(c) { return Number(c.created || 0) + Number(c.updated || 0) - Number(c.updatedUnchanged || 0) + Number(c.merged || 0); }

  function renderDryRun(r) {
    imp.report = r;
    setStep(2);
    $('import-form').hidden = true;
    $('import-result').hidden = true;
    $('dry-run').hidden = false;
    const f = (r.files || [])[0] || {};
    const notes = [];
    if (r.derivedSourceIds) notes.push('This file has no ID column, so IDs were made from row values. Re-importing an edited file may then add duplicates.');
    if ((r.unmappedColumns || []).length) notes.push('Columns not used: ' + r.unmappedColumns.join(', ') + '.');
    $('dr-banner').innerHTML = '<strong>Dry run — nothing has been written.</strong> ' + esc(f.name || 'file') + ' · ' + esc(f.rows) + ' row(s) · ' +
      esc(fmt.bytes(f.bytes)) +
      notes.map((n) => '<div class="mt-s">' + esc(n) + '</div>').join('');
    $('dr-counts').innerHTML = countsHtml(r.counts || {});
    $('dr-gate3').innerHTML = gate3Html(r);
    renderMerge(r); renderExceptions(r); renderSpot(r);
    const c = r.counts || {};
    const n = writesOf(c);
    const ok = r.gate3 && r.gate3.holds && !Number(c.unexplained);
    $('btn-commit').disabled = !ok || n === 0;
    $('btn-commit').textContent = n ? 'Import ' + n + ' customer' + (n === 1 ? '' : 's') : 'Nothing to import';
    ui.formError('commit-error', !ok ? 'Some rows are not accounted for, so importing is blocked. Download the report and send it to us.' : null);
  }

  async function runDryRun(e) {
    if (e) e.preventDefault();
    const inp = $('imp-file');
    if (inp.files && inp.files[0]) imp.file = inp.files[0];
    if (!imp.file) { ui.formError('import-error', 'Choose a CSV file first.'); return; }
    ui.formError('import-error', null);
    const btn = e && e.type === 'submit' ? $('btn-dry-run') : $('btn-apply-decisions');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await api.upload(importUrl('&dryRun=true'), importForm(true));
      renderDryRun(r);
    } catch (ex) {
      if (!$('dry-run').hidden) ui.formError('commit-error', ex); else ui.formError('import-error', ex);
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  async function reportZip() {
    if (!imp.file) return;
    const btn = $('btn-report-zip'); btn.disabled = true;
    try {
      const r = await api.fetchBlob('POST', importUrl('&dryRun=true&format=zip'), importForm(true), { filename: 'import-report.zip' });
      api.saveBlob(r.blob, r.filename);
      ui.toast('Report saved: ' + r.filename, 'ok');
    } catch (ex) { ui.formError('commit-error', ex); }
    finally { btn.disabled = false; }
  }

  function openCommit() {
    const r = imp.report; if (!r) return;
    const c = r.counts || {};
    const held = Number(r.pendingDecisions || 0);
    $('commit-summary').innerHTML = '<ul class="notes-list">' +
      '<li><strong>' + esc(c.created || 0) + '</strong> new customer(s)</li>' +
      '<li><strong>' + esc(Number(c.updated || 0) - Number(c.updatedUnchanged || 0)) + '</strong> updated (blank cells never clear a value)</li>' +
      '<li><strong>' + esc(c.merged || 0) + '</strong> merged into existing customers</li>' +
      '<li>' + esc(Number(c.excluded || 0) + Number(c.errored || 0)) + ' row(s) left out or with problems are not imported</li>' +
      (held && $('imp-undecided').value === 'hold' ? '<li class="error-text">' + esc(held) + ' possible duplicate(s) are undecided and will be held back</li>' : '') +
      '</ul>';
    ui.openModal('commit-modal');
  }

  function trimForUndo(r) {
    return {
      kind: r.kind, version: r.version, mode: r.mode, committed: r.committed, runId: r.runId, generatedAt: r.generatedAt,
      source: r.source, sourceSystem: r.sourceSystem, counts: r.counts, files: (r.files || []).map((f) => ({ name: f.name, rows: f.rows, sha256: f.sha256 })),
      rows: (r.rows || []).filter((x) => x.customerId).map((x) => ({ row: x.row, sourceId: x.sourceId, outcome: x.outcome, rule: x.rule, customerId: x.customerId, target: x.target, before: x.before, changes: x.changes })),
    };
  }

  async function commitImport(e) {
    e.preventDefault();
    const r = imp.report; if (!r || !imp.file) return;
    const sha = (r.files && r.files[0] && r.files[0].sha256) || '';
    const btn = $('btn-commit-confirm'); btn.disabled = true; btn.textContent = 'Importing…';
    try {
      const res = await api.upload(importUrl('&dryRun=false&expectSha256=' + encodeURIComponent(sha)), importForm(true));
      ui.closeModal('commit-modal');
      imp.committed = res;
      try { localStorage.setItem(UNDO_KEY, JSON.stringify(trimForUndo(res))); } catch (x) { /* storage full: the report download still works */ }
      renderCommitted(res);
      renderUndoLast();
    } catch (ex) {
      ui.closeModal('commit-modal');
      ui.formError('commit-error', ex);
    } finally { btn.disabled = false; btn.textContent = 'Import now'; }
  }

  function renderCommitted(r) {
    setStep(3);
    $('dry-run').hidden = true;
    $('import-result').hidden = false;
    const ok = r.committed;
    const banner = $('ir-banner');
    banner.className = 'notice ' + (ok ? 'ok' : 'error');
    banner.innerHTML = ok
      ? '<strong>Import complete.</strong> Download the report and keep it with the file you imported (reference <span class="nowrap">' + esc(r.runId) + '</span>).'
      : '<strong>The import stopped part-way.</strong> Batches that failed were rolled back; see below (reference <span class="nowrap">' + esc(r.runId) + '</span>).';
    $('ir-counts').innerHTML = countsHtml(r.counts || {});
    $('ir-gate3').innerHTML = gate3Html(r);
    $('ir-batches').innerHTML = (r.batches || []).map((b) => '<li>Batch ' + esc(b.batch) + ': ' + esc(b.rows) + ' row(s) — ' + esc(String(b.status).replace(/_/g, ' ')) + '</li>').join('');
  }
  function saveCommittedReport() {
    const r = imp.committed; if (!r) return;
    const copy = Object.assign({}, r); delete copy.markdown;
    api.saveBlob(new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' }), (r.runId || 'import') + '_report.json');
  }
  function resetImport() {
    imp.file = null; imp.report = null; imp.decisions = {}; imp.committed = null;
    $('import-form').reset(); $('import-form').hidden = false;
    $('dry-run').hidden = true; $('import-result').hidden = true;
    ui.formError('import-error', null); ui.formError('commit-error', null);
    setStep(1); sourceHelp();
  }

  // Undo
  function lastImport() { try { return JSON.parse(localStorage.getItem(UNDO_KEY) || 'null'); } catch (e) { return null; } }
  function renderUndoLast() {
    const last = lastImport();
    const box = $('undo-last');
    if (!last || !last.runId) { box.innerHTML = '<p class="muted small">No import from this browser to undo.</p>'; return; }
    const c = last.counts || {};
    box.innerHTML = '<div class="info-row"><span class="info-label">Last import</span><span class="info-value" id="undo-last-run">' + esc(last.runId) + '</span></div>' +
      '<div class="info-row"><span class="info-label">When</span><span class="info-value">' + esc(fmt.dateTime(last.generatedAt)) + '</span></div>' +
      '<div class="info-row"><span class="info-label">What</span><span class="info-value">' + esc((c.created || 0) + ' new, ' + (c.updated || 0) + ' updated, ' + (c.merged || 0) + ' merged') + '</span></div>' +
      '<div class="field-actions"><button class="btn btn-danger" type="button" id="btn-undo-last">Undo last import</button></div>';
  }
  async function undo(reportObj, btn) {
    if (!reportObj) return;
    if (!confirm('Undo import ' + (reportObj.runId || '') + '? New customers it added are removed and changed customers are put back.')) return;
    const status = $('undo-status');
    if (btn) btn.disabled = true;
    status.className = 'small'; status.textContent = 'Undoing…';
    try {
      const fd = new FormData();
      fd.append('report', new Blob([JSON.stringify(reportObj)], { type: 'application/json' }), 'report.json');
      const r = await api.upload('/api/imports/customers/undo', fd);
      const skipped = r.skipped || [];
      status.className = 'notice ' + (skipped.length ? 'warn' : 'ok') + ' small';
      status.innerHTML = '<strong>Undone.</strong> <span id="undo-summary">' + esc(r.deleted) + ' removed, ' + esc(r.restored) + ' restored, ' + esc(r.unlinked) + ' unlinked.</span>' +
        (skipped.length ? '<div class="mt-s">Not undone (fix by hand):</div><ul class="notes-list">' +
          skipped.map((s) => '<li>Customer ' + esc(s.customerId != null ? '#' + s.customerId : '') + (s.row != null ? ' (row ' + esc(s.row) + ')' : '') + ': ' + esc(s.reason) + '</li>').join('') + '</ul>' : '');
      const last = lastImport();
      if (last && last.runId === reportObj.runId) localStorage.removeItem(UNDO_KEY);
      renderUndoLast();
    } catch (ex) {
      status.className = 'notice error small';
      status.textContent = ex.code === 'INVALID_INPUT' ? 'That is not the report of a completed import (report.json from an import, not a dry run).' : ui.errMsg(ex);
    } finally { if (btn) btn.disabled = false; }
  }
  async function undoFromFile() {
    const inp = $('undo-file');
    const f = inp.files && inp.files[0];
    if (!f) { $('undo-status').className = 'small error-text'; $('undo-status').textContent = 'Choose a report.json file first.'; return; }
    let obj = null;
    try { obj = JSON.parse(await f.text()); } catch (e) { obj = null; }
    if (!obj || obj.kind !== 'customer-import' || obj.mode !== 'commit') {
      $('undo-status').className = 'notice error small';
      $('undo-status').textContent = 'That file is not the report of a completed customer import.';
      return;
    }
    await undo(obj, $('btn-undo-file'));
  }

  function sourceHelp() {
    const p = presets && presets.presets && presets.presets[$('imp-source').value];
    $('imp-source-help').textContent = p ? p.label : '';
  }

  // ── Export everything ───────────────────────────────────────────────────────
  async function exportAll() {
    const btn = $('btn-export-all');
    const st = $('export-all-status');
    btn.disabled = true;
    st.className = 'small mt-s'; st.textContent = 'Preparing the export…';
    try {
      const url = '/api/exports/all' + ($('exp-photos').checked ? '' : '?photos=false');
      const r = await api.fetchBlob('GET', url, undefined, {
        filename: 'export.zip',
        onProgress(got, total) { st.textContent = 'Downloading… ' + fmt.bytes(got) + (total ? ' of ' + fmt.bytes(total) : ''); },
      });
      api.saveBlob(r.blob, r.filename);
      st.className = 'notice ok small mt-s';
      st.innerHTML = 'Saved <strong id="export-all-name">' + esc(r.filename) + '</strong> (' + esc(fmt.bytes(r.blob.size)) + '). ' +
        'Check it with <code>sha256sum -c SHA256SUMS</code> after unzipping.';
    } catch (ex) {
      st.className = 'notice error small mt-s';
      st.textContent = 'Export failed: ' + ui.errMsg(ex);
    } finally { btn.disabled = false; }
  }

  // ── Xero ────────────────────────────────────────────────────────────────────
  async function exportXero(e) {
    e.preventDefault();
    const from = $('xero-from').value, to = $('xero-to').value;
    const statuses = [...document.querySelectorAll('input[name="xero-status"]:checked')].map((x) => x.value);
    if (from && to && from > to) { ui.formError('xero-error', '"Issued from" must be on or before "Issued to".'); return; }
    if (!statuses.length) { ui.formError('xero-error', 'Tick at least one invoice status.'); return; }
    ui.formError('xero-error', null);
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (statuses.length < 3) q.set('status', statuses.join(','));
    if ($('xero-date-format').value) q.set('dateFormat', $('xero-date-format').value);
    const btn = $('btn-xero'); btn.disabled = true;
    const out = $('xero-result'); out.innerHTML = '';
    try {
      const r = await api.fetchBlob('GET', '/api/exports/xero-invoices?' + q.toString(), undefined, { filename: 'xero_invoices.csv' });
      api.saveBlob(r.blob, r.filename);
      const h = (k) => r.headers.get(k);
      const n = Number(h('X-MBC-Xero-Invoices') || 0), lines = Number(h('X-MBC-Xero-Lines') || 0);
      let html = '<div class="notice ' + (n ? 'ok' : 'info') + ' small" id="xero-summary">' +
        (n ? 'Saved <strong>' + esc(r.filename) + '</strong>: ' + esc(n) + ' invoice(s), ' + esc(lines) + ' line(s), dates as ' + esc(h('X-MBC-Xero-Date-Format') || '') + '.'
          : 'No invoices were issued in that range with those statuses — the file only has the column headings.') + '</div>';
      const unmapped = (h('X-MBC-Xero-Unmapped-Tax') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (unmapped.length) {
        html += '<div class="notice warn small" id="xero-unmapped"><strong>Check the tax rates before importing.</strong> No Xero tax rate name is set for: ' +
          unmapped.map((k) => '<code>' + esc(k) + '</code>').join(', ') + '. The file uses a placeholder name for ' + (unmapped.length === 1 ? 'it' : 'them') +
          ', which Xero will reject or mis-file. Ask your administrator to set <code>XERO_TAX_TYPES</code> to the tax rate names in your Xero organisation.</div>';
      }
      let warn = h('X-MBC-Xero-Warnings') || '';
      try { warn = decodeURIComponent(warn); } catch (x) { /* keep as is */ }
      const ws = warn.split(' | ').map((s) => s.trim()).filter(Boolean);
      if (ws.length) html += '<div class="notice warn small" id="xero-warnings"><ul class="notes-list">' + ws.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>';
      out.innerHTML = html;
    } catch (ex) { ui.formError('xero-error', ex); }
    finally { btn.disabled = false; }
  }

  // ── List exports ────────────────────────────────────────────────────────────
  async function listExport(btn) {
    const what = btn.getAttribute('data-export');
    const st = $('list-export-status');
    btn.disabled = true; st.textContent = 'Preparing ' + btn.textContent.trim().toLowerCase() + '…';
    try { const name = await api.download('/api/exports/' + what, what.replace(/\?view=/, '_') + '.csv'); st.textContent = 'Saved ' + name + '.'; }
    catch (ex) { st.textContent = ''; ui.toast(ui.errMsg(ex), 'error'); }
    finally { btn.disabled = false; }
  }

  // ── QuickBooks ──────────────────────────────────────────────────────────────
  let qbo = null;
  function qboReasonText(s) {
    if (s.disabledReason === 'sandbox') return 'QuickBooks is <strong>disabled in sandbox</strong> (SANDBOX_MODE=true). The buttons below answer straight away and <strong>no request is ever sent to Intuit</strong>.';
    if (s.disabledReason === 'demo') return 'QuickBooks is <strong>disabled in demo mode</strong> (DEMO_MODE=true). No request is ever sent to Intuit.';
    return 'QuickBooks is <strong>not set up</strong> on this system: its app credentials (QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI) are missing or placeholders. No request is sent to Intuit until they are set.';
  }
  function row(label, value, id) {
    return '<div class="info-row"><span class="info-label">' + esc(label) + '</span><span class="info-value"' + (id ? ' id="' + id + '"' : '') + '>' + value + '</span></div>';
  }
  async function loadQbo() {
    try { qbo = await api.get('/api/quickbooks/status'); }
    catch (e) { $('qbo-status').innerHTML = '<div class="error-text">' + esc(e.message) + '</div>'; return; }
    const s = qbo;
    $('qbo-disabled').hidden = !!s.enabled;
    $('qbo-disabled').innerHTML = s.enabled ? '' : qboReasonText(s);
    const sync = s.sync || {};
    $('qbo-status').innerHTML =
      row('Status', s.connected ? '<span class="badge badge-active">Connected</span>' : '<span class="badge">Not connected</span>', 'qbo-state') +
      row('Environment', esc(s.environment === 'production' ? 'Production' : 'Intuit sandbox')) +
      (s.connected ? row('Company ID (realm)', fmt.text(s.realmId), 'qbo-realm') +
        row('Connected', esc(fmt.dateTime(s.connectedAt))) +
        row('Authorisation renews by', esc(fmt.dateTime(s.refreshExpiresAt))) +
        row('Linked invoices', esc(sync.linkedInvoices || 0)) +
        row('Linked customers', esc(sync.linkedCustomers || 0)) +
        row('Last payment sync', sync.lastPaymentSyncAt ? esc(fmt.dateTime(sync.lastPaymentSyncAt)) : 'Never') : '');
    $('btn-qbo-connect').textContent = s.connected ? 'Reconnect' : 'Connect to QuickBooks';
    $('btn-qbo-disconnect').hidden = !s.connected;
    $('btn-qbo-sync').hidden = !s.connected && s.enabled; // enabled but not connected: nothing to sync yet
  }
  function qboResult(kind, html) {
    const el = $('qbo-result');
    el.className = 'mt-s notice ' + kind + ' small';
    el.innerHTML = html;
  }
  function qboError(ex) {
    qboResult(ex.status === 503 ? 'warn' : 'error', '<span id="qbo-message">' + esc(ui.errMsg(ex)) + '</span>');
  }
  async function qboConnect() {
    const btn = $('btn-qbo-connect'); btn.disabled = true;
    try {
      const r = await api.post('/api/quickbooks/connect', {});
      if (r && r.authUrl && /^https:\/\//.test(r.authUrl)) { qboResult('info', 'Opening QuickBooks to sign in…'); location.href = r.authUrl; return; }
      qboResult('info', '<span id="qbo-message">' + esc(r && r.demo ? 'QuickBooks sign-in is disabled in demo mode — no request was sent. In production this opens Intuit\'s sign-in page.' : 'QuickBooks did not return a sign-in address.') + '</span>');
    } catch (ex) { qboError(ex); }
    finally { btn.disabled = false; }
  }
  async function qboDisconnect() {
    if (!confirm('Disconnect QuickBooks? Invoices already pushed stay linked if you reconnect the same company.')) return;
    try { await api.post('/api/quickbooks/disconnect', {}); qboResult('ok', 'QuickBooks disconnected.'); }
    catch (ex) { qboError(ex); }
    await loadQbo();
  }
  async function qboSync() {
    const btn = $('btn-qbo-sync'); btn.disabled = true; btn.textContent = 'Syncing…';
    try {
      const r = await api.post('/api/quickbooks/sync-payments', {});
      const paid = r.markedPaid || [], part = r.partial || [];
      qboResult('ok', '<strong>Payments synced.</strong> ' + esc(r.payments || 0) + ' payment(s), ' + esc(r.invoicesChecked || 0) + ' invoice(s) checked.' +
        (paid.length ? '<div class="mt-s">Marked paid: ' + paid.map((p) => esc(p.number || '#' + p.invoiceId)).join(', ') + '</div>' : '') +
        (part.length ? '<div class="mt-s">Part-paid (not marked paid): ' + part.map((p) => esc((p.number || '#' + p.invoiceId) + ' balance ' + fmt.money(p.balance))).join(', ') + '</div>' : '') +
        (r.unmatchedPayments ? '<div class="mt-s">' + esc(r.unmatchedPayments) + ' payment(s) in QuickBooks did not match an invoice from here.</div>' : ''));
      await loadQbo();
    } catch (ex) { qboError(ex); }
    finally { btn.disabled = false; btn.textContent = 'Sync payments'; }
  }
  // OAuth comes back to /?qbo=connected | /?qbo=error&reason=… (index.html forwards here).
  const QBO_RETURN = {
    state: 'the sign-in link expired or was opened in another browser', denied: 'access was declined in QuickBooks',
    forbidden: 'only an admin can connect QuickBooks', code: 'QuickBooks sent an invalid code', realm: 'QuickBooks did not say which company',
    exchange: 'the connection could not be completed',
  };
  function qboReturn() {
    const p = new URLSearchParams(location.search);
    const v = p.get('qbo');
    if (!v) return false;
    history.replaceState({}, '', 'settings.html#quickbooks');
    if (v === 'connected') qboResult('ok', 'QuickBooks connected.');
    else qboResult('error', 'QuickBooks was not connected: ' + esc(QBO_RETURN[p.get('reason')] || 'unknown error') + '. Try again.');
    return true;
  }

  // ── Wire up ─────────────────────────────────────────────────────────────────
  MBC.page({
    active: 'settings', title: 'Settings', roles: 'admin',
    async run() {
      document.querySelectorAll('.tabs .tab').forEach((t) => t.addEventListener('click', () => { history.replaceState({}, '', '#' + t.dataset.tab); showTab(t.dataset.tab); }));
      window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
      const returned = qboReturn();
      showTab(returned ? 'quickbooks' : location.hash.slice(1));

      // Import
      api.get('/api/imports/presets').then((p) => { presets = p; sourceHelp(); }).catch(() => {});
      $('imp-source').addEventListener('change', sourceHelp);
      $('imp-file').addEventListener('change', () => { imp.decisions = {}; });
      $('import-form').addEventListener('submit', runDryRun);
      $('btn-template').addEventListener('click', () => api.download('/api/imports/templates/customers.csv', 'customers_import_template.csv').catch((e) => ui.toast(ui.errMsg(e), 'error')));
      ui.on($('dr-merge'), 'change', 'select.merge-decision', (e, sel) => { imp.decisions[sel.getAttribute('data-key')] = sel.value; });
      $('btn-apply-decisions').addEventListener('click', runDryRun);
      $('btn-report-zip').addEventListener('click', reportZip);
      $('btn-commit').addEventListener('click', openCommit);
      $('commit-form').addEventListener('submit', commitImport);
      $('btn-start-over').addEventListener('click', resetImport);
      $('btn-ir-new').addEventListener('click', resetImport);
      $('btn-ir-report').addEventListener('click', saveCommittedReport);
      ui.on($('undo-box'), 'click', '#btn-undo-last', (e, btn) => undo(lastImport(), btn));
      $('btn-undo-file').addEventListener('click', undoFromFile);
      renderUndoLast();

      // Exports
      $('btn-export-all').addEventListener('click', exportAll);
      const today = fmt.todayISO();
      $('xero-from').value = today.slice(0, 4) + '-01-01';
      $('xero-to').value = today;
      $('xero-form').addEventListener('submit', exportXero);
      ui.on($('list-exports'), 'click', 'button[data-export]', (e, btn) => listExport(btn));

      // QuickBooks
      $('btn-qbo-connect').addEventListener('click', qboConnect);
      $('btn-qbo-disconnect').addEventListener('click', qboDisconnect);
      $('btn-qbo-sync').addEventListener('click', qboSync);
    },
  });
})();
