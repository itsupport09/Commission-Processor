import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export const FIELDS = [
  { key: 'btOrderRef',  label: 'BT Order Ref',      req: false, hint: 'Broadband / CVE match key' },
  { key: 'qbCode',      label: 'QB Code',           req: true,  hint: 'Cloud Voice match key' },
  { key: 'org',         label: 'Organization Name', req: true,  hint: 'Display only' },
  { key: 'productType', label: 'Product Type',      req: true,  hint: 'Routes CV vs Broadband/CVE' },
  { key: 'orderType',   label: 'Order Type / Notes',req: true,  hint: 'Drives Payment Stage rules' },
  { key: 'invoiceDate', label: 'Invoice Date',      req: true,  hint: 'Written to Payment Invoice Date' },
  { key: 'commission',  label: 'Commission Paid',   req: true,  hint: '£ amount written to Pipedrive' },
  { key: 'dealTotal',   label: 'Deal Total',        req: false, hint: 'Reference only' },
];

const ALIASES = {
  btOrderRef: ['btorderref', 'orderref', 'mainorderref', 'oid'],
  qbCode:     ['qbcode', 'qb', 'additionalref1', 'additionalref'],
  org:        ['organizationname', 'organisationname', 'customername', 'orgname', 'company'],
  productType:['producttype', 'scheme', 'type'],
  orderType:  ['ordertype', 'notes', 'statusdetail'],
  invoiceDate:['invoicedate', 'invoice', 'sbidate'],
  commission: ['commissionpaid', 'commission', 'commpaid'],
  dealTotal:  ['dealtotal', 'total', 'value', 'sov'],
};

export const norm = s => String(s ?? '').toLowerCase().replace(/[£()/\\\-_.\s]+/g, '').trim();

export function autoMap(headers) {
  const m = {};
  FIELDS.forEach(f => {
    const targets = [norm(f.label), ...(ALIASES[f.key] || [])];
    let found = headers.find(h => targets.includes(norm(h))) || '';
    if (!found) {
      found = headers.find(h => {
        const nh = norm(h);
        return nh.length > 1 && targets.some(t => nh.includes(t) || t.includes(nh));
      }) || '';
    }
    m[f.key] = found;
  });
  return m;
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'csv') {
      Papa.parse(file, { skipEmptyLines: true, complete: r => resolve(r.data), error: reject });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const fr = new FileReader();
      fr.onload = e => {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }));
      };
      fr.onerror = reject;
      fr.readAsArrayBuffer(file);
    } else {
      reject(new Error('Unsupported file. Upload .csv or .xlsx'));
    }
  });
}

export function parseNum(v) {
  if (v == null || v === '') return 0;
  const n = parseFloat(String(v).replace(/[£,\s]/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

/** Accepts dd/mm/yyyy, mm/dd/yy, yyyy-mm-dd. Returns ISO yyyy-mm-dd or ''. */
export function toISODate(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    y = +y < 100 ? 2000 + +y : +y;
    // >12 in first slot means it must be a day -> dd/mm; otherwise assume mm/dd (BT export format)
    const [mm, dd] = +a > 12 ? [+b, +a] : [+a, +b];
    return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
}

export const gbp = n =>
  (n < 0 ? '-£' : '£') + Math.abs(Number(n) || 0).toFixed(2);
