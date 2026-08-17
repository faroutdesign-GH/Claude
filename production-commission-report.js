#!/usr/bin/env node
'use strict';

/**
 * Production-commission (Derek 2%) reconciliation report — for matching against
 * a QuickBooks "paid & complete jobs" report for the month.
 *
 * Commission is due on jobs CLOSED (complete) in the month whose APPROVED
 * customer invoices are FULLY PAID. Denied/voided invoices are excluded at the
 * data-pull step. Base = total invoice WITH tax. Commission = invoiced × rate.
 *
 * Usage: node production-commission-report.js --data=data/july-2026-production-data.json
 */

const fs = require('fs');
const path = require('path');

const dataArg = (process.argv.slice(2).find((a) => a.startsWith('--data=')) || '').split('=')[1];
if (!dataArg) {
  console.error('Usage: node production-commission-report.js --data=<file.json>');
  process.exit(1);
}
const snap = JSON.parse(fs.readFileSync(path.resolve(dataArg), 'utf8'));
const EPS = 0.005;
const rate = snap.rate;

const money = (n) => (typeof n === 'number' ? n : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Classify each job on its approved-invoice totals.
const rows = snap.jobs.map(([number, name, closedOn, invoiced, paid]) => {
  const inv = Number(invoiced) || 0;
  const pd = Number(paid) || 0;
  const balance = round2(inv - pd);
  const status = pd >= inv - EPS ? 'Fully paid' : pd > EPS ? 'Partially paid' : 'Unpaid';
  const commissionDue = status === 'Fully paid' ? round2(inv * rate) : 0;
  return { number, name, closedOn, invoiced: inv, paid: pd, balance, status, commissionDue };
});

const paidComplete = rows.filter((r) => r.status === 'Fully paid');
const openInvoiced = rows.filter((r) => r.status !== 'Fully paid');

const totalInvoiced = round2(paidComplete.reduce((s, r) => s + r.invoiced, 0));
const totalCommission = round2(paidComplete.reduce((s, r) => s + r.commissionDue, 0));

// ---- CSV --------------------------------------------------------------------
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvHeaders = ['Status', 'JobNumber', 'Job', 'Closed', 'InvoicedWithTax', 'Paid', 'Balance', `Commission_${rate * 100}pct`];
const csvRows = rows
  .slice()
  .sort((a, b) => (b.status === 'Fully paid') - (a.status === 'Fully paid') || Number(a.number) - Number(b.number))
  .map((r) => [r.status, r.number, r.name, r.closedOn, r.invoiced, r.paid, r.balance, r.commissionDue || '']);
const csv = [csvHeaders, ...csvRows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';

// ---- HTML -------------------------------------------------------------------
function table(list, commission) {
  if (list.length === 0) return '<p class="empty">None — every closed, approved-invoiced job is fully paid.</p>';
  const body = list
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map((r) => {
      const balCls = r.balance > EPS ? 'neg' : '';
      return `<tr><td class="num">${esc(r.number)}</td><td class="jn">${esc(r.name)}</td><td>${esc(r.closedOn)}</td><td class="num">${money(
        r.invoiced
      )}</td><td class="num">${money(r.paid)}</td><td class="num ${balCls}">${r.balance > EPS ? money(r.balance) : '<span class="z">–</span>'}</td>${
        commission ? `<td class="num strong">${r.commissionDue ? money(r.commissionDue) : '<span class="z">–</span>'}</td>` : ''
      }</tr>`;
    })
    .join('');
  const foot = commission
    ? `<tr class="total"><td></td><td>Total — ${list.length} job(s)</td><td></td><td class="num">${money(totalInvoiced)}</td><td class="num">${money(
        totalInvoiced
      )}</td><td class="num"></td><td class="num">${money(totalCommission)}</td></tr>`
    : '';
  return `<table><thead><tr><th class="num">Job #</th><th>Job</th><th>Closed</th><th class="num">Invoiced (w/tax)</th><th class="num">Paid</th><th class="num">Balance</th>${
    commission ? `<th class="num">Comm. ${rate * 100}%</th>` : ''
  }</tr></thead><tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table>`;
}

const html = `<title>Production Commission — ${esc(snap.periodLabel)}</title>
<style>
  :root{ --bg:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn:#b91c1c; --z:#c4c9d0; --card:#f9fafb; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn:#fca5a5; --z:#4b525b; --card:#1a1e23; } }
  :root[data-theme="light"]{ --bg:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn:#b91c1c; --z:#c4c9d0; --card:#f9fafb; }
  :root[data-theme="dark"]{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn:#fca5a5; --z:#4b525b; --card:#1a1e23; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:23px;margin:0 0 4px}
  h2{font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--accent)}
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
  td.jn{white-space:normal;max-width:300px}
  tfoot .total td{font-weight:700;border-top:2px solid var(--accent);background:var(--head)}
  .strong{font-weight:650}
  .z{color:var(--z)}.neg{color:var(--warn)}
  .empty{color:var(--muted);font-style:italic}
  .note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;font-size:13px;color:var(--muted)}
  @media print{ :root{color-scheme:light} body{padding:0;font-size:11px} table{font-size:10px} th,td{white-space:normal} tr{break-inside:avoid} }
  @page{ size: letter portrait; margin: .5in }
</style>
<div class="wrap">
  <h1>Production Commission (${esc(snap.rep)} · ${rate * 100}%) — ${esc(snap.periodLabel)}</h1>
  <div class="meta">Jobs closed in ${esc(snap.periodLabel)} with fully-paid approved invoices · pulled live from JobTread · reconcile against QuickBooks "paid &amp; complete jobs". Commission base = <b>total invoice with tax</b>.</div>

  <div class="cards">
    <div class="card"><div class="label">Paid &amp; complete jobs</div><div class="val">${paidComplete.length}</div></div>
    <div class="card"><div class="label">Invoiced (w/tax)</div><div class="val">${money(totalInvoiced)}</div></div>
    <div class="card"><div class="label">Commission due (${rate * 100}%)</div><div class="val">${money(totalCommission)}</div></div>
  </div>

  <h2>Paid &amp; complete — commission due (${paidComplete.length})</h2>
  <div class="scroll">${table(paidComplete, true)}</div>

  ${openInvoiced.length ? `<h2>Closed but not fully paid — no commission yet (${openInvoiced.length})</h2><div class="scroll">${table(openInvoiced, false)}</div>` : ''}

  <div class="note">
    <b>How to reconcile:</b> this list should match your QuickBooks "paid &amp; complete" jobs for ${esc(snap.periodLabel)}.
    A job qualifies when it is <b>closed in ${esc(snap.periodLabel)}</b> and its <b>approved</b> customer invoices are fully collected.
    Commission = <b>${rate * 100}% of the total invoice with tax</b>.
    Denied/voided invoices are excluded — e.g. #1932 and #2002 each had a denied invoice, and #1935 and #1970 were voided, so they do not affect these totals.
    ${snap.closedJobsTotal ? `Of ${snap.closedJobsTotal} jobs closed in ${esc(snap.periodLabel)}, ${snap.excludedNoApprovedInvoice} had no approved customer invoice (quotes, EV/Qmerit jobs, voided) and are excluded.` : ''}
  </div>
</div>`;

const base = `production-commission-${snap.year}-${String(snap.month).padStart(2, '0')}`;
const outDir = path.join(__dirname, 'out', base);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${base}.html`), html);
fs.writeFileSync(path.join(outDir, `${base}.csv`), csv);

console.log(`Production commission — ${snap.periodLabel} (${snap.rep} ${rate * 100}%, base = invoice with tax)`);
console.log(`  Paid & complete jobs: ${paidComplete.length}`);
console.log(`  Invoiced (w/tax): ${money(totalInvoiced)}`);
console.log(`  Commission due: ${money(totalCommission)}`);
if (openInvoiced.length) console.log(`  Closed but not fully paid: ${openInvoiced.length}`);
console.log(`Wrote ${outDir}`);
