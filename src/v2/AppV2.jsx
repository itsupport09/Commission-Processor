import React, { useState, useRef, useMemo } from 'react';
import { FIELDS, autoMap, readFile, gbp } from '../lib/parse';
import { buildRows } from '../lib/calc';
import { resolveStage } from './calc';
import { parseLog, formatLogLine, appendLogLine, hasLogLine, logTotal } from './log';
import { searchDeals, getDeal, patchDeal, sleep } from '../lib/pipedrive';
import {
  F2, STAGE_LIST, PIPELINES, PD_DOMAIN, CURRENCY,
  RECALC_DELAY_V2, RECALC_POLL_ATTEMPTS, RECALC_POLL_INTERVAL,
} from '../config';

const STEPS = [
  ['upload',   '1. Upload'],
  ['map',      '2. Map columns'],
  ['payments', '3. Payment log'],
  ['stages',   '4. Payment Stage'],
];

const cf = (deal, key) => deal?.custom_fields?.[key];
const money = v => (v && typeof v === 'object' ? Number(v.value) : Number(v)) || 0;
const isNullMoney = v => v == null || (typeof v === 'object' && v.value == null);
const optLabel = v => (v && typeof v === 'object' ? v.label : v) ?? '';
const numOrNull = v => (v == null || v === '' ? null : Number(v));

