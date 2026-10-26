import { CALL_DELAY } from '../config';

const PROXY = '/api/pipedrive';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(path, { method = 'GET', params = {}, body } = {}) {
  const qs = new URLSearchParams({ path, ...params });
  const res = await fetch(`${PROXY}?${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok || json.success === false) {
    throw new Error(json.error || json.message || `Pipedrive ${res.status}`);
  }
  await sleep(CALL_DELAY);
  return json.data;
}

/** Search deals by custom-field value (QB Code / BT Order Ref). */
export async function searchDeals(term) {
  const data = await call('/api/v2/deals/search', {
    params: { term, fields: 'custom_fields', limit: 20 },
  });
  return data?.items?.map(i => i.item) ?? [];
}

export function getDeal(id) {
  return call(`/api/v2/deals/${id}`, { params: { include_option_labels: 'true' } });
}

/** Pipedrive is only ever written on won deals. */
export const isWon = deal => deal?.status === 'won';

/**
 * Write custom fields on a deal. The deal's own status has to be passed in and
 * has to be 'won' — an open, lost or deleted deal is never written to, so a
 * missed check upstream throws here instead of changing the CRM.
 */
export async function patchDeal(id, custom_fields, dealStatus) {
  if (!isWon({ status: dealStatus })) {
    throw new Error(`Deal ${id} is ${dealStatus || 'not won'} — Pipedrive is only updated on won deals`);
  }
  return call(`/api/v2/deals/${id}`, { method: 'PATCH', body: { custom_fields } });
}

export const dealUrl = (domain, id) => `${domain}/deal/${id}`;
