import type { GameState } from '../../sim/state.ts';
import type { GameStore } from '../../store/gameStore.ts';
import { parcelValuation } from '../../store/selectors.ts';
import type { ParcelValueItemName } from '../../sim/model/land.ts';

/**
 * Holdings panel (milestone 6 U6, R8/R9, AE4). Lists every owned parcel:
 * what it cost, what it is worth now, the signed delta, and the top named
 * causes of that delta (`parcelValuation`, `store/selectors.ts`, KTD6) — a
 * Sell button per row dispatches `sellLand` (KTD7). Thin view over the
 * selector, following `SurveyPanel`'s split (KTD7's no-rendering-tests
 * policy): `attributionLabel`/`formatSignedCents` are the pure content
 * logic covered by `tests/ui/panels.test.ts`; the component body itself is
 * not unit-tested.
 */

const ITEM_LABELS: Record<ParcelValueItemName, string> = {
  'terrain-base': 'Terrain',
  'station-uplift': 'Station uplift',
  'district-development': 'District growth',
  severance: 'Severance',
  derelict: 'Derelict scar',
  'floor-adjustment': 'Floor adjustment',
  anticipation: 'Anticipated uplift',
};

/** Human-readable label for a parcel-value item name (AE4) — every name in
 *  the closed union (`sim/model/land.ts`'s `ParcelValueItemName`) maps to a
 *  distinct, non-empty label. */
export function attributionLabel(name: ParcelValueItemName): string {
  return ITEM_LABELS[name];
}

/** Format integer cents as a signed dollar string (e.g. `+$310`, `-$120`) —
 *  the panel's one formatting rule for both totals and attribution rows. */
export function formatSignedCents(cents: number): string {
  const sign = cents < 0 ? '-' : cents > 0 ? '+' : '';
  return `${sign}$${Math.abs(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Top N attribution items, largest magnitude first (AE4's "legible cause")
 *  — `parcelValuation` already sorts by magnitude; this just bounds how
 *  many rows the panel shows per parcel. */
export const TOP_ATTRIBUTION_COUNT = 3;

const panelStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  background: 'rgba(13, 27, 42, 0.85)',
  color: '#e0e1dd',
  font: '12px system-ui, sans-serif',
  width: 240,
  maxHeight: 320,
  overflowY: 'auto',
};

const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between' };

export function LandPanel({ state, store }: { state: GameState; store: GameStore }) {
  if (state.parcels.length === 0) {
    return (
      <div style={panelStyle}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Holdings</div>
        <div style={{ opacity: 0.7 }}>No land owned yet.</div>
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Holdings</div>
      {state.parcels.map((parcel) => {
        const valuation = parcelValuation(state, parcel.id);
        if (!valuation) return null;
        const top = valuation.attribution.slice(0, TOP_ATTRIBUTION_COUNT);
        const deltaColor = valuation.deltaCents >= 0 ? '#6fcf97' : '#ef476f';
        return (
          <div
            key={parcel.id}
            style={{ borderTop: '1px solid rgba(224,225,221,0.2)', paddingTop: 6, marginTop: 6 }}
          >
            <div style={rowStyle}>
              <span>Paid</span>
              <span>{formatSignedCents(valuation.pricePaidCents).replace('+', '')}</span>
            </div>
            <div style={rowStyle}>
              <span>Now worth</span>
              <span>{formatSignedCents(valuation.currentValueCents).replace('+', '')}</span>
            </div>
            <div style={{ ...rowStyle, color: deltaColor, fontWeight: 600 }}>
              <span>Change</span>
              <span>{formatSignedCents(valuation.deltaCents)}</span>
            </div>
            {top.map((item) => (
              <div style={{ ...rowStyle, opacity: 0.85, fontSize: 11 }} key={item.name}>
                <span>{attributionLabel(item.name)}</span>
                <span>{formatSignedCents(item.cents)}</span>
              </div>
            ))}
            <button
              onClick={() => store.dispatch({ kind: 'sellLand', parcelId: parcel.id })}
              style={{
                marginTop: 4,
                padding: '2px 8px',
                borderRadius: 6,
                border: '1px solid transparent',
                background: 'rgba(239,71,111,0.5)',
                color: '#e0e1dd',
                cursor: 'pointer',
              }}
            >
              Sell
            </button>
          </div>
        );
      })}
    </div>
  );
}
