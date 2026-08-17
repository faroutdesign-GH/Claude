#!/usr/bin/env node
'use strict';

/**
 * Cash-basis July sales (QuickBooks) — reproduces the QB cash report with
 * refund/reimbursement flags and shows the 2% production-commission base under
 * each candidate basis (cash / accrual / closed-and-paid).
 *
 * Usage: node cash-sales-report.js --data=data/july-2026-cash-sales.json
 */
const fs = require('fs');
const path = require('path');
const dataArg = (process.argv.slice(2).find((a) => a.startsWith('--data=')) || '').split('=')[1];
if (!dataArg) { console.error('Usage: node cash-sales-report.js --data=<file.json>'); process.exit(1); }
const d = JSON.parse(fs.readFileSync(path.resolve(dataArg), 'utf8'));
const rate = d.rate;
const money = (n) => (typeof n === 'number' ? n : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const isReimb = (desc) => /reimbursement/i.test(desc);
let total = 0, refunds = 0, reimb = 0;
for (const [, desc, amt] of d.lines) { total += amt; if (amt < 0) refunds += amt; if (isReimb(desc)) reimb += amt; }
total = r2(total);
const cashNetReimb = r2(total - reimb);
const commCash = r2(total * rate);
const commNetReimb = r2(cashNetReimb * rate);

const rows = d.lines.map(([c, desc, amt]) => {
  const flag = amt < 0 ? 'refund' : isReimb(desc) ? 'reimbursement' : '';
  return `<tr class="${amt < 0 ? 'neg' : ''}"><td>${esc(c)}</td><td>${esc(desc)}</td><td class="num">${money(amt)}</td><td>${flag ? `<span class="warn">${flag}</span>` : ''}</td></tr>`;
}).join('');

const csv = [['Customer', 'Description', 'Amount', 'Flag'],
  ...d.lines.map(([c, desc, amt]) => [c, desc, amt, amt < 0 ? 'refund' : isReimb(desc) ? 'reimbursement' : ''])]
  .map((r) => r.map((v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n') + '\n';

const html = `<title>July 2026 Cash Sales &amp; 2% Basis</title>
<style>
  :root{ --bg:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn:#b45309; --bad:#b91c1c; --z:#c4c9d0; --card:#f9fafb; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn:#fbbf24; --bad:#fca5a5; --z:#4b525b; --card:#1a1e23; } }
  :root[data-theme="light"]{ --bg:#fff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn:#b45309; --bad:#b91c1c; --z:#c4c9d0; --card:#f9fafb; }
  :root[data-theme="dark"]{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn:#fbbf24; --bad:#fca5a5; --z:#4b525b; --card:#1a1e23; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px}
  .wrap{max-width:940px;margin:0 auto} h1{font-size:23px;margin:0 0 4px} h2{font-size:16px;margin:26px 0 8px;padding-bottom:6px;border-bottom:2px solid var(--accent)}
  .meta{color:var(--muted);font-size:13px;margin-bottom:8px}
  table{border-collapse:collapse;width:100%;font-size:13.5px;margin:6px 0} th,td{padding:6px 9px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  thead th{background:var(--head);font-weight:600;font-size:12.5px} .num{text-align:right;font-variant-numeric:tabular-nums}
  tfoot .total td{font-weight:700;border-top:2px solid var(--accent);background:var(--head)}
  .warn{color:var(--warn);font-size:12px} tr.neg td{color:var(--bad)}
  .basis{width:100%;font-size:14px;margin:6px 0} .basis td{padding:6px 9px;border-bottom:1px solid var(--line)} .basis .rec{background:var(--head);font-weight:650}
  .note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;font-size:13px;color:var(--muted);margin-top:10px}
  @media print{ :root{color-scheme:light} body{padding:0;font-size:10.5px} table{font-size:9.5px} th,td{white-space:normal} tr{break-inside:avoid} } @page{ size: letter portrait; margin: .5in }
</style>
<div class="wrap">
  <h1>July 2026 — Cash Sales &amp; 2% Production-Commission Basis</h1>
  <div class="meta">QuickBooks "Sales by Customer Summary" <b>cash basis</b> (cash collected in July). For deciding Derek's 2% production-commission base.</div>

  <h2>What 2% would be, by basis</h2>
  <table class="basis">
    <tr><td>Cash collected in July (this report)</td><td class="num">${money(total)}</td><td class="num">2% = <b>${money(commCash)}</b></td></tr>
    <tr class="rec"><td>Cash, excluding the ${money(reimb)} Qmerit reimbursement</td><td class="num">${money(cashNetReimb)}</td><td class="num">2% = <b>${money(commNetReimb)}</b> &nbsp;← suggested</td></tr>
    <tr><td>Accrual — invoiced in July</td><td class="num">${money(d.accrualTotal)}</td><td class="num">2% = ${money(r2(d.accrualTotal * rate))}</td></tr>
    <tr><td>Jobs closed AND paid in July (JobTread)</td><td class="num">${money(d.closedAndPaidTotal)}</td><td class="num">2% = ${money(r2(d.closedAndPaidTotal * rate))}</td></tr>
  </table>
  <div class="note">Refund/reversal lines total <b>${money(refunds)}</b> (incl. ACS Tampa ${money(-3873.62)} and Dale Schooley ${money(-304.03)}) and are left in as reductions to net cash. The Qmerit "Anissa Westfall" ${money(reimb)} line is a reimbursement (not a sale) and is excluded in the suggested row.</div>

  <h2>Cash-basis lines (${d.lines.length}) — ties to QB total ${money(total)}</h2>
  <table><thead><tr><th>Customer</th><th>Description</th><th class="num">Amount</th><th>Flag</th></tr></thead>
  <tbody>${rows}</tbody><tfoot><tr class="total"><td>TOTAL</td><td></td><td class="num">${money(total)}</td><td></td></tr></tfoot></table>

  <div class="note"><b>Why the bases differ:</b> cash basis counts money <i>collected</i> in July (including collections on jobs closed in earlier months, deposits, and EV/Qmerit jobs), so it's much larger than "jobs closed <i>and</i> paid in July." Pick the basis that matches how Derek's 2% is meant to be earned, and I'll finalize the payout on that basis.</div>
</div>`;

const outDir = path.join(__dirname, 'out', 'cash-sales-2026-07');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'cash-sales-2026-07.html'), html);
fs.writeFileSync(path.join(outDir, 'cash-sales-2026-07.csv'), csv);
console.log(`Cash sales July 2026: total ${money(total)} ${total === d.qbTotal ? '(ties to QB)' : '(CHECK vs ' + money(d.qbTotal) + ')'}`);
console.log(`  2% of cash: ${money(commCash)} | 2% ex reimbursement: ${money(commNetReimb)}`);
console.log(`  refunds ${money(refunds)}, reimbursement ${money(reimb)}`);
console.log(`Wrote ${outDir}`);
