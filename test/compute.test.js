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
// Efficiency-bonus engine (values verified against live JobTread data and
// confirmed by ownership: bid = job-budget approved time only)
// ---------------------------------------------------------------------------

const LABOR = config.laborCostTypeId;
const TRAVEL = config.travelCostTypeId;

test('computeBidHours: budget labor + hour-denominated travel (Generator = 4.5)', () => {
  // Generator install budget: 1 Technician Labor 4 hrs + travel 0.5 hrs.
  const gen = computeBidHours(
    [
      { name: '1 Technician Labor Install', quantity: 4, costTypeId: LABOR, unitName: 'Hours', approved: true },
      { name: 'travel Install', quantity: 0.5, costTypeId: TRAVEL, unitName: 'Hours', approved: true },
    ],
    config
  );
  assert.equal(gen.bid, 4.5);
  assert.equal(gen.flags.length, 0);
});

test('computeBidHours: non-hour travel is ignored (Panel Upgrade = 15)', () => {
  // Panel Upgrade budget: labor 12 + 3; travel 13 + 9 have no Hours unit (miles).
  const panel = computeBidHours(
    [
      { name: '1 Technician Labor', quantity: 12, costTypeId: LABOR, unitName: null, approved: true },
      { name: 'travel', quantity: 13, costTypeId: TRAVEL, unitName: null, approved: true },
      { name: '1 Technician Labor', quantity: 3, costTypeId: LABOR, unitName: null, approved: true },
      { name: 'travel', quantity: 9, costTypeId: TRAVEL, unitName: null, approved: true },
    ],
    config
  );
  assert.equal(panel.bid, 15);
});

test('computeBidHours: additive budget lines (Guest Bath = 30.5) and no-bid', () => {
  const gb = computeBidHours(
    [
      { name: '1 Technician Labor', quantity: 3, costTypeId: LABOR, unitName: null, approved: true },
      { name: '1 Technician Labor', quantity: 4, costTypeId: LABOR, unitName: null, approved: true },
      { name: '2 Technician Labor', quantity: 20, costTypeId: LABOR, unitName: null, approved: true },
      { name: 'travel', quantity: 26, costTypeId: TRAVEL, unitName: null, approved: true },
      { name: '1 Technician Labor', quantity: 3.5, costTypeId: LABOR, unitName: null, approved: true },
      { name: 'Uncategorized Time', quantity: null, costTypeId: LABOR, unitName: null, approved: true },
    ],
    config
  );
  assert.equal(gb.bid, 30.5);

  const none = computeBidHours([{ name: 'x', quantity: null, costTypeId: LABOR, unitName: null, approved: true }], config);
  assert.equal(none.bid, 0);
  assert.ok(none.flags.includes('NO_BID'));
});

