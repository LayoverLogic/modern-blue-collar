/*
 * change-password.html — the "choose a new password" screen.
 * A user with a temporary password (mustChangePassword) is sent here after sign-in and on
 * any 403 PASSWORD_CHANGE_REQUIRED; until they change it every other API call is refused.
 * PATCH /api/users/me/password {currentPassword, newPassword} → {token, user}: the new
 * token replaces the old one (all other sessions are revoked), then on to the start page.
 */
(function () {
  'use strict';
  const { api, auth, ui } = window.MBC;
  const $ = ui.$;

  async function save(e) {
    e.preventDefault();
    const cur = $('cp-current').value, next = $('cp-new').value;
    if (!cur) { ui.formError('cp-error', 'Enter your current (temporary) password.'); return; }
    const bad = ui.passwordProblem(next, $('cp-confirm').value);
    if (bad) { ui.formError('cp-error', bad); return; }
    ui.formError('cp-error', null);
    $('btn-cp-save').disabled = true;
    try {
      const r = await api.patch('/api/users/me/password', { currentPassword: cur, newPassword: next });
      if (r && r.token) auth.setToken(r.token);
      location.replace(auth.home((r && r.user) || auth.user));
    } catch (ex) { ui.formError('cp-error', ex); }
    finally { $('btn-cp-save').disabled = false; }
  }

  async function init() {
    document.body.dataset.title = 'Choose a new password';
    await MBC.brand.load('Choose a new password');
    let u = null;
    try { u = await auth.me(); } catch (e) { u = null; }
    if (!u) { location.replace('index.html'); return; }
    if (!u.mustChangePassword) {
      $('cp-intro').textContent = 'Change the password you use to sign in. Other sessions will be signed out.';
      $('l-cp-current').textContent = 'Current password';
    }
    $('l-cp-new').textContent = 'New password (at least ' + ui.PASSWORD_MIN + ' characters)';
    $('cp-username').value = u.email || '';
    $('cp-form').hidden = false;
    $('cp-form').addEventListener('submit', save);
    $('btn-cp-signout').addEventListener('click', () => auth.logout());
    setTimeout(() => $('cp-current').focus(), 30);
  }
  init();
})();
