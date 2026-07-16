import { useState } from 'react';
import type { GameStore } from '../store/gameStore.ts';
import type { GameClock } from '../sim/clock.ts';
import { useGameState } from './useGameState.ts';
import { CityPanel } from './panels/CityPanel.tsx';
import { TrainPanel } from './panels/TrainPanel.tsx';
import { FinancePanel } from './panels/FinancePanel.tsx';
import { ClockControls } from './panels/ClockControls.tsx';
import { BuildPanel, type BuildMode } from './panels/BuildPanel.tsx';

/**
 * Root of the React management overlay (U10). Subscribes to store snapshots
 * (published on tick) and composes the panels. Sits as a sibling DOM tree over
 * the PixiJS map canvas; player build actions flow back to the sim as intents.
 */
export function App({
  store,
  clock,
  onBuildModeChange,
}: {
  store: GameStore;
  clock: GameClock;
  onBuildModeChange?: (mode: BuildMode) => void;
}) {
  const state = useGameState(store);
  const [buildMode, setBuildMode] = useState<BuildMode>('none');

  const changeBuildMode = (m: BuildMode) => {
    setBuildMode(m);
    onBuildModeChange?.(m);
  };

  const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'flex-start' };

  return (
    <>
      <div style={{ position: 'absolute', top: 12, left: 12, ...row }}>
        <FinancePanel state={state} />
        <ClockControls clock={clock} />
        <BuildPanel mode={buildMode} onModeChange={changeBuildMode} store={store} />
      </div>
      <div style={{ position: 'absolute', top: 60, left: 12, width: 240 }}>
        <CityPanel state={state} />
      </div>
      <div style={{ position: 'absolute', top: 12, right: 12, width: 220 }}>
        <TrainPanel state={state} />
      </div>
    </>
  );
}
