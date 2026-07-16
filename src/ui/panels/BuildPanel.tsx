import type { GameStore } from '../../store/gameStore.ts';

export type BuildMode = 'none' | 'track' | 'station';

/**
 * Build-mode toggle (U5). Thin view over the store: choosing a mode arms the
 * map surface (U5 render) to translate clicks into layTrack / buildStation
 * intents. Kept deliberately minimal — the build logic and validation live in
 * the sim model (`track.ts`), not here.
 */
export function BuildPanel({
  mode,
  onModeChange,
}: {
  mode: BuildMode;
  onModeChange: (m: BuildMode) => void;
  store?: GameStore;
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
    <div style={{ display: 'flex', gap: 6 }}>
      {button('track', 'Lay Track')}
      {button('station', 'Build Station')}
    </div>
  );
}
