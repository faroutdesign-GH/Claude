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

/** Sum labor quantities on a document (ignoring null quantities). */
function docLaborQty(doc) {
  let total = 0;
  for (const li of doc.laborItems || []) {
    if (li.quantity != null && !Number.isNaN(Number(li.quantity))) total += Number(li.quantity);
  }
  return total;
}

/** Signature to detect exact-duplicate document copies. */
function docSignature(doc) {
  const items = (doc.laborItems || [])
    .map((li) => `${li.name}=${li.quantity}`)
    .sort()
    .join('|');
  return `${doc.issueDate || ''}::${items}`;
}

/**
 * Compute bid labor hours for a job from its approved documents.
 *
 * Priority: approved customerOrders (summed — change orders are additive),
 * falling back to the latest approved customerInvoice only if no order has
 * labor. Exact-duplicate document copies are counted once. A job with more than
 * one distinct order is flagged (MULTIPLE_ORDERS) for a quick manual check.
 *
 * @returns {{bid:number, source:string, flags:string[]}}
 */
function computeBidHours(documents) {
  const flags = [];
  const orders = documents.filter((d) => d.type === 'customerOrder');
  const invoices = documents.filter((d) => d.type === 'customerInvoice');
  const hasLabor = (d) => (d.laborItems || []).some((li) => li.quantity != null);

  const usableOrders = orders.filter(hasLabor);
  if (usableOrders.length) {
    // Earliest distinct order = base; later distinct orders = additive change orders.
    const sorted = usableOrders.slice().sort((a, b) => (a.issueDate || '').localeCompare(b.issueDate || ''));
    const seen = new Set();
    let base = null;
    let changeTotal = 0;
    let distinctCount = 0;
    for (const d of sorted) {
      const sig = docSignature(d);
      if (seen.has(sig)) continue; // duplicate document copy — do not sum
      seen.add(sig);
      distinctCount += 1;
      if (base === null) base = d;
      else changeTotal += docLaborQty(d);
    }
    const bid = docLaborQty(base) + changeTotal;
    const label = 'Contract/Proposal' + (changeTotal ? ' + change orders' : '');
    if (distinctCount > 1) flags.push('MULTIPLE_ORDERS');
    return { bid: round2(bid), source: label, flags };
  }

  const usableInvoices = invoices.filter(hasLabor);
  if (usableInvoices.length) {
    const sorted = usableInvoices.slice().sort((a, b) => (a.issueDate || '').localeCompare(b.issueDate || ''));
    flags.push('INVOICE_BID');
    return { bid: round2(docLaborQty(sorted[sorted.length - 1])), source: 'Invoice (no order found)', flags };
  }

  flags.push('NO_BID');
  return { bid: 0, source: 'No labor bid found', flags };
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

/** Bonus multiplier for hours saved. */
function multiplierFor(saved, cfg) {
  if (saved <= 0) return 0;
  const m = cfg.efficiencyBonus.multiplier;
  if (saved >= m.boostMinSaved && saved <= m.boostMaxSaved) return m.boosted;
  return m.standard;
}

/**
 * Score one job's efficiency bonus.
 * @param {object} detail  {id,name,closedOn,documents,timeEntries,truncated*}
 * @returns {object} per-job result
 */
function computeJobBonus(detail, cfg) {
  const eb = cfg.efficiencyBonus;
  const { bid, source, flags: bidFlags } = computeBidHours(detail.documents || []);
  const { regByUser, regTotalMin, warrTotalMin, flags: splitFlags } = splitActual(
    detail.timeEntries || [],
    detail.closedOn
  );

  const regHours = regTotalMin / 60;
  const warrHours = warrTotalMin / 60;
  const saved = bid - regHours;
  const multiplier = multiplierFor(saved, cfg);
  const rawBonus = Math.max(0, saved) * multiplier;
  const penalty = warrHours * eb.warrantyPenaltyRate;
  const netBonus = Math.max(0, rawBonus - penalty);

  const distribution = {};
  if (netBonus > 0 && regTotalMin > 0) {
    for (const [user, mins] of Object.entries(regByUser)) {
      distribution[user] = round3(netBonus * (mins / regTotalMin));
    }
  }

  const flags = [...bidFlags, ...splitFlags];
  if (regTotalMin === 0) flags.push('NO_TIME');
  if (saved > 0 && bid > 0 && regHours > 0 && regHours < bid * eb.lowActualFlagRatio) {
    flags.push('CHECK_LOW_ACTUAL');
  }
  if (detail.truncatedTime || detail.truncatedDocuments) flags.push('DATA_TRUNCATED');

  return {
    id: detail.id,
    name: detail.name || '(unnamed)',
    closedOn: detail.closedOn || null,
    bid: round2(bid),
    bidSource: source,
    regHours: round2(regHours),
    warrHours: round2(warrHours),
    saved: round2(saved),
    multiplier,
    rawBonus: round3(rawBonus),
    penalty: round3(penalty),
    netBonus: round3(netBonus),
    distribution,
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
  const bonusReview = bonusJobs.filter((r) => r.flags.length > 0);

  const bonus = {
    employees,
    byEmployeeMonth,
    employeeTotals,
    monthlyTotals: bonusMonthlyTotals,
    grandHours: bonusGrand,
    jobs: bonusJobs.sort((a, b) => (a.month || 99) - (b.month || 99) || b.netBonus - a.netBonus),
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
