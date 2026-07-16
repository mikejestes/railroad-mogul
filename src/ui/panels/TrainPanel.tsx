import type { GameState } from '../../sim/state.ts';
import { trainSummaries } from '../../store/selectors.ts';

/** Train roster panel (U10): each train's engine, cargo, and current station. */
export function TrainPanel({ state }: { state: GameState }) {
  const trains = trainSummaries(state);
  if (trains.length === 0) return null;
  return (
    <div
      style={{
        padding: '8px 12px',
        borderRadius: 8,
        background: 'rgba(13, 27, 42, 0.8)',
        color: '#e0e1dd',
        font: '12px system-ui, sans-serif',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Trains</div>
      {trains.map((t) => {
        const stuck = t.status.startsWith('idle');
        return (
          <div key={t.id} style={{ marginBottom: 3 }}>
            <div style={{ opacity: 0.9 }}>
              {t.id} · {t.engineId} · {t.cargoUnits}u
            </div>
            <div style={{ color: stuck ? '#e76f51' : '#a8dadc', fontSize: 11 }}>{t.status}</div>
          </div>
        );
      })}
    </div>
  );
}
