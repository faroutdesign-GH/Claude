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
  // "Travel" cost TYPE — travel lines count toward bid hours ONLY when the
  // line's unit is Hours (some travel lines are miles/dollars).
  travelCostTypeId: '22P7hfGjakPi',
  hoursUnitName: 'Hours',

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
  // under its approved bid time. The report outputs bonus hours; payroll
  // multiplies by each technician's own wage. Rules (confirmed with ownership,
  // 2026-07):
  //
  //   Qualifying   = Sales Status "Project Awarded" AND closed in the month.
  //   Bid hours    = APPROVED TIME on the JOB BUDGET, and nothing else.
  //                  Documents are irrelevant — approval bonds a document's
  //                  quantities to the budget, so the budget already reflects
  //                  all approved time, additively (base + change orders).
  //                  Counted lines: Labor cost-type quantities, plus Travel
  //                  cost-type quantities whose unit is Hours (travel lines in
  //                  miles/dollars are ignored). Since the mid-April catalog
  //                  revision, "2 Technician" items carry a formula that
  //                  multiplies person-hours in, so quantity is used as-is.
  //   Actual (reg) = time entries dated on/before the close date.
  //   Warranty     = time entries after the close date. NOT deducted — recorded
  //                  as its own line at warrantyRate (deterrent; ownership
  //                  manually docks it only if the follow-up was negligence).
  //   Saved        = bid − regular actual. If <= 0, no bonus (group loss).
  //   Multiplier   = saved <= boostOverSaved hrs -> standard (1.0x);
  //                  saved  > boostOverSaved hrs -> boosted  (1.1x).
  //   Bonus hours  = max(0, saved) × multiplier, split across the technicians
  //                  who logged regular time by their share of minutes
  //                  (group bonus).
  efficiencyBonus: {
    qualifyingSalesStatus: 'Project Awarded',
    multiplier: {
      standard: 1.0,
      boosted: 1.1,
      boostOverSaved: 6, // strictly more than 6 hrs saved pays 1.1x
    },
    warranty: {
      rate: 1.5, // recorded deduction rate; applied manually, never automatic
    },
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
