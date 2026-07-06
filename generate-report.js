#!/usr/bin/env node
'use strict';

/**
 * Far Out Design — Sales & Commission report generator.
 *
 * Pulls live data from JobTread (Pave API) and writes an HTML dashboard plus
 * CSV exports for a calendar year.
 *
 * Usage:
 *   JOBTREAD_GRANT_KEY=xxx node generate-report.js [--year=2026] [--out=out]
 *
 * Flags:
 *   --year=YYYY   Calendar year to report (default: config.defaultYear).
 *   --out=DIR     Output directory (default: ./out).
 *   --json        Also write the raw report object as report.json.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { fetchJobs, fetchPaidInvoiceRevenue, fetchCommissionLines, fetchJobLaborAndTime } = require('./src/fetch');
const { buildReport } = require('./src/compute');
const { renderHtml, renderCsvFiles, money } = require('./src/render');

function parseArgs(argv) {
  const args = { year: config.defaultYear, out: 'out', json: false };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'year') args.year = Number(val);
    else if (key === 'out') args.out = val;
    else if (key === 'json') args.json = true;
  }
  return args;
}

/** Load KEY=VALUE lines from a .env file if present (no dependency). */
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

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);
  const orgId = config.organizationId;
  const year = args.year;

  if (!Number.isInteger(year)) {
    console.error(`Invalid --year: ${args.year}`);
    process.exit(1);
  }

  const opts = { timeZone: config.timeZone };
  const start = `${year}-01-01T00:00:00.000Z`;
  const end = `${year + 1}-01-01T00:00:00.000Z`;

  console.error(`Generating Far Out Design sales & commission report for ${year}…`);

  console.error('  • fetching jobs + sales reps…');
  const jobs = await fetchJobs(orgId, opts);
  console.error(`    ${jobs.size} jobs`);

  console.error('  • fetching paid invoice revenue…');
  const revenueRows = await fetchPaidInvoiceRevenue(orgId, { start, end }, opts);
  console.error(`    ${revenueRows.length} invoice payments in ${year}`);

  console.error('  • fetching commission line items…');
  const salesCommissionLines = await fetchCommissionLines(orgId, config.costCodes.salesCommission, opts);
  console.error(`    ${salesCommissionLines.length} salesman-commission lines`);

  // Jobs closed within the report year drive commission + bonus recognition.
  const closedJobIds = [];
  for (const job of jobs.values()) {
    if (!job.closedOn) continue;
    const y = Number(String(job.closedOn).slice(0, 4));
    if (y === year) closedJobIds.push(job.id);
  }
  console.error(`  • fetching labor + time for ${closedJobIds.length} jobs closed in ${year}…`);
  const laborByJob = await fetchJobLaborAndTime(orgId, closedJobIds, opts);

  const report = buildReport(
    { jobs, revenueRows, salesCommissionLines, leadCommissionLines: [], laborByJob },
    config,
    year
  );

  // Write outputs.
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const htmlPath = path.join(outDir, `sales-commission-${year}.html`);
  fs.writeFileSync(htmlPath, renderHtml(report));

  for (const file of renderCsvFiles(report)) {
    fs.writeFileSync(path.join(outDir, file.name), file.content);
  }
  if (args.json) {
    fs.writeFileSync(path.join(outDir, `report-${year}.json`), JSON.stringify(report, null, 2));
  }

  // Console summary.
  console.error('');
  console.log(`Report for ${year}`);
  console.log(`  Paid revenue:           ${money(report.grand.revenue)}`);
  console.log(`  Sales commission:       ${money(report.grand.salesCommission)}`);
  console.log(`  Production commission:  ${money(report.grand.productionCommission)}`);
  console.log(`  Technician bonus:       ${money(report.grand.bonus)}`);
  console.log('');
  for (const rep of report.reps) {
    const t = report.repTotals[rep];
    if (!t.revenue && !t.totalCommission) continue;
    console.log(`  ${rep.padEnd(10)} revenue ${money(t.revenue).padStart(14)}  commission ${money(t.totalCommission).padStart(12)}`);
  }
  console.log('');
  console.log(`Wrote:`);
  console.log(`  ${htmlPath}`);
  console.log(`  ${path.join(outDir, '*.csv')}`);
}

main().catch((err) => {
  console.error('\nReport generation failed:');
  console.error(err && err.message ? err.message : err);
  if (err && err.details) console.error(JSON.stringify(err.details, null, 2).slice(0, 2000));
  process.exit(1);
});
