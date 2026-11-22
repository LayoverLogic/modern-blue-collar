/* index.html — sign-in and the office dashboard (technicians go to today.html). */
(function () {
  'use strict';
  const { fmt, api, auth, ui } = window.MBC;
  const $ = ui.$;
  const OPEN = ['pending', 'scheduled', 'in-progress'];

  function showLogin(message) {
    $('app').hidden = true;
    $('login-screen').hidden = false;
    const b = MBC.brand.current || {};
    const hint = b.demoLogin && b.demoLogin.email
      ? 'Demo mode. Sign in with ' + b.demoLogin.email + (b.demoLogin.password ? ' / ' + b.demoLogin.password : '')
      : (typeof b.demoHint === 'string' ? b.demoHint : '');
    if (hint) { $('demo-hint').textContent = hint; $('demo-hint').hidden = false; }
    // Only when the server says Google sign-in is configured (absent → hidden).
    const google = b.googleAuth === true;
    $('google-block').hidden = !google;
    if (message) { $('error-msg').textContent = message; $('error-msg').hidden = false; }
    setTimeout(() => $('email-input').focus(), 30);
  }

  async function showApp(user) {
    if (user.mustChangePassword) { location.replace('change-password.html'); return; }
    if (user.role === 'technician') { location.replace('today.html'); return; }
    $('login-screen').hidden = true;
    $('app').hidden = false;
    MBC.nav.render('dashboard', user);
    MBC.brand.apply(MBC.brand.current, 'Dashboard');
    await loadDashboard(user);
  }

  async function loadDashboard(user) {
    let jobs = [];
    try { jobs = await api.get('/api/jobs'); }
    catch (e) {
      $('jobs-tbody').innerHTML = '<tr><td colspan="6" class="empty error-text">' + fmt.esc(e.message) + '</td></tr>';
      return;
    }
    // "Today" and "this month" in the brand time zone, not the browser's.
    const today = fmt.todayISO();
    const month = today.slice(0, 7);
    $('stat-open').textContent = jobs.filter((j) => OPEN.includes(j.status)).length;
    $('stat-today').textContent = jobs.filter((j) => j.scheduledDate === today && j.status !== 'cancelled').length;
    $('stat-completed').textContent = jobs.filter((j) => {
      return j.status === 'completed' && j.completedAt && fmt.zonedISO(j.completedAt).slice(0, 7) === month;
    }).length;

    if (auth.isAdmin()) {
      try {
        const invs = await api.get('/api/invoices');
        const unpaid = invs.filter((i) => i.status === 'unpaid' || i.status === 'overdue');
        $('stat-unpaid').textContent = unpaid.length;
        $('stat-4-label').textContent = 'Unpaid Invoices (' + fmt.money(unpaid.reduce((s, i) => s + (fmt.num(i.amount) || 0), 0)) + ')';
      } catch (e) { $('stat-unpaid').textContent = fmt.DASH; }
    } else {
      $('stat-4-label').textContent = 'Unassigned Jobs';
      $('stat-unpaid').textContent = jobs.filter((j) => !j.technicianId && OPEN.includes(j.status)).length;
    }

    // Newest created first, from the server (GET /api/jobs?sort=recent); older servers: sort here.
    let recent = await api.get('/api/jobs?sort=recent&limit=10').catch(() => null);
    if (!Array.isArray(recent)) recent = jobs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10);
    const tb = $('jobs-tbody');
    if (!recent.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">No jobs yet.</td></tr>'; return; }
    tb.innerHTML = recent.map((j) =>
      '<tr class="clickable" data-href="job.html?id=' + encodeURIComponent(j.id) + '">' +
        '<td data-label="#"><a class="row-link" href="job.html?id=' + encodeURIComponent(j.id) + '">#' + fmt.esc(j.id) + '</a></td>' +
        '<td data-label="Customer">' + fmt.text(fmt.name(j.customer)) + '</td>' +
        '<td data-label="Job">' + fmt.text(j.title) + '<div class="muted small">' + fmt.esc(j.type || '') + '</div></td>' +
        '<td data-label="' + fmt.esc(MBC.brand.techLabel) + '">' + fmt.text(fmt.name(j.technician)) + '</td>' +
        '<td data-label="Status">' + fmt.badge(j.status) + '</td>' +
        '<td data-label="Scheduled">' + fmt.esc(fmt.schedule(j)) + '</td>' +
      '</tr>').join('');
  }

  async function doLogin(e) {
    e.preventDefault();
    const email = $('email-input').value.trim();
    const password = $('password-input').value;
    const err = $('error-msg');
    err.hidden = true;
    if (!email || !password) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
    $('btn-login').disabled = true;
    try {
      const d = await api.post('/api/auth/login', { email, password }, { noAuth: true });
      auth.setToken(d.token);
      const user = await auth.me();
      if (!user) throw new MBC.ApiError(401, 'Sign-in failed. Please try again.');
      await showApp(user);
    } catch (ex) {
      err.textContent = ex.status === 401 ? 'Email or password is incorrect.' : ui.errMsg(ex);
      err.hidden = false;
    } finally { $('btn-login').disabled = false; }
  }

  // Forgot password: POST /api/auth/forgot always answers the same (no account probing).
  function showForgot(on) {
    $('login-form').hidden = on;
    $('forgot-form').hidden = !on;
    if (on) {
      $('forgot-email').value = $('email-input').value.trim();
      $('forgot-done').hidden = true; ui.formError('forgot-error', null);
      setTimeout(() => $('forgot-email').focus(), 30);
    } else setTimeout(() => $('email-input').focus(), 30);
  }
  async function sendForgot(e) {
    e.preventDefault();
    const email = $('forgot-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { ui.formError('forgot-error', 'Enter a valid email address.'); return; }
    ui.formError('forgot-error', null);
    $('btn-forgot-send').disabled = true;
    try {
      const r = await api.post('/api/auth/forgot', { email }, { noAuth: true });
      $('forgot-done').textContent = (r && r.message) || 'If an account exists for that email address, a reset link has been sent to it.';
      $('forgot-done').hidden = false;
    } catch (ex) { ui.formError('forgot-error', ex); }
    finally { $('btn-forgot-send').disabled = false; }
  }

  async function init() {
    document.body.dataset.title = 'Dashboard';
    // Google sign-in returns a one-time ?auth_code= (60 s, single use) that is
    // exchanged for a session token; the code is stripped from the URL first.
    const params = new URLSearchParams(location.search);
    // QuickBooks OAuth returns to /?qbo=connected | /?qbo=error&reason=… → show it on Settings.
    if (params.get('qbo')) {
      const q = new URLSearchParams();
      q.set('qbo', params.get('qbo'));
      if (params.get('reason')) q.set('reason', params.get('reason'));
      location.replace('settings.html?' + q.toString() + '#quickbooks');
      return;
    }
    const authCode = params.get('auth_code');
    let authError = params.get('auth_error');
    if (authCode || authError) history.replaceState({}, '', 'index.html');
    await MBC.brand.load('Dashboard');
    if (authCode) {
      try { const d = await api.post('/api/auth/google/exchange', { code: authCode }, { noAuth: true }); auth.setToken(d.token); }
      catch (e) { authError = e.message; }
    }
    $('login-form').addEventListener('submit', doLogin);
    $('btn-forgot').addEventListener('click', () => showForgot(true));
    $('btn-forgot-back').addEventListener('click', () => showForgot(false));
    $('forgot-form').addEventListener('submit', sendForgot);
    let user = null;
    try { user = await auth.me(); } catch (e) { /* show login */ }
    if (user) await showApp(user);
    else showLogin(authError ? 'Sign-in with Google did not complete: ' + authError : '');
    if (!user && location.hash === '#forgot') { history.replaceState({}, '', 'index.html'); showForgot(true); }
  }
  init();
})();
