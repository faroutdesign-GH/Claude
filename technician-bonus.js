#!/usr/bin/env node
'use strict';

/**
 * Far Out Design — Technician Efficiency Bonus report (field hours only).
 *
 * Pulls live from JobTread and writes a technician-only HTML report plus CSVs
 * for one month. No sales / revenue / commission content.
 *
 * Usage:
 *   JOBTREAD_GRANT_KEY=xxx node technician-bonus.js --year=2026 --month=6
 *
 * Flags:
 *   --year=YYYY   Calendar year (default: current year).
 *   --month=M     Month 1-12 (default: last complete month).
 *   --out=DIR     Output directory (default: ./out/technician-bonus-<year>-<month>).
 *   --json        Also write the raw report object.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { fetchQualifyingBonusJobs, fetchBonusJobDetail } = require('./src/fetch');
const { buildReport } = require('./src/compute');
const { renderBonusHtml, renderCsvFiles, hours } = require('./src/render');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function loadDotEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function parseArgs(argv) {
  const now = new Date();
  // Default to the last COMPLETE month.
  let y = now.getFullYear();
  let m = now.getMonth(); // 0-based current month -> previous month's 1-based number
  if (m === 0) { m = 12; y -= 1; }
  const args = { year: y, month: m, out: null, json: false };
  for (const a of argv.slice(2)) {
    const mm = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!mm) continue;
    const [, key, val] = mm;
    if (key === 'year') args.year = Number(val);
    else if (key === 'month') args.month = Number(val);
    else if (key === 'out') args.out = val;
    else if (key === 'json') args.json = true;
  }
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);
  const { year, month } = args;
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    console.error(`Invalid --year/--month: ${args.year}/${args.month}`);
    process.exit(1);
  }

  const orgId = config.organizationId;
  const opts = { timeZone: config.timeZone };
  const lastDay = new Date(year, month, 0).getDate();
  const start = `${year}-${pad2(month)}-01`;
  const end = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  const periodLabel = `${MONTH_NAMES[month - 1]} ${year}`;

  console.error(`Technician efficiency bonus — ${periodLabel}`);
  console.error(`  • fetching Project Awarded jobs closed ${start}..${end}…`);
  const qualifying = await fetchQualifyingBonusJobs(orgId, { start, end }, opts);
  console.error(`    ${qualifying.length} qualifying jobs; pulling budget + time…`);

  const bonusJobDetails = [];
  for (let i = 0; i < qualifying.length; i++) {
    bonusJobDetails.push(await fetchBonusJobDetail(orgId, qualifying[i].id, opts));
    if ((i + 1) % 20 === 0 || i + 1 === qualifying.length) {
      console.error(`    [${i + 1}/${qualifying.length}]`);
    }
  }

  // Bonus-only: no revenue/commission inputs.
  const report = buildReport(
    { jobs: new Map(), revenueRows: [], salesCommissionLines: [], fullyPaidJobIds: new Set(), bonusJobDetails },
    config,
    year
  );

  const outDir = args.out ? path.resolve(args.out) : path.join(__dirname, 'out', `technician-bonus-${year}-${pad2(month)}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `technician-bonus-${year}-${pad2(month)}.html`), renderBonusHtml(report, periodLabel));

  // Only the two bonus CSVs are relevant for a technician-only run.
  for (const f of renderCsvFiles(report)) {
    if (f.name.startsWith('efficiency-bonus')) fs.writeFileSync(path.join(outDir, f.name), f.content);
  }
  if (args.json) {
    fs.writeFileSync(path.join(outDir, `bonus-${year}-${pad2(month)}.json`), JSON.stringify(report.bonus, null, 2));
  }

  const payableJobs = report.bonus.jobs.filter((j) => j.bonusHours > 0 && Object.keys(j.distribution).length > 0).length;
  console.error('');
  console.log(`Technician efficiency bonus — ${periodLabel}`);
  console.log(`  Payable pool: ${hours(report.grand.bonusHours)} across ${payableJobs} of ${report.bonus.qualifyingCount} jobs`);
  for (const emp of report.bonus.employees) {
    const h = report.bonus.employeeTotals[emp];
    if (h) console.log(`    ${emp.padEnd(22)} ${h} hrs`);
  }
  if (report.bonus.warrantyDeductionTotal) {
    console.log(`  Warranty recorded (manual): ${report.bonus.warrantyDeductionTotal} hrs`);
  }
  console.log(`  Jobs flagged for review: ${report.bonus.review.length}`);
  console.log('');
  console.log(`Wrote ${outDir}`);
}

main().catch((err) => {
  console.error('\nReport generation failed:');
  console.error(err && err.message ? err.message : err);
  if (err && err.details) console.error(JSON.stringify(err.details, null, 2).slice(0, 2000));
  process.exit(1);
});
