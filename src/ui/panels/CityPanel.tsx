import type { GameState } from '../../sim/state.ts';
import { cityDemand } from '../../store/selectors.ts';

const panelStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  background: 'rgba(13, 27, 42, 0.8)',
  color: '#e0e1dd',
  font: '12px system-ui, sans-serif',
  maxHeight: '40vh',
  overflowY: 'auto',
};

/** City demand panel (U10, R13): what each city wants, most-wanted first. */
export function CityPanel({ state }: { state: GameState }) {
  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Cities</div>
      {state.cities.map((city) => {
        const top = cityDemand(state, city.id).slice(0, 3);
        return (
          <div key={city.id} style={{ marginBottom: 4 }}>
            <span style={{ color: '#a8dadc' }}>{city.name}</span>{' '}
            <span style={{ opacity: 0.7 }}>· tier {city.sizeTier}</span>
            <div style={{ opacity: 0.85 }}>
              {top.map((r) => `${r.name} ${Math.round(r.backlog)}`).join('  ·  ') || 'no demand'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
