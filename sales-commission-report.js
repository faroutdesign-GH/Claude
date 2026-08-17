#!/usr/bin/env node
'use strict';

/**
 * Salesman-commission report for one rep for a month.
 *
 * Commission = the job's "Salesman Commission" budget line, DUE when the job is
 * closed in the month AND its approved invoices are fully collected. Jobs that
 * are sold (carry a commission line) but not yet fully paid are listed as
 * PENDING (due once collected). The Team-Lead / "Lead Commission" line is a
 * separate line and is not included here.
 *
 * Usage: node sales-commission-report.js --data=data/july-2026-sales-commission-derek.json
 */

const fs = require('fs');
const path = require('path');

const dataArg = (process.argv.slice(2).find((a) => a.startsWith('--data=')) || '').split('=')[1];
if (!dataArg) {
  console.error('Usage: node sales-commission-report.js --data=<file.json>');
  process.exit(1);
}
const snap = JSON.parse(fs.readFileSync(path.resolve(dataArg), 'utf8'));
const EPS = 0.005;

const money = (n) => (typeof n === 'number' ? n : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const rows = snap.jobs.map(([number, name, closedOn, line, invoiced, paid]) => {
  const commission = round2(Number(line) || 0);
  const inv = Number(invoiced) || 0;
  const pd = Number(paid) || 0;
  const fullyPaid = inv > EPS && pd >= inv - EPS;
  let bucket;
  if (commission <= EPS) bucket = 'none'; // no salesman commission line on the job
  else if (fullyPaid) bucket = 'due';
  else bucket = 'pending'; // sold (has a line) but not yet collected
  return { number, name, closedOn, commission, invoiced: inv, paid: pd, fullyPaid, bucket };
});

const due = rows.filter((r) => r.bucket === 'due');
const pending = rows.filter((r) => r.bucket === 'pending');
const none = rows.filter((r) => r.bucket === 'none');
const totalDue = round2(due.reduce((s, r) => s + r.commission, 0));
const totalPending = round2(pending.reduce((s, r) => s + r.commission, 0));

// ---- CSV --------------------------------------------------------------------
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvHeaders = ['Bucket', 'JobNumber', 'Job', 'Closed', 'SalesmanCommissionLine', 'ApprovedInvoicedWithTax', 'Paid', 'FullyPaid'];
const csvRows = rows.map((r) => [r.bucket, r.number, r.name, r.closedOn, r.commission, r.invoiced, r.paid, r.fullyPaid ? 'YES' : 'no']);
const csv = [csvHeaders, ...csvRows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';

// ---- HTML -------------------------------------------------------------------
function table(list, showPaid) {
  if (list.length === 0) return '<p class="empty">None.</p>';
  const body = list
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map(
      (r) =>
        `<tr><td class="num">${esc(r.number)}</td><td class="jn">${esc(r.name)}</td><td>${esc(r.closedOn)}</td><td class="num strong">${
          r.commission ? money(r.commission) : '<span class="z">–</span>'
        }</td>${showPaid ? `<td class="num">${r.invoiced ? money(r.invoiced) : '<span class="z">–</span>'}</td><td class="num">${r.paid ? money(r.paid) : '<span class="z">–</span>'}</td>` : ''}</tr>`
    )
    .join('');
  const foot = `<tr class="total"><td></td><td>Total — ${list.length} job(s)</td><td></td><td class="num">${money(
    list.reduce((s, r) => s + r.commission, 0)
  )}</td>${showPaid ? '<td></td><td></td>' : ''}</tr>`;
  return `<table><thead><tr><th class="num">Job #</th><th>Job</th><th>Closed</th><th class="num">Salesman comm.</th>${
    showPaid ? '<th class="num">Invoiced (w/tax)</th><th class="num">Paid</th>' : ''
  }</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

const html = `<title>Salesman Commission — ${esc(snap.rep)} — ${esc(snap.periodLabel)}</title>
<style>
  :root{ --bg:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn:#b91c1c; --z:#c4c9d0; --card:#f9fafb; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn:#fca5a5; --z:#4b525b; --card:#1a1e23; } }
  :root[data-theme="light"]{ --bg:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn:#b91c1c; --z:#c4c9d0; --card:#f9fafb; }
  :root[data-theme="dark"]{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn:#fca5a5; --z:#4b525b; --card:#1a1e23; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px}
  .wrap{max-width:900px;margin:0 auto}
  h1{font-size:23px;margin:0 0 4px}
  h2{font-size:16px;margin:26px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--accent)}
  .meta{color:var(--muted);font-size:13px;margin-bottom:8px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}
  .card{flex:1;min-width:150px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .card .val{font-size:22px;font-weight:650;margin-top:4px}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:14px;margin:6px 0}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  thead th{background:var(--head);font-weight:600;font-size:13px}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  td.jn{white-space:normal;max-width:320px}
  tfoot .total td{font-weight:700;border-top:2px solid var(--accent);background:var(--head)}
  .strong{font-weight:650}
  .z{color:var(--z)}
  .empty{color:var(--muted);font-style:italic}
  .note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;font-size:13px;color:var(--muted)}
  @media print{ :root{color-scheme:light} body{padding:0;font-size:11px} table{font-size:10px} th,td{white-space:normal} tr{break-inside:avoid} }
  @page{ size: letter portrait; margin: .5in }
</style>
<div class="wrap">
  <h1>Salesman Commission — ${esc(snap.rep)} — ${esc(snap.periodLabel)}</h1>
  <div class="meta">Jobs where ${esc(snap.rep)} is the Sales Rep, closed in ${esc(snap.periodLabel)} · pulled live from JobTread. Commission = each job's <b>${esc(
    snap.lineName
  )}</b> line, due once the job's approved invoices are fully collected. Team-Lead / Lead Commission is a separate line and is excluded.</div>

  <div class="cards">
    <div class="card"><div class="label">Due now (paid &amp; complete)</div><div class="val">${money(totalDue)}</div></div>
    <div class="card"><div class="label">Pending (sold, not yet paid)</div><div class="val">${money(totalPending)}</div></div>
    <div class="card"><div class="label">${esc(snap.rep)}'s closed jobs</div><div class="val">${rows.length}</div></div>
  </div>

  <h2>Due now — commission payable (${due.length})</h2>
  <div class="scroll">${table(due, true)}</div>

  <h2>Pending — sold but not yet fully paid (${pending.length})</h2>
  <div class="scroll">${table(pending, true)}</div>

  ${none.length ? `<h2>No salesman-commission line on the job (${none.length})</h2><div class="scroll">${table(none, true)}</div>` : ''}

  <div class="note">
    <b>Basis:</b> a job's ${esc(snap.lineName)} is payable when the job is <b>closed in ${esc(snap.periodLabel)}</b> and its <b>approved</b> customer invoices are <b>fully collected</b>.
    "Pending" jobs carry a commission line but haven't been fully invoiced/paid yet — they become due in the month they're collected.
    This report uses the ${esc(snap.lineName)} line only; the Team-Lead / Lead Commission line is tracked separately.
  </div>
</div>`;

const base = `sales-commission-${esc(snap.rep).toLowerCase()}-${snap.year}-${String(snap.month).padStart(2, '0')}`;
const outDir = path.join(__dirname, 'out', base);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${base}.html`), html);
fs.writeFileSync(path.join(outDir, `${base}.csv`), csv);

console.log(`Salesman commission — ${snap.rep} — ${snap.periodLabel}`);
console.log(`  Due now (paid & complete): ${money(totalDue)} across ${due.length} job(s)`);
console.log(`  Pending (sold, not yet paid): ${money(totalPending)} across ${pending.length} job(s)`);
console.log(`  No commission line: ${none.length} job(s)`);
console.log(`Wrote ${outDir}`);
