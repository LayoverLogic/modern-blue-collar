/*
 * js/nav.js — the single navigation bar, rendered per role into <nav id="topnav">.
 *
 *   Technician:            Today, Schedule
 *   Dispatcher / office:   Today, Dashboard, Customers, Dispatch, Schedule, Communications, Pricebook
 *   Admin / super-admin:   everything, incl. Team, Quotes & Invoices, API Keys
 *
 * Under 900px the links collapse behind a menu button (hamburger).
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
          '<span class="nav-user" id="nav-user-name" title="' + esc(user ? user.role : '') + '">' + esc(MBC.fmt.name(user)) + '</span>' +
          '<button class="btn-logout" type="button">Sign Out</button>' +
        '</div>' +
      '</div>';
    const toggle = nav.querySelector('.nav-toggle');
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.querySelector('.btn-logout').addEventListener('click', () => MBC.auth.logout());
  }

  MBC.nav = { ITEMS, render, allowed };
})();
