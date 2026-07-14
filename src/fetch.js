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
 * Fetch customer-invoice totals per job to determine which jobs are fully paid.
 * A job is fully paid when it has been invoiced and the amount paid covers the
 * invoiced total (incl. tax).
 *
 * @returns {Promise<Map<string, {invoiced:number, paid:number, fullyPaid:boolean}>>}
 */
async function fetchInvoiceTotalsByJob(orgId, opts = {}) {
  const EPS = 0.005;
  const nodes = await paginate(
    (page) => ({
      organization: {
        $: { id: orgId },
        documents: {
          $: { size: PAGE_SIZE, page, where: ['type', 'customerInvoice'] },
          nextPage: {},
          nodes: {
            priceWithTax: {},
            amountPaid: {},
            job: { id: {} },
          },
        },
      },
    }),
    ['organization', 'documents'],
    opts
  );

  const byJob = new Map();
  for (const inv of nodes) {
    const jobId = inv.job && inv.job.id;
    if (!jobId) continue;
    const cur = byJob.get(jobId) || { invoiced: 0, paid: 0 };
    cur.invoiced += Number(inv.priceWithTax) || 0;
    cur.paid += Number(inv.amountPaid) || 0;
    byJob.set(jobId, cur);
  }
  for (const v of byJob.values()) {
    v.fullyPaid = v.invoiced > EPS && v.paid >= v.invoiced - EPS;
  }
  return byJob;
}

/**
 * Fetch jobs that qualify for the Efficiency Bonus Program: Sales Status
 * "Project Awarded" and closed within [start, end] (inclusive 'YYYY-MM-DD').
 *
 * @returns {Promise<Array<{id, name, closedOn}>>}
 */
async function fetchQualifyingBonusJobs(orgId, { start, end }, opts = {}) {
  const statusFieldId = config.customFields.salesStatus;
  const status = config.efficiencyBonus.qualifyingSalesStatus;
  return paginate(
    (page) => ({
      organization: {
        $: { id: orgId },
        jobs: {
          $: {
            size: PAGE_SIZE,
            page,
            where: {
              and: [
                ['closedOn', '>=', start],
                ['closedOn', '<=', end],
                [['awarded', 'count'], '>', 0],
              ],
            },
            with: {
              awarded: {
                _: 'customFieldValues',
                $: {
                  where: {
                    and: [[['customField', 'id'], statusFieldId], ['value', status]],
                  },
                },
                count: {},
              },
            },
          },
          nextPage: {},
          nodes: { id: {}, name: {}, closedOn: {} },
        },
      },
    }),
    ['organization', 'jobs'],
    opts
  );
}

/**
 * Fetch the detail needed to score one job's efficiency bonus: the JOB
 * BUDGET's approved time lines (Labor cost type, plus Travel lines in Hours)
 * and the job's time entries. Documents are never consulted — approval bonds
 * a document's quantities to the budget, so the budget is the sole source of
 * truth for approved time.
 *
 * @returns {Promise<{id,name,closedOn, budgetItems:Array, timeEntries:Array,
 *   truncatedBudget:boolean, truncatedTime:boolean}>}
 */
async function fetchBonusJobDetail(orgId, jobId, opts = {}) {
  // Connection page size is capped at 100 by the API.
  const CONN_SIZE = 100;

  const budgetRes = await pave(
    {
      job: {
        $: { id: jobId },
        id: {},
        number: {},
        name: {},
        closedOn: {},
        costItems: {
          $: {
            size: CONN_SIZE,
            where: {
              and: [
                [['document', 'id'], '=', null], // budget lines only
                [['costType', 'id'], 'in', [config.laborCostTypeId, config.travelCostTypeId]],
              ],
            },
          },
          nextPage: {},
          nodes: {
            name: {},
            quantity: {},
            costType: { id: {} },
            unit: { name: {} },
            // A budget line is APPROVED when it is bonded to >= 1 approved
            // document. Unapproved lines (draft/denied estimates) are excluded
            // from bid hours.
            approvedDocs: {
              _: 'documentCostItems',
              $: { where: [['document', 'status'], 'approved'] },
              count: {},
            },
          },
        },
      },
    },
    opts
  );

  const job = budgetRes.job || {};
  const itemNodes = (job.costItems && job.costItems.nodes) || [];
  const budgetItems = itemNodes.map((ci) => ({
    name: ci.name,
    quantity: ci.quantity,
    costTypeId: ci.costType && ci.costType.id,
    unitName: ci.unit && ci.unit.name ? ci.unit.name : null,
    approved: !!(ci.approvedDocs && ci.approvedDocs.count > 0),
  }));

  // Time entries — paginate (up to 100 per page).
  const teNodes = await paginate(
    (page) => ({
      job: {
        $: { id: jobId },
        timeEntries: {
          $: { size: CONN_SIZE, page, sortBy: [{ field: 'startedAt', order: 'asc' }] },
          nextPage: {},
          nodes: { minutes: {}, startedAt: {}, user: { name: {} } },
        },
      },
    }),
    ['job', 'timeEntries'],
    opts
  );
  const timeEntries = teNodes.map((te) => ({
    minutes: te.minutes,
    startedAt: te.startedAt,
    user: te.user && te.user.name ? te.user.name : 'Unknown',
  }));

  return {
    id: job.id || jobId,
    number: job.number != null ? job.number : null,
    name: job.name || '(unnamed)',
    closedOn: job.closedOn || null,
    budgetItems,
    timeEntries,
    truncatedBudget: !!(job.costItems && job.costItems.nextPage),
    truncatedTime: false, // time entries are fully paginated
  };
}

module.exports = {
  fetchJobs,
  fetchPaidInvoiceRevenue,
  fetchCommissionLines,
  fetchInvoiceTotalsByJob,
  fetchQualifyingBonusJobs,
  fetchBonusJobDetail,
  PAGE_SIZE,
};
