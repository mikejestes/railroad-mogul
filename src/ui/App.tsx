/**
 * Root of the React management-UI overlay. This tree is a sibling of the
 * PixiJS map canvas, not a child of it (see index.html). It reads game state
 * from the store and sends player intents back — it is deliberately kept out
 * of the per-frame render path (KTD1, U10).
 *
 * U1 ships a placeholder HUD; U10 replaces it with the city/train/finance
 * panels and U12 adds the clock controls.
 */
export function App() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        padding: '8px 12px',
        borderRadius: 8,
        background: 'rgba(13, 27, 42, 0.75)',
        color: '#e0e1dd',
        font: '13px system-ui, sans-serif',
      }}
    >
      Railroad Economy Sim — scaffold
    </div>
  );
}
