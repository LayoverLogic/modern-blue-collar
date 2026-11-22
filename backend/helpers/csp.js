/**
 * helpers/csp.js — dynamic parts of the Content-Security-Policy (server.js).
 *
 *   cspAssetOrigins(brand)  https origins of BRAND_LOGO_URL / BRAND_FAVICON_URL
 *                           when they are on another host (for img-src);
 *                           same-origin paths and data: URLs need nothing.
 *   sameOriginSockets(req)  "ws://host wss://host" for the request's own host
 *                           (socket.io presence). 'self' covers ws(s) in CSP3
 *                           browsers; this is for older ones.
 */
'use strict';

function cspAssetOrigins(brand) {
  const out = new Set();
  for (const url of [brand && brand.logoUrl, brand && brand.faviconUrl]) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) continue;
    try { out.add(new URL(url).origin); } catch { /* brandValidate already rejects bad URLs */ }
  }
  return [...out];
}

// host[:port] only — the Host header goes into a response header, so anything
// else (spaces, ';', quotes) is dropped rather than echoed.
const HOST = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]{2,45}\](?::\d{1,5})?$/;

function sameOriginSockets(req) {
  const host = req && req.headers ? String(req.headers.host || '') : '';
  if (!HOST.test(host)) return "'self'";
  return `ws://${host} wss://${host}`;
}

module.exports = { cspAssetOrigins, sameOriginSockets };
