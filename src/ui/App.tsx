import { useState } from 'react';
import type { GameStore } from '../store/gameStore.ts';
import type { GameClock } from '../sim/clock.ts';
import type { SurveyController } from '../render/surveyController.ts';
import { useGameState, useSurveyProposal } from './useGameState.ts';
import { CityPanel } from './panels/CityPanel.tsx';
import { TrainPanel } from './panels/TrainPanel.tsx';
import { FinancePanel } from './panels/FinancePanel.tsx';
import { ClockControls } from './panels/ClockControls.tsx';
import { BuildPanel, type BuildMode } from './panels/BuildPanel.tsx';
import { TrainBuilder } from './panels/TrainBuilder.tsx';
import { SurveyPanel } from './panels/SurveyPanel.tsx';
import { DEFAULT_STATION_TYPE, type StationType } from '../sim/model/track.ts';

/**
 * Root of the React management overlay (U10). Subscribes to store snapshots
 * (published on tick) and composes the panels. Sits as a sibling DOM tree over
 * the PixiJS map canvas; player build actions flow back to the sim as intents.
 *
 * Milestone 3 U6: `survey` (a `SurveyController`, KTD9) and its
 * commit/cancel callbacks come from `main.ts`, the same way camera and
 * pointer handling do — the controller's state lives outside React and
 * `GameState` alike; `useSurveyProposal` is this component's only touch
 * point with it.
 *
 * Milestone 5 U1 (R4, KTD3): `stationType` is boot-scope view state, same
 * status as `buildMode` — it only decides what the *next* `buildStation`
 * click carries, never `GameState` itself. `onStationTypeChange` mirrors
 * `onBuildModeChange`'s pattern of pushing the chosen value out to
 * `main.ts`, which reads it at click time.
 */
export function App({
  store,
  clock,
  survey,
  onBuildModeChange,
  onStationTypeChange,
  onSurveyCommit,
  onSurveyCancel,
}: {
  store: GameStore;
  clock: GameClock;
  survey: SurveyController;
  onBuildModeChange?: (mode: BuildMode) => void;
  onStationTypeChange?: (t: StationType) => void;
  onSurveyCommit?: () => void;
  onSurveyCancel?: () => void;
}) {
  const state = useGameState(store);
  const surveyProposal = useSurveyProposal(store, survey);
  const [buildMode, setBuildMode] = useState<BuildMode>('none');
  const [stationType, setStationType] = useState<StationType>(DEFAULT_STATION_TYPE);

  const changeBuildMode = (m: BuildMode) => {
    setBuildMode(m);
    onBuildModeChange?.(m);
  };

  const changeStationType = (t: StationType) => {
    setStationType(t);
    onStationTypeChange?.(t);
  };

  const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'flex-start' };

  return (
    <>
      <div style={{ position: 'absolute', top: 12, left: 12, ...row }}>
        <FinancePanel state={state} />
        <ClockControls clock={clock} />
        <BuildPanel
          mode={buildMode}
          onModeChange={changeBuildMode}
          stationType={stationType}
          onStationTypeChange={changeStationType}
        />
      </div>
      <div style={{ position: 'absolute', top: 60, left: 12, width: 240 }}>
        <CityPanel state={state} />
      </div>
      <div style={{ position: 'absolute', top: 12, right: 12, width: 220 }}>
        <TrainPanel state={state} />
      </div>
      {buildMode === 'train' && (
        <div style={{ position: 'absolute', top: 60, right: 12 }}>
          <TrainBuilder state={state} store={store} onDone={() => changeBuildMode('none')} />
        </div>
      )}
      {buildMode === 'survey' && (
        <div style={{ position: 'absolute', bottom: 12, left: 12 }}>
          <SurveyPanel proposal={surveyProposal} onCommit={() => onSurveyCommit?.()} onCancel={() => onSurveyCancel?.()} />
        </div>
      )}
    </>
  );
}
