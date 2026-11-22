/*
 * js/api.js — the only place pages talk to the API.
 *
 *   await MBC.api.get('/api/jobs')                 → parsed JSON
 *   await MBC.api.post('/api/customers', body)     (also patch / put / del)
 *   await MBC.api.upload(url, formData)
 *   await MBC.api.download('/api/exports/jobs', 'jobs.csv')
 *   await MBC.api.fetchBlob('POST', url, formData, { onProgress(bytes, total) })  → { blob, filename, headers }
 *   MBC.api.saveBlob(blob, 'name.zip')              save a Blob as a download
 *
 * Errors throw MBC.ApiError with .status and .message set to a FRIENDLY text:
 * never raw server / Prisma output.  401 → token cleared, back to the login page.
 * 409 → "Someone else changed this … reload".
 *
 * MBC.auth.requireUser({ roles }) loads the signed-in user (or redirects to login)
 * and, if the user's role is not allowed on the page, shows a no-access message
 * instead of calling APIs the role cannot use.
 */
(function () {
  'use strict';
  const MBC = (window.MBC = window.MBC || {});

  const ROLES = {
    admin: ['admin', 'super-admin'],
    staff: ['admin', 'super-admin', 'dispatcher', 'office'],
    all: ['admin', 'super-admin', 'dispatcher', 'office', 'technician'],
  };

  class ApiError extends Error {
    constructor(status, message, code, data) { super(message); this.status = status; this.code = code || ''; this.data = data || {}; }
  }

  // Field names in API errors → words people use.
  const FIELD_LABELS = {
    firstName: 'First name', lastName: 'Last name', phone: 'Phone', email: 'Email', address: 'Street address',
    city: 'Town / City', zip: 'Postcode / ZIP', state: 'State / County', title: 'Title', customerId: 'Customer',
    technicianId: 'Technician', scheduledDate: 'Date', scheduledTime: 'Time', duration: 'Hours', amount: 'Amount',
    dueDate: 'Due date', name: 'Name', category: 'Category', price: 'Price', password: 'Password', role: 'Role',
    status: 'Status', priority: 'Priority', type: 'Type', notes: 'Notes', description: 'Description', jobId: 'Job',
  };
  const LINE_FIELDS = { description: 'description', quantity: 'quantity', unitPrice: 'unit price', taxRateKey: 'tax rate', pricebookItemId: 'pricebook item' };
  function fieldLabel(f) {
    if (!f) return '';
    // Document line errors name the line: lines[2].unitPrice → "Line 3 unit price"
    const lm = /^lines\[(\d+)\](?:\.(\w+))?$/.exec(f);
    if (lm) return 'Line ' + (Number(lm[1]) + 1) + (lm[2] ? ' ' + (LINE_FIELDS[lm[2]] || lm[2]) : '');
    if (f === 'city' && MBC.fmt) return MBC.fmt.addressLabels().city;
    if (f === 'address' && MBC.fmt) return MBC.fmt.addressLabels().address;
    if (f === 'zip' && MBC.fmt) return MBC.fmt.addressLabels().postal;
    if (f === 'state' && MBC.fmt) return MBC.fmt.addressLabels().region;
    if (f === 'technicianId' && MBC.brand) return MBC.brand.techLabel;
    return FIELD_LABELS[f] || f;
  }

  // Server text is shown only if it looks like a deliberate, human-written message.
  const LEAKY = /prisma|invocation|\binvalid `|constraint|foreign key|column|relation|select |insert |delete from|stack|\bat \w+ \(|\.js\b|\.ts\b|\/home\/|\/usr\/|node_modules|ECONN|ENOENT|TypeError|ReferenceError|SyntaxError|\bP\d{4}\b|\n/i;
  function safeServerText(s) {
    if (!s || typeof s !== 'string') return '';
    const t = s.trim();
    if (t.length > 180 || LEAKY.test(t)) return '';
    return t;
  }
  function friendly(status, serverMsg, code, data) {
    data = data || {};
    const label = fieldLabel(data.field);
    switch (code) {
      case 'VERSION_CONFLICT': return 'Someone else changed this while you were editing. Reload to see the latest version, then try again.';
      case 'VERSION_REQUIRED': return 'This page is out of date. Reload it and try again.';
      case 'SCHEDULE_CONFLICT': return 'That ' + ((MBC.brand && MBC.brand.techLabel) || 'technician').toLowerCase() + ' is already booked at that time' +
        (data.conflictJobId ? ' (job #' + data.conflictJobId + ')' : '') + '. Pick another time or person.';
      case 'REQUIRED': return label ? label + ' is required.' : 'Some required details are missing.';
      case 'INVALID_AMOUNT':
        if (/^lines\[/.test(data.field || '')) return label + ' is not a valid number (quantity up to 3 decimals and more than 0; price up to 2 decimals).';
        return (label || 'Amount') + (data.field === 'amount' || !data.field ? ' must be greater than 0.' : ' is not a valid amount.');
      case 'INVALID_ENUM': return (label || 'A value') + ' is not one of the allowed options.';
      case 'INVALID_INPUT': {
        const safe = safeServerText(serverMsg);
        if (label && safe && data.field && safe.indexOf(data.field) === 0) return label + safe.slice(data.field.length) + '.';
        return label ? label + ' is not valid.' : (safe || 'Some details are not valid. Please check the form.');
      }
      case 'WEAK_PASSWORD': return 'The password must be at least 10 characters.';
      case 'DUPLICATE': return 'A record with these details already exists (for example, the same email address).';
      case 'IN_USE_OR_MISSING_REFERENCE': return 'This is still linked to other records, so it cannot be changed or removed.';
      case 'NOT_FOUND': return 'That record could not be found. It may have been deleted.';
      case 'OUT_OF_SCOPE': return 'That is not assigned to you.';
      case 'FILE_TOO_LARGE': case 'PAYLOAD_TOO_LARGE': return 'That file is too large.';
      case 'UNSUPPORTED_FILE_TYPE': return 'That file type is not supported. Upload a photo (JPEG, PNG, WebP or HEIC).';
      case 'SESSION_REQUIRED': return 'Please sign in again to do that.';
      case 'INVALID_LOGIN_CODE': return 'That sign-in link has expired. Please sign in again.';
      case 'INVALID_PHONE': return (label || 'Phone') + ' is not a valid phone number. Use the full number with area code' +
        (MBC.fmt && MBC.fmt.country() !== 'US' ? ' (or +country code)' : '') + '; no letters or extensions.';
      case 'NOT_OWNER': return 'You can only delete photos you uploaded yourself.';
      case 'RECIPIENT_NOT_CUSTOMER': return 'That number does not belong to a customer.';
      // Phase 2b documents
      case 'DOCUMENT_LOCKED': return 'This document has been ' + (data.status && data.status !== 'draft' && data.status !== 'unpaid' ? 'marked ' + data.status : 'sent') +
        ', so its lines and details can no longer be edited — only its status can change.';
      case 'TOTALS_FROM_LINES': return 'This document has line items, so its total is worked out from the lines. Edit the lines instead of the total.';
      case 'EMAIL_DISABLED': return 'Email is not set up on this system yet, so nothing was sent. Ask your administrator to configure outgoing email.';
      case 'NO_CUSTOMER_EMAIL': return 'This customer has no email address on file. Add one on the customer page, then try again.';
      case 'QUOTE_DECLINED': return 'This quote was declined, so it cannot be turned into an invoice.';
      case 'UNKNOWN_PRICEBOOK_ITEM': return (label || 'A line') + ' refers to a pricebook item that no longer exists. Remove it and add it again.';
      case 'UNKNOWN_JOB': return 'That job no longer exists. Reload the page.';
      // Phase 2c integrations: imports, exports, QuickBooks
      case 'IMPORT_RUNNING': return 'Another import is running right now. Wait for it to finish, then try again.';
      case 'FILE_CHANGED': return 'The file is not the one the dry run checked. Run a new dry run before importing.';
      case 'INVALID_CSV': return 'That file could not be read as a CSV. Save it as "CSV UTF-8" and try again.' + (safeServerText(serverMsg) ? ' (' + safeServerText(serverMsg) + ')' : '');
      case 'TOO_MANY_ROWS': return 'That file has too many rows for one import. Split it into smaller files.';
      case 'INVALID_JSON': return (label || 'A value') + ' is not valid JSON.';
      case 'EXPORT_RUNNING': return 'An export is already running. Wait a moment and try again.';
      case 'QBO_NOT_CONNECTED': return 'QuickBooks is not connected. Connect it in Settings → QuickBooks first.';
      case 'QBO_REAUTH_REQUIRED': return 'The QuickBooks connection has expired or was revoked. Reconnect QuickBooks in Settings.';
      case 'QBO_INVOICE_VOID': return 'Void invoices are not pushed to QuickBooks.';
      case 'QBO_TAX_CODE_UNMAPPED': return 'Nothing was pushed: no QuickBooks tax code is set for ' + (Array.isArray(data.keys) && data.keys.length ? data.keys.join(', ') : 'this invoice\'s tax rates') + '. Ask your administrator to set QBO_TAX_CODES.';
      case 'QBO_THROTTLED': return 'QuickBooks is busy (rate limit). Try again in a minute.';
      case 'QBO_UNREACHABLE': return 'QuickBooks could not be reached. Try again later.';
      case 'QBO_TOKEN_FAILED': return 'QuickBooks refused the sign-in token. Try again, or reconnect QuickBooks in Settings.';
      case 'QBO_API_ERROR': return 'QuickBooks rejected the request' + (data.qboCode ? ' (code ' + String(data.qboCode).slice(0, 20) + ')' : '') + '.' + (safeServerText(serverMsg) ? ' ' + safeServerText(serverMsg) : '');
      default: break;
    }
    // Integration switched off (SANDBOX_MODE / DEMO_MODE / no credentials): 503 and nothing was sent.
    if (status === 503 && data.integration) return disabledText(data);
    const safe = safeServerText(serverMsg);
    switch (status) {
      case 0: return 'Could not reach the server. Check your connection and try again.';
      case 400: case 422: return safe || 'Some details are missing or not valid. Please check the form and try again.';
      case 401: return 'Your session has expired. Please sign in again.';
      case 403: return 'You do not have permission to do that.';
      case 404: return 'That record could not be found. It may have been deleted.';
      case 409: return safe || 'That conflicts with another record. Reload and try again.';
      case 413: return 'That file is too large.';
      case 415: return safe || 'That file type is not supported.';
      case 429: return 'Too many requests. Please wait a minute and try again.';
      case 501: case 503: return safe || 'This feature is not set up on this system yet.';
      default: return status >= 500 ? 'Something went wrong on the server. Please try again.' : (safe || 'Request failed.');
    }
  }

  const INTEGRATION_NAMES = { quickbooks: 'QuickBooks', twilio: 'Text messaging', google: 'Google sign-in', gmail: 'Gmail' };
  function disabledText(data) {
    const n = INTEGRATION_NAMES[data.integration] || 'This integration';
    if (data.sandbox || data.reason === 'sandbox') return n + ' is disabled in sandbox — no request was sent.';
    if (data.demo || data.reason === 'demo') return n + ' is disabled in demo mode — no request was sent.';
    return n + ' is not set up on this system (no credentials) — no request was sent.';
  }

  function token() { return localStorage.getItem('token'); }
  function setToken(t) { if (t) localStorage.setItem('token', t); else localStorage.removeItem('token'); }
  function onLoginPage() { return /(^|\/)(index\.html)?$/.test(location.pathname); }
  function toLogin() {
    setToken(null);
    if (!onLoginPage()) location.href = 'index.html';
  }

  async function request(method, url, body, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    const t = token();
    if (t && !opts.noAuth) headers.Authorization = 'Bearer ' + t;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, { method, headers, body: payload }); }
    catch (e) { throw new ApiError(0, friendly(0), 'NETWORK'); }
    if (opts.raw && res.ok) return res;
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) { try { data = await res.json(); } catch (e) { data = null; } }
    if (!res.ok) {
      if (res.status === 401 && !opts.noAuth && !opts.no401Redirect) toLogin();
      throw new ApiError(res.status, friendly(res.status, data && (data.error || data.message), data && data.code, data), data && data.code, data);
    }
    return data;
  }

  function filenameFrom(res, fallback) {
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    let name = '';
    if (m) { try { name = decodeURIComponent(m[1]); } catch (e) { name = m[1]; } }
    return name || fallback || 'export.csv';
  }
  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return name;
  }
  // Fetch a file (GET, or POST with a body) as a Blob. opts.onProgress(bytesSoFar, totalOrNull)
  // is called while the body streams in (exports are streamed, so the total is often unknown).
  // → { blob, filename, headers }
  async function fetchBlob(method, url, body, opts) {
    opts = opts || {};
    const res = await request(method, url, body, Object.assign({}, opts, { raw: true }));
    const total = Number(res.headers.get('content-length')) || null;
    let blob;
    if (opts.onProgress && res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        parts.push(r.value); got += r.value.length;
        opts.onProgress(got, total);
      }
      blob = new Blob(parts, { type: res.headers.get('content-type') || 'application/octet-stream' });
    } else blob = await res.blob();
    return { blob, filename: filenameFrom(res, opts.filename), headers: res.headers };
  }
  async function download(url, filename, opts) {
    const r = await fetchBlob('GET', url, undefined, Object.assign({ filename }, opts || {}));
    MBC.api.saveBlob(r.blob, r.filename);
    return r.filename;
  }

  MBC.ApiError = ApiError;
  MBC.api = {
    request,
    get: (u, o) => request('GET', u, undefined, o),
    post: (u, b, o) => request('POST', u, b === undefined ? {} : b, o),
    patch: (u, b, o) => request('PATCH', u, b, o),
    put: (u, b, o) => request('PUT', u, b, o),
    del: (u, o) => request('DELETE', u, undefined, o),
    upload: (u, fd, o) => request('POST', u, fd, o),
    download, fetchBlob, saveBlob,
    friendly, disabledText,
  };

  let me = null;
  MBC.auth = {
    ROLES,
    token, setToken,
    get user() { return me; },
    is(role) { return !!me && (ROLES[role] ? ROLES[role].includes(me.role) : me.role === role); },
    isAdmin() { return this.is('admin'); },
    isStaff() { return this.is('staff'); },
    isTech() { return !!me && me.role === 'technician'; },
    async me() {
      if (!token()) return null;
      try { me = await request('GET', '/api/auth/me', undefined, { no401Redirect: true }); }
      catch (e) { if (e.status === 401 || e.status === 404) { setToken(null); return null; } throw e; }
      return me;
    },
    // Page guard. allowed: 'admin' | 'staff' | 'all' | array of roles.
    async requireUser(allowed) {
      const u = await this.me();
      if (!u) { toLogin(); return null; }
      const list = Array.isArray(allowed) ? allowed : ROLES[allowed || 'all'];
      if (list && !list.includes(u.role)) {
        const main = document.querySelector('main');
        if (main) {
          main.innerHTML = '<div class="card"><div class="empty">You do not have access to this page.<br><a href="' +
            (u.role === 'technician' ? 'today.html' : 'index.html') + '">Go to your start page</a></div></div>';
        }
        return Object.assign({}, u, { denied: true });
      }
      return u;
    },
    logout() { setToken(null); location.href = 'index.html'; },
  };
})();
