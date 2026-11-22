/*
 * js/ui.js — small UI helpers shared by every page (no framework).
 *
 *   MBC.page({ active, title, roles, run(user) })  brand → auth guard → nav → run
 *   MBC.ui.toast(msg, 'ok'|'error')
 *   MBC.ui.openModal(id) / closeModal(id)          (Esc and backdrop click close)
 *   MBC.ui.formError(el, msgOrError)               show / clear a form error
 *   MBC.ui.on(root, 'click', '[data-x]', fn)       event delegation (no inline handlers)
 *   MBC.ui.$(id)                                    document.getElementById
 *   MBC.ui.addressForm(prefix)                      locale labels / required marks on an address form;
 *                                                   returns { read(), check(body) → error text | null }
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

  // Address fields <prefix>-address, -address2, -city, -state, -zip with labels
  // l-address, l-address2, l-city, l-state, l-zip. Labels, required fields and the
  // postcode pattern come from GET /api/brand → locale (MBC.fmt.addressLabels()).
  function addressForm(prefix) {
    const L = MBC.fmt.addressLabels();
    // Older servers do not send requiredAddressFields: keep the historic form rules.
    const required = L.required || ['address', 'city', 'zip'];
    const names = { address: L.address, address2: L.addressLine2, city: L.city, state: L.region, zip: L.postal };
    for (const k of Object.keys(names)) {
      const lab = $('l-' + k); if (!lab) continue;
      const req = required.includes(k === 'address2' ? 'addressLine2' : k);
      lab.textContent = names[k] + (req ? ' *' : '');
      const inp = $(prefix + '-' + k); if (inp) inp.required = req;
    }
    const zip = $(prefix + '-zip'); if (zip && L.postcodeExample) zip.placeholder = 'e.g. ' + L.postcodeExample;
    const st = $(prefix + '-state'); if (st && L.defaultState && !st.placeholder) st.placeholder = L.defaultState;
    const val = (k) => { const e = $(prefix + '-' + k); return e ? e.value.trim() : ''; };
    return {
      labels: L, required,
      read() { return { address: val('address'), addressLine2: val('address2'), city: val('city'), state: val('state'), zip: val('zip') }; },
      // Returns the missing / invalid field names as a sentence, or null.
      check(body) {
        const miss = required.filter((k) => !body[k]).map((k) => names[k === 'addressLine2' ? 'address2' : k] || k);
        if (miss.length) return miss;
        if (body.zip && L.postcodePattern) {
          let re = null; try { re = new RegExp(L.postcodePattern, 'i'); } catch (e) { re = null; }
          if (re && !re.test(body.zip)) return 'BAD_POSTCODE';
        }
        return null;
      },
      postcodeMessage() { return L.postal + ' does not look right' + (L.postcodeExample ? ' (for example ' + L.postcodeExample + ')' : '') + '.'; },
    };
  }

  MBC.ui = { $, toast, addressForm, openModal, closeModal, formError, errMsg, on, applyRoleVisibility };
  MBC.page = page;
})();
