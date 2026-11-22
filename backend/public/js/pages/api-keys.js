/* api-keys.html — create / list / revoke integration keys (admin). */
(function () {
  'use strict';
  const { fmt, api, ui } = window.MBC;
  const $ = ui.$;
  let keys = [];

  async function load() {
    try { keys = await api.get('/api/api-keys'); }
    catch (e) { $('keys-tbody').innerHTML = '<tr><td colspan="7" class="empty error-text">' + fmt.esc(e.message) + '</td></tr>'; return; }
    $('keys-tbody').innerHTML = keys.length ? keys.map((k) =>
      '<tr><td data-label="Name"><strong>' + fmt.text(k.name) + '</strong>' + (k.createdBy ? '<div class="muted small">by ' + fmt.esc(fmt.name(k.createdBy)) + '</div>' : '') + '</td>' +
      '<td data-label="Prefix"><code>' + fmt.esc(k.prefix) + '…</code></td>' +
      '<td data-label="Scopes">' + String(k.scopes || '').split(',').filter(Boolean).map((s) => '<span class="scope-tag">' + fmt.esc(s.trim()) + '</span>').join('') + '</td>' +
      '<td data-label="Status">' + fmt.badge(k.active ? 'active' : 'revoked') + '</td>' +
      '<td data-label="Last used">' + (k.lastUsedAt ? fmt.esc(fmt.date(k.lastUsedAt)) : '<span class="muted">Never</span>') + '</td>' +
      '<td data-label="Created">' + fmt.esc(fmt.date(k.createdAt)) + '</td>' +
      '<td data-label="">' + (k.active ? '<button class="btn btn-danger btn-sm" type="button" data-revoke="' + fmt.esc(k.id) + '">Revoke</button>' : '') + '</td></tr>').join('')
      : '<tr><td colspan="7" class="empty">No API keys yet.</td></tr>';
  }

  async function create(e) {
    e.preventDefault();
    const name = $('f-name').value.trim();
    if (!name) { ui.formError('modal-error', 'Give the key a name.'); return; }
    $('btn-create').disabled = true;
    try {
      const d = await api.post('/api/api-keys', { name, scopes: $('f-scopes').value, expiresAt: $('f-expires').value || null });
      $('btn-create').hidden = true;
      $('key-result').innerHTML = '<div class="key-reveal"><strong>Your API key &mdash; copy it now, it will not be shown again.</strong>' +
        '<div class="key-value" id="key-text">' + fmt.esc(d.key) + '</div><button class="btn btn-outline btn-sm" type="button" id="btn-copy">Copy</button></div>';
      $('btn-copy').addEventListener('click', () => navigator.clipboard.writeText(d.key).then(() => { $('btn-copy').textContent = 'Copied'; }).catch(() => {}));
      await load();
    } catch (ex) { ui.formError('modal-error', ex); }
    finally { $('btn-create').disabled = false; }
  }

  MBC.page({
    active: 'api-keys', title: 'API Keys', roles: 'admin',
    async run() {
      $('btn-new').addEventListener('click', () => { $('key-form').reset(); $('key-result').innerHTML = ''; $('btn-create').hidden = false; ui.openModal('create-modal'); });
      $('key-form').addEventListener('submit', create);
      $('keys-tbody').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-revoke]'); if (!b) return;
        const k = keys.find((x) => String(x.id) === b.dataset.revoke);
        if (!confirm('Revoke "' + (k ? k.name : 'this key') + '"? Anything using it loses access immediately.')) return;
        try { await api.del('/api/api-keys/' + encodeURIComponent(b.dataset.revoke)); ui.toast('Key revoked.', 'ok'); await load(); }
        catch (ex) { ui.toast(ex.message, 'error'); }
      });
      await load();
    },
  });
})();