export default function AppV2() {
  const [stage, setStage] = useState('upload');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState([]);
  const [raw, setRaw] = useState([]);
  const [map, setMap] = useState({});
  const [skip, setSkip] = useState(0);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [over, setOver] = useState(false);
  const inputRef = useRef();

  const dataRows = useMemo(() => raw.slice(skip), [raw, skip]);
  const missing = FIELDS.filter(f => f.req && !map[f.key]);

  /* ---------------- upload + map ---------------- */
  const loadFile = async file => {
    setErr(''); setFileName(file.name);
    try {
      const matrix = await readFile(file);
      if (!matrix || matrix.length < 2) throw new Error('File looks empty.');
      const head = matrix[0].map(h => String(h).replace(/^\uFEFF/, '').trim());
      const m = autoMap(head);
      const cIdx = head.indexOf(m.commission);
      const second = matrix[1];
      const autoSkip = cIdx >= 0 && second &&
        Number.isNaN(parseFloat(String(second[cIdx]).replace(/[£,\s]/g, ''))) ? 1 : 0;
      setHeaders(head);
      setSkip(autoSkip);
      setRaw(matrix.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]]))));
      setMap(m);
      setStage('map');
    } catch (e) { setErr(e.message); }
  };

  const reset = () => {
    setStage('upload'); setRaw([]); setHeaders([]); setMap({});
    setRows([]); setFileName(''); setErr(''); setProgress({ done: 0, total: 0 });
  };

  /* ---------------- step 2: match in Pipedrive ----------------
   * Same matching as V1 (Cloud Voice -> QB Code in pipelines 2/14,
   * Broadband/CVE -> BT Order Ref in pipelines 3/4), but read-only:
   * V2 does no zero-seeding, so nothing is written during matching.  */
  const matchInPipedrive = async () => {
    setErr(''); setBusy('Matching deals in Pipedrive (read-only — nothing is written yet)…');
    const base = buildRows(dataRows, map);
    setProgress({ done: 0, total: base.length });
    const result = [];

    for (const row of base) {
      const allowed = row.product === 'Cloud Voice' ? PIPELINES.cloudVoice : PIPELINES.broadband;
      try {
        const items = await searchDeals(row.matchKey);
        const deals = [];
        for (const it of items.slice(0, 6)) {
          const d = await getDeal(it.id);
          if (d && allowed.includes(d.pipeline_id)) deals.push(d);
        }
        if (deals.length === 0) {
          result.push({ ...row, status: 'nomatch', error: `No deal in pipeline ${allowed.join('/')}` });
        } else {
          const d = deals[0];
          const multi = deals.length > 1;
          const currentLog = cf(d, F2.paymentLog) || '';
          const parsed = parseLog(currentLog);
          const storedRollup = cf(d, F2.rollupTotal);

          // Re-run guard: an identical line (same formatted date, same amount to
          // 2dp) already in the log means this Excel row was pushed before.
          const applied = hasLogLine(currentLog, row.invoiceDate, row.amount);

          result.push({
            ...row,
            dealId: d.id, dealTitle: d.title, pipelineId: d.pipeline_id,
            currentLog,
            logEntries: parsed.entries,
            logBad: parsed.bad,
            // Rollup is always recomputed from the log, never read-and-added-to.
            // We keep the stored value only to show drift against the log.
            parsedTotal: parsed.total,
            storedRollup: isNullMoney(storedRollup) ? null : money(storedRollup),
            applied,
            currentStage: optLabel(cf(d, F2.paymentStage)),
            variancePct: numOrNull(cf(d, F2.newVariancePct)),
            varianceGbp: isNullMoney(cf(d, F2.newVarianceGbp)) ? null : money(cf(d, F2.newVarianceGbp)),
            approved: !applied && !multi,
            status: applied ? 'applied' : multi ? 'ambiguous' : 'matched',
            error: multi ? `${deals.length} deals matched — verify` : '',
          });
        }
      } catch (e) {
        result.push({ ...row, status: 'error', error: e.message });
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }

    setRows(result);
    setBusy('');
    setStage('payments');
  };

  const editRow = (id, patch) =>
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));

  /**
   * Editing the amount or date on Preview 2 changes the line we would append, so
   * the re-run guard has to be re-evaluated — otherwise a row edited away from a
   * duplicate would keep its stale "Already applied" flag (and vice versa).
   * Only flips between matched/applied; 'ambiguous' and error states are left alone.
   */
  const editLogRow = (row, patch) => {
    const next = { ...row, ...patch };
    const applied = hasLogLine(next.currentLog || '', next.invoiceDate, next.amount);
    const toggleable = row.status === 'matched' || row.status === 'applied';
    editRow(row.id, {
      ...patch,
      applied,
      ...(toggleable
        ? { status: applied ? 'applied' : 'matched', ...(applied ? { approved: false } : {}) }
        : {}),
    });
  };

  /* ---------------- step 3: append log line + write rollup ----------------
   * One PATCH per deal carrying both fields. Rollup is recomputed by summing
   * the whole appended log, so a hand-edited line self-corrects on this run. */
  const pushPayments = async () => {
    const targets = rows.filter(r => r.approved && r.dealId);
    if (!targets.length) { setErr('Tick at least one row to approve.'); return; }
    setErr(''); setBusy('Appending payment lines and writing Rollup…');
    setProgress({ done: 0, total: targets.length });

    const written = [];
    for (const r of targets) {
      try {
        const line = formatLogLine(r.invoiceDate, r.amount);
        if (!r.invoiceDate) throw new Error('No invoice date — cannot format the log line');
        const nextLog = appendLogLine(r.currentLog, line);
        const nextRollup = logTotal(nextLog);

        await patchDeal(r.dealId, {
          [F2.paymentLog]: nextLog,
          // Must never sit null — the variance formulas need a number to fire.
          [F2.rollupTotal]: { value: Number.isFinite(nextRollup) ? nextRollup : 0, currency: CURRENCY },
        });

        editRow(r.id, {
          status: 'written', error: '', wrote: true,
          currentLog: nextLog, parsedTotal: nextRollup, storedRollup: nextRollup,
          logEntries: parseLog(nextLog).entries,
        });
        written.push(r);
      } catch (e) {
        editRow(r.id, { status: 'error', error: e.message });
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }

    setBusy('Waiting for Pipedrive to recalculate New Payment Variance…');
    await sleep(RECALC_DELAY_V2);
    await refreshAndResolve(written.length ? written : targets);
    setBusy('');
    setStage('stages');
  };

  /**
   * Re-read each deal and derive Payment Stage from New Payment Variance %.
   * The formula fields land 2.8–5.1s after the write (measured), so rows still
   * reading null get re-polled a few times rather than trusting one fixed wait.
   */
  const refreshAndResolve = async targets => {
    setBusy('Re-reading deals…');
    setProgress({ done: 0, total: targets.length });

    const pending = new Map();
    for (const r of targets) {
      try {
        const d = await getDeal(r.dealId);
        const applied = apply(r, d);
        if (applied.needsRepoll) pending.set(r.id, r);
      } catch (e) {
        editRow(r.id, { reviewed: true, status: 'error', error: e.message });
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }

    // Only rows whose variance is still null are worth asking about again.
    for (let attempt = 1; pending.size && attempt <= RECALC_POLL_ATTEMPTS; attempt++) {
      setBusy(`Variance still calculating on ${pending.size} deal(s) — retry ${attempt}/${RECALC_POLL_ATTEMPTS}…`);
      await sleep(RECALC_POLL_INTERVAL);
      setProgress({ done: 0, total: pending.size });
      for (const [id, r] of [...pending]) {
        try {
          const d = await getDeal(r.dealId);
          if (!apply(r, d).needsRepoll) pending.delete(id);
        } catch { /* keep it queued for the next attempt */ }
        setProgress(p => ({ ...p, done: p.done + 1 }));
      }
    }
  };

  /** Fold a freshly-read deal into its row. Returns whether variance is still pending. */
  const apply = (r, d) => {
    const rollupRaw = cf(d, F2.rollupTotal);
    const rollupNull = isNullMoney(rollupRaw);
    const rollup = rollupNull ? null : money(rollupRaw);
    const variancePct = numOrNull(cf(d, F2.newVariancePct));
    const varianceGbpRaw = cf(d, F2.newVarianceGbp);
    const log = cf(d, F2.paymentLog) || '';
    const suggested = resolveStage(r.product, r.notes, variancePct);
    const needsRepoll = variancePct == null && !rollupNull;

    editRow(r.id, {
      reviewed: true,
      currentLog: log,
      logEntries: parseLog(log).entries,
      parsedTotal: parseLog(log).total,
      storedRollup: rollup,
      variancePct,
      varianceGbp: isNullMoney(varianceGbpRaw) ? null : money(varianceGbpRaw),
      currentStage: optLabel(cf(d, F2.paymentStage)),
      newStage: suggested ? suggested.id : null,
      status: needsRepoll ? 'calculating' : suggested ? 'ready' : 'nostage',
      error: needsRepoll
        ? 'Variance formula has not recalculated yet'
        : suggested
          ? ''
          : rollupNull
            ? 'Rollup is empty on this deal — variance cannot calculate'
            : 'No rule matched these notes — set manually',
    });
    return { needsRepoll };
  };

  /* Skip the write entirely — re-read matched deals and jump to Payment Stage.
   * Read-only: V2 never seeds, so a deal with an empty Rollup will show no
   * variance and simply block approval on that row. */
  const reviewStagesOnly = async () => {
    const targets = rows.filter(r => r.dealId);
    if (!targets.length) { setErr('No matched deals to review.'); return; }
    setErr('');
    await refreshAndResolve(targets);
    setBusy('');
    setStage('stages');
  };

  /* ---------------- step 4: push Payment Stage ---------------- */
  const pushStages = async () => {
    const targets = rows.filter(r => r.stageApproved && r.dealId && r.newStage);
    if (!targets.length) { setErr('Tick at least one row to approve.'); return; }
    setErr(''); setBusy('Updating Payment Stage…');
    setProgress({ done: 0, total: targets.length });
    for (const r of targets) {
      try {
        await patchDeal(r.dealId, { [F2.paymentStage]: r.newStage });
        editRow(r.id, { status: 'done', error: '' });
      } catch (e) {
        editRow(r.id, { status: 'error', error: e.message });
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }
    setBusy('');
  };

  const allTick = (key, val) =>
    setRows(rs => rs.map(r => (r.dealId ? { ...r, [key]: val } : r)));

  /* ---------------- render ---------------- */
  const stepIdx = STEPS.findIndex(s => s[0] === stage);

  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">
          <div className="logo logo-v2">UN</div>
          <div>
            <h1>Commission Processor <span className="badge-v2">V2 — TESTING</span></h1>
            <p>BT raw data → Rollup Total Commission Received + payment log</p>
          </div>
        </div>
        <div className="stepper">
          {STEPS.map((s, i) => (
            <div key={s[0]} className={i < stepIdx ? 'step done' : i === stepIdx ? 'step active' : 'step'}>
              <b>{i < stepIdx ? '✓' : i + 1}</b>{s[1].replace(/^\d\.\s/, '')}
            </div>
          ))}
        </div>
      </div>

      {busy && (
        <div className="card busy">
          <div className="spin" /> {busy}
          {progress.total > 0 && <span className="pill">{progress.done} / {progress.total}</span>}
        </div>
      )}

      {/* ---- 1. upload ---- */}
      {stage === 'upload' && (
        <div className="card">
          <h2>Upload BT raw data</h2>
          <p className="sub">
            CSV or Excel export. Columns auto-map — fix anything wrong on the next screen.
            V2 writes one running total (<b>Rollup Total Commission Received</b>) plus an appended
            line in <b>Invoice Amounts &amp; Payment Dates</b>. Payment 1 / Payment 2 are not touched.
          </p>
          <div className={'drop' + (over ? ' over' : '')}
            onClick={() => inputRef.current.click()}
            onDragOver={e => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); }}>
            <div className="ico">⬆</div>
            <div>Drop file here or <strong>browse</strong></div>
            <div className="small">.csv · .xlsx · .xls</div>
          </div>
          <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" hidden
            onChange={e => e.target.files[0] && loadFile(e.target.files[0])} />
          {err && <div className="err">{err}</div>}
        </div>
      )}

      {/* ---- 2. map ---- */}
      {stage === 'map' && (
        <div className="card">
          <h2>Preview 1 — Map columns</h2>
          <p className="sub"><span className="pill">{fileName}</span> {dataRows.length} data rows. Required <span className="req">●</span></p>
          <div className="field" style={{ maxWidth: 260 }}>
            <label>Header / sub-header rows to skip</label>
            <input type="number" min="0" value={skip} onChange={e => setSkip(Math.max(0, +e.target.value || 0))} />
          </div>
          <div className="row">
            {FIELDS.map(f => (
              <div className="field" key={f.key}>
                <label>{f.label} {f.req && <span>●</span>}</label>
                <select value={map[f.key] || ''} onChange={e => setMap({ ...map, [f.key]: e.target.value })}>
                  <option value="">— not mapped —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <div className="hint">{f.key === 'invoiceDate'
                  ? 'Becomes the date label on the payment log line'
                  : f.key === 'commission'
                    ? '£ amount appended to the payment log'
                    : f.hint}</div>
              </div>
            ))}
          </div>
          <div className="scroll">
            <table>
              <thead><tr>{FIELDS.map(f => <th key={f.key}>{f.label}</th>)}</tr></thead>
              <tbody>{dataRows.slice(0, 5).map((r, i) => (
                <tr key={i}>{FIELDS.map(f => <td key={f.key}>{map[f.key] ? String(r[map[f.key]] ?? '') : '—'}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
          {missing.length > 0 && <div className="err">Map required: {missing.map(m => m.label).join(', ')}</div>}
          {err && <div className="err">{err}</div>}
          <div className="btns">
            <button className="b-ghost" onClick={reset}>Start over</button>
            <button className="b-primary" disabled={missing.length > 0 || busy} onClick={matchInPipedrive}>
              Match in Pipedrive →
            </button>
          </div>
        </div>
      )}

      {/* ---- 3. payment log preview ---- */}
      {stage === 'payments' && (
        <div className="card">
          <h2>Preview 2 — Payment log</h2>
          <p className="sub">
            One line is <b>appended</b> to Invoice Amounts &amp; Payment Dates; existing lines are never
            rewritten or reordered. <b>Rollup Total Commission Received</b> is then recomputed by summing
            the whole log, so a hand-edited line in Pipedrive self-corrects on this run. Rows whose exact
            line is already logged are flagged <b>Already applied</b> and left unticked. Nothing has been
            written yet.
          </p>
          <SummaryV2 rows={rows} />
          <div className="scroll">
            <table>
              <thead><tr>
                <th><input type="checkbox" onChange={e => allTick('approved', e.target.checked)} /></th>
                <th>Product</th><th>Match key</th><th>Deal</th>
                <th style={{ minWidth: 190 }}>Current log</th>
                <th className="num">Current<br />Rollup</th>
                <th style={{ minWidth: 110 }}>New amount</th>
                <th style={{ minWidth: 140 }}>New date</th>
                <th style={{ minWidth: 180 }}>Line to append</th>
                <th className="num" style={{ minWidth: 130 }}>New Rollup</th>
                <th>Order type / notes</th><th>Status</th>
              </tr></thead>
              <tbody>{rows.map(r => {
                const line = r.invoiceDate ? formatLogLine(r.invoiceDate, r.amount) : '';
                const nextLog = r.dealId ? appendLogLine(r.currentLog || '', line) : '';
                const nextRollup = r.dealId && line ? logTotal(nextLog) : null;
                const drift = r.dealId && r.storedRollup != null &&
                  Math.abs(r.storedRollup - r.parsedTotal) > 0.005;
                return (
                <tr key={r.id} className={r.dealId ? '' : 'dim'}>
                  <td><input type="checkbox" disabled={!r.dealId} checked={!!r.approved}
                    onChange={e => editRow(r.id, { approved: e.target.checked })} /></td>
                  <td><span className={'tag ' + (r.product === 'Cloud Voice' ? 't-cv' : 't-bb')}>{r.product}</span></td>
                  <td className="mono">{r.matchKey}<div className="small">{r.matchField}</div></td>
                  <td>
                    {r.dealId
                      ? <a href={`${PD_DOMAIN}/deal/${r.dealId}`} target="_blank" rel="noreferrer">{r.dealTitle}</a>
                      : <span className="small">{r.org}</span>}
                    <div className="small">{r.dealId ? `#${r.dealId} · pipeline ${r.pipelineId}` : '—'}</div>
                  </td>
                  <td>
                    {!r.dealId ? <span className="small">—</span> : (
                      <>
                        <pre className="logblock">{r.currentLog?.trim() || '(empty)'}</pre>
                        {r.logBad?.length > 0 && (
                          <div className="small neg">
                            {r.logBad.length} line(s) could not be parsed and are excluded from the
                            total — kept in the field as-is: {r.logBad.map(b => `"${b.raw.trim()}"`).join(', ')}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="num">
                    {r.dealId == null ? '—' : gbp(r.parsedTotal)}
                    {drift && <div className="small neg">stored {gbp(r.storedRollup)} — will be corrected</div>}
                  </td>
                  <td>
                    <input type="number" step="0.01" value={r.amount}
                      onChange={e => editLogRow(r, { amount: parseFloat(e.target.value) || 0 })} />
                    {r.amount < 0 && <div className="small">clawback</div>}
                  </td>
                  <td><input type="date" value={r.invoiceDate || ''}
                    onChange={e => editLogRow(r, { invoiceDate: e.target.value })} /></td>
                  <td>
                    {!r.dealId ? <span className="small">—</span>
                      : line ? <code className="logline">+ {line}</code>
                      : <span className="small neg">No invoice date — cannot build a line</span>}
                  </td>
                  <td className="num">
                    {nextRollup == null ? '—' : (
                      <span className="rollup-diff">
                        <span className="was">{gbp(r.parsedTotal)}</span>
                        <span className="arrow"> → </span>
                        <b className={nextRollup < 0 ? 'neg' : ''}>{gbp(nextRollup)}</b>
                      </span>
                    )}
                  </td>
                  <td className="bd">{r.notes}</td>
                  <td><StatusTag r={r} /></td>
                </tr>
              ); })}</tbody>
            </table>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="btns">
            <button className="b-ghost" onClick={() => setStage('map')}>← Back to mapping</button>
            <button className="b-good" disabled={!!busy} onClick={pushPayments}>
              Approve &amp; append to payment log
            </button>
            <button className="b-ghost" disabled={!!busy} onClick={reviewStagesOnly}
              title="Re-read every matched deal and go straight to Payment Stage — nothing is written">
              Skip write → review Payment Stage
            </button>
          </div>
        </div>
      )}

      {/* ---- 4. payment stage ---- */}
      {stage === 'stages' && (
        <div className="card">
          <h2>Preview 3 — Payment Stage</h2>
          <p className="sub">
            New Payment Variance % and £ re-read from Pipedrive after the write. Stage below is the rule
            output — override with the dropdown if needed, then approve.
          </p>
          <div className="scroll">
            <table>
              <thead><tr>
                <th><input type="checkbox" onChange={e => allTick('stageApproved', e.target.checked)} /></th>
                <th>Product</th><th>Deal</th>
                <th className="num">Rollup</th>
                <th className="num">New Payment<br />Variance £</th>
                <th className="num">New Payment<br />Variance %</th>
                <th>Notes</th><th>Current stage</th><th>New stage</th><th>Status</th>
              </tr></thead>
              <tbody>{rows.filter(r => r.reviewed).map(r => (
                <tr key={r.id}>
                  <td><input type="checkbox" disabled={!r.newStage} checked={!!r.stageApproved}
                    onChange={e => editRow(r.id, { stageApproved: e.target.checked })} /></td>
                  <td><span className={'tag ' + (r.product === 'Cloud Voice' ? 't-cv' : 't-bb')}>{r.product}</span></td>
                  <td>
                    <a href={`${PD_DOMAIN}/deal/${r.dealId}`} target="_blank" rel="noreferrer">{r.dealTitle}</a>
                    <div className="small mono">{r.matchKey}</div>
                  </td>
                  <td className="num">{r.storedRollup == null ? '—' : gbp(r.storedRollup)}</td>
                  <td className={'num' + (r.varianceGbp < 0 ? ' neg' : '')}>
                    {r.varianceGbp == null ? '—' : gbp(r.varianceGbp)}
                  </td>
                  <td className="num">
                    <b>{r.variancePct == null ? '—' : r.variancePct.toFixed(2)}</b>
                  </td>
                  <td className="bd">{r.notes}</td>
                  <td className="small">{r.currentStage || '—'}</td>
                  <td>
                    <select value={r.newStage || ''} onChange={e => editRow(r.id, { newStage: +e.target.value || null })}>
                      <option value="">— none —</option>
                      {STAGE_LIST.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  </td>
                  <td><StatusTag r={r} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="btns">
            <button className="b-ghost" onClick={() => setStage('payments')}>← Back</button>
            <button className="b-good" disabled={!!busy} onClick={pushStages}>
              Approve &amp; update Payment Stage
            </button>
            <button className="b-ghost" onClick={reset}>New file</button>
          </div>
          <div className="footnote">
            Rules — CV: cancelled note → Order Cancelled · in-progress/50% note → Part Payment 50% ·
            order complete + full commission → variance &gt; 95 = Payment Complete, &lt; 95 = Discrepancy.
            BB/CVE: variance &gt; 95 = Payment Complete, &lt; 95 = Discrepancy.
            Exactly 95.00 falls through to Discrepancy. Variance is read from <b>New Payment Variance %</b>.
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryV2({ rows }) {
  const t = rows.reduce((a, r) => {
    a.total++;
    if (r.product === 'Cloud Voice') a.cv++; else a.bb++;
    if (!r.dealId) a.nomatch++;
    if (r.applied) a.applied++;
    a.sum += r.amount;
    return a;
  }, { total: 0, cv: 0, bb: 0, nomatch: 0, applied: 0, sum: 0 });
  return (
    <div className="stats">
      <div className="stat"><div className="v">{t.total}</div><div className="k">Deals to update</div></div>
      <div className="stat"><div className="v">{t.cv}</div><div className="k">Cloud Voice</div></div>
      <div className="stat"><div className="v">{t.bb}</div><div className="k">Broadband / CVE</div></div>
      <div className="stat"><div className={'v' + (t.applied ? ' warn' : '')}>{t.applied}</div><div className="k">Already applied</div></div>
      <div className="stat"><div className={'v' + (t.nomatch ? ' neg' : '')}>{t.nomatch}</div><div className="k">Not matched</div></div>
      <div className="stat"><div className="v">{gbp(t.sum)}</div><div className="k">Net commission</div></div>
    </div>
  );
}

function StatusTag({ r }) {
  const m = {
    pending: ['t-part', 'Pending'], matched: ['t-full', 'Matched'],
    ambiguous: ['t-part', 'Multiple'], nomatch: ['t-cancel', 'No deal'],
    applied: ['t-part', 'Already applied'],
    written: ['t-full', 'Written'], ready: ['t-full', 'Ready'],
    calculating: ['t-part', 'Calculating'],
    nostage: ['t-part', 'No rule'], done: ['t-full', 'Done'],
    error: ['t-cancel', 'Error'],
  };
  const [cls, label] = m[r.status] || ['t-part', r.status];
  return <><span className={'tag ' + cls}>{label}</span>{r.error && <div className="small neg">{r.error}</div>}</>;
}
