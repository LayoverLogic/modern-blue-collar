/**
 * helpers/cookies.js — minimal cookie read/write (no cookie-parser dependency).
 * Used only for short-lived OAuth state cookies (Google sign-in, QuickBooks).
 */

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function serialize(name, value, { maxAge, path = '/', secure = false, sameSite = 'Lax', httpOnly = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge != null) c += `; Max-Age=${Math.floor(maxAge)}`;
  return c;
}

function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

function setCookie(res, name, value, opts) {
  appendCookie(res, serialize(name, value, opts));
}

function clearCookie(res, name, opts = {}) {
  appendCookie(res, serialize(name, '', { ...opts, maxAge: 0 }));
}

module.exports = { getCookie, setCookie, clearCookie };
