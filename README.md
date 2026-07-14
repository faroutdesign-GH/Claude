# Far Out Design — Sales, Commission & Bonus Reports

Generates monthly **sales, commission, and efficiency‑bonus reports** for Far Out
Design inc directly from live JobTread data (the Pave JSON‑graph API). Produces an
HTML dashboard and CSV exports for a calendar year, covering paid‑invoice revenue,
sales commissions, Derek's production commission, and the technician **Efficiency
Bonus Program** (bonus hours for finishing jobs under their labor bid).

## Quick start

```bash
# 1. Set your JobTread grant key
cp .env.example .env         # then edit .env and paste your grant key

# 2. Generate the current year's report
npm run report               # == node generate-report.js

# 3. Or pick a year / output folder
node generate-report.js --year=2026 --out=out --json
```

### Technician efficiency bonus (monthly, one command)

For the **field-technician efficiency bonus only** — no sales, revenue, or
commission content — run the dedicated monthly report straight from live data:

```bash
npm run bonus                            # last complete month
node technician-bonus.js --year=2026 --month=6
```

It writes `technician-bonus-<year>-<mm>.html` (payroll summary, jobs-to-review,
all qualifying jobs) plus the two `efficiency-bonus-*.csv` files to
`./out/technician-bonus-<year>-<mm>/`. Multiply each technician's hours by their
wage in payroll. Jobs with approved time but no logged time earn nothing and are
flagged to fix the time entries.

Outputs land in `./out/`:

| File | Contents |
| --- | --- |
| `sales-commission-<year>.html` | Full dashboard — open in any browser |
| `monthly-summary.csv` | One row per month per rep (revenue + commissions) |
| `sales-commission-detail.csv` | Every salesman‑commission line item, with cap flags |
| `production-commission-detail.csv` | Derek's 2% production commission per month |
| `efficiency-bonus-by-employee.csv` | Payable bonus hours per technician per month |
| `efficiency-bonus-jobs.csv` | Per‑job efficiency‑bonus detail, with flags |
| `report-<year>.json` | Raw report object (only with `--json`) |

### Getting a grant key

The report authenticates with a JobTread **Pave grant key**. Create or copy one from
JobTread (Settings → API / Pave), then put it in `.env` as `JOBTREAD_GRANT_KEY`. The
key is read from `.env` or the environment and is never committed (`.env` is gitignored).

## How the numbers are built

All figures are bucketed into months using the `America/New_York` timezone (configurable).

### Sales / revenue — *paid customer invoices*
Money **actually collected**: payments applied to customer invoices, bucketed by the
payment date and attributed to the invoice's job's **Sales Rep**.

### Sales commission — *budget line item, recognized on job close*
Sales commission is entered by hand as a **"Salesman Commission"** (cost code `03`)
budget line item, so the report reports the **actual line‑item total** per job. It is
recognized in the month the job is marked **closed** (`closedOn`).

The policy **cap** is shown for reference and any line above cap is flagged:

| Rep | Cap policy |
| --- | --- |
| Ben | 5% of job price under $10,000; 7% at/over $10,000 |
| Derek | 5% of job price |
| Curtice | 5% (default — no stated policy) |

### Production commission — *Derek, computed*
2% of the price of **jobs that are closed and fully paid in the month**, attributed to
Derek and (per policy) paid out the following month. A job qualifies once it is marked
closed (treated as completed) **and** its customer invoices are fully collected. This is
**not** a line item — it is computed here.

### Efficiency bonus hours — *Efficiency Bonus Program*
Technicians earn bonus **hours** for finishing a job under its bid labor hours. The
report outputs hours; payroll multiplies by each technician's own wage.

Qualifying jobs are **Sales Status "Project Awarded" and closed in the month**.

```
bid        = Σ labor cost-item quantity, from the approved order
             + additive change orders  (exact duplicate copies counted once)
regular    = time entries dated on/before the close date
warranty   = time entries dated after the close date
saved      = bid − regular
multiplier = 1.1  when 6 ≤ saved ≤ 15   else 1.0   (0 if saved ≤ 0)
rawBonus   = max(0, saved) × multiplier
penalty    = warranty hours × 1.5
netBonus   = max(0, rawBonus − penalty)
```

- **Bid** uses the **"Labor" cost type**, so it captures every labor line regardless
  of cost code. The "N Technician" text in a line name is a **label, not a multiplier**.
- Change orders are **additive** (summed). Any job with more than one distinct order
  is **flagged "Multiple orders — verify bid"** so the office manager can confirm the
  bid before paying (this catches accidental duplicate re‑issues).
- **Net bonus is split** across the technicians who logged regular time, by each one's
  share of regular minutes.
- Jobs are **flagged** for: no time logged, no labor bid, bid taken from an invoice,
  no close date, actual < 50% of bid (likely unlogged time), or truncated data. Review
  these before paying — see the "Jobs to review" section of the dashboard.

## Assumptions & knobs

These choices are encoded in [`config.js`](./config.js) — change them there, re‑run,
done. The ones most worth confirming with the business:

1. **Commission recognition = job close date.** A job must be marked *closed* in
   JobTread to appear in a month's sales‑commission and bonus totals. Commission
   lines on jobs not yet closed are summed separately and reported as "open" so
   nothing is silently dropped.
2. **Production commission base = all jobs closed *and fully paid* that month**
   (`scope: 'company'`). "Fully paid" means the job's customer invoices are fully
   collected (`amountPaid ≥ priceWithTax`); "completed" is taken to be the closed
   state. If Derek's 2% is meant to apply only to jobs where he is the rep, set
   `productionCommission.scope = 'own'`.
3. **Sales‑commission caps are advisory.** The report never overrides the entered
   line item; it only flags lines above the policy cap.
4. **Bonus is reported in hours, not dollars.** Payroll multiplies the payable bonus
   hours by each technician's wage — wages are not read from JobTread.
5. **Change orders are additive**, and the bonus multiplier boosts from 6 hours saved
   (set `efficiencyBonus.multiplier.boostMinSaved = 7` if the intended floor is 7).
   Very large savings (> 15 hrs) fall back to ×1.0, since they usually mean unlogged
   time rather than real efficiency.
6. **Revenue = collected cash** (paid invoices), so revenue timing and
   commission‑on‑close timing are intentionally on different clocks.

All JobTread ids (cost codes, custom fields, org) are resolved and pinned in
`config.js`; update them there if you rename or add these in JobTread.

## Project layout

```
config.js            Org id, JobTread ids, and all commission rules
generate-report.js   CLI: fetch → compute → write HTML + CSV
src/pave.js          Pave API client (query + pagination)
src/fetch.js         Data fetch + normalization
src/compute.js       Pure report math (unit tested)
src/render.js        HTML dashboard + CSV rendering
src/dates.js         Timezone‑aware month bucketing
test/compute.test.js Unit tests for the commission math
```

## Tests

```bash
npm test        # node --test — verifies the commission math end to end
```

The compute layer is pure (data in → report out), so the tests run without any API
access. The data‑fetch queries were validated against the live Far Out Design
organization.

## Requirements

Node.js 18+ (uses built‑in `fetch` and the `node:test` runner). No dependencies.
