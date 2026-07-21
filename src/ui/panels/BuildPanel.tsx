export type BuildMode = 'none' | 'survey' | 'station' | 'train';

/**
 * Build-mode toggle (U5; 'track' renamed to 'survey' in milestone 3 U6).
 * Thin view over the store: choosing a mode arms the map surface to
 * translate clicks into build intents. Survey mode replaces the old
 * click-chained `layTrack` interaction (R1-R4): clicks feed a
 * `SurveyController` instead of dispatching track segments directly — see
 * `main.ts` and `SurveyPanel.tsx`. Kept deliberately minimal — the build
 * logic and validation live in the sim model, not here.
 */
export function BuildPanel({
  mode,
  onModeChange,
}: {
  mode: BuildMode;
  onModeChange: (m: BuildMode) => void;
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
      {button('survey', 'Survey Route')}
      {button('station', 'Build Station')}
      {button('train', 'Buy Train')}
    </div>
  );
}
