import { useState } from 'react';
import type { GameClock } from '../../sim/clock.ts';

/**
 * Clock controls (U12 UI): pause and speed. Drives the GameClock directly —
 * speed/pause are clock state, not sim state.
 */
const SPEEDS = [1, 2, 4];

export function ClockControls({ clock }: { clock: GameClock }) {
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  const btn = (label: string, active: boolean, onClick: () => void) => (
    <button
      onClick={() => {
        onClick();
        rerender();
      }}
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        border: active ? '1px solid #e0e1dd' : '1px solid transparent',
        background: active ? '#415a77' : 'rgba(65,90,119,0.4)',
        color: '#e0e1dd',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {btn(clock.paused ? '▶ Resume' : '⏸ Pause', false, () => {
        clock.paused = !clock.paused;
      })}
      {SPEEDS.map((s) =>
        btn(`${s}×`, !clock.paused && clock.speed === s, () => {
          clock.speed = s;
          clock.paused = false;
        }),
      )}
    </div>
  );
}
