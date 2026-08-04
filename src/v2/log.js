/**
 * Payment log — the source of truth for V2.
 *
 * "Invoice Amounts & Payment Dates" is a free-text field that people have been
 * hand-typing into for years, so reading it has to be forgiving:
 *
 *     June 2024 - 580
 *     Aug 24 - 1000
 *     nov 24 - -1580
 *
 * Rollup Total Commission Received is always recomputed by parsing the whole
 * log and summing it — never by reading the old rollup and adding to it. If
 * somebody hand-edits a line in Pipedrive, the next run self-corrects.
 *
 * Writing uses one canonical format so future parses stay clean:
 *
 *     23 June 2025 - 508.00
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** ISO yyyy-mm-dd -> "23 June 2025". Returns '' for anything unusable. */
export function formatLogDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return '';
  const [, y, mo, d] = m;
  const name = MONTHS[+mo - 1];
  if (!name) return '';
  return `${+d} ${name} ${y}`;
}

/** Canonical line: "23 June 2025 - 508.00", negatives as "23 August 2025 - -1508.00". */
export function formatLogLine(iso, amount) {
  const label = formatLogDate(iso);
  const n = Number(amount);
  return `${label} - ${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

/**
 * Pull the amount off one line.
 *
 * Splitting on "-" and walking from the end is what makes the negative case
 * work: "nov 24 - -1580" splits to ['nov 24 ', ' ', '1580'], and the blank
 * middle segment is the tell that the trailing number is negative. Compare
 * "June 2024 - 580" -> ['June 2024 ', ' 580'], where the segment before the
 * number is the date label, so the number is positive.
 *
 * Returns { label, amount } or null when there is no trailing number.
 */
export function parseLogLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;

  const parts = text.split('-');
  if (parts.length < 2) return null;

  const numeric = s => {
    const t = String(s).replace(/[£,\s]/g, '');
    return t !== '' && /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
  };

  const last = numeric(parts[parts.length - 1]);
  if (last === null) return null;

  // A whitespace-only segment immediately before the number means the "-" that
  // preceded it was a sign, not the label/amount separator.
  const prev = parts[parts.length - 2];
  const negative = String(prev).trim() === '';
  const labelParts = parts.slice(0, negative ? parts.length - 2 : parts.length - 1);
  const label = labelParts.join('-').trim();
  if (!label) return null;

  return { label, amount: negative ? -last : last };
}

/**
 * Parse the whole field.
 * Unparseable lines are kept verbatim (they are never rewritten) and reported
 * so Preview 2 can warn on that row.
 */
export function parseLog(text) {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);
  const entries = [];
  const bad = [];

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const p = parseLogLine(line);
    if (p) entries.push({ raw: line, label: p.label, amount: p.amount, line: i });
    else bad.push({ raw: line, line: i });
  });

  const total = +entries.reduce((s, e) => s + e.amount, 0).toFixed(2);
  return { entries, bad, total, isEmpty: raw.trim() === '' };
}

/** Sum of every parseable line — what Rollup gets set to. */
export const logTotal = text => parseLog(text).total;

/**
 * Append a line. Never rewrites or reorders what is already there — this is an
 * audit trail.
 */
export function appendLogLine(text, line) {
  const existing = String(text ?? '').replace(/\s+$/, '');
  return existing ? `${existing}\n${line}` : line;
}

/**
 * Re-run guard: has an identical line (same formatted date, same amount to 2dp)
 * already been logged? Compares parsed values rather than strings so a
 * hand-typed "23 June 2025 - 508" still matches our "23 June 2025 - 508.00".
 */
export function hasLogLine(text, iso, amount) {
  const label = formatLogDate(iso);
  if (!label) return false;
  const target = Number(amount);
  if (!Number.isFinite(target)) return false;
  const wanted = label.toLowerCase();
  return parseLog(text).entries.some(
    e => e.label.toLowerCase() === wanted && Math.abs(e.amount - target) < 0.005
  );
}
