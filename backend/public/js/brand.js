/*
 * js/brand.js — one loadBrand for every page. Load it in <head> (no defer):
 * it immediately re-applies the last brand seen (localStorage) so there is no
 * flash of default colours, then MBC.brand.load() fetches /api/brand.
 *
 * Reads (all optional, tolerates absence):
 *   companyName, companySlogan, industryLabel, tradeType, technicianLabel, jobTypes,
 *   colors.{primary, primaryDark, navBg, navText, accent},
 *   logoUrl, faviconUrl, country, locale, currency, regionLabel, postalLabel,
 *   demoLogin {email, password} | demoHint (string), googleAuth (boolean).
 * primaryDark is derived from primary when absent; text colours on primary/accent
 * are picked for contrast. Without a faviconUrl an initials SVG favicon is drawn.
 */
(function () {
  'use strict';
  const MBC = (window.MBC = window.MBC || {});
  const KEY = 'mbc.brand';

  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(rgb) { return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
  function darken(hex, f) { const rgb = hexToRgb(hex); return rgb ? rgbToHex(rgb.map((v) => v * (1 - f))) : hex; }
  function luminance(hex) {
    const rgb = hexToRgb(hex); if (!rgb) return 0;
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function onColor(hex) { return luminance(hex) > 0.45 ? '#111827' : '#ffffff'; }
  function validColor(c) { return typeof c === 'string' && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c.trim()) ? (c.trim()[0] === '#' ? c.trim() : '#' + c.trim()) : null; }

  function applyColors(b) {
    const c = (b && b.colors) || {};
    const s = document.documentElement.style;
    const primary = validColor(c.primary);
    if (primary) {
      s.setProperty('--color-primary', primary);
      s.setProperty('--color-primary-dark', validColor(c.primaryDark) || darken(primary, 0.18));
      s.setProperty('--color-on-primary', onColor(primary));
    }
    const navBg = validColor(c.navBg); if (navBg) s.setProperty('--color-nav-bg', navBg);
    const navText = validColor(c.navText); if (navText) s.setProperty('--color-nav-text', navText);
    const accent = validColor(c.accent) || validColor(c.secondary);
    if (accent) { s.setProperty('--color-accent', accent); s.setProperty('--color-on-accent', onColor(accent)); }
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  function applyFavicon(b) {
    let link = document.querySelector('link[rel~="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    if (b.faviconUrl) { link.href = b.faviconUrl; return; }
    const bg = validColor(b.colors && b.colors.primary) || '#475569';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="' + bg +
      '"/><text x="32" y="42" font-family="Arial,sans-serif" font-size="28" font-weight="700" text-anchor="middle" fill="' + onColor(bg) + '">' +
      initials(b.companyName).replace(/[<>&"]/g, '') + '</text></svg>';
    link.type = 'image/svg+xml';
    link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function setTitle(b, pageTitle) {
    const page = pageTitle || document.body && document.body.dataset.title || '';
    document.title = [b.companyName, page].filter(Boolean).join(' – ') || page;
  }

  // Put the brand into any element marked with data-brand="companyName" etc.
  function fillText(b) {
    document.querySelectorAll('[data-brand]').forEach((el) => {
      const v = b[el.getAttribute('data-brand')];
      if (v) el.textContent = v;
    });
    document.querySelectorAll('[data-tech-label]').forEach((el) => {
      const t = b.technicianLabel || 'Technician';
      el.textContent = el.getAttribute('data-tech-label') === 'plural' ? t + 's' : t;
    });
    document.querySelectorAll('img[data-brand-logo]').forEach((img) => {
      if (b.logoUrl) { img.src = b.logoUrl; img.alt = b.companyName || 'Logo'; img.hidden = false; } else img.hidden = true;
    });
  }

  function apply(b, pageTitle) {
    b = b || {};
    MBC.brand.current = b;
    applyColors(b);
    if (document.head) { setTitle(b, pageTitle); applyFavicon(b); }
    if (document.body) fillText(b);
  }

  MBC.brand = {
    current: {},
    darken, onColor,
    // Fetch /api/brand (public), apply and cache. Never throws.
    async load(pageTitle) {
      let b = null;
      try {
        const r = await fetch('/api/brand');
        if (r.ok) b = await r.json();
      } catch (e) { /* offline: keep cached */ }
      if (b) { try { localStorage.setItem(KEY, JSON.stringify(b)); } catch (e) { /* quota */ } }
      apply(b || MBC.brand.current, pageTitle);
      return MBC.brand.current;
    },
    apply,
    get techLabel() { return MBC.brand.current.technicianLabel || 'Technician'; },
    get industry() { return MBC.brand.current.industryLabel || ''; },
  };

  // Early, synchronous: apply the cached brand before first paint.
  try {
    const cached = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (cached) { MBC.brand.current = cached; applyColors(cached); }
  } catch (e) { /* ignore */ }
})();
