'use strict';

const { pave, paginate } = require('./pave');
const config = require('../config');

const PAGE_SIZE = 100;

/**
 * Extract the "Sales Rep" value from a job's filtered customFieldValues.
 */
function repFromJobNode(jobNode) {
  const nodes = jobNode.customFieldValues && jobNode.customFieldValues.nodes;
  if (Array.isArray(nodes) && nodes.length && nodes[0].value != null) {
    return String(nodes[0].value);
  }
  return null;
}

/**
 * Fetch every job in the org with the fields the report needs.
 * @returns {Promise<Map<string, {id,name,number,rep,closedOn,price}>>}
 */
async function fetchJobs(orgId, opts = {}) {
  const salesRepId = config.customFields.salesRep;
  const nodes = await paginate(
    (page) => ({
      organization: {
        $: { id: orgId },
        jobs: {
          $: { size: PAGE_SIZE, page },
          nextPage: {},
          nodes: {
            id: {},
            name: {},
            number: {},
            closedOn: {},
            projectedPrice: {},
            customFieldValues: {
              $: { size: 1, where: [['customField', 'id'], salesRepId] },
              nodes: { value: {} },
            },
          },
        },
      },
    }),
    ['organization', 'jobs'],
    opts
  );

  const byId = new Map();
  for (const j of nodes) {
    byId.set(j.id, {
      id: j.id,
      name: j.name,
      number: j.number,
      rep: repFromJobNode(j),
      closedOn: j.closedOn || null,
      price: typeof j.projectedPrice === 'number' ? j.projectedPrice : null,
    });
  }
  return byId;
}

/**
 * Fetch amounts applied to customer INVOICES via payments received in the
 * window. A single payment can be split across several documents, so we walk
 * each payment's documentPayments and keep only the customerInvoice slices.
 *
 * @returns {Promise<Array<{jobId:string, amount:number, paidAt:string}>>}
 */
async function fetchPaidInvoiceRevenue(orgId, { start, end }, opts = {}) {
  const payments = await paginate(
    (page) => ({
      organization: {
        $: { id: orgId },
        payments: {
          $: {
            size: PAGE_SIZE,
            page,
            where: { and: [['paidAt', '>=', start], ['paidAt', '<', end]] },
            sortBy: [{ field: 'paidAt' }],
          },
          nextPage: {},
          nodes: {
            id: {},
            paidAt: {},
            documentPayments: {
              $: { size: 100 },
              nodes: {
                amount: {},
                document: { type: {}, job: { id: {} } },
              },
            },
          },
        },
      },
    }),
    ['organization', 'payments'],
    opts
  );

  const rows = [];
  for (const p of payments) {
    const dps = (p.documentPayments && p.documentPayments.nodes) || [];
    for (const dp of dps) {
      const doc = dp.document;
      if (!doc || doc.type !== 'customerInvoice') continue;
      const jobId = doc.job && doc.job.id;
      if (!jobId) continue;
      rows.push({ jobId, amount: Number(dp.amount) || 0, paidAt: p.paidAt });
    }
  }
  return rows;
}

/**
 * Fetch commission budget line items for a given cost code.
 * @returns {Promise<Array<{jobId:string, cost:number, price:number}>>}
 */
async function fetchCommissionLines(orgId, costCodeId, opts = {}) {
  const nodes = await paginate(
    (page) => ({
      organization: {
        $: { id: orgId },
        costItems: {
          $: {
            size: PAGE_SIZE,
            page,
            where: { and: [[['costCode', 'id'], costCodeId], [['job', 'id'], '!=', null]] },
          },
          nextPage: {},
          nodes: {
            cost: {},
            price: {},
            job: { id: {} },
          },
        },
      },
    }),
    ['organization', 'costItems'],
    opts
  );
  return nodes
    .filter((n) => n.job && n.job.id)
    .map((n) => ({ jobId: n.job.id, cost: Number(n.cost) || 0, price: Number(n.price) || 0 }));
}

/**
 * For a set of jobs, fetch the data needed for the technician bonus-hours
 * calculation: bid labor person-hours (from labor cost-item quantities scaled
 * by crew size) and actual clocked hours per technician (from time entries).
 *
 * Jobs are fetched in aliased batches so one request covers several jobs.
 *
 * @returns {Promise<Map<string, {bidPersonHours:number, actualHours:number,
 *   techs: Map<string,{hours:number, hourlyRate:number}>}>>}
 */
async function fetchJobLaborAndTime(orgId, jobIds, opts = {}) {
  const batchSize = 8;
  const result = new Map();

  for (let i = 0; i < jobIds.length; i += batchSize) {
    const batch = jobIds.slice(i, i + batchSize);
    const fields = {};
    batch.forEach((jobId, idx) => {
      fields[`j${idx}`] = {
        _: 'job',
        $: { id: jobId },
        id: {},
        costItems: {
          $: { size: 300 },
          nodes: {
            quantity: {},
            costCode: { id: {} },
            customFieldValues: {
              $: { size: 5, where: [['customField', 'id'], config.customFields.laborHours] },
              nodes: { value: {} },
            },
          },
        },
        timeEntries: {
          $: { size: 500 },
          nodes: {
            minutes: {},
            hourlyRate: {},
            user: { name: {} },
          },
        },
      };
    });

    const res = await pave(fields, opts);

    for (let idx = 0; idx < batch.length; idx++) {
      const node = res[`j${idx}`];
      if (!node) continue;
      const jobId = node.id;

      // Bid person-hours: sum over labor lines of quantity * crewSize.
      // Prefer the line quantity; fall back to the "Labor Hours" custom field.
      let bidPersonHours = 0;
      const ci = (node.costItems && node.costItems.nodes) || [];
      for (const line of ci) {
        const code = line.costCode && line.costCode.id;
        const laborDef = code && config.costCodes.labor[code];
        if (!laborDef) continue;
        let hours = typeof line.quantity === 'number' ? line.quantity : null;
        if (hours == null) {
          const cfv = (line.customFieldValues && line.customFieldValues.nodes) || [];
          if (cfv.length && cfv[0].value != null) hours = Number(cfv[0].value);
        }
        if (typeof hours === 'number' && !Number.isNaN(hours)) {
          bidPersonHours += hours * laborDef.crewSize;
        }
      }

      // Actual clocked hours per technician.
      const techs = new Map();
      let actualHours = 0;
      const te = (node.timeEntries && node.timeEntries.nodes) || [];
      for (const entry of te) {
        const hrs = (Number(entry.minutes) || 0) / 60;
        actualHours += hrs;
        const name = (entry.user && entry.user.name) || 'Unknown';
        const rate = Number(entry.hourlyRate) || 0;
        const cur = techs.get(name) || { hours: 0, hourlyRate: 0, _rateHours: 0 };
        cur.hours += hrs;
        // Track an hours-weighted average wage in case the rate varies.
        cur._rateHours += rate * hrs;
        techs.set(name, cur);
      }
      for (const t of techs.values()) {
        t.hourlyRate = t.hours > 0 ? t._rateHours / t.hours : 0;
        delete t._rateHours;
      }

      result.set(jobId, { bidPersonHours, actualHours, techs });
    }
  }
  return result;
}

module.exports = {
  fetchJobs,
  fetchPaidInvoiceRevenue,
  fetchCommissionLines,
  fetchJobLaborAndTime,
  PAGE_SIZE,
};
