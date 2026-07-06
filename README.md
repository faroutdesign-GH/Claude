# Far Out Design — Sales & Commission Reports

Generates monthly **sales and commission reports** for Far Out Design inc directly
from live JobTread data (the Pave JSON‑graph API). Produces an HTML dashboard and
CSV exports for a calendar year, covering paid‑invoice revenue, sales commissions,
Derek's production commission, and technician bonus hours.

## Quick start

```bash
# 1. Set your JobTread grant key
cp .env.example .env         # then edit .env and paste your grant key

# 2. Generate the current year's report
npm run report               # == node generate-report.js

# 3. Or pick a year / output folder
node generate-report.js --year=2026 --out=out --json
```

Outputs land in `./out/`:

| File | Contents |
| --- | --- |
| `sales-commission-<year>.html` | Full dashboard — open in any browser |
| `monthly-summary.csv` | One row per month per rep (revenue + commissions) |
| `sales-commission-detail.csv` | Every salesman‑commission line item, with cap flags |
| `production-commission-detail.csv` | Derek's 2% production commission per month |
| `bonus-hours-detail.csv` | Technician bonus hours per job |
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
2% of the price of **jobs closed in the month**, attributed to Derek and (per policy)
paid out the following month. This is **not** a line item — it is computed here.

### Technician bonus hours
Unused labor hours on a closed job become a technician bonus:

```
bonusHours = bidPersonHours − actualClockedHours          (per job, if positive)
payMultiplier = 1.1  if bonusHours > 10   else 1.0
bonusPay = bonusHours × payMultiplier × technician wage
```

- **Bid person‑hours** come from labor cost‑item quantities scaled by crew size
  (`1–4 Technician Labor` codes), falling back to the "Labor Hours" custom field.
- **Actual hours & wage** come from time entries (`minutes`, `hourlyRate`, `user`).
- When multiple technicians worked a job, the bonus is split in proportion to the
  hours each clocked.

## Assumptions & knobs

These choices are encoded in [`config.js`](./config.js) — change them there, re‑run,
done. The ones most worth confirming with the business:

1. **Commission recognition = job close date.** A job must be marked *closed* in
   JobTread to appear in a month's sales‑commission and bonus totals. Commission
   lines on jobs not yet closed are summed separately and reported as "open" so
   nothing is silently dropped.
2. **Production commission base = *all* jobs closed that month** (`scope: 'company'`).
   If Derek's 2% is meant to apply only to jobs where he is the rep, set
   `productionCommission.scope = 'own'`.
3. **Sales‑commission caps are advisory.** The report never overrides the entered
   line item; it only flags lines above the policy cap.
4. **Bonus wage = the time entry's `hourlyRate`** (the labor cost rate logged on the
   entry). If technicians' true wages differ, adjust the source or the config.
5. **Revenue = collected cash** (paid invoices), so revenue timing and
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
