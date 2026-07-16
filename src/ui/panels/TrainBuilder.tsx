import { useState } from 'react';
import type { GameState } from '../../sim/state.ts';
import type { GameStore } from '../../store/gameStore.ts';
import { availableEngines, currentYear } from '../../sim/model/trains.ts';
import { stationLabel } from '../../store/selectors.ts';

/**
 * Buy-train flow (U6/U10): pick an available engine, click stations to build an
 * ordered route (2+ stops), then dispatch. The train loads whatever each stop's
 * catchment produces and delivers what each demands. Emits a `buyTrain` intent;
 * validation and cost live in applyIntents/track.
 */
const panel: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(13, 27, 42, 0.92)',
  color: '#e0e1dd',
  font: '12px system-ui, sans-serif',
  width: 260,
  maxHeight: '70vh',
  overflowY: 'auto',
};

const chip = (active: boolean): React.CSSProperties => ({
  padding: '4px 8px',
  margin: '2px 3px 2px 0',
  borderRadius: 6,
  border: active ? '1px solid #e0e1dd' : '1px solid transparent',
  background: active ? '#415a77' : 'rgba(65,90,119,0.4)',
  color: '#e0e1dd',
  cursor: 'pointer',
  fontSize: 12,
});

export function TrainBuilder({ state, store, onDone }: { state: GameState; store: GameStore; onDone: () => void }) {
  const [engineId, setEngineId] = useState<string | null>(null);
  const [route, setRoute] = useState<string[]>([]);

  const engines = availableEngines(currentYear(state));
  const engine = engines.find((e) => e.id === engineId) ?? null;
  const canAfford = engine ? state.moneyCents >= engine.cost : false;
  const canDispatch = engine !== null && route.length >= 2 && canAfford;

  const dispatch = () => {
    if (!engine) return;
    store.dispatch({ kind: 'buyTrain', engineId: engine.id, stationIds: route });
    setEngineId(null);
    setRoute([]);
    onDone();
  };

  return (
    <div style={panel}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Buy Train</div>

      <div style={{ opacity: 0.75, marginBottom: 3 }}>Engine ({currentYear(state)})</div>
      <div style={{ marginBottom: 8 }}>
        {engines.map((e) => (
          <button key={e.id} style={chip(e.id === engineId)} onClick={() => setEngineId(e.id)}>
            {e.name} · spd {e.speed}/pwr {e.power} · ${(e.cost / 100).toLocaleString()}
          </button>
        ))}
      </div>

      <div style={{ opacity: 0.75, marginBottom: 3 }}>Route — click stations in order</div>
      {state.stations.length < 2 ? (
        <div style={{ opacity: 0.7, marginBottom: 8 }}>Build at least 2 stations first.</div>
      ) : (
        <div style={{ marginBottom: 8 }}>
          {state.stations.map((s) => (
            <button key={s.id} style={chip(false)} onClick={() => setRoute((r) => [...r, s.id])}>
              + {stationLabel(state, s)}
            </button>
          ))}
        </div>
      )}

      {route.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ opacity: 0.75 }}>Stops:</div>
          <ol style={{ margin: '2px 0 0 16px', padding: 0 }}>
            {route.map((id, i) => {
              const s = state.stations.find((st) => st.id === id);
              return <li key={`${id}-${i}`}>{s ? stationLabel(state, s) : id}</li>;
            })}
          </ol>
          <button style={chip(false)} onClick={() => setRoute([])}>
            Clear route
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button
          onClick={dispatch}
          disabled={!canDispatch}
          style={{
            ...chip(false),
            opacity: canDispatch ? 1 : 0.4,
            cursor: canDispatch ? 'pointer' : 'not-allowed',
            background: canDispatch ? '#2a9d8f' : 'rgba(65,90,119,0.4)',
          }}
        >
          Dispatch{engine ? ` ($${(engine.cost / 100).toLocaleString()})` : ''}
        </button>
        <button style={chip(false)} onClick={onDone}>
          Cancel
        </button>
      </div>
      {engine && !canAfford && <div style={{ color: '#e76f51', marginTop: 4 }}>Not enough cash.</div>}
    </div>
  );
}
