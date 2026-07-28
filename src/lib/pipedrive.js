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

export function patchDeal(id, custom_fields) {
  return call(`/api/v2/deals/${id}`, { method: 'PATCH', body: { custom_fields } });
}

export const dealUrl = (domain, id) => `${domain}/deal/${id}`;
