/*
 * team.html — members (admin only): completed-job counts (technicians only), status badges (Deactivated /
 * Invited / Must change password / last sign-in), invite by email (accept-invite link,
 * copyable when not emailed), add with a temporary password, and per member:
 * change role, deactivate / reactivate, reset password (temporary password shown once,
 * or a reset link to copy).
 *
 * Role matrix (the server enforces it too): nobody manages themselves; an admin manages
 * technicians, dispatchers and office staff and can give only those roles; admins and
 * super-admins are managed — and admin / super-admin granted — only by a super-admin.
 */
(function () {
  'use strict';
  const { fmt, api, auth, ui } = window.MBC;
  const $ = ui.$;
  const GROUPS = { technicians: ['technician'], office: ['dispatcher', 'office'], admins: ['admin', 'super-admin'] };
  const PRIVILEGED = ['admin', 'super-admin'];
  let users = [];
  let completed = {};
  let tab = 'all';
  let resetting = null;

  const isSuper = () => !!auth.user && auth.user.role === 'super-admin';
  function roleName(r) { return r === 'technician' ? MBC.brand.techLabel : ({ 'super-admin': 'Super-admin', admin: 'Admin', dispatcher: 'Dispatcher', office: 'Office' })[r] || r; }
  function grantable() { return ['technician', 'dispatcher', 'office'].concat(isSuper() ? ['admin', 'super-admin'] : []); }
  function canManage(u) { return !!auth.user && u.id !== auth.user.id && (!PRIVILEGED.includes(u.role) || isSuper()); }

  function badges(u) {
    const b = ['<span class="badge">' + fmt.esc(roleName(u.role)) + '</span>'];
    if (!u.active) b.push('<span class="badge badge-inactive">Deactivated</span>');
    else if (u.invitePending) b.push('<span class="badge badge-invited">Invited</span>');
    if (u.active && u.mustChangePassword) b.push('<span class="badge badge-mustchange">Must change password</span>');
    return b.join(' ');
  }
  function actions(u) {
    if (!canManage(u)) return u.id === (auth.user && auth.user.id) ? '<div class="line">This is you — use the menu under your name to change your password.</div>' : '';
    const id = fmt.esc(u.id);
    const opts = grantable().map((r) => '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + fmt.esc(roleName(r)) + '</option>').join('');
    return '<div class="actions">' +
      '<label for="role-' + id + '" class="sr-only">Role for ' + fmt.esc(fmt.name(u)) + '</label>' +
      '<select id="role-' + id + '" data-role-for="' + id + '"' + (u.active ? '' : ' disabled') + '>' + opts + '</select>' +
      (u.active
        ? '<button class="btn btn-outline btn-sm" type="button" data-reset="' + id + '">Reset password</button>' +
          '<button class="btn btn-danger btn-sm" type="button" data-deactivate="' + id + '">Deactivate</button>'
        : '<button class="btn btn-outline btn-sm" type="button" data-reactivate="' + id + '">Reactivate</button>') +
      '</div>';
  }
  function render() {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    const list = users.filter((u) => tab === 'all' || GROUPS[tab].includes(u.role));
    const grid = $('team-grid');
    if (!list.length) { grid.innerHTML = '<div class="empty">No members in this group.</div>'; return; }
    grid.innerHTML = list.map((u) =>
      '<div class="team-card' + (u.active ? '' : ' inactive') + '" data-user="' + fmt.esc(u.id) + '"><div class="name">' + fmt.text(fmt.name(u)) + '</div>' +
      '<div>' + badges(u) + '</div>' +
      (u.email ? '<div class="line">' + fmt.esc(u.email) + '</div>' : '') +
      (u.phone ? '<div class="line">' + fmt.esc(fmt.phone(u.phone)) + '</div>' : '') +
      (u.role === 'technician' ? '<div class="line">Jobs completed: ' + fmt.esc(completed[u.id] || 0) + '</div>' : '') +
      '<div class="line">' + (u.lastLoginAt ? 'Last signed in ' + fmt.esc(fmt.dateTime(u.lastLoginAt)) : 'Never signed in') + '</div>' +
      '<div class="line">Member since ' + fmt.esc(fmt.date(u.createdAt)) + '</div>' +
      actions(u) + '</div>').join('');
  }

  async function load() {
    try {
      const [us, jobs] = await Promise.all([api.get('/api/users'), api.get('/api/jobs').catch(() => [])]);
      users = us;
      completed = {};
      jobs.filter((j) => j.status === 'completed' && j.technicianId).forEach((j) => { completed[j.technicianId] = (completed[j.technicianId] || 0) + 1; });
      render();
    } catch (e) { $('team-grid').innerHTML = '<div class="empty error-text">' + fmt.esc(e.message) + '</div>'; }
  }
  const byId = (id) => users.find((u) => String(u.id) === String(id));

  // ── Per-member actions ──────────────────────────────────────────────────────
  async function changeRole(sel) {
    const u = byId(sel.getAttribute('data-role-for')); if (!u) return;
    const role = sel.value;
    if (role === u.role) return;
    if (!confirm('Change ' + fmt.name(u) + ' from ' + roleName(u.role) + ' to ' + roleName(role) + '? They are signed out of live screens and continue with the new role.')) { sel.value = u.role; return; }
    try { await api.patch('/api/users/' + encodeURIComponent(u.id) + '/role', { role }); ui.toast(fmt.name(u) + ' is now ' + roleName(role) + '.', 'ok'); }
    catch (e) { ui.toast(e.message, 'error'); }
    await load();
  }
  async function setActive(id, active) {
    const u = byId(id); if (!u) return;
    if (!active && !confirm('Deactivate ' + fmt.name(u) + '? They are signed out everywhere at once and cannot sign in until reactivated. Their jobs and history stay.')) return;
    try {
      await api.post('/api/users/' + encodeURIComponent(u.id) + '/' + (active ? 'reactivate' : 'deactivate'), {});
      ui.toast(fmt.name(u) + (active ? ' reactivated.' : ' deactivated and signed out.'), 'ok');
    } catch (e) { ui.toast(e.message, 'error'); }
    await load();
  }
  function openReset(id) {
    resetting = byId(id); if (!resetting) return;
    $('reset-who').textContent = fmt.name(resetting) + (resetting.email ? ' (' + resetting.email + ')' : '');
    $('reset-choose').hidden = false;
    $('reset-result').hidden = true; $('reset-result').innerHTML = '';
    ui.formError('reset-error', null);
    ui.openModal('reset-modal');
  }
  function secretBlock(label, value, id) {
    return '<div class="small">' + fmt.esc(label) + '</div><div class="secret" id="' + id + '">' + fmt.esc(value) + '</div>' +
      '<button class="btn btn-outline btn-sm" type="button" id="' + id + '-copy">Copy</button>';
  }
  async function doReset(mode) {
    const u = resetting; if (!u) return;
    const btns = [$('btn-reset-temp'), $('btn-reset-link')];
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await api.post('/api/users/' + encodeURIComponent(u.id) + '/reset-password', { mode });
      const box = $('reset-result');
      if (mode === 'temporary') {
        box.innerHTML = '<div class="notice warn small"><strong>Shown only once.</strong> Give this to ' + fmt.esc(fmt.name(u)) + ' in person or by phone. They must choose their own password when they sign in.</div>' +
          secretBlock('Temporary password', r.temporaryPassword, 'reset-secret');
        ui.copyButton($('reset-secret-copy'), r.temporaryPassword);
      } else {
        const note = r.emailed
          ? (r.mailDriver === 'outbox' ? '<div class="notice warn small"><strong>Sandbox:</strong> the email went to the local outbox folder, not to a real inbox. Copy the link below if needed.</div>' : '<div class="notice ok small">Reset link emailed to ' + fmt.esc(u.email) + '.</div>')
          : '<div class="notice warn small">The email was not sent' + (r.mailError ? ' (the mail server refused it)' : ' (email is not set up)') + '. Copy the link and send it to ' + fmt.esc(u.email) + ' yourself.</div>';
        box.innerHTML = note + (r.resetLink ? secretBlock('Reset link (works once' + (r.expiresAt ? ', until ' + fmt.dateTime(r.expiresAt) : '') + ')', r.resetLink, 'reset-secret') : '');
        if (r.resetLink) ui.copyButton($('reset-secret-copy'), r.resetLink);
      }
      $('reset-choose').hidden = true;
      box.hidden = false;
      load();
    } catch (e) { ui.formError('reset-error', e); }
    finally { btns.forEach((b) => { b.disabled = false; }); }
  }

  // ── Invite / add ────────────────────────────────────────────────────────────
  async function sendInvite(e) {
    e.preventDefault();
    const email = $('f-email').value.trim();
    const first = $('f-first').value.trim(), last = $('f-last').value.trim();
    if (!first || !last) { ui.formError('modal-error', 'First name and last name are required.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { ui.formError('modal-error', 'Enter a valid email address.'); return; }
    ui.formError('modal-error', null);
    $('btn-send').disabled = true;
    try {
      const d = await api.post('/api/invites', { email, role: $('f-role').value, firstName: first, lastName: last, phone: $('f-phone').value.trim() || undefined });
      load();
      const box = $('invite-result');
      let note;
      if (d.inviteLink === null && d.passwordInvite === false) note = '<div class="notice info small">' + fmt.esc(email) + ' already has an account. They can sign in, or use “Forgot password?” on the sign-in page.</div>';
      else if (d.emailed && d.mailDriver === 'outbox') note = '<div class="notice warn small"><strong>Sandbox:</strong> no email was sent. The invite was written to the local outbox folder (backend/outbox/) instead. Copy the link below to pass it on.</div>';
      else if (d.emailed) note = '<div class="notice ok small">Invite emailed to ' + fmt.esc(email) + '.</div>';
      else note = '<div class="notice warn small">The invite email was not sent' + (d.mailError ? ' (the mail server refused it)' : ' (email is not set up)') + '. Copy the link below and send it to ' + fmt.esc(email) + ' yourself.</div>';
      box.innerHTML = note + (d.inviteLink ? '<div class="small">Invitation link — they open it to choose a password' + (d.googleSignIn ? ' or sign in with Google' : '') +
        (d.expiresAt ? ' (works once, until ' + fmt.esc(fmt.dateTime(d.expiresAt)) + ')' : '') + ':</div>' +
        '<div class="invite-link" id="invite-link">' + fmt.esc(d.inviteLink) + '</div>' +
        '<button class="btn btn-outline btn-sm" type="button" id="btn-copy-link">Copy</button>' : '');
      box.hidden = false;
      if (d.inviteLink) ui.copyButton($('btn-copy-link'), d.inviteLink);
    } catch (ex) { ui.formError('modal-error', ex); }
    finally { $('btn-send').disabled = false; }
  }

  async function addMember(e) {
    e.preventDefault();
    const v = (id) => $(id).value.trim();
    const body = { firstName: v('a-first'), lastName: v('a-last'), email: v('a-email'), role: $('a-role').value, phone: v('a-phone') || undefined, password: $('a-password').value, mustChangePassword: $('a-must-change').checked };
    if (!body.firstName || !body.lastName || !body.email) { ui.formError('add-error', 'First name, last name and email are required.'); return; }
    const bad = ui.passwordProblem(body.password);
    if (bad) { ui.formError('add-error', bad.replace('new password', 'temporary password').replace('Enter a', 'Enter a temporary')); return; }
    $('btn-create').disabled = true;
    try {
      await api.post('/api/users', body);
      ui.closeModal('add-modal'); $('add-form').reset();
      ui.toast('Account created for ' + body.firstName + (body.mustChangePassword ? '. They choose their own password at first sign-in.' : '.'), 'ok');
      await load();
    } catch (ex) { ui.formError('add-error', ex.status === 409 ? 'Someone with that email already has an account.' : ex); }
    finally { $('btn-create').disabled = false; }
  }

  MBC.page({
    active: 'team', title: 'Team', roles: 'admin',
    async run() {
      const tl = MBC.brand.techLabel;
      $('page-title').textContent = tl + 's & Team';
      $('tab-tech').textContent = tl + 's';
      $('invite-google-note').hidden = MBC.brand.current.googleAuth !== true;
      // Admin / super-admin roles can only be granted by a super-admin (server enforces this too).
      const roles = grantable().map((r) => [r, roleName(r)]);
      document.querySelectorAll('.role-select').forEach((sel) => { sel.innerHTML = roles.map((r) => '<option value="' + r[0] + '">' + fmt.esc(r[1]) + '</option>').join(''); });
      document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; render(); }));
      $('btn-invite').addEventListener('click', () => { $('invite-form').reset(); $('invite-result').hidden = true; ui.openModal('modal'); });
      $('btn-add').addEventListener('click', () => ui.openModal('add-modal'));
      $('invite-form').addEventListener('submit', sendInvite);
      $('add-form').addEventListener('submit', addMember);
      ui.on($('team-grid'), 'change', 'select[data-role-for]', (e, sel) => changeRole(sel));
      ui.on($('team-grid'), 'click', '[data-deactivate]', (e, b) => setActive(b.getAttribute('data-deactivate'), false));
      ui.on($('team-grid'), 'click', '[data-reactivate]', (e, b) => setActive(b.getAttribute('data-reactivate'), true));
      ui.on($('team-grid'), 'click', '[data-reset]', (e, b) => openReset(b.getAttribute('data-reset')));
      $('btn-reset-temp').addEventListener('click', () => doReset('temporary'));
      $('btn-reset-link').addEventListener('click', () => doReset('link'));
      await load();
    },
  });
})();
