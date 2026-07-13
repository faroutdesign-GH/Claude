'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const {
  buildReport,
  capFor,
  recognitionMonth,
  sumLinesByJob,
  computeBidHours,
  splitActual,
  multiplierFor,
  computeJobBonus,
} = require('../src/compute');

// ---------------------------------------------------------------------------
// Commission fixture (revenue / sales commission / production commission)
// ---------------------------------------------------------------------------
function commissionFixture() {
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
    { jobId: 'UNKNOWN', amount: 100, paidAt: '2026-03-01' },
    { jobId: 'J1', amount: 999, paidAt: '2025-12-31' },
  ];
  const salesCommissionLines = [
    { jobId: 'J1', cost: 500, price: 500 },
    { jobId: 'J2', cost: 700, price: 700 },
    { jobId: 'J2', cost: 300, price: 300 },
    { jobId: 'J3', cost: 250, price: 250 },
    { jobId: 'J4', cost: 100, price: 100 },
  ];
  const fullyPaidJobIds = new Set(['J1', 'J2', 'J3']);
  return { jobs, revenueRows, salesCommissionLines, fullyPaidJobIds, bonusJobDetails: [] };
}

test('capFor applies Ben tiers, Derek flat, and default', () => {
  assert.deepEqual(capFor('Ben', 8000, config), { rate: 0.05, cap: 400 });
  assert.deepEqual(capFor('Ben', 10000, config), { rate: 0.05, cap: 500 });
  assert.deepEqual(capFor('Ben', 20000, config), { rate: 0.07, cap: 1400 });
  assert.deepEqual(capFor('Derek', 5000, config), { rate: 0.05, cap: 250 });
  assert.deepEqual(capFor('Curtice', 1000, config), { rate: 0.05, cap: 50 });
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

test('paid-invoice revenue bucketed by month and rep', () => {
  const r = buildReport(commissionFixture(), config, 2026);
  assert.equal(r.months[2].revenueByRep.Ben, 4000);
  assert.equal(r.months[2].revenueByRep.Derek, 5000);
  assert.equal(r.months[2].revenueByRep.Unassigned, 100);
  assert.equal(r.months[3].revenueByRep.Ben, 4000);
  assert.equal(r.grand.revenue, 13100);
});

test('sales commission recognized on close, with cap flags', () => {
  const r = buildReport(commissionFixture(), config, 2026);
  assert.equal(r.grand.salesCommission, 1750);
  assert.equal(r.repTotals.Ben.salesCommission, 1500);
  assert.equal(r.repTotals.Derek.salesCommission, 250);
  assert.equal(r.openSalesCommission, 100);
  assert.equal(r.detail.salesCommission.find((d) => d.jobId === 'J1').overCap, true);
  assert.equal(r.detail.salesCommission.find((d) => d.jobId === 'J2').overCap, false);
  assert.equal(r.detail.salesCommission.find((d) => d.jobId === 'J3').overCap, false);
});

test('Derek production commission = 2% of closed AND paid jobs/month', () => {
  const r = buildReport(commissionFixture(), config, 2026);
  assert.equal(r.months[2].productionCommission, 260); // J1 8000 + J3 5000 (J5 unpaid)
  assert.equal(r.months[3].productionCommission, 400); // J2 20000
  assert.equal(r.grand.productionCommission, 660);
  assert.equal(r.repTotals.Derek.totalCommission, 910);
});

// ---------------------------------------------------------------------------
// Efficiency-bonus engine (values verified against live JobTread data)
// ---------------------------------------------------------------------------

test('computeBidHours: additive change orders, dedup exact copies', () => {
  // Guest Bath: two identical 27-hr orders (one is a copy) + a 3.5 change order.
  const guestBath = computeBidHours([
    { type: 'customerOrder', issueDate: '2026-04-29', laborItems: [{ name: 'A', quantity: 20 }, { name: 'B', quantity: 7 }] },
    { type: 'customerOrder', issueDate: '2026-04-29', laborItems: [{ name: 'A', quantity: 20 }, { name: 'B', quantity: 7 }] },
    { type: 'customerOrder', issueDate: '2026-05-11', laborItems: [{ name: 'C', quantity: 3.5 }] },
  ]);
  assert.equal(guestBath.bid, 30.5); // 27 base + 3.5 change; exact copy dropped
  assert.ok(guestBath.flags.includes('MULTIPLE_ORDERS'));
});

test('computeBidHours: near-duplicate different dates are summed (flagged)', () => {
  // Generator: 4 (Jun 16) + 4 (Jun 17) — additive per policy, but flagged.
  const gen = computeBidHours([
    { type: 'customerOrder', issueDate: '2026-06-16', laborItems: [{ name: 'X', quantity: 4 }] },
    { type: 'customerOrder', issueDate: '2026-06-17', laborItems: [{ name: 'X', quantity: 4 }] },
  ]);
  assert.equal(gen.bid, 8);
  assert.ok(gen.flags.includes('MULTIPLE_ORDERS'));
});

test('computeBidHours: invoice fallback and no-bid', () => {
  const inv = computeBidHours([
    { type: 'customerInvoice', issueDate: '2026-05-12', laborItems: [{ name: 'L', quantity: 3.5 }] },
  ]);
  assert.equal(inv.bid, 3.5);
  assert.ok(inv.flags.includes('INVOICE_BID'));

  const none = computeBidHours([
    { type: 'customerOrder', issueDate: '2026-05-12', laborItems: [{ name: 'M', quantity: null }] },
  ]);
  assert.equal(none.bid, 0);
  assert.ok(none.flags.includes('NO_BID'));
});

test('splitActual separates regular and warranty by close date', () => {
  const s = splitActual(
    [
      { minutes: 60, startedAt: '2026-06-20T13:00:00Z', user: 'Alice' },
      { minutes: 120, startedAt: '2026-06-26T13:00:00Z', user: 'Alice' }, // on close = regular
      { minutes: 30, startedAt: '2026-06-30T13:00:00Z', user: 'Bob' }, // after close = warranty
    ],
    '2026-06-26'
  );
  assert.equal(s.regTotalMin, 180);
  assert.equal(s.warrTotalMin, 30);
  assert.equal(s.regByUser.Alice, 180);
});

test('multiplierFor bands', () => {
  assert.equal(multiplierFor(-1, config), 0);
  assert.equal(multiplierFor(5, config), 1.0); // below boost
  assert.equal(multiplierFor(6, config), 1.1); // boost lower bound
  assert.equal(multiplierFor(15, config), 1.1); // boost upper bound
  assert.equal(multiplierFor(16, config), 1.0); // above boost -> standard
});

test('computeJobBonus reproduces the real Guest Bath result (30.5 bid, 23.1 actual -> 8.14)', () => {
  const detail = {
    id: 'GB',
    name: 'Guest Bath and Water Heater',
    closedOn: '2026-06-26',
    documents: [
      { type: 'customerOrder', issueDate: '2026-04-29', laborItems: [{ name: 'A', quantity: 20 }, { name: 'B', quantity: 7 }] },
      { type: 'customerOrder', issueDate: '2026-04-29', laborItems: [{ name: 'A', quantity: 20 }, { name: 'B', quantity: 7 }] },
      { type: 'customerOrder', issueDate: '2026-05-11', laborItems: [{ name: 'C', quantity: 3.5 }] },
    ],
    // 1386 minutes total = 23.1 hrs, split between two techs, all before close.
    timeEntries: [
      { minutes: 831, startedAt: '2026-05-15T13:00:00Z', user: 'Aaron Motta' }, // 13.85 hrs
      { minutes: 555, startedAt: '2026-05-16T13:00:00Z', user: 'Nigel Greenberg' }, // 9.25 hrs
    ],
  };
  const r = computeJobBonus(detail, config);
  assert.equal(r.bid, 30.5);
  assert.equal(r.regHours, 23.1);
  assert.equal(r.saved, 7.4);
  assert.equal(r.multiplier, 1.1);
  assert.equal(r.netBonus, 8.14); // 7.4 * 1.1
  const distTotal = Object.values(r.distribution).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(distTotal - 8.14) < 0.002);
  assert.ok(r.distribution['Aaron Motta'] > r.distribution['Nigel Greenberg']); // more hours -> larger share
});

test('computeJobBonus: warranty penalty and no-bonus when saved <= 0', () => {
  const detail = {
    id: 'W',
    name: 'Warranty job',
    closedOn: '2026-06-10',
    documents: [{ type: 'customerOrder', issueDate: '2026-05-01', laborItems: [{ name: 'L', quantity: 10 }] }],
    timeEntries: [
      { minutes: 300, startedAt: '2026-06-05T12:00:00Z', user: 'Alice' }, // 5 hrs regular -> saved 5
      { minutes: 120, startedAt: '2026-06-20T12:00:00Z', user: 'Alice' }, // 2 hrs warranty -> penalty 3
    ],
  };
  const r = computeJobBonus(detail, config);
  assert.equal(r.saved, 5);
  assert.equal(r.multiplier, 1.0); // 5 < boost min
  assert.equal(r.rawBonus, 5);
  assert.equal(r.penalty, 3); // 2 warranty hrs * 1.5
  assert.equal(r.netBonus, 2); // 5 - 3
});

test('buildReport aggregates bonus per employee/month and flags review jobs', () => {
  const jobs = new Map([
    ['GB', { id: 'GB', name: 'Guest Bath', number: 200, rep: 'Ben', closedOn: '2026-06-26', price: 5000 }],
    ['NB', { id: 'NB', name: 'No time job', number: 201, rep: 'Ben', closedOn: '2026-06-09', price: 3000 }],
  ]);
  const bonusJobDetails = [
    {
      id: 'GB', name: 'Guest Bath', closedOn: '2026-06-26',
      documents: [{ type: 'customerOrder', issueDate: '2026-04-29', laborItems: [{ name: 'A', quantity: 30.5 }] }],
      timeEntries: [
        { minutes: 831, startedAt: '2026-05-15T13:00:00Z', user: 'Aaron Motta' },
        { minutes: 555, startedAt: '2026-05-16T13:00:00Z', user: 'Nigel Greenberg' },
      ],
    },
    {
      id: 'NB', name: 'No time job', closedOn: '2026-06-09',
      documents: [{ type: 'customerOrder', issueDate: '2026-05-01', laborItems: [{ name: 'A', quantity: 130 }] }],
      timeEntries: [], // no time -> flagged, not payable
    },
  ];
  const r = buildReport({ jobs, revenueRows: [], salesCommissionLines: [], fullyPaidJobIds: new Set(), bonusJobDetails }, config, 2026);
  assert.equal(r.bonus.qualifyingCount, 2);
  // June (month 6) bonus hours = 8.14, split across the two techs
  assert.ok(Math.abs(r.bonus.monthlyTotals[5] - 8.14) < 0.01);
  assert.ok(r.bonus.employees.includes('Aaron Motta'));
  assert.equal(Math.round(r.grand.bonusHours * 100) / 100, 8.14);
  // NB job flagged NO_TIME and is in review, not payable
  const nb = r.bonus.jobs.find((j) => j.id === 'NB');
  assert.ok(nb.flags.includes('NO_TIME'));
  assert.equal(Object.keys(nb.distribution).length, 0);
  assert.ok(r.bonus.review.some((j) => j.id === 'NB'));
});
