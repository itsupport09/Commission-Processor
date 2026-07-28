import { parseNum, toISODate, norm } from './parse';
import { STAGE, VARIANCE_THRESHOLD } from '../config';

export const isCloudVoice = t => /cloud\s*voice|^cv$/i.test(String(t || ''));
export const isBroadband  = t => /broadband|\bcve\b|fttp|btnet|\bbb\b/i.test(String(t || ''));

/**
 * Excel rows -> one row per Pipedrive deal to update.
 * Cloud Voice  : grouped by QB Code, matched in Pipedrive on QB Code.
 * Broadband/CVE: grouped by BT Order Ref, matched on BT Order Ref, Payment 1 only.
 */
export function buildRows(dataRows, map) {
  const get = (r, k) => (map[k] ? r[map[k]] : '');

  const recs = dataRows.map(r => ({
    btOrderRef:  String(get(r, 'btOrderRef') || '').trim(),
    qbCode:      String(get(r, 'qbCode') || '').trim(),
    org:         String(get(r, 'org') || '').trim(),
    productType: String(get(r, 'productType') || '').trim(),
    orderType:   String(get(r, 'orderType') || '').trim(),
    invoiceDate: toISODate(get(r, 'invoiceDate')),
    commission:  parseNum(get(r, 'commission')),
    dealTotal:   parseNum(get(r, 'dealTotal')),
  })).filter(r => r.qbCode || r.btOrderRef);

  const out = [];

  const group = (list, keyOf, product, matchField) => {
    const buckets = new Map();
    list.forEach(r => {
      const k = keyOf(r);
      if (!k) return;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    });
    buckets.forEach((rows, key) => {
      rows.sort((a, b) => (a.invoiceDate || '').localeCompare(b.invoiceDate || ''));
      const latest = rows[rows.length - 1];
      out.push({
        id: `${product}:${key}`,
        product,
        matchField,
        matchKey: key,
        org: latest.org,
        notes: latest.orderType,
        amount: +rows.reduce((s, r) => s + r.commission, 0).toFixed(2),
        invoiceDate: latest.invoiceDate,
        dealTotal: latest.dealTotal,
        sourceRows: rows.length,
        // filled in during Pipedrive matching
        dealId: null, dealTitle: '', pipelineId: null,
        slot: null, existingP1: null, existingP2: null,
        variancePct: null, currentStage: null, newStage: null,
        status: 'pending', error: '',
      });
    });
  };

  group(recs.filter(r => isCloudVoice(r.productType)), r => r.qbCode, 'Cloud Voice', 'QB Code');
  group(recs.filter(r => !isCloudVoice(r.productType) && isBroadband(r.productType)),
        r => r.btOrderRef, 'Broadband', 'BT Order Ref');

  out.sort((a, b) => a.product.localeCompare(b.product) || a.org.localeCompare(b.org));
  return out;
}

/**
 * Payment Stage rules.
 *  CV : Cancelled note -> Order Cancelled
 *       In Progress / 50% note -> Part Payment 50%
 *       Order Complete + Full commission -> variance > 95 ? Complete : Discrepancy
 *  BB/CVE : variance > 95 ? Complete : Discrepancy
 */
export function resolveStage(product, notes, variancePct) {
  const n = norm(notes);
  const v = Number(variancePct);

  if (product === 'Cloud Voice') {
    if (n.includes('cancel')) return STAGE.cancelled;
    if (n.includes('inprogress') || n.includes('50')) return STAGE.part;
    if (n.includes('ordercomplete') || n.includes('fullcommission')) {
      if (!Number.isFinite(v)) return null;
      return v > VARIANCE_THRESHOLD ? STAGE.complete : STAGE.discrepancy;
    }
    return null; // unmatched note -> leave for manual review
  }

  if (!Number.isFinite(v)) return null;
  return v > VARIANCE_THRESHOLD ? STAGE.complete : STAGE.discrepancy;
}
