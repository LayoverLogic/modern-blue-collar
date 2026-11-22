/*
 * js/nav.js — the single navigation bar, rendered per role into <nav id="topnav">.
 *
 *   Technician:            Today, Schedule
 *   Dispatcher / office:   Today, Dashboard, Customers, Dispatch, Schedule, Communications, Pricebook
 *   Admin / super-admin:   everything, incl. Team, Quotes & Invoices, API Keys, Settings (data import / export, QuickBooks)
 *
 * Under 900px the links collapse behind a menu button (hamburger).
 * The person's name opens a profile menu: Change password (modal, PATCH
 * /api/users/me/password → new token stored) and Sign out.
 */
(function () {
  'use strict';
  const MBC = (window.MBC = window.MBC || {});
  const esc = (v) => MBC.fmt.esc(v);

  const ITEMS = [
    { key: 'today', href: 'today.html', label: 'Today', roles: 'all' },
    { key: 'dashboard', href: 'index.html', label: 'Dashboard', roles: 'staff' },
    { key: 'customers', href: 'customers.html', label: 'Customers', roles: 'staff' },
    { key: 'dispatch', href: 'dispatch.html', label: 'Dispatch', roles: 'staff' },
    { key: 'schedule', href: 'schedule.html', label: 'Schedule', roles: 'all' },
    { key: 'communications', href: 'communications.html', label: 'Communications', roles: 'staff' },
    { key: 'team', href: 'team.html', label: 'Team', roles: 'admin' },
    { key: 'pricebook', href: 'pricebook.html', label: 'Pricebook', roles: 'staff' },
    { key: 'billing', href: 'quote-invoice.html', label: 'Quotes & Invoices', roles: 'admin' },
    { key: 'api-keys', href: 'api-keys.html', label: 'API Keys', roles: 'admin' },
    { key: 'settings', href: 'settings.html', label: 'Settings', roles: 'admin' },
  ];

  function allowed(item, user) {
    return !!user && MBC.auth.ROLES[item.roles].includes(user.role);
  }

  function render(active, user) {
    let nav = document.getElementById('topnav');
    if (!nav) { nav = document.createElement('nav'); nav.id = 'topnav'; document.body.prepend(nav); }
    const b = MBC.brand.current || {};
    const home = user && user.role === 'technician' ? 'today.html' : 'index.html';
    const links = ITEMS.filter((i) => allowed(i, user)).map((i) =>
      '<a href="' + i.href + '"' + (i.key === active ? ' class="active" aria-current="page"' : '') + ' data-nav="' + i.key + '">' + esc(i.label) + '</a>').join('');
    const badge = b.industryLabel ? '<span class="trade-badge" id="nav-trade">' + esc(b.industryLabel) + '</span>' : '';
    const logo = b.logoUrl ? '<img class="brand-logo" src="' + esc(b.logoUrl) + '" alt="">' : '';
    nav.innerHTML =
      '<div class="nav-inner">' +
        '<a class="nav-brand" href="' + home + '">' + logo + '<span class="brand-name" id="nav-company">' + esc(b.companyName || '') + '</span>' + badge + '</a>' +
        '<button class="nav-toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="nav-links">&#9776;</button>' +
        '<div class="nav-links" id="nav-links">' + links + '</div>' +
        '<div class="nav-right">' +
          '<div class="profile">' +
            '<button class="nav-profile" type="button" id="nav-profile" aria-haspopup="true" aria-expanded="false" aria-controls="nav-menu">' +
              '<span class="nav-user" id="nav-user-name">' + esc(MBC.fmt.name(user)) + '</span> <span aria-hidden="true">&#9662;</span></button>' +
            '<div class="profile-menu" id="nav-menu" role="menu" hidden>' +
              '<div class="profile-who small">' + esc(user && user.email || '') + '<br><span class="nav-role">' + esc(roleLabel(user)) + '</span></div>' +
              '<button type="button" role="menuitem" id="nav-change-password">Change password</button>' +
              '<button type="button" role="menuitem" class="btn-logout">Sign out</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    const toggle = nav.querySelector('.nav-toggle');
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.querySelector('.btn-logout').addEventListener('click', () => MBC.auth.logout());
    const prof = nav.querySelector('#nav-profile');
    const menu = nav.querySelector('#nav-menu');
    const setMenu = (open) => { menu.hidden = !open; prof.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    prof.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
    document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { setMenu(false); prof.focus(); } });
    nav.querySelector('#nav-change-password').addEventListener('click', () => { setMenu(false); openPasswordModal(); });
  }

  function roleLabel(user) {
    if (!user) return '';
    if (user.role === 'technician') return (MBC.brand && MBC.brand.techLabel) || 'Technician';
    return ({ 'super-admin': 'Super-admin', admin: 'Admin', dispatcher: 'Dispatcher', office: 'Office' })[user.role] || user.role;
  }

  // ── Change password (profile menu) — PATCH /api/users/me/password ───────────
  // The answer carries a NEW token (every other session is signed out): store it.
  function passwordModal() {
    let m = document.getElementById('pw-modal');
    if (m) return m;
    m = document.createElement('div');
    m.className = 'modal-overlay'; m.id = 'pw-modal';
    m.innerHTML =
      '<form class="modal" id="pw-form" novalidate>' +
        '<h3>Change password</h3>' +
        '<input type="text" class="sr-only" autocomplete="username" tabindex="-1" aria-hidden="true" id="pw-username" />' +
        '<div class="form-group"><label for="pw-current">Current password</label><input type="password" id="pw-current" autocomplete="current-password" required /></div>' +
        '<div class="form-group"><label for="pw-new">New password (at least ' + MBC.ui.PASSWORD_MIN + ' characters)</label><input type="password" id="pw-new" autocomplete="new-password" required /></div>' +
        '<div class="form-group"><label for="pw-confirm">New password again</label><input type="password" id="pw-confirm" autocomplete="new-password" required /></div>' +
        '<p class="muted small">Changing it signs you out everywhere else (other browsers and phones).</p>' +
        '<div id="pw-error" class="form-error" hidden></div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-outline" type="button" data-close-modal>Cancel</button>' +
          '<button class="btn btn-primary" type="submit" id="pw-save">Change password</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(m);
    m.querySelector('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const $ = (id) => document.getElementById(id);
      const cur = $('pw-current').value, next = $('pw-new').value;
      if (!cur) { MBC.ui.formError('pw-error', 'Enter your current password.'); return; }
      const bad = MBC.ui.passwordProblem(next, $('pw-confirm').value);
      if (bad) { MBC.ui.formError('pw-error', bad); return; }
      MBC.ui.formError('pw-error', null);
      $('pw-save').disabled = true;
      try {
        const r = await MBC.api.patch('/api/users/me/password', { currentPassword: cur, newPassword: next });
        if (r && r.token) MBC.auth.setToken(r.token);
        MBC.ui.closeModal('pw-modal');
        m.querySelector('form').reset();
        MBC.ui.toast('Password changed. Any other sessions have been signed out.', 'ok');
      } catch (ex) { MBC.ui.formError('pw-error', ex); }
      finally { $('pw-save').disabled = false; }
    });
    return m;
  }
  function openPasswordModal() {
    const m = passwordModal();
    m.querySelector('form').reset();
    const u = document.getElementById('pw-username'); if (u && MBC.auth.user) u.value = MBC.auth.user.email || '';
    MBC.ui.openModal('pw-modal');
  }

  MBC.nav = { ITEMS, render, allowed, openPasswordModal };
})();
