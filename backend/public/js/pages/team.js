/* team.html — members (admin only), completed-job counts, invite via Google link, add with password. */
(function () {
  'use strict';
  const { fmt, api, ui } = window.MBC;
  const $ = ui.$;
  const GROUPS = { technicians: ['technician'], office: ['dispatcher', 'office'], admins: ['admin', 'super-admin'] };
  let users = [];
  let completed = {};
  let tab = 'all';

  function render() {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    const list = users.filter((u) => tab === 'all' || GROUPS[tab].includes(u.role));
    const grid = $('team-grid');
    if (!list.length) { grid.innerHTML = '<div class="empty">No members in this group.</div>'; return; }
    const tl = MBC.brand.techLabel;
    grid.innerHTML = list.map((u) =>
      '<div class="team-card"><div class="name">' + fmt.text(fmt.name(u)) + '</div>' +
      '<div><span class="badge">' + fmt.esc(u.role === 'technician' ? tl : fmt.statusLabel(u.role)) + '</span> ' + fmt.badge(u.active ? 'active' : 'inactive') + '</div>' +
      (u.email ? '<div class="line">' + fmt.esc(u.email) + '</div>' : '') +
      (u.phone ? '<div class="line">' + fmt.esc(u.phone) + '</div>' : '') +
      '<div class="line">Jobs completed: ' + fmt.esc(completed[u.id] || 0) + '</div>' +
      '<div class="line">Member since ' + fmt.esc(fmt.date(u.createdAt)) + '</div></div>').join('');
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

  async function sendInvite(e) {
    e.preventDefault();
    const email = $('f-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { ui.formError('modal-error', 'Enter a valid email address.'); return; }
    ui.formError('modal-error', null);
    $('btn-send').disabled = true;
    try {
      const d = await api.post('/api/invites', {
        email, role: $('f-role').value, firstName: $('f-first').value.trim() || undefined,
        lastName: $('f-last').value.trim() || undefined, phone: $('f-phone').value.trim() || undefined,
      });
      if (d.created) load();
      const box = $('invite-result');
      let note;
      if (d.emailed && d.mailDriver === 'outbox') note = '<div class="notice warn small"><strong>Sandbox:</strong> no email was sent. The invite was written to the local outbox folder (backend/outbox/) instead.</div>';
      else if (d.emailed) note = '<div class="notice ok small">Invite emailed to ' + fmt.esc(email) + '.</div>';
      else note = '<div class="notice warn small">Email is not set up on this system, so nothing was sent. Copy the link below and send it to ' + fmt.esc(email) + ' yourself.</div>';
      box.innerHTML = note + (d.inviteLink ? '<div class="small">Invite link (starts Sign in with Google):</div><div class="invite-link" id="invite-link">' + fmt.esc(d.inviteLink) + '</div>' +
        '<button class="btn btn-outline btn-sm" type="button" id="btn-copy-link">Copy link</button>' : '');
      box.hidden = false;
      const copy = $('btn-copy-link');
      if (copy) copy.addEventListener('click', () => navigator.clipboard.writeText(d.inviteLink).then(() => { copy.textContent = 'Copied'; }).catch(() => {}));
    } catch (ex) { ui.formError('modal-error', ex); }
    finally { $('btn-send').disabled = false; }
  }

  async function addMember(e) {
    e.preventDefault();
    const v = (id) => $(id).value.trim();
    const body = { firstName: v('a-first'), lastName: v('a-last'), email: v('a-email'), role: $('a-role').value, phone: v('a-phone') || undefined, password: $('a-password').value };
    if (!body.firstName || !body.lastName || !body.email) { ui.formError('add-error', 'First name, last name and email are required.'); return; }
    if (body.password.length < 10) { ui.formError('add-error', 'The temporary password must be at least 10 characters.'); return; }
    $('btn-create').disabled = true;
    try {
      await api.post('/api/users', body);
      ui.closeModal('add-modal'); $('add-form').reset();
      ui.toast('Account created for ' + body.firstName + '.', 'ok');
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
      $('google-off').hidden = MBC.brand.current.googleAuth !== false;
      // Admin / super-admin roles can only be granted by a super-admin (server enforces this too).
      const roles = [['technician', tl], ['dispatcher', 'Dispatcher'], ['office', 'Office']].concat(MBC.auth.user.role === 'super-admin' ? [['admin', 'Admin']] : []);
      document.querySelectorAll('.role-select').forEach((sel) => { sel.innerHTML = roles.map((r) => '<option value="' + r[0] + '">' + fmt.esc(r[1]) + '</option>').join(''); });
      document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; render(); }));
      $('btn-invite').addEventListener('click', () => { $('invite-form').reset(); $('invite-result').hidden = true; ui.openModal('modal'); });
      $('btn-add').addEventListener('click', () => ui.openModal('add-modal'));
      $('invite-form').addEventListener('submit', sendInvite);
      $('add-form').addEventListener('submit', addMember);
      await load();
    },
  });
})();
