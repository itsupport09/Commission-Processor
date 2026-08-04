import React, { useState } from 'react';
import AppV1 from './v1/AppV1';
import AppV2 from './v2/AppV2';

const MODES = [
  { key: 'v1', label: 'Commission Processor',    hint: 'Payment 1 / Payment 2 · current live version' },
  { key: 'v2', label: 'Commission Processor V2', hint: 'Rollup + payment log · testing' },
];

/**
 * Both versions stay mounted and are toggled with CSS rather than conditional
 * rendering, so switching modes mid-run never unmounts an in-progress match or
 * write and loses its state.
 */
export default function Shell() {
  const [mode, setMode] = useState('v1');

  return (
    <div className="shell">
      <nav className="shell-nav">
        <div className="shell-brand">
          <div className="logo">UN</div>
          <div className="shell-brand-text">
            <strong>Unify</strong>
            <span>Commission tools</span>
          </div>
        </div>
        <div className="shell-modes">
          {MODES.map(m => (
            <button
              key={m.key}
              type="button"
              className={'shell-mode' + (mode === m.key ? ' active' : '')}
              aria-current={mode === m.key ? 'page' : undefined}
              onClick={() => setMode(m.key)}
            >
              <span className="shell-mode-label">
                {m.label}
                {m.key === 'v2' && <span className="badge-v2 sm">V2</span>}
              </span>
              <span className="shell-mode-hint">{m.hint}</span>
            </button>
          ))}
        </div>
      </nav>

      <main className="shell-main">
        <div hidden={mode !== 'v1'}><AppV1 /></div>
        <div hidden={mode !== 'v2'}><AppV2 /></div>
      </main>
    </div>
  );
}
