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
    // Labor cost codes. Their line-item `quantity` is the *bid* labor hours,
    // and crewSize is how many technicians that code represents (so bid hours
    // are scaled to person-hours to compare against clocked time).
    labor: {
      '22P6fNyvL9ih': { name: 'Hourly Labor', crewSize: 1 },
      '22P7tc3tHm85': { name: '1 Technician Labor', crewSize: 1 },
      '22P7tc6trfuA': { name: '2 Technician Labor', crewSize: 2 },
      '22P7tc9RL53f': { name: '3 Technician Labor', crewSize: 3 },
      '22P8b8ZYvj8w': { name: '4 Technician Labor', crewSize: 4 },
    },
  },

  customFields: {
    salesRep: '22PBgFev6YGS', // "Sales Rep" (option) on job
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

  // Technician bonus hours: unused hours from a job's labor bid, given to the
  // technician(s) who did the physical work. The report outputs BONUS HOURS
  // (payroll multiplies by each technician's own wage) — not dollars.
  //   bonusHours = max(0, bidPersonHours - actualClockedHours)   [per job]
  // If a job's bonus hours exceed `thresholdHours`, every bonus hour on that
  // job counts at `multiplier`; otherwise at `baseMultiplier`. Hours are split
  // across the technicians who worked the job in proportion to hours clocked.
  bonusHours: {
    thresholdHours: 10,
    multiplier: 1.1,
    baseMultiplier: 1.0,
  },

  // ---- Reporting window ---------------------------------------------------
  // Calendar year to report. Overridable with `--year=YYYY` on the CLI.
  defaultYear: new Date().getUTCFullYear(),

  // IANA timezone used to bucket dates into months. Far Out Design is in FL.
  timeZone: 'America/New_York',
};
