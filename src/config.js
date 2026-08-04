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

/* ------------------------------------------------------------------ *
 * V2 — rollup total + payment log. Additive only; nothing above here
 * changes, so the live Payment 1 / Payment 2 flow is untouched.
 * All four IDs verified against GET /api/v1/dealFields?limit=500.
 * ------------------------------------------------------------------ */
export const F2 = {
  // We write these two.
  rollupTotal:   '1fb0c5b33dd91ef52a6cf0edec10e8e939123d82', // monetary
  paymentLog:    '9e543b85f840ac6df77b48cecf6fc1c4b44e717d', // large text
  // Read-only formulas, derived from rollupTotal. Never written.
  //   New Payment Variance % = rollup / (deal value * (BT rate / 100)) * 100
  //   New Payment Variance £ = rollup - (deal value * (BT rate / 100))
  newVariancePct: '1a1989704f3bcd7791b92455069eb4ca4c94e4db', // double  (formula)
  newVarianceGbp: 'a13281d3b572f4afc2c65596ceeb45ee35309900', // monetary(formula)
  // Shared with V1, unchanged.
  paymentStage:  'cbeb7c907113828791b341495888fca31b0a69d5',
  btOrderRef:    '18e1106b343f6c62c859ee1b36dffa595e81c155',
  connectionDate:'df3e245bc58532c0fdeca90cd7aa7d36b98804d8',
};

/**
 * Measured on live deals (24664, value £3106.80 @ 5%): after PATCHing Rollup,
 * the two variance formulas landed between 2775ms and 5080ms across six writes.
 * V1's 2500ms would have been too short every single time, so V2 waits longer
 * and then re-polls only the rows still reading null.
 */
export const RECALC_DELAY_V2 = 6000;
export const RECALC_POLL_ATTEMPTS = 4;
export const RECALC_POLL_INTERVAL = 2000;
