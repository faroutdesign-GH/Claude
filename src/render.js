'use strict';

const config = require('../config');

function money(n) {
  const v = typeof n === 'number' ? n : 0;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function num(n, digits = 1) {
  const v = typeof n === 'number' ? n : 0;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function hours(n) {
  const v = typeof n === 'number' ? n : 0;
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} hrs`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- CSV -----------------------------------------------------------------

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

/**
 * Build the set of CSV files for a report.
 * @returns {Array<{name:string, content:string}>}
 */
function renderCsvFiles(report) {
  const files = [];
  const pc = config.productionCommission;

  // 1. Monthly summary: one row per month per rep + totals.
  {
    const headers = ['Month', 'Rep', 'PaidRevenue', 'SalesCommission', 'ProductionCommission', 'TotalCommission'];
    const rows = [];
    for (const mo of report.months) {
      for (const rep of report.reps) {
        const rev = mo.revenueByRep[rep] || 0;
        const sc = mo.salesCommissionByRep[rep] || 0;
        const prod = pc && rep === pc.rep ? mo.productionCommission : 0;
        if (rev === 0 && sc === 0 && prod === 0) continue;
        rows.push([`${report.year}-${String(mo.month).padStart(2, '0')}`, rep, rev, sc, prod, sc + prod]);
      }
    }
    files.push({ name: 'monthly-summary.csv', content: toCsv(headers, rows) });
  }

  // 2. Sales commission detail (per job).
  {
    const headers = ['Month', 'JobNumber', 'Job', 'Rep', 'JobPrice', 'CommissionLine', 'CapRate', 'Cap', 'OverCap'];
    const rows = report.detail.salesCommission.map((d) => [
      `${report.year}-${String(d.month).padStart(2, '0')}`,
      d.number, d.name, d.rep, d.jobPrice, d.lineTotal,
      d.capRate == null ? '' : d.capRate, d.cap == null ? '' : d.cap, d.overCap ? 'YES' : '',
    ]);
    files.push({ name: 'sales-commission-detail.csv', content: toCsv(headers, rows) });
  }

  // 3. Production commission detail (per month).
  {
    const headers = ['Month', 'Rep', 'Rate', 'JobsClosed', 'BaseAmount', 'ProductionCommission'];
    const rows = report.detail.production
      .filter((d) => d.amount !== 0 || d.jobsCount !== 0)
      .map((d) => [
        `${report.year}-${String(d.month).padStart(2, '0')}`,
        pc.rep, pc.rate, d.jobsCount, d.base, d.amount,
      ]);
    files.push({ name: 'production-commission-detail.csv', content: toCsv(headers, rows) });
  }

  // 4. Technician bonus-hours detail.
  {
    const headers = ['Month', 'JobNumber', 'Job', 'Technician', 'BidPersonHours', 'ActualHours', 'BonusHours', 'Multiplier', 'PayableBonusHours'];
    const rows = report.detail.bonus.map((d) => [
      `${report.year}-${String(d.month).padStart(2, '0')}`,
      d.number, d.name, d.tech, d.bidPersonHours, d.actualHours, d.bonusHours, d.multiplier, d.payableHours,
    ]);
    files.push({ name: 'bonus-hours-detail.csv', content: toCsv(headers, rows) });
  }

  return files;
}

// ---- HTML ----------------------------------------------------------------

function repColumns(report) {
  return report.reps;
}

function monthlyTable(report) {
  const reps = repColumns(report);
  const pc = config.productionCommission;
  const head = `<tr><th>Month</th>${reps
    .map((r) => `<th class="num">${esc(r)}<br><span class="sub">paid rev</span></th>`)
    .join('')}<th class="num">Sales comm.</th><th class="num">Prod. comm.</th><th class="num">Bonus hrs</th></tr>`;

  const body = report.months
    .map((mo) => {
      const revCells = reps
        .map((r) => `<td class="num">${mo.revenueByRep[r] ? money(mo.revenueByRep[r]) : '<span class="z">–</span>'}</td>`)
        .join('');
      return `<tr><td>${esc(mo.name)}</td>${revCells}<td class="num">${
        mo.salesCommissionTotal ? money(mo.salesCommissionTotal) : '<span class="z">–</span>'
      }</td><td class="num">${
        mo.productionCommission ? money(mo.productionCommission) : '<span class="z">–</span>'
      }</td><td class="num">${mo.bonusHoursTotal ? hours(mo.bonusHoursTotal) : '<span class="z">–</span>'}</td></tr>`;
    })
    .join('');

  const totalRev = reps
    .map((r) => `<td class="num">${money(report.repTotals[r].revenue)}</td>`)
    .join('');
  const foot = `<tr class="total"><td>Year total</td>${totalRev}<td class="num">${money(
    report.grand.salesCommission
  )}</td><td class="num">${money(report.grand.productionCommission)}</td><td class="num">${hours(
    report.grand.bonusHours
  )}</td></tr>`;

  return `<table><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

function repSummaryTable(report) {
  const pc = config.productionCommission;
  const rows = report.reps
    .map((rep) => {
      const t = report.repTotals[rep];
      return `<tr><td>${esc(rep)}</td><td class="num">${money(t.revenue)}</td><td class="num">${money(
        t.salesCommission
      )}</td><td class="num">${t.productionCommission ? money(t.productionCommission) : '<span class="z">–</span>'}</td><td class="num strong">${money(
        t.totalCommission
      )}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Sales rep</th><th class="num">Paid revenue</th><th class="num">Sales commission</th><th class="num">Production commission</th><th class="num">Total commission</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function techBonusTable(report) {
  if (report.techs.length === 0) {
    return '<p class="empty">No technician bonus hours recorded for closed jobs this year.</p>';
  }
  const head = `<tr><th>Month</th>${report.techs.map((t) => `<th class="num">${esc(t)}</th>`).join('')}<th class="num">Total</th></tr>`;
  const body = report.months
    .filter((mo) => mo.bonusHoursTotal > 0)
    .map((mo) => {
      const cells = report.techs
        .map((t) => `<td class="num">${mo.bonusHoursByTech[t] ? hours(mo.bonusHoursByTech[t]) : '<span class="z">–</span>'}</td>`)
        .join('');
      return `<tr><td>${esc(mo.name)}</td>${cells}<td class="num">${hours(mo.bonusHoursTotal)}</td></tr>`;
    })
    .join('');
  const foot = `<tr class="total"><td>Year total</td>${report.techs
    .map((t) => `<td class="num">${hours(report.techTotals[t])}</td>`)
    .join('')}<td class="num">${hours(report.grand.bonusHours)}</td></tr>`;
  return `<table><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

function salesCommissionDetailTable(report) {
  if (report.detail.salesCommission.length === 0) return '<p class="empty">No sales-commission line items on jobs closed this year.</p>';
  const rows = report.detail.salesCommission
    .map((d) => {
      const flag = d.overCap
        ? `<span class="flag">over cap</span>`
        : '';
      return `<tr class="${d.overCap ? 'warn' : ''}"><td>${report.year}-${String(d.month).padStart(2, '0')}</td><td>${esc(
        d.number
      )}</td><td>${esc(d.name)}</td><td>${esc(d.rep)}</td><td class="num">${d.jobPrice == null ? '<span class="z">n/a</span>' : money(d.jobPrice)}</td><td class="num">${money(
        d.lineTotal
      )}</td><td class="num">${d.cap == null ? '<span class="z">–</span>' : money(d.cap)} ${flag}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Month</th><th>Job #</th><th>Job</th><th>Rep</th><th class="num">Job price</th><th class="num">Commission line</th><th class="num">Cap (policy)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHtml(report) {
  const pc = config.productionCommission;
  const overCapCount = report.detail.salesCommission.filter((d) => d.overCap).length;

  const notes = [
    `<b>Sales / revenue</b> is money actually collected — payments applied to customer invoices, bucketed by payment date.`,
    `<b>Sales commission</b> is the actual amount on each job's "Salesman Commission" budget line, recognized in the month the job is marked <i>closed</i>. The policy cap (Ben ${'5% <$10k / 7% ≥$10k'}, Derek 5%) is shown for reference; lines over cap are flagged.`,
    `<b>Production commission</b> is ${pc.rate * 100}% for ${esc(pc.rep)}, computed on the ${
      pc.scope === 'own' ? `${esc(pc.rep)}'s` : 'total'
    } price of jobs that are closed <i>and fully paid</i> each month (paid out the following month).`,
    `<b>Technician bonus hours</b> = unused labor hours (bid − clocked) on closed jobs, counted at ${config.bonusHours.multiplier}× when a job's bonus exceeds ${config.bonusHours.thresholdHours} hrs (otherwise ${config.bonusHours.baseMultiplier}×), split across the technicians who worked the job. These are <b>hours</b> — multiply by each technician's wage in payroll.`,
  ];

  return `<title>Far Out Design — Sales & Commission Report ${report.year}</title>
<style>
  :root{
    --bg:#ffffff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa;
    --accent:#0f766e; --warn-bg:#fef2f2; --warn-fg:#b91c1c; --z:#c4c9d0; --card:#f9fafb;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126;
      --accent:#2dd4bf; --warn-bg:#3a1e1e; --warn-fg:#fca5a5; --z:#4b525b; --card:#1a1e23; }
  }
  :root[data-theme="light"]{ --bg:#ffffff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn-bg:#fef2f2; --warn-fg:#b91c1c; --z:#c4c9d0; --card:#f9fafb; }
  :root[data-theme="dark"]{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn-bg:#3a1e1e; --warn-fg:#fca5a5; --z:#4b525b; --card:#1a1e23; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px}
  .wrap{max-width:1100px;margin:0 auto}
  h1{font-size:24px;margin:0 0 4px}
  h2{font-size:17px;margin:36px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--accent)}
  .meta{color:var(--muted);font-size:13px;margin-bottom:8px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}
  .card{flex:1;min-width:170px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .card .val{font-size:22px;font-weight:650;margin-top:4px}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:14px;margin:6px 0}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  thead th{background:var(--head);font-weight:600;font-size:13px;vertical-align:bottom}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  tfoot .total td{font-weight:700;border-top:2px solid var(--accent);background:var(--head)}
  .strong{font-weight:650}
  .sub{color:var(--muted);font-weight:400;font-size:11px}
  .z{color:var(--z)}
  tr.warn{background:var(--warn-bg)}
  .flag{display:inline-block;background:var(--warn-fg);color:#fff;font-size:11px;padding:1px 6px;border-radius:6px;margin-left:4px}
  .notes{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;font-size:13px;color:var(--fg)}
  .notes li{margin:6px 0}
  .empty{color:var(--muted);font-style:italic}
  .alert{background:var(--warn-bg);color:var(--warn-fg);border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}
</style>
<div class="wrap">
  <h1>Far Out Design — Sales &amp; Commission Report</h1>
  <div class="meta">Calendar year ${report.year} · generated ${esc(report.generatedAt)} · timezone ${esc(config.timeZone)}</div>

  <div class="cards">
    <div class="card"><div class="label">Paid revenue</div><div class="val">${money(report.grand.revenue)}</div></div>
    <div class="card"><div class="label">Sales commission</div><div class="val">${money(report.grand.salesCommission)}</div></div>
    <div class="card"><div class="label">Production commission</div><div class="val">${money(report.grand.productionCommission)}</div></div>
    <div class="card"><div class="label">Technician bonus hours</div><div class="val">${hours(report.grand.bonusHours)}</div></div>
  </div>

  ${overCapCount > 0 ? `<div class="alert">⚠ ${overCapCount} job${overCapCount === 1 ? '' : 's'} have a sales-commission line above the policy cap — see the detail table below.</div>` : ''}
  ${report.openSalesCommission > 0 ? `<div class="alert">ℹ ${money(report.openSalesCommission)} of sales-commission lines sit on jobs not yet marked closed (or closed outside ${report.year}); they are excluded from the monthly totals above.</div>` : ''}

  <h2>Per-rep totals</h2>
  <div class="scroll">${repSummaryTable(report)}</div>

  <h2>Monthly breakdown</h2>
  <div class="scroll">${monthlyTable(report)}</div>

  <h2>Technician bonus hours</h2>
  <div class="scroll">${techBonusTable(report)}</div>

  <h2>Sales-commission line items (jobs closed in ${report.year})</h2>
  <div class="scroll">${salesCommissionDetailTable(report)}</div>

  <h2>How these numbers are built</h2>
  <ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>
</div>`;
}

module.exports = { renderHtml, renderCsvFiles, toCsv, money };
