// All IDs verified against live Pipedrive (deal 3632 + pipeline 2 scan).

export const F = {
  payment1Amount:      '3bf68c483c9161847952b26191c514658404c7d0', // monetary
  payment1InvoiceDate: '0198197825dcf428b76ed013ee0eba67943118ee', // date
  payment2Amount:      '88fb215c7dbc8f3d53dad2bc79a068b9e8f0885e', // monetary
  payment2InvoiceDate: '4392f13fa6c2693b68190a7ed0b12c06652328d9', // date
  totalCommission:     '0368dcdc330a7c8d34125e9c0e9bd66e33f05a60', // monetary (formula)
  paymentStage:        'cbeb7c907113828791b341495888fca31b0a69d5', // enum
  varianceGbp:         '9f088abfe360d936242de7bb4ec5a1343620a795', // monetary (formula)
  variancePct:         'e5044fda5572f29b133f4257d838b07900b14e09', // number  (formula)
  btOrderRef:          '18e1106b343f6c62c859ee1b36dffa595e81c155', // varchar
  connectionDate:      'df3e245bc58532c0fdeca90cd7aa7d36b98804d8',
};

// Payment Stage option IDs (confirmed from live deals)
export const STAGE = {
  complete:  { id: 209, label: 'Payment Complete - Full Commission Allocated' },
  discrepancy:{ id: 211, label: 'Discrepancy' },
  part:      { id: 258, label: 'Part Payment - 50% Commission Allocated' },
  cancelled: { id: 320, label: 'Order Cancelled' },
};
export const STAGE_LIST = Object.values(STAGE);

export const PIPELINES = {
  cloudVoice: [2, 14],
  broadband:  [3, 4],
};

export const VARIANCE_THRESHOLD = 95;   // > 95 = complete, < 95 = discrepancy
export const CURRENCY = 'GBP';
export const PD_DOMAIN = 'https://unifynetworks.pipedrive.com';

// Delay (ms) after writing amounts before re-reading, so Pipedrive
// recalculates Total / Variance £ / Variance % formula fields.
export const RECALC_DELAY = 2500;
export const CALL_DELAY = 150;          // throttle between API calls
