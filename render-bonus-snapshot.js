#!/usr/bin/env node
'use strict';

/**
 * Render the technician efficiency-bonus report from a self-contained snapshot
 * file (produced when a live grant key isn't available in this environment).
 *
 * Snapshot shape: { year, month, periodLabel, bonusDetails: [
 *   { id, number, name, closedOn,
 *     items: [[quantity, 'L'|'T', 'H'|null, approved], ...],
 *     tes:   [[minutes, 'YYYY-MM-DD', user], ...] } ] }
 *
 * Usage: node render-bonus-snapshot.js --data=data/july-2026-bonus-data.json
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { buildReport } = require('./src/compute');
const { renderBonusHtml, renderCsvFiles, hours } = require('./src/render');

const dataArg = (process.argv.slice(2).find((a) => a.startsWith('--data=')) || '').split('=')[1];
if (!dataArg) {
  console.error('Usage: node render-bonus-snapshot.js --data=<snapshot.json>');
  process.exit(1);
}
const snap = JSON.parse(fs.readFileSync(path.resolve(dataArg), 'utf8'));
const pad2 = (n) => String(n).padStart(2, '0');

const bonusJobDetails = snap.bonusDetails.map((d) => ({
  id: d.id,
  number: d.number != null ? d.number : null,
  name: d.name || d.id,
  closedOn: d.closedOn || null,
  budgetItems: d.items.map(([quantity, type, unit, approved]) => ({
    name: type === 'L' ? 'Labor' : 'Travel',
    quantity,
    costTypeId: type === 'L' ? config.laborCostTypeId : config.travelCostTypeId,
    unitName: unit === 'H' ? config.hoursUnitName : null,
    approved: !!approved,
  })),
  timeEntries: d.tes.map(([minutes, date, user]) => ({ minutes, startedAt: date, user })),
  excludeFromLoss: d.excludeFromLoss || [],
  lossNote: d.lossNote || null,
}));

const report = buildReport(
  { jobs: new Map(), revenueRows: [], salesCommissionLines: [], fullyPaidJobIds: new Set(), bonusJobDetails },
  config,
  snap.year
);

const label = `technician-bonus-${snap.year}-${pad2(snap.month)}`;
const outDir = path.join(__dirname, 'out', label);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${label}.html`), renderBonusHtml(report, snap.periodLabel));
for (const f of renderCsvFiles(report)) {
  if (f.name.startsWith('efficiency-bonus')) fs.writeFileSync(path.join(outDir, f.name), f.content);
}

const payableJobs = report.bonus.jobs.filter((j) => j.bonusHours > 0 && Object.keys(j.distribution).length > 0).length;
console.log(`Technician efficiency bonus — ${snap.periodLabel}`);
console.log(`  Payable pool: ${hours(report.grand.bonusHours)} across ${payableJobs} of ${report.bonus.qualifyingCount} jobs`);
for (const e of report.bonus.employeeSummary) {
  console.log(`    ${e.name.padEnd(22)} won +${e.positive}  over −${e.negative}  warr −${e.warranty}  net ${e.net >= 0 ? '+' : ''}${e.net}`);
}
console.log(`  Jobs flagged for review: ${report.bonus.review.length}`);
console.log(`Wrote ${outDir}`);
