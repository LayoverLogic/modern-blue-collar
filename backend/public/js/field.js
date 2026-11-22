/*
 * js/field.js — technician "in the field" actions shared by job.html and today.html.
 *
 * Navigate opens the phone's maps app; Call is a tel: link; Text Customer and
 * On My Way are sms: links that open the technician's OWN messaging app with an
 * editable message (no SMS provider, nothing sent by the server). Ported from the
 * all-pro client branch (142378d, 1a395d0), made generic: the message uses the
 * brand's company name and the date/time is formatted for the brand locale.
 * "sms:NUMBER?&body=" is the form both iOS and Android accept.
 */
(function () {
  'use strict';
  const MBC = (window.MBC = window.MBC || {});
  const fmt = MBC.fmt;

  const isApple = () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;

  function mapsUrl(c) {
    const addr = fmt.address(c);
    if (!addr) return '';
    const q = encodeURIComponent(addr);
    return isApple() ? 'https://maps.apple.com/?daddr=' + q : 'https://www.google.com/maps/dir/?api=1&destination=' + q;
  }
  function telUrl(c) { const n = fmt.phoneDigits(c && c.phone); return n ? 'tel:' + n : ''; }
  function smsUrl(c, body) {
    const n = fmt.phoneDigits(c && c.phone);
    return n ? 'sms:' + n + '?&body=' + encodeURIComponent(body) : '';
  }

  function parts(job, user) {
    const c = (job && job.customer) || {};
    return {
      hi: c.firstName ? 'Hi ' + String(c.firstName).trim() + ', ' : 'Hi, ',
      who: 'this is ' + (user && user.firstName ? String(user.firstName).trim() + ' with ' : '') + ((MBC.brand.current || {}).companyName || 'us'),
      svc: (job && job.type) ? String(job.type).toLowerCase() : 'service',
    };
  }
  function textMessage(job, user) {
    const p = parts(job, user);
    const when = job && job.scheduledDate ? ' on ' + fmt.dateLong(job.scheduledDate) + (job.scheduledTime ? ' at ' + fmt.time(job.scheduledTime) : '') : '';
    return p.hi + p.who + ' regarding your ' + p.svc + ' appointment' + when + '.';
  }
  function onMyWayMessage(job, user) {
    const p = parts(job, user);
    return p.hi + p.who + ". I'm on my way to your " + p.svc + ' appointment now. See you soon.';
  }

  // HTML for the big action buttons (escaped). Missing phone/address → disabled button.
  function actionsHtml(job, user) {
    const c = (job && job.customer) || {};
    const esc = fmt.esc;
    const link = (url, label, cls, id) => url
      ? '<a class="btn ' + cls + '" id="' + id + '" href="' + esc(url) + '"' + (url.startsWith('http') ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>'
      : '<button class="btn ' + cls + '" id="' + id + '" type="button" disabled title="Not on file">' + label + '</button>';
    return link(mapsUrl(c), 'Navigate', 'btn-primary', 'act-navigate-' + job.id) +
      link(telUrl(c), 'Call', 'btn-outline', 'act-call-' + job.id) +
      link(smsUrl(c, textMessage(job, user)), 'Text Customer', 'btn-outline', 'act-text-' + job.id) +
      link(smsUrl(c, onMyWayMessage(job, user)), 'On My Way', 'btn-outline', 'act-omw-' + job.id);
  }

  MBC.field = { mapsUrl, telUrl, smsUrl, textMessage, onMyWayMessage, actionsHtml };
})();
