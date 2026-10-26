import React, { useState, useRef, useMemo } from 'react';
import { FIELDS, autoMap, readFile, gbp } from '../lib/parse';
import { buildRows, resolveStage } from '../lib/calc';
import { searchDeals, getDeal, patchDeal, sleep, isWon } from '../lib/pipedrive';
import { F, STAGE_LIST, PIPELINES, PD_DOMAIN, CURRENCY, RECALC_DELAY } from '../config';

const STEPS = [
  ['upload',   '1. Upload'],
  ['map',      '2. Map columns'],
  ['payments', '3. Payments preview'],
  ['stages',   '4. Payment Stage'],
];

const cf = (deal, key) => deal?.custom_fields?.[key];
const money = v => (v && typeof v === 'object' ? Number(v.value) : Number(v)) || 0;
const optLabel = v => (v && typeof v === 'object' ? v.label : v) ?? '';
const dateOf = v => (typeof v === 'string' ? v.slice(0, 10) : '');

/** Nothing is written to Pipedrive unless the matched deal is won. */
const canWrite = r => !!r.dealId && r.dealStatus === 'won';

export default function AppV1() {
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

  /* ---------------- step 2: match in Pipedrive ---------------- */
  const matchInPipedrive = async () => {
    setErr(''); setBusy('Matching deals in Pipedrive (seeding empty payment slots with £0.00)…');
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
        // Won deals only. Anything else is shown for reference and left untouched.
        const wonDeals = deals.filter(isWon);
        if (deals.length === 0) {
          result.push({ ...row, status: 'nomatch', error: `No deal in pipeline ${allowed.join('/')}` });
        } else if (wonDeals.length === 0) {
          const d = deals[0];
          result.push({
            ...row,
            dealId: d.id, dealTitle: d.title, pipelineId: d.pipeline_id, dealStatus: d.status,
            existingP1: money(cf(d, F.payment1Amount)),
            existingP2: money(cf(d, F.payment2Amount)),
            existingD1: dateOf(cf(d, F.payment1InvoiceDate)),
            existingD2: dateOf(cf(d, F.payment2InvoiceDate)),
            currentStage: optLabel(cf(d, F.paymentStage)),
            approved: false,
            status: 'notwon',
            error: `Deal is ${d.status || 'not won'} — nothing is written until it is won`,
          });
        } else {
          const d = wonDeals[0];
          const p1Raw = cf(d, F.payment1Amount);
          const p2Raw = cf(d, F.payment2Amount);
          const isEmpty = v => v == null || (typeof v === 'object' && v.value == null);
          const p1 = money(p1Raw);
          const p2 = money(p2Raw);
          const d1 = dateOf(cf(d, F.payment1InvoiceDate));
          const d2 = dateOf(cf(d, F.payment2InvoiceDate));

          // Re-run guard: identical amount AND identical invoice date already sitting
          // in a payment slot means this Excel row was pushed before.
          const same = (amt, dt) =>
            row.amount !== 0 && !!row.invoiceDate &&
            Math.abs(amt - row.amount) < 0.005 && dt === row.invoiceDate;
          const appliedIn = same(p1, d1) ? 1 : same(p2, d2) ? 2 : 0;

          // Pipedrive formula fields (Total / Variance £ / Variance %) stay
          // "Not calculated" while either payment slot is null. Seed 0 immediately
          // so Preview 2 and Preview 3 both show real figures.
          let p1Empty = isEmpty(p1Raw);
          let p2Empty = isEmpty(p2Raw);
          let seeded = false;
          if (p1Empty || p2Empty) {
            try {
              const seed = {};
              if (p1Empty) seed[F.payment1Amount] = { value: 0, currency: CURRENCY };
              if (p2Empty) seed[F.payment2Amount] = { value: 0, currency: CURRENCY };
              await patchDeal(d.id, seed, d.status);
              p1Empty = false; p2Empty = false; seeded = true;
            } catch { /* leave flags set; refreshAndResolve will retry */ }
          }

          const multi = wonDeals.length > 1;
          const slot = appliedIn || (p1 > 0 ? 2 : 1);
          const slotReason = appliedIn
            ? `Identical amount + date already in Payment ${appliedIn}`
            : p1 > 0 ? `Payment 1 already holds ${gbp(p1)}` : 'Payment 1 is empty';

          result.push({
            ...row,
            dealId: d.id, dealTitle: d.title, pipelineId: d.pipeline_id, dealStatus: d.status,
            existingP1: p1, existingP2: p2, existingD1: d1, existingD2: d2,
            slot, slotReason, appliedIn, seeded,
            p1Empty, p2Empty,
            currentStage: optLabel(cf(d, F.paymentStage)),
            approved: !appliedIn && !multi,
            status: appliedIn ? 'applied' : multi ? 'ambiguous' : 'matched',
            error: multi ? `${wonDeals.length} won deals matched — verify` : '',
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

  /* ---------------- step 3: push payments, then re-read variance ---------------- */
  const pushPayments = async () => {
    const targets = rows.filter(r => r.approved && canWrite(r));
    if (!targets.length) { setErr('Tick at least one row to approve.'); return; }
    setErr(''); setBusy('Writing Payment amounts + dates…');
    setProgress({ done: 0, total: targets.length });

    for (const r of targets) {
      try {
        const fields = r.slot === 1
          ? { [F.payment1Amount]: { value: r.amount, currency: CURRENCY },
              [F.payment1InvoiceDate]: r.invoiceDate || null }
          : { [F.payment2Amount]: { value: r.amount, currency: CURRENCY },
              [F.payment2InvoiceDate]: r.invoiceDate || null };

        // Pipedrive formula fields (Total / Variance £ / Variance %) return
        // "Not calculated" when the other payment slot is null. Seed it with 0.
        if (r.slot === 1 && r.p2Empty) fields[F.payment2Amount] = { value: 0, currency: CURRENCY };
        if (r.slot === 2 && r.p1Empty) fields[F.payment1Amount] = { value: 0, currency: CURRENCY };

        await patchDeal(r.dealId, fields, r.dealStatus);
        editRow(r.id, { status: 'written', error: '', wrote: true, p1Empty: false, p2Empty: false });
      } catch (e) {
        editRow(r.id, { status: 'error', error: e.message });
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }

    setBusy('Waiting for Pipedrive to recalculate Variance…');
    await sleep(RECALC_DELAY);
    await refreshAndResolve(targets);
    setBusy('');
    setStage('stages');
  };

  /* Seed empty payment slots with 0, then re-read deals and derive Payment Stage. */
  const refreshAndResolve = async targets => {
    // Pipedrive formula fields (Total / Variance £ / Variance %) stay "Not calculated"
    // while either payment slot is null — including on rows we didn't write to.
    const needSeed = targets.filter(r => !r.wrote && (r.p1Empty || r.p2Empty));
    if (needSeed.length) {
      setBusy('Seeding empty payment slots with £0.00…');
      setProgress({ done: 0, total: needSeed.length });
      for (const r of needSeed) {
        try {
          const fields = {};
          if (r.p1Empty) fields[F.payment1Amount] = { value: 0, currency: CURRENCY };
          if (r.p2Empty) fields[F.payment2Amount] = { value: 0, currency: CURRENCY };
          await patchDeal(r.dealId, fields, r.dealStatus);
          editRow(r.id, { p1Empty: false, p2Empty: false });
        } catch (e) {
          editRow(r.id, { error: `Could not seed £0.00: ${e.message}` });
        }
        setProgress(p => ({ ...p, done: p.done + 1 }));
      }
      setBusy('Waiting for Pipedrive to recalculate Variance…');
      await sleep(RECALC_DELAY);
    }

    setBusy('Re-reading deals…');
    setProgress({ done: 0, total: targets.length });
    for (const r of targets) {
      try {
        const d = await getDeal(r.dealId);
        const variancePct = Number(cf(d, F.variancePct));
        const suggested = resolveStage(r.product, r.notes, variancePct);
        editRow(r.id, {
          reviewed: true,
          variancePct,
          varianceGbp: money(cf(d, F.varianceGbp)),
          total: money(cf(d, F.totalCommission)),
          existingP1: money(cf(d, F.payment1Amount)),
          existingP2: money(cf(d, F.payment2Amount)),
          currentStage: optLabel(cf(d, F.paymentStage)),
          newStage: suggested ? suggested.id : null,
          status: suggested ? 'ready' : 'nostage',
          error: suggested ? '' : 'No rule matched these notes — set manually',
        });
      } catch (e) {
        editRow(r.id, { reviewed: true, status: 'error', error: e.message });
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }
  };

  /* Skip the payment write entirely — useful when amounts were pushed in an earlier run. */
  const reviewStagesOnly = async () => {
    const targets = rows.filter(canWrite);
    if (!targets.length) { setErr('No won deals to review.'); return; }
    setErr('');
    await refreshAndResolve(targets);
    setBusy('');
    setStage('stages');
  };

  /* ---------------- step 4: push Payment Stage ---------------- */
  const pushStages = async () => {
    const targets = rows.filter(r => r.stageApproved && canWrite(r) && r.newStage);
    if (!targets.length) { setErr('Tick at least one row to approve.'); return; }
    setErr(''); setBusy('Updating Payment Stage…');
    setProgress({ done: 0, total: targets.length });
    for (const r of targets) {
      try {
        await patchDeal(r.dealId, { [F.paymentStage]: r.newStage }, r.dealStatus);
        editRow(r.id, { status: 'done', error: '' });
      } catch (e) {
        editRow(r.id, { status: 'error', error: e.message });
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }
    setBusy('');
  };

  const allTick = (key, val) =>
    setRows(rs => rs.map(r => (canWrite(r) ? { ...r, [key]: val } : r)));

  /* ---------------- render ---------------- */
  const stepIdx = STEPS.findIndex(s => s[0] === stage);

  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">
          <div className="logo">UN</div>
          <div>
            <h1>Commission Processor</h1>
            <p>BT raw data → live Pipedrive commission updates</p>
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
          <p className="sub">CSV or Excel export. Columns auto-map — fix anything wrong on the next screen.</p>
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
                <div className="hint">{f.hint}</div>
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

      {/* ---- 3. payments preview ---- */}
      {stage === 'payments' && (
        <div className="card">
          <h2>Preview 2 — Payment amount &amp; invoice date</h2>
          <p className="sub">
            All products — writes to <b>Payment 2</b> if Payment 1 already has a value, otherwise <b>Payment 1</b>.{' '}
            The <b>Writing to</b> column shows the exact Pipedrive field that will be overwritten. Override with the
            dropdown if needed. Empty payment slots are filled with £0.00 during matching so the Pipedrive variance formulas calculate. Only <b>won</b> deals are ever written to — a matched deal that is still open or lost is flagged Not won and left untouched. Rows whose amount and invoice date already exist on the deal are flagged Already applied and left unticked.
          </p>
          <Summary rows={rows} />
          <div className="scroll">
            <table>
              <thead><tr>
                <th><input type="checkbox" onChange={e => allTick('approved', e.target.checked)} /></th>
                <th>Product</th><th>Match key</th><th>Deal</th>
                <th className="num">Existing<br />Payment 1</th>
                <th className="num">Existing<br />Payment 2</th>
                <th style={{ minWidth: 180 }}>Writing to</th>
                <th style={{ minWidth: 110 }}>Amount</th>
                <th style={{ minWidth: 140 }}>Invoice date</th>
                <th>Order type / notes</th><th>Status</th>
              </tr></thead>
              <tbody>{rows.map(r => {
                const targetHas = r.slot === 2 ? r.existingP2 : r.existingP1;
                const dup = targetHas > 0 && Math.abs(targetHas - r.amount) < 0.005;
                return (
                <tr key={r.id} className={canWrite(r) ? '' : 'dim'}>
                  <td><input type="checkbox" disabled={!canWrite(r)} checked={!!r.approved}
                    onChange={e => editRow(r.id, { approved: e.target.checked })} /></td>
                  <td><span className={'tag ' + (r.product === 'Cloud Voice' ? 't-cv' : 't-bb')}>{r.product}</span></td>
                  <td className="mono">{r.matchKey}<div className="small">{r.matchField}</div></td>
                  <td>
                    {r.dealId
                      ? <a href={`${PD_DOMAIN}/deal/${r.dealId}`} target="_blank" rel="noreferrer">{r.dealTitle}</a>
                      : <span className="small">{r.org}</span>}
                    <div className="small">{r.dealId ? `#${r.dealId} · pipeline ${r.pipelineId}` : '—'}</div>
                  </td>
                  <td className={'num' + (r.slot === 1 ? ' hit' : '')}>
                    {r.dealId == null ? '—' : gbp(r.existingP1)}
                    {r.seeded && r.existingP1 === 0 && <div className="small">seeded £0.00</div>}
                  </td>
                  <td className={'num' + (r.slot === 2 ? ' hit' : '')}>
                    {r.dealId == null ? '—' : gbp(r.existingP2)}
                    {r.seeded && r.existingP2 === 0 && <div className="small">seeded £0.00</div>}
                  </td>
                  <td>
                    {!canWrite(r) ? <span className="small">—</span>
                      : <><select className={r.slot === 2 ? 'sel-2' : 'sel-1'} value={r.slot || 1}
                            onChange={e => editRow(r.id, { slot: +e.target.value })}>
                            <option value={1}>Payment 1</option>
                            <option value={2}>Payment 2</option>
                          </select>
                          <div className="small">{r.slotReason}</div></>}
                  </td>
                  <td>
                    <input type="number" step="0.01" value={r.amount}
                      onChange={e => editRow(r.id, { amount: parseFloat(e.target.value) || 0 })} />
                    {dup && <div className="small neg">Same value already in Payment {r.slot} — possible re-run</div>}
                  </td>
                  <td><input type="date" value={r.invoiceDate || ''}
                    onChange={e => editRow(r.id, { invoiceDate: e.target.value })} /></td>
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
              Approve &amp; update payments in Pipedrive
            </button>
            <button className="b-ghost" disabled={!!busy} onClick={reviewStagesOnly}
              title="Fill empty payment slots with £0.00, re-read every matched deal, then go to Payment Stage — no commission amounts written">
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
            Variance re-read from Pipedrive after the payment write. Stage below is the rule output — override with the
            dropdown if needed, then approve.
          </p>
          <div className="scroll">
            <table>
              <thead><tr>
                <th><input type="checkbox" onChange={e => allTick('stageApproved', e.target.checked)} /></th>
                <th>Product</th><th>Deal</th>
                <th>P1</th><th>P2</th><th>Total</th><th>Variance £</th><th>Variance %</th>
                <th>Notes</th><th>Current stage</th><th>New stage</th><th>Status</th>
              </tr></thead>
              <tbody>{rows.filter(r => r.reviewed).map(r => (
                <tr key={r.id}>
                  <td><input type="checkbox" disabled={!r.newStage || !canWrite(r)} checked={!!r.stageApproved}
                    onChange={e => editRow(r.id, { stageApproved: e.target.checked })} /></td>
                  <td><span className={'tag ' + (r.product === 'Cloud Voice' ? 't-cv' : 't-bb')}>{r.product}</span></td>
                  <td>
                    <a href={`${PD_DOMAIN}/deal/${r.dealId}`} target="_blank" rel="noreferrer">{r.dealTitle}</a>
                    <div className="small mono">{r.matchKey}</div>
                  </td>
                  <td className="num">{gbp(r.existingP1)}</td>
                  <td className="num">{gbp(r.existingP2)}</td>
                  <td className="num">{gbp(r.total)}</td>
                  <td className={'num' + (r.varianceGbp < 0 ? ' neg' : '')}>{gbp(r.varianceGbp)}</td>
                  <td className="num"><b>{Number.isFinite(r.variancePct) ? r.variancePct.toFixed(2) : '—'}</b></td>
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
          </div>
        </div>
      )}
    </div>
  );
}

function Summary({ rows }) {
  const t = rows.reduce((a, r) => {
    a.total++;
    if (r.product === 'Cloud Voice') a.cv++; else a.bb++;
    if (!r.dealId) a.nomatch++;
    if (r.dealId && r.dealStatus !== 'won') a.notwon++;
    if (r.appliedIn) a.applied++;
    if (r.slot === 2) a.p2++;
    a.sum += r.amount;
    return a;
  }, { total: 0, cv: 0, bb: 0, nomatch: 0, notwon: 0, applied: 0, p2: 0, sum: 0 });
  return (
    <div className="stats">
      <div className="stat"><div className="v">{t.total}</div><div className="k">Deals to update</div></div>
      <div className="stat"><div className="v">{t.cv}</div><div className="k">Cloud Voice</div></div>
      <div className="stat"><div className="v">{t.bb}</div><div className="k">Broadband / CVE</div></div>
      <div className="stat"><div className="v">{t.p2}</div><div className="k">Going to Payment 2</div></div>
      <div className="stat"><div className={'v' + (t.applied ? ' warn' : '')}>{t.applied}</div><div className="k">Already applied</div></div>
      <div className="stat"><div className={'v' + (t.nomatch ? ' neg' : '')}>{t.nomatch}</div><div className="k">Not matched</div></div>
      <div className="stat"><div className={'v' + (t.notwon ? ' neg' : '')}>{t.notwon}</div><div className="k">Not won — skipped</div></div>
      <div className="stat"><div className="v">{gbp(t.sum)}</div><div className="k">Net commission</div></div>
    </div>
  );
}

function StatusTag({ r }) {
  const m = {
    pending: ['t-part', 'Pending'], matched: ['t-full', 'Matched'],
    ambiguous: ['t-part', 'Multiple'], nomatch: ['t-cancel', 'No deal'],
    notwon: ['t-cancel', 'Not won'],
    applied: ['t-part', 'Already applied'],
    written: ['t-full', 'Written'], ready: ['t-full', 'Ready'],
    nostage: ['t-part', 'No rule'], done: ['t-full', 'Done'],
    error: ['t-cancel', 'Error'],
  };
  const [cls, label] = m[r.status] || ['t-part', r.status];
  return <><span className={'tag ' + cls}>{label}</span>{r.error && <div className="small neg">{r.error}</div>}</>;
}