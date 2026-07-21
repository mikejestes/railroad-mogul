import type { StationType } from '../../sim/model/track.ts';

export type BuildMode = 'none' | 'survey' | 'station' | 'train';

/** The three station types a picker offers, in the order they're shown
 *  (milestone 5 U1, R4). `'mixed'` is listed first — it's the default the
 *  picker starts on (KTD3). */
export const STATION_TYPE_OPTIONS: { value: StationType; label: string }[] = [
  { value: 'mixed', label: 'Mixed Depot' },
  { value: 'freight', label: 'Freight Yard' },
  { value: 'passenger', label: 'Passenger Terminal' },
];

/**
 * Build-mode toggle (U5; 'track' renamed to 'survey' in milestone 3 U6).
 * Thin view over the store: choosing a mode arms the map surface to
 * translate clicks into build intents. Survey mode replaces the old
 * click-chained `layTrack` interaction (R1-R4): clicks feed a
 * `SurveyController` instead of dispatching track segments directly — see
 * `main.ts` and `SurveyPanel.tsx`. Kept deliberately minimal — the build
 * logic and validation live in the sim model, not here.
 *
 * Milestone 5 U1 (R4, KTD3): while station mode is armed, a type picker
 * appears alongside the mode buttons so the type is chosen before the
 * player clicks the map — `main.ts` reads `stationType` at click time and
 * threads it into the `buildStation` intent.
 */
export function BuildPanel({
  mode,
  onModeChange,
  stationType,
  onStationTypeChange,
}: {
  mode: BuildMode;
  onModeChange: (m: BuildMode) => void;
  stationType: StationType;
  onStationTypeChange: (t: StationType) => void;
}) {
  const button = (m: BuildMode, label: string) => (
    <button
      onClick={() => onModeChange(mode === m ? 'none' : m)}
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        border: mode === m ? '1px solid #e0e1dd' : '1px solid transparent',
        background: mode === m ? '#415a77' : 'rgba(65,90,119,0.4)',
        color: '#e0e1dd',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {button('survey', 'Survey Route')}
      {button('station', 'Build Station')}
      {button('train', 'Buy Train')}
      {mode === 'station' && (
        <select
          value={stationType}
          onChange={(e) => onStationTypeChange(e.target.value as StationType)}
          style={{
            padding: '4px 6px',
            borderRadius: 6,
            border: '1px solid #e0e1dd',
            background: '#1b263b',
            color: '#e0e1dd',
          }}
        >
          {STATION_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
