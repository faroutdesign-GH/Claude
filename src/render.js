'use strict';

const config = require('../config');

function money(n) {
  const v = typeof n === 'number' ? n : 0;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
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
function ymLabel(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// Flag → { label, color }
const FLAG_LABELS = {
  NO_TIME: { label: 'No time logged — fix time entries, no bonus', color: '#c0392b' },
  NO_BID: { label: 'No approved time on budget', color: '#c0392b' },
  NO_CLOSE_DATE: { label: 'No close date', color: '#c0392b' },
  UNAPPROVED_TIME: { label: 'Unapproved bid time excluded', color: '#6b7280' },
  WARRANTY_TIME: { label: 'Warranty time — deduction is manual', color: '#b8860b' },
  CHECK_LOW_ACTUAL: { label: 'Actual < 50% of bid — check unlogged time', color: '#b8860b' },
  DATA_TRUNCATED: { label: 'Data truncated — verify', color: '#c0392b' },
};
function flagChip(flag, small) {
  const f = FLAG_LABELS[flag] || { label: flag, color: '#777' };
  return `<span class="chip${small ? ' sm' : ''}" style="background:${f.color}">${esc(f.label)}</span>`;
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

function renderCsvFiles(report) {
  const files = [];
  const pc = config.productionCommission;

  // 1. Monthly summary per rep.
  {
    const headers = ['Month', 'Rep', 'PaidRevenue', 'SalesCommission', 'ProductionCommission', 'TotalCommission'];
    const rows = [];
    for (const mo of report.months) {
      for (const rep of report.reps) {
        const rev = mo.revenueByRep[rep] || 0;
        const sc = mo.salesCommissionByRep[rep] || 0;
        const prod = pc && rep === pc.rep ? mo.productionCommission : 0;
        if (rev === 0 && sc === 0 && prod === 0) continue;
        rows.push([ymLabel(report.year, mo.month), rep, rev, sc, prod, sc + prod]);
      }
    }
    files.push({ name: 'monthly-summary.csv', content: toCsv(headers, rows) });
  }

  // 2. Sales commission detail.
  {
    const headers = ['Month', 'JobNumber', 'Job', 'Rep', 'JobPrice', 'CommissionLine', 'CapRate', 'Cap', 'OverCap'];
    const rows = report.detail.salesCommission.map((d) => [
      ymLabel(report.year, d.month), d.number, d.name, d.rep, d.jobPrice, d.lineTotal,
      d.capRate == null ? '' : d.capRate, d.cap == null ? '' : d.cap, d.overCap ? 'YES' : '',
    ]);
    files.push({ name: 'sales-commission-detail.csv', content: toCsv(headers, rows) });
  }

  // 3. Production commission detail.
  {
    const headers = ['Month', 'Rep', 'Rate', 'JobsClosedAndPaid', 'BaseAmount', 'ProductionCommission'];
    const rows = report.detail.production
      .filter((d) => d.amount !== 0 || d.jobsCount !== 0)
      .map((d) => [ymLabel(report.year, d.month), pc.rep, pc.rate, d.jobsCount, d.base, d.amount]);
    files.push({ name: 'production-commission-detail.csv', content: toCsv(headers, rows) });
  }

  // 4. Efficiency bonus — payable hours per employee per month.
  {
    const headers = ['Month', 'Employee', 'BonusHours'];
    const rows = [];
    for (let m = 1; m <= 12; m++) {
      for (const emp of report.bonus.employees) {
        const hrs = report.bonus.byEmployeeMonth[emp][m - 1];
        if (!hrs) continue;
        rows.push([ymLabel(report.year, m), emp, hrs]);
      }
    }
    files.push({ name: 'efficiency-bonus-by-employee.csv', content: toCsv(headers, rows) });
  }

  // 5. Efficiency bonus — per job. Warranty deduction is recorded, not applied.
  {
    const headers = ['Month', 'JobNumber', 'Job', 'Closed', 'ApprovedBidHrs', 'UnapprovedBidHrsExcluded', 'ActualRegHrs', 'SavedHrs',
      'Multiplier', 'BonusHrs', 'WarrantyHrs', 'WarrantyDeductionIfApplied', 'Distribution', 'Flags'];
    const rows = report.bonus.jobs.map((j) => [
      j.month ? ymLabel(report.year, j.month) : '', j.number != null ? j.number : '', j.name, j.closedOn || '', j.bid, j.unapprovedHours || 0, j.regHours,
      j.saved, j.multiplier, j.bonusHours, j.warrHours, j.warrantyDeduction,
      Object.entries(j.distribution).map(([u, h]) => `${u}: ${h}`).join('; '),
      j.flags.map((f) => (FLAG_LABELS[f] ? FLAG_LABELS[f].label : f)).join('; '),
    ]);
    files.push({ name: 'efficiency-bonus-jobs.csv', content: toCsv(headers, rows) });
  }

  return files;
}

// ---- HTML ----------------------------------------------------------------

function monthlyTable(report) {
  const reps = report.reps;
  const head = `<tr><th>Month</th>${reps
    .map((r) => `<th class="num">${esc(r)}<br><span class="sub">paid rev</span></th>`)
    .join('')}<th class="num">Sales comm.</th><th class="num">Prod. comm.</th><th class="num">Bonus hrs</th></tr>`;

  const body = report.months
    .map((mo) => {
      const revCells = reps
        .map((r) => `<td class="num">${mo.revenueByRep[r] ? money(mo.revenueByRep[r]) : '<span class="z">–</span>'}</td>`)
        .join('');
      const bonusHrs = report.bonus.monthlyTotals[mo.month - 1];
      return `<tr><td>${esc(mo.name)}</td>${revCells}<td class="num">${
        mo.salesCommissionTotal ? money(mo.salesCommissionTotal) : '<span class="z">–</span>'
      }</td><td class="num">${
        mo.productionCommission ? money(mo.productionCommission) : '<span class="z">–</span>'
      }</td><td class="num">${bonusHrs ? hours(bonusHrs) : '<span class="z">–</span>'}</td></tr>`;
    })
    .join('');

  const totalRev = reps.map((r) => `<td class="num">${money(report.repTotals[r].revenue)}</td>`).join('');
  const foot = `<tr class="total"><td>Year total</td>${totalRev}<td class="num">${money(
    report.grand.salesCommission
  )}</td><td class="num">${money(report.grand.productionCommission)}</td><td class="num">${hours(
    report.grand.bonusHours
  )}</td></tr>`;

  return `<table><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

function repSummaryTable(report) {
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

function salesCommissionDetailTable(report) {
  if (report.detail.salesCommission.length === 0) return '<p class="empty">No sales-commission line items on jobs closed this year.</p>';
  const rows = report.detail.salesCommission
    .map((d) => {
      const flag = d.overCap ? `<span class="flag">over cap</span>` : '';
      return `<tr class="${d.overCap ? 'warn' : ''}"><td>${ymLabel(report.year, d.month)}</td><td>${esc(
        d.number
      )}</td><td>${esc(d.name)}</td><td>${esc(d.rep)}</td><td class="num">${
        d.jobPrice == null ? '<span class="z">n/a</span>' : money(d.jobPrice)
      }</td><td class="num">${money(d.lineTotal)}</td><td class="num">${
        d.cap == null ? '<span class="z">–</span>' : money(d.cap)
      } ${flag}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Month</th><th>Job #</th><th>Job</th><th>Rep</th><th class="num">Job price</th><th class="num">Commission line</th><th class="num">Cap (policy)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---- Efficiency bonus sections ------------------------------------------

function bonusPayrollCards(report) {
  const b = report.bonus;
  if (b.employees.length === 0) return '<p class="empty">No bonus hours earned this year.</p>';
  const cards = b.employees
    .filter((e) => b.employeeTotals[e] > 0)
    .sort((a, x) => b.employeeTotals[x] - b.employeeTotals[a])
    .map((e) => {
      const njobs = b.jobs.filter((j) => j.month && j.distribution[e]).length;
      return `<div class="pcard"><div class="pname">${esc(e)}</div><div class="phours">+${b.employeeTotals[e].toLocaleString(
        'en-US',
        { maximumFractionDigits: 3 }
      )} <span>hrs</span></div><div class="pjobs">${njobs} job(s)</div></div>`;
    })
    .join('');
  return `<div class="payroll">${cards || '<p class="empty">No payable bonus hours.</p>'}</div>`;
}

function bonusByMonthTable(report) {
  const b = report.bonus;
  const payable = b.employees.filter((e) => b.employeeTotals[e] > 0);
  if (payable.length === 0) return '';
  const head = `<tr><th>Month</th>${payable.map((e) => `<th class="num">${esc(e)}</th>`).join('')}<th class="num">Total</th></tr>`;
  const body = report.months
    .filter((mo) => b.monthlyTotals[mo.month - 1] > 0)
    .map((mo) => {
      const cells = payable
        .map((e) => {
          const v = b.byEmployeeMonth[e][mo.month - 1];
          return `<td class="num">${v ? hours(v) : '<span class="z">–</span>'}</td>`;
        })
        .join('');
      return `<tr><td>${esc(mo.name)}</td>${cells}<td class="num">${hours(b.monthlyTotals[mo.month - 1])}</td></tr>`;
    })
    .join('');
  const foot = `<tr class="total"><td>Year total</td>${payable
    .map((e) => `<td class="num">${hours(b.employeeTotals[e])}</td>`)
    .join('')}<td class="num">${hours(b.grandHours)}</td></tr>`;
  return `<table><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

function bonusReviewTable(report) {
  const review = report.bonus.review;
  if (review.length === 0) return '<p class="empty">No anomalies flagged — all qualifying jobs look clean.</p>';
  const rows = review
    .map(
      (j) =>
        `<tr><td class="num">${esc(j.number != null ? j.number : '—')}</td><td>${esc(j.name)}</td><td>${esc(j.closedOn || '—')}</td><td class="num">${j.bid}</td><td class="num">${j.regHours}</td><td>${j.flags
          .map((f) => flagChip(f, false))
          .join(' ')}</td></tr>`
    )
    .join('');
  return `<table><thead><tr><th class="num">Job #</th><th>Job</th><th>Closed</th><th class="num">Bid</th><th class="num">Actual</th><th>Flag</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function bonusAllJobsTable(report) {
  const jobs = report.bonus.jobs;
  if (jobs.length === 0) return '<p class="empty">No qualifying (Project Awarded, closed) jobs this year.</p>';
  const rows = jobs
    .map((j) => {
      const dist =
        Object.entries(j.distribution)
          .sort((a, b) => b[1] - a[1])
          .map(([u, h]) => `${esc(u)}: +${h}`)
          .join('<br>') || '—';
      const chips = j.flags.length ? `<div class="fl">${j.flags.map((f) => flagChip(f, true)).join(' ')}</div>` : '';
      const payable = j.bonusHours > 0 && Object.keys(j.distribution).length > 0;
      const warrCell = j.warrHours > 0
        ? `${j.warrHours.toFixed(2)} <span class="sub">(−${j.warrantyDeduction.toFixed(2)} if applied)</span>`
        : '<span class="z">–</span>';
      const bidCell = `${j.bid.toFixed(2)}${
        j.unapprovedHours > 0 ? ` <span class="sub">(+${j.unapprovedHours.toFixed(2)} unappr.)</span>` : ''
      }`;
      return `<tr><td class="num">${esc(j.number != null ? j.number : '-')}</td><td class="jn">${esc(j.name)}${chips}</td><td>${esc(j.closedOn || '—')}</td><td class="num">${bidCell}</td><td class="num">${j.regHours.toFixed(2)}</td><td class="num ${j.saved > 0 ? 'pos' : 'neg'}">${
        j.saved >= 0 ? '+' : ''
      }${j.saved.toFixed(2)}</td><td class="num">${j.bonusHours > 0 ? 'x' + j.multiplier : '—'}</td><td class="num" style="font-weight:700">${
        payable ? '<span class="pos">+' + j.bonusHours.toFixed(3) + '</span>' : '<span class="z">not payable</span>'
      }</td><td class="num warr">${warrCell}</td><td class="dist">${dist}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th class="num">Job #</th><th>Job</th><th>Closed</th><th class="num">Approved bid</th><th class="num">Actual</th><th class="num">Saved</th><th class="num">Mult</th><th class="num">Bonus hrs</th><th class="num">Warranty (manual)</th><th>Distribution</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHtml(report) {
  const pc = config.productionCommission;
  const eb = config.efficiencyBonus;
  const overCapCount = report.detail.salesCommission.filter((d) => d.overCap).length;
  const reviewCount = report.bonus.review.length;

  const notes = [
    `<b>Sales / revenue</b> is money actually collected — payments applied to customer invoices, bucketed by payment date.`,
    `<b>Sales commission</b> is the actual amount on each job's "Salesman Commission" budget line, recognized in the month the job is marked <i>closed</i>. The policy cap (Ben 5% &lt;$10k / 7% ≥$10k, Derek 5%) is shown for reference; lines over cap are flagged.`,
    `<b>Production commission</b> is ${pc.rate * 100}% for ${esc(pc.rep)}, on the ${
      pc.scope === 'own' ? `${esc(pc.rep)}'s` : 'total'
    } price of jobs closed <i>and fully paid</i> each month (paid the following month).`,
    `<b>Efficiency bonus hours</b> — for jobs "Project Awarded" and closed in the month: approved bid time from the <b>job budget only</b> (Labor lines, plus Travel lines in Hours) minus regular clocked hours = hours saved. ${eb.multiplier.boostOverSaved} hrs or less saved pays ×${eb.multiplier.standard}; over ${eb.multiplier.boostOverSaved} hrs pays ×${eb.multiplier.boosted}. Bonus is split across everyone who logged regular time, by share of hours (group bonus, group loss), and paid as <b>hours</b> at each person's own wage.`,
    `<b>Warranty time</b> (clocked after the close date) is <b>recorded, not deducted</b> — the ×${eb.warranty.rate} deduction is shown per job and applied manually by ownership only when the follow-up was due to negligence.`,
  ];

  return `<title>Far Out Design — Sales, Commission &amp; Bonus Report ${report.year}</title>
<style>
  :root{
    --bg:#ffffff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa;
    --accent:#0f766e; --warn-bg:#fef2f2; --warn-fg:#b91c1c; --z:#c4c9d0; --card:#f9fafb; --pos:#1a7a3c;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126;
      --accent:#2dd4bf; --warn-bg:#3a1e1e; --warn-fg:#fca5a5; --z:#4b525b; --card:#1a1e23; --pos:#34d399; }
  }
  :root[data-theme="light"]{ --bg:#ffffff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn-bg:#fef2f2; --warn-fg:#b91c1c; --z:#c4c9d0; --card:#f9fafb; --pos:#1a7a3c; }
  :root[data-theme="dark"]{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn-bg:#3a1e1e; --warn-fg:#fca5a5; --z:#4b525b; --card:#1a1e23; --pos:#34d399; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px}
  .wrap{max-width:1150px;margin:0 auto}
  h1{font-size:24px;margin:0 0 4px}
  h2{font-size:17px;margin:34px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--accent)}
  .meta{color:var(--muted);font-size:13px;margin-bottom:8px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}
  .card{flex:1;min-width:170px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .card .val{font-size:22px;font-weight:650;margin-top:4px}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:14px;margin:6px 0}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}
  thead th{background:var(--head);font-weight:600;font-size:13px}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  tfoot .total td{font-weight:700;border-top:2px solid var(--accent);background:var(--head)}
  .strong{font-weight:650}
  .sub{color:var(--muted);font-weight:400;font-size:11px}
  .z{color:var(--z)}
  .pos{color:var(--pos)}.neg{color:var(--warn-fg)}
  td.warr{color:#b8860b}
  td.jn{font-weight:600;max-width:250px;white-space:normal}
  td.dist{font-size:12px;color:var(--muted)}
  tr.warn{background:var(--warn-bg)}
  .flag{display:inline-block;background:var(--warn-fg);color:#fff;font-size:11px;padding:1px 6px;border-radius:6px;margin-left:4px}
  .chip{display:inline-block;color:#fff;font-size:10px;padding:2px 7px;border-radius:10px;margin:1px 0}
  .chip.sm{font-size:9px;padding:1px 6px}
  .fl{margin-top:4px}
  .payroll{display:flex;flex-wrap:wrap;gap:12px}
  .pcard{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;min-width:160px}
  .pname{font-weight:600;font-size:15px}
  .phours{font-size:26px;font-weight:700;color:var(--pos);margin-top:6px}
  .phours span{font-size:13px;color:var(--muted);font-weight:400}
  .pjobs{font-size:12px;color:var(--muted);margin-top:2px}
  .notes{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;font-size:13px}
  .notes li{margin:6px 0}
  .empty{color:var(--muted);font-style:italic}
  .alert{background:var(--warn-bg);color:var(--warn-fg);border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}
</style>
<div class="wrap">
  <h1>Far Out Design — Sales, Commission &amp; Bonus Report</h1>
  <div class="meta">Calendar year ${report.year} · generated ${esc(report.generatedAt)} · timezone ${esc(config.timeZone)}</div>

  <div class="cards">
    <div class="card"><div class="label">Paid revenue</div><div class="val">${money(report.grand.revenue)}</div></div>
    <div class="card"><div class="label">Sales commission</div><div class="val">${money(report.grand.salesCommission)}</div></div>
    <div class="card"><div class="label">Production commission</div><div class="val">${money(report.grand.productionCommission)}</div></div>
    <div class="card"><div class="label">Efficiency bonus hours</div><div class="val">${hours(report.grand.bonusHours)}</div></div>
  </div>

  ${overCapCount > 0 ? `<div class="alert">⚠ ${overCapCount} job${overCapCount === 1 ? '' : 's'} have a sales-commission line above the policy cap — see the sales-commission table.</div>` : ''}
  ${report.openSalesCommission > 0 ? `<div class="alert">ℹ ${money(report.openSalesCommission)} of sales-commission lines sit on jobs not yet closed (or closed outside ${report.year}); excluded from monthly totals.</div>` : ''}
  ${reviewCount > 0 ? `<div class="alert">⚠ ${reviewCount} qualifying job${reviewCount === 1 ? '' : 's'} flagged for review before paying efficiency bonuses — see "Efficiency bonus — jobs to review".</div>` : ''}

  <h2>Per-rep totals (commission)</h2>
  <div class="scroll">${repSummaryTable(report)}</div>

  <h2>Monthly breakdown</h2>
  <div class="scroll">${monthlyTable(report)}</div>

  <h2>Efficiency bonus — payable hours by technician</h2>
  ${bonusPayrollCards(report)}
  <div class="scroll">${bonusByMonthTable(report)}</div>

  <h2>Efficiency bonus — jobs to review (${reviewCount})</h2>
  <div class="scroll">${bonusReviewTable(report)}</div>

  <h2>Efficiency bonus — all qualifying jobs (${report.bonus.qualifyingCount})</h2>
  <div class="scroll">${bonusAllJobsTable(report)}</div>

  <h2>Sales-commission line items (jobs closed in ${report.year})</h2>
  <div class="scroll">${salesCommissionDetailTable(report)}</div>

  <h2>How these numbers are built</h2>
  <ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>
</div>`;
}

/**
 * Technician-only report: the Efficiency Bonus Program with NO sales,
 * revenue, or commission content — field technician work hours only.
 * `periodLabel` names the period on the page (e.g. "June 2026").
 */
function renderBonusHtml(report, periodLabel) {
  const eb = config.efficiencyBonus;
  const reviewCount = report.bonus.review.length;
  const payableJobs = report.bonus.jobs.filter((j) => j.bonusHours > 0 && Object.keys(j.distribution).length > 0).length;

  const notes = [
    `<b>Scoring is per JOB NUMBER</b>: the job's total approved time vs the job's total consumed time. Individual line items or change orders may win or lose — only the whole job's result counts.`,
    `<b>Approved bid time</b> comes from the job budget only — Labor lines plus hour-denominated Travel lines that are bonded to an approved document. Unapproved lines (draft/denied estimates) are excluded and shown for reference.`,
    `<b>Saved</b> = approved − consumed (regular time on/before the close date). ${eb.multiplier.boostOverSaved} hrs or less saved pays ×${eb.multiplier.standard}; over ${eb.multiplier.boostOverSaved} hrs pays ×${eb.multiplier.boosted}. Hours are split across everyone who logged regular time, by share of hours (group bonus, group loss), and paid at each technician's own wage.`,
    `<b>Approved jobs with no consumed time earn nothing</b> — that means the time was logged incorrectly; fix the time entries and re-run.`,
    `<b>Warranty time</b> (after the close date) is recorded at ×${eb.warranty.rate} as its own line and deducted <i>manually</i> by ownership only when the follow-up was due to negligence.`,
  ];

  return `<title>Technician Efficiency Bonus — ${esc(periodLabel)}</title>
<style>
  :root{
    --bg:#ffffff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa;
    --accent:#0f766e; --warn-bg:#fef2f2; --warn-fg:#b91c1c; --z:#c4c9d0; --card:#f9fafb; --pos:#1a7a3c;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126;
      --accent:#2dd4bf; --warn-bg:#3a1e1e; --warn-fg:#fca5a5; --z:#4b525b; --card:#1a1e23; --pos:#34d399; }
  }
  :root[data-theme="light"]{ --bg:#ffffff; --fg:#1a1d21; --muted:#6b7280; --line:#e5e7eb; --head:#f7f8fa; --accent:#0f766e; --warn-bg:#fef2f2; --warn-fg:#b91c1c; --z:#c4c9d0; --card:#f9fafb; --pos:#1a7a3c; }
  :root[data-theme="dark"]{ --bg:#14171a; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f36; --head:#1c2126; --accent:#2dd4bf; --warn-bg:#3a1e1e; --warn-fg:#fca5a5; --z:#4b525b; --card:#1a1e23; --pos:#34d399; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px}
  .wrap{max-width:1150px;margin:0 auto}
  h1{font-size:24px;margin:0 0 4px}
  h2{font-size:17px;margin:34px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--accent)}
  .meta{color:var(--muted);font-size:13px;margin-bottom:8px}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:14px;margin:6px 0}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}
  thead th{background:var(--head);font-weight:600;font-size:13px}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  tfoot .total td{font-weight:700;border-top:2px solid var(--accent);background:var(--head)}
  .sub{color:var(--muted);font-weight:400;font-size:11px}
  .z{color:var(--z)}
  .pos{color:var(--pos)}.neg{color:var(--warn-fg)}
  td.warr{color:#b8860b}
  td.jn{font-weight:600;max-width:250px;white-space:normal}
  td.dist{font-size:12px;color:var(--muted)}
  .chip{display:inline-block;color:#fff;font-size:10px;padding:2px 7px;border-radius:10px;margin:1px 0}
  .chip.sm{font-size:9px;padding:1px 6px}
  .fl{margin-top:4px}
  .payroll{display:flex;flex-wrap:wrap;gap:12px}
  .pcard{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;min-width:170px}
  .pname{font-weight:600;font-size:15px}
  .phours{font-size:28px;font-weight:700;color:var(--pos);margin-top:6px}
  .phours span{font-size:13px;color:var(--muted);font-weight:400}
  .pjobs{font-size:12px;color:var(--muted);margin-top:2px}
  .notes{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;font-size:13px}
  .notes li{margin:6px 0}
  .empty{color:var(--muted);font-style:italic}
  .alert{background:var(--warn-bg);color:var(--warn-fg);border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}
  .pool{margin-top:10px;font-size:13px;color:var(--muted)}
</style>
<div class="wrap">
  <h1>Technician Efficiency Bonus — ${esc(periodLabel)}</h1>
  <div class="meta">Far Out Design inc · generated ${esc(report.generatedAt)} · data pulled live from JobTread · timezone ${esc(config.timeZone)}</div>

  ${reviewCount > 0 ? `<div class="alert">⚠ ${reviewCount} job${reviewCount === 1 ? '' : 's'} flagged — review before paying (see "Jobs to review").</div>` : ''}

  <h2>Payroll summary — pay these hours (× each technician's wage)</h2>
  ${bonusPayrollCards(report)}
  <div class="pool">Total bonus pool: <b>${hours(report.grand.bonusHours)}</b> across ${payableJobs} paying job(s) of ${report.bonus.qualifyingCount} qualifying. Warranty recorded (manual deduction): <b>${report.bonus.warrantyDeductionTotal} hrs</b>.</div>

  <h2>Jobs to review (${reviewCount})</h2>
  <div class="scroll">${bonusReviewTable(report)}</div>

  <h2>All qualifying jobs (${report.bonus.qualifyingCount})</h2>
  <div class="scroll">${bonusAllJobsTable(report)}</div>

  <h2>Program rules</h2>
  <ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>
</div>`;
}

module.exports = { renderHtml, renderBonusHtml, renderCsvFiles, toCsv, money, hours };
