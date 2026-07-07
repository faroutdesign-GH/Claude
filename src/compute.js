'use strict';

const { toYearMonth, monthName } = require('./dates');

const EPSILON = 0.005; // half a cent, for cap comparisons

function addTo(obj, key, amount) {
  obj[key] = (obj[key] || 0) + amount;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
  // First tier whose maxJobPrice the price does not exceed; else the last tier.
  const tier = tiers.find((t) => price <= t.maxJobPrice) || tiers[tiers.length - 1];
  const cap = typeof jobPrice === 'number' ? round2(jobPrice * tier.rate) : null;
  return { rate: tier.rate, cap };
}

/**
 * Month (1-12) in which a job's commission/bonus is recognized: the month the
 * job is marked closed. Jobs without a close date are treated as still open and
 * excluded from the monthly figures (surfaced separately as "open").
 */
function recognitionMonth(job, tz) {
  if (!job || !job.closedOn) return null;
  return toYearMonth(job.closedOn, tz);
}

/**
 * Aggregate commission line items to a per-job total (using the line `cost`,
 * which is the commission dollar amount).
 */
function sumLinesByJob(lines) {
  const byJob = new Map();
  for (const l of lines) {
    byJob.set(l.jobId, (byJob.get(l.jobId) || 0) + (Number(l.cost) || 0));
  }
  return byJob;
}

/**
 * Build the full monthly sales & commission report.
 *
 * @param {object} data
 *   - jobs: Map<jobId, {id,name,number,rep,closedOn,price}>
 *   - revenueRows: Array<{jobId, amount, paidAt}>
 *   - salesCommissionLines: Array<{jobId, cost, price}>
 *   - leadCommissionLines: Array<{jobId, cost, price}>
 *   - laborByJob: Map<jobId, {bidPersonHours, actualHours, techs:Map<name,{hours,hourlyRate}>}>
 * @param {object} cfg  the config module
 * @param {number} year
 */
function buildReport(data, cfg, year) {
  const tz = cfg.timeZone;
  const jobs = data.jobs;

  const repKeys = new Set(cfg.reps);
  const techKeys = new Set();

  const months = [];
  for (let m = 1; m <= 12; m++) {
    months.push({
      month: m,
      name: monthName(m - 1),
      revenueByRep: {},
      revenueTotal: 0,
      salesCommissionByRep: {},
      salesCommissionTotal: 0,
      productionCommission: 0, // attributed to cfg.productionCommission.rep
      bonusHoursByTech: {}, // payable bonus hours (multiplier already applied)
      bonusHoursTotal: 0,
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
  let openSalesCommission = 0; // lines on jobs not closed in this year
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
  // Base = price of jobs that are closed (treated as completed) and fully paid,
  // recognized in the month they closed. `fullyPaidJobIds` gates on payment.
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
        if (!fullyPaidJobIds.has(job.id)) continue; // must be paid (and completed)
        if (pc.scope === 'own' && job.rep !== pc.rep) continue;
        const price = typeof job.price === 'number' ? job.price : 0;
        base += price;
        jobsCount += 1;
      }
      const amount = round2(base * pc.rate);
      monthAt(m).productionCommission = amount;
      productionDetail.push({ month: m, base: round2(base), jobsCount, amount });
    }
  }

  // ---- Technician bonus hours ---------------------------------------------
  // Output is BONUS HOURS (with the multiplier applied), not dollars — payroll
  // multiplies by each technician's wage. If a job's bonus exceeds the
  // threshold, all of its bonus hours are paid at the multiplier.
  const bh = cfg.bonusHours;
  const bonusDetail = [];
  for (const [jobId, labor] of data.laborByJob) {
    const job = jobs.get(jobId);
    if (!job) continue;
    const ym = recognitionMonth(job, tz);
    if (!ym || ym.year !== year) continue;

    const rawBonusHours = labor.bidPersonHours - labor.actualHours;
    if (!(rawBonusHours > 0)) continue;

    const multiplier = rawBonusHours > bh.thresholdHours ? bh.multiplier : bh.baseMultiplier;

    // Distribute bonus hours across the techs who clocked time, by their share.
    let totalTechHours = 0;
    for (const t of labor.techs.values()) totalTechHours += t.hours;
    if (totalTechHours <= 0) continue; // no clocked time -> unknown who worked

    const mo = monthAt(ym.month);
    for (const [name, t] of labor.techs) {
      const share = t.hours / totalTechHours;
      const rawShareHours = rawBonusHours * share;
      const payableHours = round2(rawShareHours * multiplier);
      if (payableHours === 0) continue;
      techKeys.add(name);
      addTo(mo.bonusHoursByTech, name, payableHours);
      mo.bonusHoursTotal += payableHours;
      bonusDetail.push({
        month: ym.month,
        jobId,
        number: job.number,
        name: job.name,
        tech: name,
        bidPersonHours: round2(labor.bidPersonHours),
        actualHours: round2(labor.actualHours),
        bonusHours: round2(rawShareHours),
        multiplier,
        payableHours,
      });
    }
  }

  // ---- Totals -------------------------------------------------------------
  const reps = [...cfg.reps, ...[...repKeys].filter((r) => !cfg.reps.includes(r))];
  const techs = [...techKeys].sort();

  const repTotals = {};
  for (const rep of reps) {
    repTotals[rep] = { revenue: 0, salesCommission: 0, productionCommission: 0 };
  }
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

  // techTotals are payable bonus HOURS per technician.
  const techTotals = {};
  for (const tech of techs) techTotals[tech] = 0;
  for (const mo of months) {
    for (const tech of techs) techTotals[tech] += mo.bonusHoursByTech[tech] || 0;
  }
  for (const tech of techs) techTotals[tech] = round2(techTotals[tech]);

  // Round month figures for presentation.
  for (const mo of months) {
    for (const rep of reps) {
      if (mo.revenueByRep[rep] != null) mo.revenueByRep[rep] = round2(mo.revenueByRep[rep]);
      if (mo.salesCommissionByRep[rep] != null) {
        mo.salesCommissionByRep[rep] = round2(mo.salesCommissionByRep[rep]);
      }
    }
    for (const tech of techs) {
      if (mo.bonusHoursByTech[tech] != null) mo.bonusHoursByTech[tech] = round2(mo.bonusHoursByTech[tech]);
    }
    mo.revenueTotal = round2(mo.revenueTotal);
    mo.salesCommissionTotal = round2(mo.salesCommissionTotal);
    mo.bonusHoursTotal = round2(mo.bonusHoursTotal);
  }

  const grand = {
    revenue: round2(months.reduce((s, m) => s + m.revenueTotal, 0)),
    salesCommission: round2(months.reduce((s, m) => s + m.salesCommissionTotal, 0)),
    productionCommission: round2(months.reduce((s, m) => s + m.productionCommission, 0)),
    bonusHours: round2(months.reduce((s, m) => s + m.bonusHoursTotal, 0)),
  };

  return {
    year,
    generatedAt: new Date().toISOString(),
    reps,
    techs,
    months,
    repTotals,
    techTotals,
    grand,
    openSalesCommission: round2(openSalesCommission),
    detail: {
      salesCommission: salesCommissionDetail.sort((a, b) => a.month - b.month || a.number - b.number),
      production: productionDetail,
      bonus: bonusDetail.sort((a, b) => a.month - b.month),
    },
  };
}

module.exports = { buildReport, capFor, recognitionMonth, sumLinesByJob, round2 };
