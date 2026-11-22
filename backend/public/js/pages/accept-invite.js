/*
 * accept-invite.html#token=… — a new team member sets their password.
 * The token comes from the URL FRAGMENT and is stripped from the address bar at once.
 *   GET  /api/invites/:token → {valid, email, firstName, lastName, role, companyName, expiresAt, googleSignIn}
 *                              | 404 INVALID_INVITE (unknown, used, replaced, expired, deactivated)
 *   POST /api/invites/:token/accept {password, firstName?, lastName?} → {token, user}: signed in.
 * "Continue with Google" shows only when the invite says googleSignIn AND /api/brand googleAuth.
 */
(function () {
  'use strict';
  const { fmt, api, auth, ui } = window.MBC;
  const $ = ui.$;
  let token = null;
  const ROLE = { 'super-admin': 'Super-admin', admin: 'Admin', dispatcher: 'Dispatcher', office: 'Office' };

  function takeToken() {
    const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const t = h.get('token');
    if (location.hash || location.search) history.replaceState(null, '', location.pathname);
    return t && /^[A-Za-z0-9_-]{16,200}$/.test(t) ? t : null;
  }
  function bad(msg) {
    $('ai-form').hidden = true; $('ai-status').hidden = true;
    $('ai-bad').textContent = msg; $('ai-bad').hidden = false;
    $('ai-links').hidden = false;
  }

  async function accept(e) {
    e.preventDefault();
    const pw = $('ai-password').value;
    const problem = ui.passwordProblem(pw, $('ai-confirm').value);
    if (problem) { ui.formError('ai-error', problem); return; }
    ui.formError('ai-error', null);
    $('btn-ai-accept').disabled = true;
    try {
      const r = await api.post('/api/invites/' + encodeURIComponent(token) + '/accept',
        { password: pw, firstName: $('ai-first').value.trim() || undefined, lastName: $('ai-last').value.trim() || undefined }, { noAuth: true });
      token = null;
      auth.setToken(r.token);
      location.replace(auth.home(r.user));
    } catch (ex) {
      if (ex.code === 'INVALID_INVITE') bad(ex.message);
      else ui.formError('ai-error', ex);
    } finally { $('btn-ai-accept').disabled = false; }
  }

  async function init() {
    document.body.dataset.title = 'Accept invitation';
    token = takeToken();
    const b = await MBC.brand.load('Accept invitation');
    if (!token) { bad('This page needs the link from your invitation email. Open it again, or ask your administrator for a new invite.'); return; }
    let inv;
    try { inv = await api.get('/api/invites/' + encodeURIComponent(token), { noAuth: true }); }
    catch (ex) { bad(ex.code === 'INVALID_INVITE' || ex.status === 404 ? MBC.api.friendly(404, '', 'INVALID_INVITE') : ui.errMsg(ex)); return; }
    $('ai-title').textContent = 'Join ' + (inv.companyName || b.companyName || 'the team');
    $('ai-status').textContent = 'Set a password to finish setting up your account.' + (inv.expiresAt ? ' This invitation works until ' + fmt.dateTime(inv.expiresAt) + '.' : '');
    $('ai-email').textContent = inv.email || '';
    $('ai-username').value = inv.email || '';
    $('ai-role').textContent = inv.role === 'technician' ? MBC.brand.techLabel : (ROLE[inv.role] || inv.role || '');
    $('ai-first').value = inv.firstName || '';
    $('ai-last').value = inv.lastName || '';
    $('l-ai-password').textContent = 'Choose a password (at least ' + ui.PASSWORD_MIN + ' characters)';
    $('ai-google').hidden = !(inv.googleSignIn && b.googleAuth === true);
    $('ai-form').hidden = false;
    $('ai-form').addEventListener('submit', accept);
    setTimeout(() => $('ai-password').focus(), 30);
  }
  init();
})();
