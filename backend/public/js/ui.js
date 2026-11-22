/*
 * js/ui.js — small UI helpers shared by every page (no framework).
 *
 *   MBC.page({ active, title, roles, run(user) })  brand → auth guard → nav → run
 *   MBC.ui.toast(msg, 'ok'|'error')
 *   MBC.ui.openModal(id) / closeModal(id)          (Esc and backdrop click close)
 *   MBC.ui.formError(el, msgOrError)               show / clear a form error
 *   MBC.ui.on(root, 'click', '[data-x]', fn)       event delegation (no inline handlers)
 *   MBC.ui.$(id)                                    document.getElementById
 */
(function () {
  'use strict';
  const MBC = (window.MBC = window.MBC || {});
  const $ = (id) => document.getElementById(id);

  function toast(msg, type) {
    let host = $('toast-host');
    if (!host) { host = document.createElement('div'); host.id = 'toast-host'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 7000 : 3500);
  }

  function openModal(id) {
    const m = $(id); if (!m) return;
    m.classList.add('open');
    m.querySelectorAll('.form-error').forEach((e) => { e.hidden = true; e.textContent = ''; });
    const first = m.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeModal(id) { const m = $(id); if (m) m.classList.remove('open'); }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach((m) => m.classList.remove('open'));
  });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('modal-overlay')) t.classList.remove('open');
    const closer = t.closest && t.closest('[data-close-modal]');
    if (closer) { const m = closer.closest('.modal-overlay'); if (m) m.classList.remove('open'); }
  });

  function formError(el, err) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    if (!err) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = typeof err === 'string' ? err : (err instanceof MBC.ApiError ? err.message : 'Something went wrong. Please try again.');
    el.hidden = false;
  }
  function errMsg(err) { return err instanceof MBC.ApiError ? err.message : 'Something went wrong. Please try again.'; }

  function on(root, type, selector, fn) {
    (root || document).addEventListener(type, (e) => {
      const el = e.target.closest && e.target.closest(selector);
      if (el && (root || document).contains(el)) fn(e, el);
    });
  }

  // Rows with data-href navigate on click (links inside still work normally).
  on(document, 'click', 'tr[data-href]', (e, tr) => {
    if (e.target.closest('a, button, input, select, textarea')) return;
    location.href = tr.getAttribute('data-href');
  });

  async function page(opts) {
    opts = opts || {};
    document.body.dataset.title = opts.title || '';
    await MBC.brand.load(opts.title);
    try {
      const user = await MBC.auth.requireUser(opts.roles || 'all');
      if (!user) return;
      MBC.nav.render(opts.active, user);
      if (user.denied) return;
      await opts.run(user);
    }
    catch (e) {
      if (!(e instanceof MBC.ApiError)) console.warn(e);
      if (!(e instanceof MBC.ApiError && e.status === 401)) toast(errMsg(e), 'error');
    }
  }

  // Hide elements for roles: <button data-roles="admin">
  function applyRoleVisibility(root) {
    (root || document).querySelectorAll('[data-roles]').forEach((el) => {
      const r = el.getAttribute('data-roles');
      el.hidden = !MBC.auth.is(r);
    });
  }

  MBC.ui = { $, toast, openModal, closeModal, formError, errMsg, on, applyRoleVisibility };
  MBC.page = page;
})();
