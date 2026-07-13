'use strict';

/**
 * Configuration for the Far Out Design sales & commission reports.
 *
 * Every id below was resolved against the live Far Out Design inc JobTread
 * organization (id 22P6fNy3jgsx). If you add/rename cost codes, custom fields,
 * or reps in JobTread, update the matching entry here.
 *
 * The commission RULES encode the policy described by the business. Where the
 * policy leaves something to interpretation, the choice is called out in a
 * comment and in README.md under "Assumptions". Adjust freely — the compute
 * layer reads everything from this object.
 */

const INFINITY = Number.POSITIVE_INFINITY;

module.exports = {
  organizationId: process.env.JOBTREAD_ORG_ID || '22P6fNy3jgsx',

  // Sales reps, matching the "Sales Rep" job custom field options exactly.
  reps: ['Ben', 'Curtice', 'Derek'],

  // ---- JobTread ids -------------------------------------------------------
  costCodes: {
    // "Salesman Commission" (03) — the budget line item that holds the actual
    // sales-commission dollar amount for a job.
    salesCommission: '22P8bPrAtCpM',
    // "Lead Commission" (02) — reported alongside for visibility.
    leadCommission: '22PaBSbbPWZ8',
    // Labor cost codes, for reference. Efficiency-bonus bid hours are derived
    // from the "Labor" cost TYPE (laborCostTypeId) so they capture every labor
    // line regardless of code. A line-item `quantity` is bid hours as written —
    // the "N Technician" label is NOT a multiplier.
    labor: [
      '22P6fNyvL9ih', // Hourly Labor
      '22P7tc3tHm85', // 1 Technician Labor
      '22P7tc6trfuA', // 2 Technician Labor
      '22P7tc9RL53f', // 3 Technician Labor
      '22P8b8ZYvj8w', // 4 Technician Labor
    ],
  },

  // "Labor" cost TYPE — groups every labor line regardless of cost code
  // (Hourly Labor, 1–4 Technician Labor, …). Used for efficiency-bonus bid hours.
  laborCostTypeId: '22P6fNyvL9jH',

  customFields: {
    salesRep: '22PBgFev6YGS', // "Sales Rep" (option) on job
    salesStatus: '22P6fNyvcwAk', // "Sales Status" (option) on job
    laborHours: '22PVW7L4qwNY', // "Labor Hours" (number) on costItem
  },

  // ---- Commission policy --------------------------------------------------

  // Sales commission is entered by hand as a budget line item, so the report
  // reports the ACTUAL line-item total. These caps are the policy ceiling; the
  // report flags any job whose sales-commission line exceeds cap = rate * base.
  // `base` selects what the percentage applies to: 'price' (contract price
  // before tax) or 'priceWithTax'.
  salesCommissionCaps: {
    base: 'price',
    tiers: {
      Ben: [
        { maxJobPrice: 10000, rate: 0.05 },
        { maxJobPrice: INFINITY, rate: 0.07 },
      ],
      Derek: [{ maxJobPrice: INFINITY, rate: 0.05 }],
      // Curtice has no stated cap; 5% is used as a sensible default for flags.
      Curtice: [{ maxJobPrice: INFINITY, rate: 0.05 }],
    },
  },

  // Derek's production commission: 2% based on jobs that are closed, completed,
  // and PAID in the month. Computed (not a budget line item) and reported the
  // following month. A job counts once it is marked closed (treated as
  // completed) AND its customer invoices are fully paid; it is recognized in
  // the month it closed.
  //   scope 'company'  -> 2% of the price of all qualifying jobs that month
  //   scope 'own'      -> only jobs where Derek is the Sales Rep
  // `base` is which price to use ('price' or 'priceWithTax').
  productionCommission: {
    rep: 'Derek',
    rate: 0.02,
    scope: 'company',
    base: 'price',
  },

  // Efficiency Bonus Program — technicians earn bonus HOURS for finishing a job
  // under its bid labor hours. The report outputs bonus hours; payroll multiplies
  // by each technician's own wage. Rules (confirmed with ownership):
  //
  //   Qualifying   = Sales Status "Project Awarded" AND closed in the month.
  //   Bid hours    = SUM of labor cost-item quantity (Labor cost type) from the
  //                  approved documents. Change orders are ADDITIVE — a job's
  //                  base order plus each additional order are summed. Exact
  //                  duplicate document copies are not double-counted, and any
  //                  job with more than one distinct order is flagged for a
  //                  quick manual check. The "N Technician" label in an item
  //                  name is NOT a multiplier. Orders (customerOrder) are
  //                  preferred; an approved invoice is a fallback if no order.
  //   Actual (reg) = time entries dated on/before the close date.
  //   Warranty     = time entries after the close date (penalized).
  //   Saved        = bid − regular actual. If <= 0, no bonus.
  //   Multiplier   = boosted between boostMinSaved..boostMaxSaved hours saved,
  //                  otherwise standard. (Very large savings fall back to
  //                  standard, since they usually mean unlogged time.)
  //   Raw bonus    = max(0, saved) × multiplier
  //   Penalty      = warranty hours × warrantyPenaltyRate
  //   Net bonus    = max(0, raw − penalty)
  //   Split        = by each technician's share of regular minutes.
  efficiencyBonus: {
    qualifyingSalesStatus: 'Project Awarded',
    multiplier: {
      standard: 1.0,
      boosted: 1.1,
      // NOTE: confirm the lower bound — the working script boosts from 6 hrs
      // saved; if the intent is 7, change boostMinSaved to 7.
      boostMinSaved: 6,
      boostMaxSaved: 15,
    },
    warrantyPenaltyRate: 1.5,
    // Flag a job when regular actual is below this fraction of the bid — usually
    // a sign of unlogged time rather than real efficiency.
    lowActualFlagRatio: 0.5,
  },

  // ---- Reporting window ---------------------------------------------------
  // Calendar year to report. Overridable with `--year=YYYY` on the CLI.
  defaultYear: new Date().getUTCFullYear(),

  // IANA timezone used to bucket dates into months. Far Out Design is in FL.
  timeZone: 'America/New_York',
};
