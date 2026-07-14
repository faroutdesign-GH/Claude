'use strict';

const { toYearMonth, monthName } = require('./dates');

const EPSILON = 0.005; // half a cent, for cap comparisons

function addTo(obj, key, amount) {
  obj[key] = (obj[key] || 0) + amount;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function round3(n) {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/**
 * Resolve the sales-commission policy cap for a rep on a job of a given price.
 * Returns { rate, cap } or { rate: null, cap: null } if no policy is defined.
 */
function capFor(rep, jobPrice, cfg) {
  const caps = cfg.salesCommissionCaps;
  const tiers = caps.tiers[rep];
  if (!tiers || tiers.length === 0) return { rate: null, cap: null };
  const price = typeof jobPrice === 'number' ? jobPrice : 0;
  const tier = tiers.find((t) => price <= t.maxJobPrice) || tiers[tiers.length - 1];
  const cap = typeof jobPrice === 'number' ? round2(jobPrice * tier.rate) : null;
  return { rate: tier.rate, cap };
}

/**
 * Month (1-12) in which a job's commission/bonus is recognized: the month the
 * job is marked closed. Jobs without a close date return null.
 */
function recognitionMonth(job, tz) {
  if (!job || !job.closedOn) return null;
  return toYearMonth(job.closedOn, tz);
}

/** Aggregate commission line items to a per-job total (using line `cost`). */
function sumLinesByJob(lines) {
  const byJob = new Map();
  for (const l of lines) {
    byJob.set(l.jobId, (byJob.get(l.jobId) || 0) + (Number(l.cost) || 0));
  }
  return byJob;
}

// ===========================================================================
// Efficiency Bonus engine
// ===========================================================================

/**
 * Compute bid hours from the JOB BUDGET's APPROVED time. A budget line is
 * approved when it is bonded to at least one approved document — unapproved
 * lines (draft/denied estimates) carry bid time that must NOT count.
 *
 * `budgetItems`: [{quantity, costTypeId, unitName, approved}] — pre-filtered
 * to the Labor and Travel cost types. Labor quantities count when approved;
 * Travel counts when approved AND the line's unit is Hours.
 *
 * @returns {{bid:number, unapprovedHours:number, source:string, flags:string[]}}
 */
function computeBidHours(budgetItems, cfg) {
  const flags = [];
  let bid = 0;
  let unapprovedHours = 0;
  let counted = 0;
  for (const item of budgetItems || []) {
    const qty = Number(item.quantity);
    if (item.quantity == null || Number.isNaN(qty)) continue;
    const isHourLine =
      item.costTypeId === cfg.laborCostTypeId ||
      (item.costTypeId === cfg.travelCostTypeId && item.unitName === cfg.hoursUnitName);
    if (!isHourLine) continue;
    if (item.approved) {
      bid += qty;
      counted += 1;
    } else {
      unapprovedHours += qty;
    }
  }
  if (unapprovedHours > 0) flags.push('UNAPPROVED_TIME');
  if (counted === 0) {
    flags.push('NO_BID');
    return { bid: 0, unapprovedHours: round2(unapprovedHours), source: 'No approved time on budget', flags };
  }
  return { bid: round2(bid), unapprovedHours: round2(unapprovedHours), source: 'Budget approved time', flags };
}

/**
 * Split time entries into regular (on/before close) and warranty (after close).
 * @returns {{regByUser:Object, regTotalMin:number, warrTotalMin:number, flags:string[]}}
 */
function splitActual(timeEntries, closedOn) {
  const flags = [];
  const regByUser = {};
  let regTotalMin = 0;
  let warrTotalMin = 0;
  if (!closedOn) flags.push('NO_CLOSE_DATE');
  for (const te of timeEntries) {
    const started = (te.startedAt || '').slice(0, 10);
    const mins = Number(te.minutes) || 0;
    const user = te.user || 'Unknown';
    const isWarranty = !!closedOn && started > closedOn;
    if (isWarranty) {
      warrTotalMin += mins;
    } else {
      addTo(regByUser, user, mins);
      regTotalMin += mins;
    }
  }
  return { regByUser, regTotalMin, warrTotalMin, flags };
}

/** Bonus multiplier for hours saved: > boostOverSaved pays boosted, else standard. */
function multiplierFor(saved, cfg) {
  if (saved <= 0) return 0;
  const m = cfg.efficiencyBonus.multiplier;
  return saved > m.boostOverSaved ? m.boosted : m.standard;
}

/**
 * Score one job's efficiency bonus.
 * @param {object} detail  {id,name,closedOn,budgetItems,timeEntries,truncated*}
 * @returns {object} per-job result
 */
function computeJobBonus(detail, cfg) {
  const eb = cfg.efficiencyBonus;
  const { bid, unapprovedHours, source, flags: bidFlags } = computeBidHours(detail.budgetItems || [], cfg);
  const { regByUser, regTotalMin, warrTotalMin, flags: splitFlags } = splitActual(
    detail.timeEntries || [],
    detail.closedOn
  );

  const regHours = regTotalMin / 60;
  const warrHours = warrTotalMin / 60;
  const saved = bid - regHours;
  // A job with approved time but NO consumed time is not a win — it means the
  // time was logged incorrectly. No bonus; flagged for correction instead.
  const noTime = regTotalMin === 0;
  const multiplier = noTime ? 0 : multiplierFor(saved, cfg);
  const bonusHours = noTime ? 0 : round3(Math.max(0, saved) * multiplier);
  // Warranty deduction is RECORDED, never applied automatically — ownership
  // docks it manually only when the follow-up was negligence.
  const warrantyDeduction = round3(warrHours * eb.warranty.rate);

  const distribution = {};
  if (bonusHours > 0 && regTotalMin > 0) {
    for (const [user, mins] of Object.entries(regByUser)) {
      distribution[user] = round3(bonusHours * (mins / regTotalMin));
    }
  }

  // Loss side (for the win/lose comparison): a job over its approved time.
  // Raw overage hours (no multiplier), split by who worked it — a group loss.
  const lossHours = noTime ? 0 : saved < 0 ? round3(-saved) : 0;
  const lossDistribution = {};
  if (lossHours > 0 && regTotalMin > 0) {
    for (const [user, mins] of Object.entries(regByUser)) {
      lossDistribution[user] = round3(lossHours * (mins / regTotalMin));
    }
  }

  const flags = [...bidFlags, ...splitFlags];
  if (noTime) flags.push('NO_TIME');
  if (warrTotalMin > 0) flags.push('WARRANTY_TIME');
  if (saved > 0 && bid > 0 && regHours > 0 && regHours < bid * eb.lowActualFlagRatio) {
    flags.push('CHECK_LOW_ACTUAL');
  }
  if (detail.truncatedTime || detail.truncatedBudget) flags.push('DATA_TRUNCATED');

  return {
    id: detail.id,
    number: detail.number != null ? detail.number : null,
    name: detail.name || '(unnamed)',
    closedOn: detail.closedOn || null,
    bid: round2(bid),
    unapprovedHours,
    bidSource: source,
    regHours: round2(regHours),
    warrHours: round2(warrHours),
    saved: round2(saved),
    multiplier,
    bonusHours,
    lossHours,
    warrantyDeduction,
    distribution,
    lossDistribution,
    regByUser: Object.fromEntries(Object.entries(regByUser).map(([u, m]) => [u, round2(m / 60)])),
    flags,
  };
}

// ===========================================================================
// Report assembly
// ===========================================================================

function buildReport(data, cfg, year) {
  const tz = cfg.timeZone;
  const jobs = data.jobs;

  const repKeys = new Set(cfg.reps);

  const months = [];
  for (let m = 1; m <= 12; m++) {
    months.push({
      month: m,
      name: monthName(m - 1),
      revenueByRep: {},
      revenueTotal: 0,
      salesCommissionByRep: {},
      salesCommissionTotal: 0,
      productionCommission: 0,
    });
  }
  const monthAt = (m) => months[m - 1];

  // ---- Revenue: paid customer invoices, bucketed by payment date ----------
  for (const row of data.revenueRows) {
    const ym = toYearMonth(row.paidAt, tz);
    if (!ym || ym.year !== year) continue;
    const job = jobs.get(row.jobId);
    const rep = (job && job.rep) || 'Unassigned';
    repKeys.add(rep);
    const mo = monthAt(ym.month);
    addTo(mo.revenueByRep, rep, row.amount);
    mo.revenueTotal += row.amount;
  }

  // ---- Sales commission: budget line items, recognized on job close -------
  const salesCommissionDetail = [];
  let openSalesCommission = 0;
  const salesByJob = sumLinesByJob(data.salesCommissionLines);
  for (const [jobId, total] of salesByJob) {
    const job = jobs.get(jobId);
    if (!job || total === 0) continue;
    const ym = recognitionMonth(job, tz);
    if (!ym || ym.year !== year) {
      openSalesCommission += total;
      continue;
    }
    const rep = job.rep || 'Unassigned';
    repKeys.add(rep);
    const mo = monthAt(ym.month);
    addTo(mo.salesCommissionByRep, rep, total);
    mo.salesCommissionTotal += total;

    const { rate, cap } = capFor(rep, job.price, cfg);
    salesCommissionDetail.push({
      month: ym.month,
      jobId,
      number: job.number,
      name: job.name,
      rep,
      jobPrice: job.price,
      lineTotal: round2(total),
      capRate: rate,
      cap,
      overCap: cap != null && total > cap + EPSILON,
    });
  }

  // ---- Production commission (Derek): 2% of jobs closed AND fully paid ----
  const pc = cfg.productionCommission;
  const fullyPaidJobIds = data.fullyPaidJobIds || new Set();
  const productionDetail = [];
  if (pc && pc.rate) {
    repKeys.add(pc.rep);
    for (let m = 1; m <= 12; m++) {
      let base = 0;
      let jobsCount = 0;
      for (const job of jobs.values()) {
        const ym = recognitionMonth(job, tz);
        if (!ym || ym.year !== year || ym.month !== m) continue;
        if (!fullyPaidJobIds.has(job.id)) continue;
        if (pc.scope === 'own' && job.rep !== pc.rep) continue;
        base += typeof job.price === 'number' ? job.price : 0;
        jobsCount += 1;
      }
      const amount = round2(base * pc.rate);
      monthAt(m).productionCommission = amount;
      productionDetail.push({ month: m, base: round2(base), jobsCount, amount });
    }
  }

  // ---- Efficiency bonus ---------------------------------------------------
  const bonusJobs = [];
  const empSet = new Set();
  for (const detail of data.bonusJobDetails || []) {
    const res = computeJobBonus(detail, cfg);
    const ym = res.closedOn ? toYearMonth(res.closedOn, tz) : null;
    res.month = ym && ym.year === year ? ym.month : null;
    bonusJobs.push(res);
    for (const emp of Object.keys(res.distribution)) empSet.add(emp);
    for (const emp of Object.keys(res.lossDistribution)) empSet.add(emp);
  }
  const employees = [...empSet].sort();
  const byEmployeeMonth = {};
  employees.forEach((e) => (byEmployeeMonth[e] = Array(12).fill(0)));
  const bonusMonthlyTotals = Array(12).fill(0);
  for (const res of bonusJobs) {
    if (!res.month) continue;
    for (const [emp, hrs] of Object.entries(res.distribution)) {
      byEmployeeMonth[emp][res.month - 1] = round3(byEmployeeMonth[emp][res.month - 1] + hrs);
      bonusMonthlyTotals[res.month - 1] = round3(bonusMonthlyTotals[res.month - 1] + hrs);
    }
  }
  const employeeTotals = {};
  let bonusGrand = 0;
  for (const e of employees) {
    employeeTotals[e] = round3(byEmployeeMonth[e].reduce((a, b) => a + b, 0));
    bonusGrand += employeeTotals[e];
  }
  bonusGrand = round3(bonusGrand);

  // Per-employee win/lose comparison: positive = bonus hours on jobs finished
  // under approved time; negative = hours over on jobs that ran long.
  const pos = {};
  const neg = {};
  employees.forEach((e) => { pos[e] = 0; neg[e] = 0; });
  for (const res of bonusJobs) {
    if (!res.month) continue;
    for (const [emp, h] of Object.entries(res.distribution)) pos[emp] = round3(pos[emp] + h);
    for (const [emp, h] of Object.entries(res.lossDistribution)) neg[emp] = round3(neg[emp] + h);
  }
  const employeeSummary = employees
    .map((e) => ({ name: e, positive: round3(pos[e]), negative: round3(neg[e]), net: round3(pos[e] - neg[e]) }))
    .sort((a, b) => b.net - a.net);

  const bonusReview = bonusJobs.filter((r) => r.flags.length > 0);

  const bonus = {
    employees,
    byEmployeeMonth,
    employeeTotals,
    employeeSummary,
    monthlyTotals: bonusMonthlyTotals,
    grandHours: bonusGrand,
    lossHoursTotal: round3(employeeSummary.reduce((s, e) => s + e.negative, 0)),
    warrantyDeductionTotal: round3(bonusJobs.reduce((s, j) => s + (j.warrantyDeduction || 0), 0)),
    jobs: bonusJobs.sort((a, b) => (a.month || 99) - (b.month || 99) || b.bonusHours - a.bonusHours),
    review: bonusReview,
    qualifyingCount: bonusJobs.length,
  };

  // ---- Rep totals ---------------------------------------------------------
  const reps = [...cfg.reps, ...[...repKeys].filter((r) => !cfg.reps.includes(r))];
  const repTotals = {};
  for (const rep of reps) repTotals[rep] = { revenue: 0, salesCommission: 0, productionCommission: 0 };
  for (const mo of months) {
    for (const rep of reps) {
      repTotals[rep].revenue += mo.revenueByRep[rep] || 0;
      repTotals[rep].salesCommission += mo.salesCommissionByRep[rep] || 0;
    }
    if (pc && pc.rep) repTotals[pc.rep].productionCommission += mo.productionCommission;
  }
  for (const rep of reps) {
    repTotals[rep].revenue = round2(repTotals[rep].revenue);
    repTotals[rep].salesCommission = round2(repTotals[rep].salesCommission);
    repTotals[rep].productionCommission = round2(repTotals[rep].productionCommission);
    repTotals[rep].totalCommission = round2(
      repTotals[rep].salesCommission + repTotals[rep].productionCommission
    );
  }

  // Round monthly figures.
  for (const mo of months) {
    for (const rep of reps) {
      if (mo.revenueByRep[rep] != null) mo.revenueByRep[rep] = round2(mo.revenueByRep[rep]);
      if (mo.salesCommissionByRep[rep] != null) mo.salesCommissionByRep[rep] = round2(mo.salesCommissionByRep[rep]);
    }
    mo.revenueTotal = round2(mo.revenueTotal);
    mo.salesCommissionTotal = round2(mo.salesCommissionTotal);
  }

  const grand = {
    revenue: round2(months.reduce((s, m) => s + m.revenueTotal, 0)),
    salesCommission: round2(months.reduce((s, m) => s + m.salesCommissionTotal, 0)),
    productionCommission: round2(months.reduce((s, m) => s + m.productionCommission, 0)),
    bonusHours: bonus.grandHours,
  };

  return {
    year,
    generatedAt: new Date().toISOString(),
    reps,
    months,
    repTotals,
    grand,
    bonus,
    openSalesCommission: round2(openSalesCommission),
    detail: {
      salesCommission: salesCommissionDetail.sort((a, b) => a.month - b.month || a.number - b.number),
      production: productionDetail,
    },
  };
}

module.exports = {
  buildReport,
  capFor,
  recognitionMonth,
  sumLinesByJob,
  computeBidHours,
  splitActual,
  multiplierFor,
  computeJobBonus,
  round2,
  round3,
};
