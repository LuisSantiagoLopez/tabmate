/* Fake CRM behavior for the Tabmate sandbox. Local only. */
(function () {
  'use strict';
  const LEADS = [
    ['Maya Chen', 'Lumen Labs', 'maya@lumenlabs.test', 'qualified'],
    ['Diego Ruiz', 'Brightwave', 'diego@brightwave.test', 'new'],
    ['Ava Patel', 'Orchard AI', 'ava@orchard.test', 'qualified'],
    ['Noah Kim', 'Fieldnote', 'noah@fieldnote.test', 'lost'],
    ['Lena Fischer', 'Kite & Co', 'lena@kite.test', 'qualified'],
    ['Omar Haddad', 'Parcel', 'omar@parcel.test', 'new'],
    ['Sofia Rossi', 'Tandem', 'sofia@tandem.test', 'qualified'],
    ['Jonas Berg', 'Northstar', 'jonas@northstar.test', 'new'],
  ];
  document.querySelectorAll('[data-noop]').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
  const KEY = 'tabmate-sandbox-status';

  const rows = document.getElementById('rows');
  if (rows) {
    const status = document.getElementById('status');
    const paint = () => {
      const v = status.value;
      rows.textContent = '';
      const shown = LEADS.filter((l) => v === 'all' || l[3] === v);
      for (const l of shown) {
        const tr = document.createElement('tr');
        l.forEach((c, i) => {
          const td = document.createElement('td');
          if (i === 3) { const s = document.createElement('span'); s.className = 'pill-s' + (c === 'qualified' ? ' q' : ''); s.textContent = c[0].toUpperCase() + c.slice(1); td.append(s); }
          else td.textContent = c;
          tr.append(td);
        });
        rows.append(tr);
      }
      document.getElementById('count').textContent = shown.length + ' of ' + LEADS.length + ' leads';
      try { sessionStorage.setItem(KEY, v); } catch (e) { /* private mode */ }
    };
    status.addEventListener('change', paint);
    paint();
  }

  const form = document.getElementById('exportForm');
  if (form) {
    let status = 'all';
    try { status = sessionStorage.getItem(KEY) || 'all'; } catch (e) { /* ignore */ }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fmt = form.format.value || 'csv';
      const name = (form.filename.value || 'leads-export').replace(/[^\w.-]+/g, '-');
      const n = LEADS.filter((l) => status === 'all' || l[3] === status).length;
      const out = document.getElementById('result');
      out.textContent = '';
      const b = document.createElement('b');
      b.textContent = name + '.' + fmt;
      out.append('Export ready: ', b, ' · ' + n + ' leads' + (form.emails.checked ? ' with emails' : ''));
      out.hidden = false;
      out.dataset.file = name + '.' + fmt;
      const count = Number(sessionStorage.getItem('tabmate-sandbox-exports') || 0) + 1;
      try { sessionStorage.setItem('tabmate-sandbox-exports', String(count)); } catch (err) { /* ignore */ }
      out.dataset.count = String(count);
    });
  }
})();
