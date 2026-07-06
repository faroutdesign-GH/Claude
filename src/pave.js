'use strict';

/**
 * Minimal client for the JobTread Pave API.
 *
 * Pave is a JSON-graph API: you POST a query object describing the shape of the
 * data you want and get back the same shape filled in. Auth is a grant key
 * placed on the query root under the special "$" key.
 *
 * Docs: https://docs.jobtread.com/pave
 */

const PAVE_ENDPOINT = process.env.JOBTREAD_PAVE_ENDPOINT || 'https://api.jobtread.com/pave';

class PaveError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PaveError';
    this.details = details;
  }
}

function getGrantKey() {
  const key = process.env.JOBTREAD_GRANT_KEY;
  if (!key) {
    throw new PaveError(
      'Missing JOBTREAD_GRANT_KEY. Copy .env.example to .env and set your grant key, ' +
        'or export JOBTREAD_GRANT_KEY in the environment.'
    );
  }
  return key;
}

/**
 * Execute a Pave query. `fields` is the query object WITHOUT the root "$"
 * (grantKey) — this function injects auth and optional request options.
 *
 * @param {object} fields  query fields, e.g. { organization: { $: {...}, ... } }
 * @param {object} [opts]  { grantKey, timeZone, fetchImpl }
 * @returns {Promise<object>} the query result
 */
async function pave(fields, opts = {}) {
  const grantKey = opts.grantKey || getGrantKey();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new PaveError('No fetch implementation available. Use Node 18+ or pass opts.fetchImpl.');
  }

  const root = { $: { grantKey } };
  if (opts.timeZone) root.$.timeZone = opts.timeZone;
  Object.assign(root, fields);

  let res;
  try {
    res = await fetchImpl(PAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: root }),
    });
  } catch (err) {
    throw new PaveError(`Network error calling Pave API: ${err.message}`, err);
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new PaveError(`Pave API returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new PaveError(`Pave API HTTP ${res.status}`, body);
  }
  if (body.error || body.errors) {
    throw new PaveError('Pave API returned an error', body.error || body.errors);
  }
  return body;
}

/**
 * Page through a connection (a field that returns { nodes, nextPage }).
 *
 * @param {(page: string|undefined) => object} buildQuery  builds the full query
 *        fields for a given page token; the connection must live at `path`.
 * @param {string[]} path  keys from the query root down to the connection
 *        object, e.g. ['organization', 'jobs'].
 * @param {object} [opts]  passed to pave(); plus { pageSize } used by callers.
 * @returns {Promise<object[]>} all nodes concatenated across pages
 */
async function paginate(buildQuery, path, opts = {}) {
  const all = [];
  let page;
  // Hard stop to avoid runaway loops on unexpected API behavior.
  for (let guard = 0; guard < 10000; guard++) {
    const result = await pave(buildQuery(page), opts);
    const connection = path.reduce((node, key) => (node == null ? node : node[key]), result);
    if (!connection) break;
    if (Array.isArray(connection.nodes)) all.push(...connection.nodes);
    if (!connection.nextPage) break;
    page = connection.nextPage;
  }
  return all;
}

module.exports = { pave, paginate, getGrantKey, PaveError, PAVE_ENDPOINT };
