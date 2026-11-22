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
 *   MBC.ui.dateFields(root)                         date inputs in the brand date order when the browser's
 *                                                   order differs (run by MBC.page; later inputs via a MutationObserver)
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

  // ── Date fields in the BRAND date order ────────────────────────────────────
  // A native <input type="date"> shows the BROWSER's order (an Irish office on a US laptop
  // sees 11/25/2026). When the browser's order differs from the brand's, every date input is
  // given a text box in the brand format (DD/MM/YYYY or MM/DD/YYYY, typed and parsed by
  // MBC.fmt.parseDateInput) and a calendar button that opens the native picker. The original
  // input stays in the DOM with its id, value ('YYYY-MM-DD') and change / input events, so page
  // code and tests keep using it unchanged; setting its .value updates the text box.
  // localStorage 'mbc.dateFields' = 'text' | 'native' forces either behaviour.
  const NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const CAL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
  function dateFieldsWanted() {
    let force = null;
    try { force = localStorage.getItem('mbc.dateFields'); } catch (e) { /* storage blocked */ }
    if (force === 'text') return true;
    if (force === 'native') return false;
    const browser = MBC.fmt.dateOrder((navigator.languages && navigator.languages[0]) || navigator.language || 'en-US');
    const brandOrder = MBC.fmt.datePattern().replace(/[^DMY]/g, '').replace('DD', 'd').replace('MM', 'm').replace('YYYY', 'y');
    return browser !== brandOrder;
  }
  let dateSeq = 0;
  function enhanceDate(input) {
    if (input.dataset.dateField || input.type !== 'date') return;
    input.dataset.dateField = '1';
    const pattern = MBC.fmt.datePattern();
    const wrap = document.createElement('span');
    wrap.className = 'date-field';
    const text = document.createElement('input');
    text.type = 'text';
    text.id = (input.id || 'date-' + (++dateSeq)) + '-text';
    text.className = 'date-text';
    text.inputMode = 'numeric';
    text.autocomplete = 'off';
    text.placeholder = pattern;
    text.title = 'Date as ' + pattern;
    text.required = input.required;
    const lab = input.id ? document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(input.id) : input.id) + '"]') : null;
    const name = (lab && lab.textContent.trim()) || input.getAttribute('aria-label') || 'Date';
    if (lab) lab.htmlFor = text.id; else text.setAttribute('aria-label', name);
    const hint = document.createElement('span');
    hint.className = 'sr-only'; hint.id = text.id + '-hint'; hint.textContent = 'Format ' + pattern;
    text.setAttribute('aria-describedby', hint.id);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'date-pick';
    btn.setAttribute('aria-label', 'Choose ' + name.replace(/\s*\*$/, '').toLowerCase() + ' from a calendar');
    btn.innerHTML = CAL_SVG;
    input.parentNode.insertBefore(wrap, input);
    wrap.append(text, btn, input, hint);
    input.classList.add('date-native');
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');

    const get = () => NATIVE_VALUE.get.call(input);
    const sync = () => { text.value = MBC.fmt.formatDateInput(get()); text.removeAttribute('aria-invalid'); };
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return get(); },
      set(v) { NATIVE_VALUE.set.call(input, v); sync(); },
    });
    function commit() {
      const raw = text.value.trim();
      const iso = raw ? MBC.fmt.parseDateInput(raw) : '';
      if (iso === null) {
        text.setAttribute('aria-invalid', 'true');
        toast('Type the date as ' + pattern + '.', 'error');
        sync(); // back to the last good date
        return;
      }
      if (iso === get()) { sync(); return; }
      NATIVE_VALUE.set.call(input, iso);
      sync();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    text.addEventListener('change', commit);
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    input.focus = () => text.focus(); // page code focusing the date (e.g. after an error) lands on the text box
    const pick = () => {
      try { if (input.showPicker) { input.showPicker(); return; } } catch (e) { /* not allowed here */ }
      text.focus();
    };
    btn.addEventListener('click', pick);
    // The invisible native input lies over the button for pointer / touch, so a tap opens the
    // platform picker even where showPicker() is missing.
    input.addEventListener('click', (e) => { if (input.showPicker) { e.preventDefault(); pick(); } });
    if (input.form) input.form.addEventListener('reset', () => setTimeout(sync, 0));
    sync();
  }
  let dateObserver = null;
  function dateFields(root) {
    if (!MBC.fmt || !dateFieldsWanted()) return;
    (root || document).querySelectorAll('input[type="date"]').forEach(enhanceDate);
    if (!dateObserver && window.MutationObserver && document.body) {
      dateObserver = new MutationObserver((muts) => {
        for (const m of muts) m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches('input[type="date"]')) enhanceDate(n);
          else if (n.querySelectorAll) n.querySelectorAll('input[type="date"]').forEach(enhanceDate);
        });
      });
      dateObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function page(opts) {
    opts = opts || {};
    document.body.dataset.title = opts.title || '';
    await MBC.brand.load(opts.title);
    try { dateFields(document); } catch (e) { console.warn(e); }
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

  // Client-side check of a new password (the server has the final say: ≥ 10 chars, ≤ 72 bytes).
  const PASSWORD_MIN = 10;
  function passwordProblem(pw, confirm) {
    if (!pw) return 'Enter a new password.';
    if (pw.length < PASSWORD_MIN) return 'The new password must be at least ' + PASSWORD_MIN + ' characters.';
    if (new TextEncoder().encode(pw).length > 72) return 'The new password is too long (at most 72 bytes).';
    if (confirm !== undefined && pw !== confirm) return 'The two new passwords do not match.';
    return null;
  }
  // Copy text with a button that confirms ("Copied").
  function copyButton(btn, text) {
    btn.addEventListener('click', () => {
      const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      else fallbackCopy(text, done);
    });
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr-only';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* select it by hand */ }
    ta.remove();
  }

  MBC.ui = { $, toast, addressForm, openModal, closeModal, formError, errMsg, on, applyRoleVisibility, passwordProblem, PASSWORD_MIN, copyButton, dateFields, dateFieldsWanted };
  MBC.page = page;
})();
