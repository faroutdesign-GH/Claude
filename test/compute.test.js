'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const { buildReport, capFor, recognitionMonth, sumLinesByJob } = require('../src/compute');

// A small, deterministic fixture exercising every commission path.
function fixture() {
  const jobs = new Map([
    ['J1', { id: 'J1', name: 'Panel swap', number: 101, rep: 'Ben', closedOn: '2026-03-10', price: 8000 }],
    ['J2', { id: 'J2', name: 'Rewire', number: 102, rep: 'Ben', closedOn: '2026-04-05', price: 20000 }],
    ['J3', { id: 'J3', name: 'EV charger', number: 103, rep: 'Derek', closedOn: '2026-03-20', price: 5000 }],
    ['J4', { id: 'J4', name: 'Open lead', number: 104, rep: 'Curtice', closedOn: null, price: 1000 }],
    ['J5', { id: 'J5', name: 'Generator', number: 105, rep: 'Derek', closedOn: '2026-03-25', price: 12000 }],
  ]);

  const revenueRows = [
    { jobId: 'J1', amount: 4000, paidAt: '2026-03-15' },
    { jobId: 'J1', amount: 4000, paidAt: '2026-04-15' },
    { jobId: 'J3', amount: 5000, paidAt: '2026-03-20' },
    { jobId: 'UNKNOWN', amount: 100, paidAt: '2026-03-01' }, // job not in map -> Unassigned
    { jobId: 'J1', amount: 999, paidAt: '2025-12-31' }, // prior year -> excluded
  ];

  const salesCommissionLines = [
    { jobId: 'J1', cost: 500, price: 500 }, // Ben, price 8000, cap 400 -> OVER
    { jobId: 'J2', cost: 700, price: 700 }, // Ben, price 20000
    { jobId: 'J2', cost: 300, price: 300 }, //   + -> 1000, cap 1400 -> ok
    { jobId: 'J3', cost: 250, price: 250 }, // Derek, price 5000, cap 250 -> exactly at cap
    { jobId: 'J4', cost: 100, price: 100 }, // open job -> excluded (openSalesCommission)
  ];

  const laborByJob = new Map([
    // bonus 12 hrs (>10 -> 1.1x), split Alice 5/8, Bob 3/8
    ['J5', { bidPersonHours: 20, actualHours: 8, techs: new Map([
      ['Alice', { hours: 5 }],
      ['Bob', { hours: 3 }],
    ]) }],
    // negative bonus -> skipped
    ['J1', { bidPersonHours: 4, actualHours: 6, techs: new Map([['Alice', { hours: 6 }]]) }],
    // bonus 6 hrs (<=10 -> 1.0x), Alice only
    ['J3', { bidPersonHours: 10, actualHours: 4, techs: new Map([['Alice', { hours: 4 }]]) }],
  ]);

  // J1, J2, J3 are fully paid; J5 is closed but NOT paid (so it is excluded
  // from production commission but still yields technician bonus hours).
  const fullyPaidJobIds = new Set(['J1', 'J2', 'J3']);

  return { jobs, revenueRows, salesCommissionLines, leadCommissionLines: [], laborByJob, fullyPaidJobIds };
}

test('capFor applies Ben tiers, Derek flat, and default', () => {
  assert.deepEqual(capFor('Ben', 8000, config), { rate: 0.05, cap: 400 });
  assert.deepEqual(capFor('Ben', 10000, config), { rate: 0.05, cap: 500 }); // <=10k boundary
  assert.deepEqual(capFor('Ben', 20000, config), { rate: 0.07, cap: 1400 });
  assert.deepEqual(capFor('Derek', 5000, config), { rate: 0.05, cap: 250 });
  assert.deepEqual(capFor('Curtice', 1000, config), { rate: 0.05, cap: 50 });
  assert.deepEqual(capFor('Ben', null, config), { rate: 0.05, cap: null });
});

test('recognitionMonth reads the close date, null when open', () => {
  assert.deepEqual(recognitionMonth({ closedOn: '2026-03-10' }, config.timeZone), { year: 2026, month: 3 });
  assert.equal(recognitionMonth({ closedOn: null }, config.timeZone), null);
});

test('sumLinesByJob totals commission lines per job', () => {
  const m = sumLinesByJob([{ jobId: 'A', cost: 10 }, { jobId: 'A', cost: 5 }, { jobId: 'B', cost: 7 }]);
  assert.equal(m.get('A'), 15);
  assert.equal(m.get('B'), 7);
});

test('buildReport: paid-invoice revenue is bucketed by month and rep', () => {
  const r = buildReport(fixture(), config, 2026);
  const mar = r.months[2];
  const apr = r.months[3];
  assert.equal(mar.revenueByRep.Ben, 4000);
  assert.equal(mar.revenueByRep.Derek, 5000);
  assert.equal(mar.revenueByRep.Unassigned, 100);
  assert.equal(apr.revenueByRep.Ben, 4000);
  assert.equal(r.grand.revenue, 13100); // prior-year 999 excluded
  assert.equal(r.repTotals.Ben.revenue, 8000);
  assert.equal(r.repTotals.Derek.revenue, 5000);
});

test('buildReport: sales commission recognized on close, with cap flags', () => {
  const r = buildReport(fixture(), config, 2026);
  assert.equal(r.grand.salesCommission, 1750); // 500 + 1000 + 250
  assert.equal(r.repTotals.Ben.salesCommission, 1500);
  assert.equal(r.repTotals.Derek.salesCommission, 250);
  assert.equal(r.openSalesCommission, 100); // J4 not closed

  const j1 = r.detail.salesCommission.find((d) => d.jobId === 'J1');
  assert.equal(j1.overCap, true); // 500 > 400
  const j2 = r.detail.salesCommission.find((d) => d.jobId === 'J2');
  assert.equal(j2.lineTotal, 1000);
  assert.equal(j2.overCap, false); // 1000 <= 1400
  const j3 = r.detail.salesCommission.find((d) => d.jobId === 'J3');
  assert.equal(j3.overCap, false); // exactly at cap
});

test('buildReport: Derek production commission = 2% of closed AND paid jobs/month', () => {
  const r = buildReport(fixture(), config, 2026);
  // March closed + paid: J1 8000 + J3 5000 = 13000 -> 260 (J5 closed but unpaid)
  assert.equal(r.months[2].productionCommission, 260);
  // April closed + paid: J2 20000 -> 400
  assert.equal(r.months[3].productionCommission, 400);
  assert.equal(r.grand.productionCommission, 660);
  assert.equal(r.repTotals.Derek.productionCommission, 660);
  assert.equal(r.repTotals.Derek.totalCommission, 910); // 250 + 660
});

test('buildReport: technician bonus HOURS, multiplier, and per-tech split', () => {
  const r = buildReport(fixture(), config, 2026);
  const mar = r.months[2];
  // J5: 12 bonus hrs @1.1x -> Alice 7.5*1.1=8.25, Bob 4.5*1.1=4.95 (unpaid job still yields bonus)
  // J3: 6 bonus hrs @1.0x -> Alice 6
  assert.equal(mar.bonusHoursByTech.Alice, 14.25); // 8.25 + 6
  assert.equal(mar.bonusHoursByTech.Bob, 4.95);
  assert.equal(mar.bonusHoursTotal, 19.2);
  assert.equal(r.grand.bonusHours, 19.2);
  assert.equal(r.techTotals.Alice, 14.25);
  assert.equal(r.techTotals.Bob, 4.95);
  // J1 had negative bonus -> no entry
  assert.equal(r.detail.bonus.some((d) => d.jobId === 'J1'), false);
});
