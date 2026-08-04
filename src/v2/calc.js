import { norm } from '../lib/parse';
import { STAGE, VARIANCE_THRESHOLD } from '../config';

/**
 * Payment Stage rules for V2.
 *
 * Deliberately a COPY of the V1 implementation in src/lib/calc.js rather than an
 * import: the two versions read different variance fields (V1 "Payment Variance %",
 * V2 "New Payment Variance %"), and a future rule change to one must not silently
 * alter the other. Keep the duplication.
 *
 *  Cloud Voice
 *    notes contain "Cancelled"                       -> Order Cancelled (320)
 *    notes contain "In Progress" or "50%"            -> Part Payment 50% (258)
 *    Order Complete + full commission, variance > 95 -> Payment Complete (209)
 *    Order Complete + full commission, variance < 95 -> Discrepancy (211)
 *
 *  Broadband / CVE
 *    variance > 95 -> Payment Complete (209)
 *    variance < 95 -> Discrepancy (211)
 *
 * Exactly 95.00 falls through to Discrepancy. No match returns null, which leaves
 * the dropdown blank and blocks approval on that row.
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
