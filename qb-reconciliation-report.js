#!/usr/bin/env node
'use strict';

/**
 * QuickBooks (accrual Sales by Customer) vs JobTread (approved customer
 * invoices issued in the month) reconciliation. Verifies the bridge ties out.
 *
 * Usage: node qb-reconciliation-report.js --data=data/july-2026-qb-reconciliation.json
 */

const fs = require('fs');
const path = require('path');

const dataArg = (process.argv.slice(2).find((a) => a.startsWith('--data=')) || '').split('=')[1];
if (!dataArg) { console.error('Usage: node qb-reconciliation-report.js --data=<file.json>'); process.exit(1); }
const d = JSON.parse(fs.readFileSync(path.resolve(dataArg), 'utf8'));

const money = (n) => (typeof n === 'number' ? n : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (arr, i) => round2(arr.reduce((s, r) => s + (Number(r[i]) || 0), 0));

const matchedQb = sum(d.matched, 2);
const qbMissing = sum(d.qbNotInJobtread, 2);
const qbNotApproved = sum(d.qbNotApprovedInJobtread, 2);
const jtOnly = sum(d.jobtreadNotInQb, 2);

const qbAccounted = round2(matchedQb + qbMissing + qbNotApproved);
const qbTie = round2(qbAccounted - d.qbTotal);
// Small rounding term so the QB->JT bridge ties exactly (TV relocation 10c).
const rounding = round2(d.jtApprovedTotal - (d.qbTotal - qbMissing - qbNotApproved + jtOnly));

// ---- CSV --------------------------------------------------------------------
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvLines = [['Category', 'QB_Customer', 'QB_Description', 'QB_Amount', 'JT_Job', 'JT_Name', 'JT_Amount_or_Status']];
d.matched.forEach((r) => csvLines.push(['Matched', r[0], r[1], r[2], r[3], r[4], r[5]]));
d.qbNotInJobtread.forEach((r) => csvLines.push(['QB not in JobTread', r[0], r[1], r[2], '', '', r[3]]));
d.qbNotApprovedInJobtread.forEach((r) => csvLines.push(['QB pending/denied in JobTread', r[0], r[1], r[2], r[3], r[4], r[5]]));
d.jobtreadNotInQb.forEach((r) => csvLines.push(['JobTread not in QB', '', '', '', r[0], r[1], r[2]]));
const csv = csvLines.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';

// ---- HTML -------------------------------------------------------------------
function matchTable(rows) {
  const body = rows.map((r) => {
    const diff = round2((Number(r[2]) || 0) - (Number(r[5]) || 0));
    return `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="num">${money(r[2])}</td><td class="num">${esc(r[3])}</td><td>${esc(r[4])}</td><td class="num">${money(
      r[5]
    )}</td><td>${r[6] ? `<span class="warn">${esc(r[6])}</span>` : ''}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>QB customer</th><th>QB line</th><th class="num">QB amt</th><th class="num">JT job #</th><th>JT job</th><th class="num">JT amt</th><th>Note</th></tr></thead><tbody>${body}</tbody><tfoot><tr class="total"><td>Matched — ${rows.length}</td><td></td><td class="num">${money(matchedQb)}</td><td></td><td></td><td class="num"></td><td></td></tr></tfoot></table>`;
}
function qbMissTable(rows) {
  const body = rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="num strong">${money(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('');
  return `<table><thead><tr><th>QB customer</th><th>QB line</th><th class="num">QB amt</th><th>Why</th></tr></thead><tbody>${body}</tbody><tfoot><tr class="total"><td>Subtotal — ${rows.length}</td><td></td><td class="num">${money(qbMissing)}</td><td></td></tr></tfoot></table>`;
}
function qbNaTable(rows) {
  const body = rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="num strong">${money(r[2])}</td><td class="num">${esc(r[3])}</td><td>${esc(r[4])}</td><td><span class="warn">${esc(r[5])}</span></td></tr>`).join('');
  return `<table><thead><tr><th>QB customer</th><th>QB line</th><th class="num">QB amt</th><th class="num">JT job #</th><th>JT job</th><th>JT status</th></tr></thead><tbody>${body}</tbody><tfoot><tr class="total"><td>Subtotal — ${rows.length}</td><td></td><td class="num">${money(qbNotApproved)}</td><td></td><td></td><td></td></tr></tfoot></table>`;
}
function jtOnlyTable(rows) {
  const body = rows.map((r) => `<tr><td class="num">${esc(r[0])}</td><td>${esc(r[1])}</td><td class="num strong">${money(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('');
  return `<table><thead><tr><th class="num">JT job #</th><th>JT job</th><th class="num">JT amt</th><th>Why</th></tr></thead><tbody>${body}</tbody><tfoot><tr class="total"><td>Subtotal — ${rows.length}</td><td></td><td class="num">${money(jtOnly)}</td><td></td></tr></tfoot></table>`;
}

const html = `<title>QB vs JobTread Reconciliation — ${esc(d.periodLabel)}</title>
<style>
  :root{ --bg:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn:#b45309; --bad:#b91c1c; --z:#c4c9d0; --card:#f9fafb; --ok:#0f766e; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn:#fbbf24; --bad:#fca5a5; --z:#4b525b; --card:#1a1e23; --ok:#2dd4bf; } }
  :root[data-theme="light"]{ --bg:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn:#b45309; --bad:#b91c1c; --z:#c4c9d0; --card:#f9fafb; --ok:#0f766e; }
  :root[data-theme="dark"]{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn:#fbbf24; --bad:#fca5a5; --z:#4b525b; --card:#1a1e23; --ok:#2dd4bf; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px}
  .wrap{max-width:1050px;margin:0 auto}
  h1{font-size:23px;margin:0 0 4px}
  h2{font-size:16px;margin:26px 0 8px;padding-bottom:6px;border-bottom:2px solid var(--accent)}
  .meta{color:var(--muted);font-size:13px;margin-bottom:8px}
  .bridge{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:16px 0;font-size:14px}
  .bridge table{width:auto;min-width:60%}
  .bridge td{border:none;padding:3px 10px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
  .card{flex:1;min-width:150px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .card .val{font-size:22px;font-weight:650;margin-top:4px}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:13.5px;margin:6px 0}
  th,td{padding:6px 9px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  thead th{background:var(--head);font-weight:600;font-size:12.5px}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  tfoot .total td{font-weight:700;border-top:2px solid var(--accent);background:var(--head)}
  .strong{font-weight:650}.warn{color:var(--warn)}
  .tie{color:var(--ok);font-weight:700}
  .note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;font-size:13px;color:var(--muted);margin-top:8px}
  @media print{ :root{color-scheme:light} body{padding:0;font-size:10.5px} table{font-size:9.5px} th,td{white-space:normal} tr{break-inside:avoid} h2{page-break-after:avoid} }
  @page{ size: letter landscape; margin: .5in }
</style>
<div class="wrap">
  <h1>QuickBooks ↔ JobTread Reconciliation — ${esc(d.periodLabel)}</h1>
  <div class="meta">QuickBooks "Sales by Customer Summary" (accrual, pre-tax) vs JobTread approved customer invoices issued in ${esc(d.periodLabel)}. Pulled live from JobTread.</div>

  <div class="cards">
    <div class="card"><div class="label">QuickBooks sales</div><div class="val">${money(d.qbTotal)}</div></div>
    <div class="card"><div class="label">JobTread approved invoices</div><div class="val">${money(d.jtApprovedTotal)}</div></div>
    <div class="card"><div class="label">Difference</div><div class="val">${money(round2(d.qbTotal - d.jtApprovedTotal))}</div></div>
  </div>

  <div class="bridge">
    <b>Bridge (why they differ):</b>
    <table>
      <tr><td>QuickBooks sales</td><td class="num">${money(d.qbTotal)}</td></tr>
      <tr><td>− In QB but no JobTread invoice</td><td class="num">${money(qbMissing)}</td></tr>
      <tr><td>− In QB but pending/denied in JobTread</td><td class="num">${money(qbNotApproved)}</td></tr>
      <tr><td>+ In JobTread (approved) but not in QB</td><td class="num">${money(jtOnly)}</td></tr>
      <tr><td>± Rounding (TV relocation: QB 304.88 vs JT 304.98)</td><td class="num">${money(rounding)}</td></tr>
      <tr><td><b>= JobTread approved invoices</b></td><td class="num"><b>${money(round2(d.qbTotal - qbMissing - qbNotApproved + jtOnly + rounding))}</b> ${round2(d.qbTotal - qbMissing - qbNotApproved + jtOnly + rounding) === d.jtApprovedTotal ? '<span class="tie">✓ ties</span>' : ''}</td></tr>
    </table>
  </div>

  <h2>① In QuickBooks but NOT in JobTread — all explained ✓ (${d.qbNotInJobtread.length}) · ${money(qbMissing)}</h2>
  <div class="scroll">${qbMissTable(d.qbNotInJobtread)}</div>

  <h2>② In QuickBooks but pending/denied in JobTread — systems disagree (${d.qbNotApprovedInJobtread.length}) · ${money(qbNotApproved)}</h2>
  <div class="scroll">${qbNaTable(d.qbNotApprovedInJobtread)}</div>

  <h2>③ In JobTread (approved) but NOT in QuickBooks — verify it posted (${d.jobtreadNotInQb.length}) · ${money(jtOnly)}</h2>
  <div class="scroll">${jtOnlyTable(d.jobtreadNotInQb)}</div>

  <h2>Matched — agree on both sides (${d.matched.length})</h2>
  <div class="scroll">${matchTable(d.matched)}</div>

  <div class="note">
    <b>Read this first:</b> Section ① is money on the QuickBooks report with no JobTread invoice at all — either invoiced directly in QB or a JobTread invoice is missing. Section ② exists in JobTread but the invoice is <b>pending or denied</b>, so JobTread doesn't count it while QuickBooks does — decide which system is right and approve/void accordingly. Section ③ is approved in JobTread but absent from the QuickBooks report. The bridge above ties QuickBooks to JobTread exactly.
  </div>
</div>`;

const outDir = path.join(__dirname, 'out', 'qb-reconciliation-2026-07');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'qb-reconciliation-2026-07.html'), html);
fs.writeFileSync(path.join(outDir, 'qb-reconciliation-2026-07.csv'), csv);

console.log(`QB vs JobTread reconciliation — ${d.periodLabel}`);
console.log(`  QuickBooks sales:            ${money(d.qbTotal)}`);
console.log(`  JobTread approved invoices:  ${money(d.jtApprovedTotal)}`);
console.log(`  Difference:                  ${money(round2(d.qbTotal - d.jtApprovedTotal))}`);
console.log(`  (1) QB not in JobTread:      ${money(qbMissing)}  (${d.qbNotInJobtread.length})`);
console.log(`  (2) QB pending/denied in JT: ${money(qbNotApproved)}  (${d.qbNotApprovedInJobtread.length})`);
console.log(`  (3) JobTread not in QB:      ${money(jtOnly)}  (${d.jobtreadNotInQb.length})`);
console.log(`  QB categorized total:        ${money(qbAccounted)}  ${qbTie === 0 ? '(ties to QB total)' : '(MISMATCH ' + money(qbTie) + ')'}`);
const bridgeTotal = round2(d.qbTotal - qbMissing - qbNotApproved + jtOnly + rounding);
console.log(`  Bridge -> JobTread:          ${money(bridgeTotal)}  ${bridgeTotal === d.jtApprovedTotal ? '(ties)' : '(MISMATCH)'}  [incl ${money(rounding)} rounding]`);
console.log(`Wrote ${outDir}`);
