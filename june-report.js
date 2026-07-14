#!/usr/bin/env node
'use strict';

/**
 * June 2026 commission report driver.
 *
 * Runs the tested report engine (src/compute.js + src/render.js) against a
 * snapshot of JobTread data pulled live on 2026-07-14 (data/june-2026-data.json).
 *
 * Data-prep decisions (documented in the output):
 *  - Collected revenue = invoice amountPaid on jobs closed in June, attributed
 *    to the close month. (JobTread has almost no payment-date records — most
 *    invoices are marked paid via the QBO sync without a payment entity.)
 *  - Job price = projectedPrice, falling back to the job's invoiced pre-tax
 *    total when the budget has no price (common on service calls).
 *  - PAYABLE sales commission = lines on closed jobs that are Project Awarded
 *    or have collected money. Commission lines sitting on lost/not-proceeding
 *    closed jobs are listed separately as NOT payable.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { buildReport } = require('./src/compute');
const { renderHtml, renderBonusHtml, renderCsvFiles, toCsv, money, hours } = require('./src/render');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/june-2026-data.json'), 'utf8'));
// Efficiency-bonus source data (re-pulled 2026-07-14 after rule corrections:
// bid = job-budget approved time only; budget Labor lines + Travel lines in Hours).
const bonusData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data/june-2026-bonus-data.json'), 'utf8')
);
const EPS = 0.005;

// ---- Jobs map with price fallback -----------------------------------------
const invoiceAgg = new Map(); // jobId -> {pre, withTax, paid}
for (const [jobId, pre, withTax, paid] of data.invoices) {
  const cur = invoiceAgg.get(jobId) || { pre: 0, withTax: 0, paid: 0 };
  cur.pre += pre;
  cur.withTax += withTax;
  cur.paid += paid;
  invoiceAgg.set(jobId, cur);
}

const jobs = new Map();
for (const j of data.jobs) {
  const agg = invoiceAgg.get(j.id);
  const price = j.price != null ? j.price : agg ? Math.round(agg.pre * 100) / 100 : null;
  jobs.set(j.id, { id: j.id, name: j.name, number: j.number, rep: j.rep, closedOn: j.closedOn, price, status: j.status });
}

// ---- Collected revenue (amountPaid, attributed to close month) ------------
const revenueRows = [];
for (const [jobId, agg] of invoiceAgg) {
  const job = jobs.get(jobId);
  if (!job || agg.paid <= 0) continue;
  revenueRows.push({ jobId, amount: agg.paid, paidAt: job.closedOn });
}

// ---- Fully paid jobs (production commission gate) --------------------------
const fullyPaidJobIds = new Set();
for (const [jobId, agg] of invoiceAgg) {
  if (agg.withTax > EPS && agg.paid >= agg.withTax - EPS) fullyPaidJobIds.add(jobId);
}

// ---- Sales commission: payable vs excluded --------------------------------
function isPayable(job) {
  const agg = invoiceAgg.get(job.id);
  return job.status === 'Project Awarded' || (agg && agg.paid > 0);
}
const salesCommissionLines = [];
const excludedByJob = new Map();
for (const [jobId, cost] of data.commissionLines) {
  const job = jobs.get(jobId);
  if (job && isPayable(job)) {
    salesCommissionLines.push({ jobId, cost, price: cost });
  } else {
    excludedByJob.set(jobId, (excludedByJob.get(jobId) || 0) + cost);
  }
}

// ---- Efficiency-bonus details (job-budget approved time) -------------------
const bonusJobDetails = bonusData.bonusDetails.map((d) => {
  const job = jobs.get(d.id);
  return {
    id: d.id,
    number: job ? job.number : null,
    name: job ? job.name : d.id,
    closedOn: job ? job.closedOn : null,
    budgetItems: d.items.map(([quantity, type, unit, approved]) => ({
      name: type === 'L' ? 'Labor' : 'Travel',
      quantity,
      costTypeId: type === 'L' ? config.laborCostTypeId : config.travelCostTypeId,
      unitName: unit === 'H' ? config.hoursUnitName : null,
      approved: !!approved,
    })),
    timeEntries: d.tes.map(([minutes, date, user]) => ({ minutes, startedAt: date, user })),
  };
});

// ---- Build + render ---------------------------------------------------------
const report = buildReport(
  { jobs, revenueRows, salesCommissionLines, fullyPaidJobIds, bonusJobDetails },
  config,
  data.year
);

const outDir = path.join(__dirname, 'out', 'june-2026');
fs.mkdirSync(outDir, { recursive: true });
// Technician-only efficiency bonus report (no sales/commission content).
fs.writeFileSync(path.join(outDir, 'june-2026-technician-bonus.html'), renderBonusHtml(report, 'June 2026'));
// Full internal report (revenue + commissions + bonus) kept for reference.
fs.writeFileSync(path.join(outDir, 'june-2026-commission-report.html'), renderHtml(report));
for (const f of renderCsvFiles(report)) fs.writeFileSync(path.join(outDir, f.name), f.content);

// Excluded (not payable) commission lines CSV.
const exclRows = [...excludedByJob.entries()]
  .map(([jobId, total]) => {
    const j = jobs.get(jobId);
    return [j.number, j.name, j.rep, j.status, Math.round(total * 100) / 100];
  })
  .sort((a, b) => b[4] - a[4]);
fs.writeFileSync(
  path.join(outDir, 'excluded-commission-lines.csv'),
  toCsv(['JobNumber', 'Job', 'Rep', 'SalesStatus', 'CommissionLineTotal'], exclRows)
);
fs.writeFileSync(path.join(outDir, 'report-data.json'), JSON.stringify(report, null, 2));

// ---- Console summary (June) -------------------------------------------------
const jun = report.months[5];
const excludedTotal = exclRows.reduce((s, r) => s + r[4], 0);
console.log(`JUNE 2026`);
console.log(`Collected revenue: ${money(jun.revenueTotal)}`);
for (const rep of report.reps) {
  if (jun.revenueByRep[rep]) console.log(`  ${rep.padEnd(9)} ${money(jun.revenueByRep[rep])}`);
}
console.log(`Payable sales commission: ${money(jun.salesCommissionTotal)}`);
for (const rep of report.reps) {
  if (jun.salesCommissionByRep[rep]) console.log(`  ${rep.padEnd(9)} ${money(jun.salesCommissionByRep[rep])}`);
}
console.log(`Excluded (lost/not-proceeding) commission lines: ${money(excludedTotal)} across ${exclRows.length} jobs`);
console.log(`Production commission (Derek, pay in July): ${money(jun.productionCommission)}`);
const prodJun = report.detail.production.find((p) => p.month === 6);
console.log(`  base ${money(prodJun.base)} across ${prodJun.jobsCount} closed+fully-paid jobs x ${config.productionCommission.rate * 100}%`);
console.log(`Efficiency bonus hours: ${hours(report.bonus.monthlyTotals[5])}`);
for (const e of report.bonus.employees) {
  const h = report.bonus.byEmployeeMonth[e][5];
  if (h) console.log(`  ${e.padEnd(22)} ${h} hrs`);
}
console.log(`Warranty time recorded (deduction is manual): ${report.bonus.warrantyDeductionTotal} hrs at 1.5x`);
console.log(`Bonus jobs flagged for review: ${report.bonus.review.length} of ${report.bonus.qualifyingCount}`);
console.log(`Over-cap sales-commission lines: ${report.detail.salesCommission.filter((d) => d.overCap).length}`);
