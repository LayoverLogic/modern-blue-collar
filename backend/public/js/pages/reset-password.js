/*
 * reset-password.html#token=… — choose a new password from an emailed (or admin-made) link.
 * The token is read from the URL FRAGMENT (never sent to the server in a URL, never logged)
 * and stripped from the address bar at once, then kept only in memory.
 *   POST /api/auth/reset/validate {token} → {valid, email, expiresAt} | 400 INVALID_RESET_TOKEN
 *   POST /api/auth/reset {token, newPassword} → {success, message, email} (no session: sign in)
 * Every session of that user is revoked by the reset.
 */
(function () {
  'use strict';
  const { fmt, api, ui } = window.MBC;
  const $ = ui.$;
  let token = null;

  function takeToken() {
    const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const t = h.get('token');
    if (location.hash || location.search) history.replaceState(null, '', location.pathname);
    return t && /^[A-Za-z0-9_-]{16,200}$/.test(t) ? t : null;
  }
  function bad(msg) {
    $('rp-form').hidden = true;
    $('rp-status').hidden = true;
    $('rp-bad').textContent = msg;
    $('rp-bad').hidden = false;
    $('rp-again').hidden = false;
  }

  async function save(e) {
    e.preventDefault();
    const pw = $('rp-new').value;
    const problem = ui.passwordProblem(pw, $('rp-confirm').value);
    if (problem) { ui.formError('rp-error', problem); return; }
    ui.formError('rp-error', null);
    $('btn-rp-save').disabled = true;
    try {
      const r = await api.post('/api/auth/reset', { token, newPassword: pw }, { noAuth: true });
      token = null;
      $('rp-form').hidden = true;
      $('rp-status').hidden = true;
      $('rp-done').textContent = 'Your password has been changed' + (r && r.email ? ' for ' + r.email : '') + '. Sign in with the new password. Any other sessions were signed out.';
      $('rp-done').hidden = false;
      $('rp-signin').textContent = 'Sign in';
      $('rp-signin').classList.remove('btn-outline'); $('rp-signin').classList.add('btn-primary');
    } catch (ex) {
      if (ex.code === 'INVALID_RESET_TOKEN') bad(ex.message);
      else ui.formError('rp-error', ex);
    } finally { $('btn-rp-save').disabled = false; }
  }

  async function init() {
    document.body.dataset.title = 'Reset password';
    token = takeToken();
    await MBC.brand.load('Reset password');
    if (!token) { bad('This page needs the link from your password-reset email. Open the link again, or ask for a new one.'); return; }
    try {
      const v = await api.post('/api/auth/reset/validate', { token }, { noAuth: true });
      $('rp-status').textContent = 'Choose a new password for ' + (v.email || 'your account') + '.' + (v.expiresAt ? ' This link works until ' + fmt.dateTime(v.expiresAt) + '.' : '');
      $('rp-username').value = v.email || '';
      $('l-rp-new').textContent = 'New password (at least ' + ui.PASSWORD_MIN + ' characters)';
      $('rp-form').hidden = false;
      $('rp-form').addEventListener('submit', save);
      setTimeout(() => $('rp-new').focus(), 30);
    } catch (ex) {
      bad(ex.code === 'INVALID_RESET_TOKEN' ? 'This link has expired or was already used. Ask for a new one below.' : ui.errMsg(ex));
    }
  }
  init();
})();
