# Market Analysis — Electrical Contracting

An interactive market-analysis dashboard for **Far Out Design inc** (Seminole, FL),
combining the company's own JobTread pipeline data with the external U.S./Florida
electrical-contracting market.

## View it

Open [`index.html`](./index.html) in any browser. It is a single self-contained file
(no build step, no external requests) with a light/dark theme toggle, interactive
charts, and a data-table appendix.

## What's inside

| Section | Content |
|---|---|
| KPI hero | Awarded revenue, projects, avg. job value, gross margin, win rate, accounts |
| 01 Pipeline | Decided outcomes (won vs. lost), active pipeline, dormant leads, win rate |
| 02 Over time | Monthly awarded revenue (area) and job count (columns), Mar 2025 – Jun 2026 |
| 03 Service area | Awarded revenue by sub-region; Pinellas vs. Tampa concentration |
| 04 Where the money is | Revenue & job count by contract-value band (Pareto) |
| 05 Market | U.S./FL market size, demand drivers (EV, generators, heat pumps, solar), pricing, labor |
| 06 How Far Out compares | Gross margin, avg. job, win rate, and scale vs. industry benchmarks |
| 07 Takeaways | Data-driven strategic recommendations |
| Appendix | Full 13-stage pipeline and monthly tables |

## Data & provenance

- **Internal figures** come from the Far Out Design JobTread account (organization
  "Far Out Design inc"), records created **19 Mar 2025 – 6 Jul 2026**. Pulled via the
  JobTread Pave API.
- **"Revenue" and "gross margin"** use each job's *projected price* and *projected
  cost* (the contracted/estimated values in JobTread) as a proxy for booked revenue
  and margin — not audited financials. Actual invoiced amounts and true net profit
  will differ.
- **"Awarded"** = jobs with Sales Status `Project Awarded` (312 jobs, $761,051 projected
  value). Monthly figures are bucketed by job-created date.
- **Market figures** are third-party estimates (IBISWorld, BLS, Mordor, Grand View,
  NAHB, Plan Hillsborough, Angi/HomeGuide, and others), each cited in the dashboard
  footer with source links.

This dashboard is decision-support, not financial or investment advice.

## Headline internal findings

- **312 awarded projects · $761K projected value · ~$2,440 avg job · 57.1% gross margin**
- **56.6% win rate** among decided opportunities; **1,165 imported leads** sit untouched
- **~83% of revenue is in Pinellas County**; Hillsborough/Tampa is the growth edge
- **$5K+ projects are ~12% of jobs but 51% of revenue** — the top growth lever