test('computeBidHours: UNAPPROVED lines are excluded (Chart House = 101)', () => {
  // Chart House budget: labor 64+15+14+8 approved; an 80-hr line sits only on
  // a DENIED order and must not count.
  const ch = computeBidHours(
    [
      { name: '1 Technician Labor', quantity: 64, costTypeId: LABOR, unitName: 'Hours', approved: true },
      { name: '1 Technician Labor', quantity: 15, costTypeId: LABOR, unitName: 'Hours', approved: true },
      { name: '1 Technician Labor', quantity: 80, costTypeId: LABOR, unitName: 'Hours', approved: false },
      { name: '3 Technician Labor', quantity: 14, costTypeId: LABOR, unitName: 'Hours', approved: true },
      { name: '1 Technician Labor', quantity: 8, costTypeId: LABOR, unitName: 'Hours', approved: true },
    ],
    config
  );
  assert.equal(ch.bid, 101);
  assert.equal(ch.unapprovedHours, 80);
  assert.ok(ch.flags.includes('UNAPPROVED_TIME'));
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

test('multiplierFor: 6 hrs or less saved -> 1.0x, over 6 -> 1.1x (no upper band)', () => {
  assert.equal(multiplierFor(-1, config), 0);
  assert.equal(multiplierFor(5, config), 1.0);
  assert.equal(multiplierFor(6, config), 1.0); // exactly 6 -> standard
  assert.equal(multiplierFor(6.01, config), 1.1); // over 6 -> boosted
  assert.equal(multiplierFor(15, config), 1.1);
  assert.equal(multiplierFor(85, config), 1.1); // no upper band
});

test('computeJobBonus reproduces Guest Bath (30.5 approved, 26:07 consumed -> 4.383 hrs @1.0x)', () => {
  const detail = {
    id: 'GB',
    name: 'Guest Bath and Water Heater',
    closedOn: '2026-06-26',
    budgetItems: [
      { name: '1 Technician Labor', quantity: 3, costTypeId: LABOR, unitName: null, approved: true },
      { name: '1 Technician Labor', quantity: 4, costTypeId: LABOR, unitName: null, approved: true },
      { name: '2 Technician Labor', quantity: 20, costTypeId: LABOR, unitName: null, approved: true },
      { name: '1 Technician Labor', quantity: 3.5, costTypeId: LABOR, unitName: null, approved: true },
    ],
    // 26:07 = 1567 minutes consumed, all before close.
    timeEntries: [
      { minutes: 950, startedAt: '2026-05-15T13:00:00Z', user: 'Nigel Greenberg' },
      { minutes: 617, startedAt: '2026-05-16T13:00:00Z', user: 'Aaron Motta' },
    ],
  };
  const r = computeJobBonus(detail, config);
  assert.equal(r.bid, 30.5);
  assert.equal(r.regHours, 26.12);
  assert.equal(r.saved, 4.38);
  assert.equal(r.multiplier, 1.0); // 4.38 <= 6 -> standard
  assert.ok(Math.abs(r.bonusHours - 4.383) < 0.001);
  const distTotal = Object.values(r.distribution).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(distTotal - r.bonusHours) < 0.002);
  assert.ok(r.distribution['Nigel Greenberg'] > r.distribution['Aaron Motta']);
});

test('computeJobBonus: warranty is recorded, never deducted', () => {
  const detail = {
    id: 'W',
    name: 'Warranty job',
    closedOn: '2026-06-10',
    budgetItems: [{ name: 'L', quantity: 10, costTypeId: LABOR, unitName: null, approved: true }],
    timeEntries: [
      { minutes: 300, startedAt: '2026-06-05T12:00:00Z', user: 'Alice' }, // 5 hrs regular -> saved 5
      { minutes: 120, startedAt: '2026-06-20T12:00:00Z', user: 'Alice' }, // 2 hrs warranty
    ],
  };
  const r = computeJobBonus(detail, config);
  assert.equal(r.saved, 5);
  assert.equal(r.multiplier, 1.0);
  assert.equal(r.bonusHours, 5); // full bonus paid — no automatic deduction
  assert.equal(r.warrantyDeduction, 3); // 2 warranty hrs x 1.5, recorded for manual use
  assert.ok(r.flags.includes('WARRANTY_TIME'));
  assert.equal(r.distribution['Alice'], 5);
});

test('buildReport aggregates bonus per employee/month and flags review jobs', () => {
  const jobs = new Map([
    ['GB', { id: 'GB', name: 'Guest Bath', number: 200, rep: 'Ben', closedOn: '2026-06-26', price: 5000 }],
    ['NB', { id: 'NB', name: 'No time job', number: 201, rep: 'Ben', closedOn: '2026-06-09', price: 3000 }],
  ]);
  const bonusJobDetails = [
    {
      id: 'GB', name: 'Guest Bath', closedOn: '2026-06-26',
      budgetItems: [{ name: 'A', quantity: 33.1, costTypeId: LABOR, unitName: null, approved: true }],
      timeEntries: [
        { minutes: 831, startedAt: '2026-05-15T13:00:00Z', user: 'Aaron Motta' }, // 13.85
        { minutes: 555, startedAt: '2026-05-16T13:00:00Z', user: 'Nigel Greenberg' }, // 9.25
      ], // 23.1 actual -> saved 10 -> x1.1 -> 11 hrs
    },
    {
      id: 'NB', name: 'No time job', closedOn: '2026-06-09',
      budgetItems: [{ name: 'A', quantity: 130, costTypeId: LABOR, unitName: null, approved: true }],
      timeEntries: [], // no time -> flagged, not payable
    },
  ];
  const r = buildReport({ jobs, revenueRows: [], salesCommissionLines: [], fullyPaidJobIds: new Set(), bonusJobDetails }, config, 2026);
  assert.equal(r.bonus.qualifyingCount, 2);
  assert.ok(Math.abs(r.bonus.monthlyTotals[5] - 11) < 0.01);
  assert.ok(r.bonus.employees.includes('Aaron Motta'));
  // NB job flagged NO_TIME and is in review, not payable
  const nb = r.bonus.jobs.find((j) => j.id === 'NB');
  assert.ok(nb.flags.includes('NO_TIME'));
  assert.equal(Object.keys(nb.distribution).length, 0);
  assert.ok(r.bonus.review.some((j) => j.id === 'NB'));
});

test('buildReport: per-employee win/lose summary', () => {
  const jobs = new Map();
  const bonusJobDetails = [
    { // WIN: 20 approved, 8 consumed -> saved 12 (>6 ->x1.1) -> 13.2 bonus, one tech
      id: 'W', name: 'Won', number: 1, closedOn: '2026-06-10',
      budgetItems: [{ quantity: 20, costTypeId: LABOR, unitName: 'Hours', approved: true }],
      timeEntries: [{ minutes: 480, startedAt: '2026-06-05T12:00:00Z', user: 'Alice' }],
    },
    { // LOSS: 5 approved, 9 consumed -> over 4, split Alice/Bob by hours
      id: 'L', name: 'Lost', number: 2, closedOn: '2026-06-12',
      budgetItems: [{ quantity: 5, costTypeId: LABOR, unitName: 'Hours', approved: true }],
      timeEntries: [
        { minutes: 360, startedAt: '2026-06-08T12:00:00Z', user: 'Alice' }, // 6h
        { minutes: 180, startedAt: '2026-06-08T12:00:00Z', user: 'Bob' }, // 3h
      ], // total 9h, over 4h -> Alice 2.667, Bob 1.333
    },
  ];
  const r = buildReport({ jobs, revenueRows: [], salesCommissionLines: [], fullyPaidJobIds: new Set(), bonusJobDetails }, config, 2026);
  const bySummary = Object.fromEntries(r.bonus.employeeSummary.map((e) => [e.name, e]));
  assert.equal(bySummary.Alice.positive, 13.2);
  assert.ok(Math.abs(bySummary.Alice.negative - 2.667) < 0.002);
  assert.ok(Math.abs(bySummary.Alice.net - (13.2 - 2.667)) < 0.002);
  assert.ok(Math.abs(bySummary.Bob.negative - 1.333) < 0.002);
  assert.equal(bySummary.Bob.positive, 0);
  assert.ok(bySummary.Bob.net < 0);
});
