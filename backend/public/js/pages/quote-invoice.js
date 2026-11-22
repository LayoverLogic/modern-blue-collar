/* quote-invoice.html — billing lists (admin): document numbers (Q-0001 / INV-0001), totals in each
 * document's currency, print links. Customer comes from job.customer; total from amount. */
(function () {
  'use strict';
  const { fmt, api, ui } = window.MBC;
  const $ = ui.$;
  let quotes = [], invoices = [], jobs = [];
  let tab = 'quotes';
  const STATUSES = { quotes: ['draft', 'sent', 'approved', 'declined'], invoices: ['unpaid', 'paid', 'overdue', 'void'] };

  function setTab(t) {
    tab = t;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === t));
    $('status-filter').innerHTML = '<option value="">All statuses</option>' + STATUSES[t].map((s) => '<option value="' + s + '">' + fmt.statusLabel(s) + '</option>').join('');
    $('table-head').innerHTML = '<tr><th>Number</th><th>Customer</th><th>Job</th><th>Status</th><th class="num">Total</th><th>' + (t === 'quotes' ? 'Issued' : 'Due') + '</th><th><span class="sr-only">Print</span></th></tr>';
    render();
  }

  function render() {
    const q = $('search-input').value.trim().toLowerCase();
    const st = $('status-filter').value;
    const list = (tab === 'quotes' ? quotes : invoices).filter((i) => {
      const job = i.job || {};
      const hay = [fmt.name(job.customer), job.title, i.number, '#' + i.id, 'job #' + i.jobId].join(' ').toLowerCase();
      return (!q || hay.includes(q)) && (!st || i.status === st);
    });
    $('list-tbody').innerHTML = list.length ? list.map((i) => {
      const job = i.job || {};
      const href = 'job.html?id=' + encodeURIComponent(i.jobId);
      const type = tab === 'quotes' ? 'quote' : 'invoice';
      return '<tr class="clickable" data-href="' + href + '"><td data-label="Number"><a class="row-link" href="' + href + '">' + fmt.esc(i.number || '#' + i.id) + '</a></td>' +
        '<td data-label="Customer">' + fmt.text(fmt.name(job.customer)) + '</td>' +
        '<td data-label="Job">#' + fmt.esc(i.jobId) + ' ' + fmt.esc(job.title || '') + '</td>' +
        '<td data-label="Status">' + fmt.badge(i.status) + '</td>' +
        '<td data-label="Total" class="num">' + fmt.esc(fmt.money(i.amount, i.currency)) + '</td>' +
        '<td data-label="' + (tab === 'quotes' ? 'Issued' : 'Due') + '">' + fmt.esc(tab === 'quotes' ? fmt.date(i.issuedAt || i.createdAt) : (i.dueDate ? fmt.date(String(i.dueDate).slice(0, 10)) : fmt.DASH)) + '</td>' +
        '<td data-label="Print"><a class="btn btn-outline btn-sm" href="print.html?type=' + type + '&id=' + encodeURIComponent(i.id) + '" target="_blank" rel="noopener">Print</a></td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">No ' + tab + ' found.</td></tr>';
  }

  function stats() {
    $('s-quotes').textContent = quotes.filter((q) => q.status === 'draft' || q.status === 'sent').length;
    $('s-unpaid').textContent = fmt.money(invoices.filter((i) => i.status === 'unpaid' || i.status === 'overdue').reduce((s, i) => s + (fmt.num(i.amount) || 0), 0));
    const month = fmt.todayISO().slice(0, 7); // this month in the brand time zone
    $('s-paid').textContent = fmt.money(invoices.filter((i) => i.status === 'paid' && i.paidAt && fmt.zonedISO(i.paidAt).slice(0, 7) === month)
      .reduce((s, i) => s + (fmt.num(i.amount) || 0), 0));
  }

  async function openNewQuote() {
    if (!jobs.length) { try { jobs = await api.get('/api/jobs'); } catch (e) { ui.toast(e.message, 'error'); return; } }
    // A job can have several quotes: offer every job that is not cancelled, jobs without a quote first.
    const open = jobs.filter((j) => j.status !== 'cancelled').sort((a, b) => (a.quote ? 1 : 0) - (b.quote ? 1 : 0));
    const has = (j) => { const n = (Array.isArray(j.quotes) ? j.quotes : (j.quote ? [j.quote] : [])).map((q) => q.number).filter(Boolean); return n.length ? ' (has ' + n.slice(0, 2).join(', ') + (n.length > 2 ? '…' : '') + ')' : ''; };
    $('f-job').innerHTML = open.length ? open.map((j) => '<option value="' + fmt.esc(j.id) + '">#' + fmt.esc(j.id) + ' ' + fmt.esc(j.title || j.type || '') + ' – ' + fmt.esc(fmt.name(j.customer)) + fmt.esc(has(j)) + '</option>').join('')
      : '<option value="">No open jobs to quote</option>';
    ui.openModal('modal');
  }

  MBC.page({
    active: 'billing', title: 'Quotes & Invoices', roles: 'admin',
    async run() {
      document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
      $('search-input').addEventListener('input', render);
      $('status-filter').addEventListener('change', render);
      $('btn-export').addEventListener('click', () => api.download('/api/exports/invoices', 'invoices.csv').catch((e) => ui.toast(e.message, 'error')));
      $('btn-new-quote').addEventListener('click', openNewQuote);
      $('new-quote-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const id = $('f-job').value;
        if (!id) { ui.formError('modal-error', 'There is no job to quote. Create a job first.'); return; }
        location.href = 'job.html?id=' + encodeURIComponent(id) + '#quote';
      });
      const p = new URLSearchParams(location.search);
      [quotes, invoices] = await Promise.all([api.get('/api/quotes'), api.get('/api/invoices')]);
      stats();
      setTab(p.get('tab') === 'invoices' ? 'invoices' : 'quotes');
    },
  });
})();
