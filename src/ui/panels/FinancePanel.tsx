import type { GameState } from '../../sim/state.ts';
import { playerCash } from '../../store/selectors.ts';
import { currentYear } from '../../sim/model/trains.ts';

/**
 * Finance readout (U10): player cash and the current sim year. This is a
 * cash/cashflow display only — NOT the deferred stock/robber-baron layer (KTD9).
 */
export function FinancePanel({ state }: { state: GameState }) {
  const cash = playerCash(state);
  return (
    <div
      style={{
        padding: '6px 12px',
        borderRadius: 8,
        background: 'rgba(13, 27, 42, 0.8)',
        color: '#e0e1dd',
        font: '13px system-ui, sans-serif',
      }}
    >
      <span style={{ color: '#a8dadc', fontWeight: 600 }}>
        ${cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </span>
      <span style={{ opacity: 0.7, marginLeft: 10 }}>Year {currentYear(state)}</span>
    </div>
  );
}
