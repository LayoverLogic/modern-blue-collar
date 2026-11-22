/* quote-invoice.html — billing lists (admin). Quote/invoice customer comes from job.customer; amount from amount. */
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
    $('table-head').innerHTML = '<tr><th>#</th><th>Customer</th><th>Job</th><th>Status</th><th class="num">Amount</th><th>' + (t === 'quotes' ? 'Created' : 'Due') + '</th></tr>';
    render();
  }

  function render() {
    const q = $('search-input').value.trim().toLowerCase();
    const st = $('status-filter').value;
    const list = (tab === 'quotes' ? quotes : invoices).filter((i) => {
      const job = i.job || {};
      const hay = [fmt.name(job.customer), job.title, '#' + i.id, 'job #' + i.jobId].join(' ').toLowerCase();
      return (!q || hay.includes(q)) && (!st || i.status === st);
    });
    $('list-tbody').innerHTML = list.length ? list.map((i) => {
      const job = i.job || {};
      const href = 'job.html?id=' + encodeURIComponent(i.jobId);
      return '<tr class="clickable" data-href="' + href + '"><td data-label="#"><a class="row-link" href="' + href + '">#' + fmt.esc(i.id) + '</a></td>' +
        '<td data-label="Customer">' + fmt.text(fmt.name(job.customer)) + '</td>' +
        '<td data-label="Job">#' + fmt.esc(i.jobId) + ' ' + fmt.esc(job.title || '') + '</td>' +
        '<td data-label="Status">' + fmt.badge(i.status) + '</td>' +
        '<td data-label="Amount" class="num">' + fmt.money(i.amount) + '</td>' +
        '<td data-label="' + (tab === 'quotes' ? 'Created' : 'Due') + '">' + fmt.esc(fmt.date(tab === 'quotes' ? i.createdAt : i.dueDate)) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">No ' + tab + ' found.</td></tr>';
  }

  function stats() {
    const now = new Date();
    $('s-quotes').textContent = quotes.filter((q) => q.status === 'draft' || q.status === 'sent').length;
    $('s-unpaid').textContent = fmt.money(invoices.filter((i) => i.status === 'unpaid' || i.status === 'overdue').reduce((s, i) => s + (fmt.num(i.amount) || 0), 0));
    $('s-paid').textContent = fmt.money(invoices.filter((i) => { const p = i.status === 'paid' && fmt.parseDate(i.paidAt); return p && p.getMonth() === now.getMonth() && p.getFullYear() === now.getFullYear(); })
      .reduce((s, i) => s + (fmt.num(i.amount) || 0), 0));
  }

  async function openNewQuote() {
    if (!jobs.length) { try { jobs = await api.get('/api/jobs'); } catch (e) { ui.toast(e.message, 'error'); return; } }
    const open = jobs.filter((j) => !j.quote && !j.invoice && j.status !== 'cancelled');
    $('f-job').innerHTML = open.length ? open.map((j) => '<option value="' + fmt.esc(j.id) + '">#' + fmt.esc(j.id) + ' ' + fmt.esc(j.title || j.type || '') + ' – ' + fmt.esc(fmt.name(j.customer)) + '</option>').join('')
      : '<option value="">Every open job already has a quote</option>';
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
