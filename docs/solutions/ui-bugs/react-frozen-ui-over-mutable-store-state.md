---
title: React panels froze during play — useSyncExternalStore over in-place-mutated store state
date: 2026-07-18
category: ui-bugs
module: "src/store (game store), src/ui (React overlay)"
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Finance and city-demand panels stayed frozen at their initial values while the game clock and economy clearly advanced"
  - "Panels only refreshed when the player interacted (clicked a build button or a clock control)"
  - "The PixiJS map canvas updated correctly, so state WAS advancing — only the React panels were stale"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [react, usesyncexternalstore, state-management, reactivity, mutable-state, object-identity, game-loop]
---

# React panels froze during play — useSyncExternalStore over in-place-mutated store state

## Problem

The React management panels (finance, city demand, trains) appeared frozen while the simulation ran: they showed Year 1830 / demand 0 even after the sim had advanced many ticks. The panels only updated when the player clicked something unrelated. The map canvas, meanwhile, updated fine.

## Symptoms

- Panels stuck at initial values (e.g. "Year 1830", "$1,000,000", "Food 0") while the game visibly advanced.
- Panels refreshed only on an unrelated interaction (a build-mode button, a pause/speed control) — anything that forced a React re-render for its own reason.
- The PixiJS map (a separate render path that reads state every animation frame) stayed correct, which proved the sim state was advancing and narrowed the fault to the React binding.

## What Didn't Work

- **Screenshots / visual checks alone did not catch it.** The map canvas updated every frame, so a glance at the screen looked fine; the stale numbers lived only in the DOM panels. The bug was found only by comparing state read through a debug hook (`window.__game.summary()` reported Year 1847) against the rendered DOM text (still "Year 1830").
- **The original binding was itself the bug.** `useGameState` returned `store.getState()` as the `useSyncExternalStore` snapshot — which looks correct but is exactly what freezes the UI (see below).

## Solution

The store mutates one `GameState` object in place each tick and republishes the *same reference*, so `useSyncExternalStore`'s `Object.is` snapshot check never detects a change. Fix: publish a monotonic **version counter** and use that (a changing primitive) as the snapshot, then read the live state separately.

Before (frozen):

```ts
// useGameState.ts — broken: snapshot reference never changes
export function useGameState(store: GameStore): GameState {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState(), // same object every tick -> Object.is bails -> no re-render
  );
}
```

After (`gameStore.ts:43-52`, `useGameState.ts:14-18`):

```ts
// gameStore.ts — bump a version on every publish
getVersion(): number {
  return this.version;
}
publish(state: GameState): void {
  this.state = state;
  this.version += 1;                 // changing primitive
  for (const l of this.listeners) l(state);
}

// useGameState.ts — subscribe to the version, read live state after
export function useGameState(store: GameStore): GameState {
  useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getVersion(),         // changing snapshot drives the re-render
  );
  return store.getState();            // read the live, in-place-mutated state
}
```

## Why This Works

`useSyncExternalStore(subscribe, getSnapshot)` re-renders only when `getSnapshot()` returns a value that is not `Object.is`-equal to the previous one. When the external store mutates a single object in place and hands back that same reference, every snapshot is identical, so React bails on every notification. A monotonic integer bumped on each publish is guaranteed to differ, so React re-renders; the hook then reads the live state directly. The map canvas was immune because it re-reads state unconditionally inside a `requestAnimationFrame` loop — it never relied on reference identity to decide whether to redraw.

## Prevention

- **Do not return an in-place-mutated object as a `useSyncExternalStore` snapshot.** Either produce a fresh immutable snapshot per change (expensive for a per-tick game state) or key the snapshot on a cheap changing primitive (a version counter / tick number) and read the mutable state separately. For a game loop that mutates state every tick, the version-counter approach avoids cloning the whole world each frame.
- **Verify canvas/WebGL apps by asserting on state, not pixels.** This bug hid from screenshots because one render path (canvas) was correct while another (DOM) was stale. A dev-only inspection hook (e.g. `window.__game` exposing `state`/`summary()`) that a browser driver can compare against the rendered DOM catches "engine advanced but UI didn't" that visual checks miss.
- **Watch for the "only updates when I click" tell.** A UI that refreshes on unrelated interaction but not on its own data source almost always means a missed subscription or a snapshot whose identity never changes.

## Related Issues

- No prior `docs/solutions/` entries (greenfield project). Fixed locally in commit `28b5e0e` ("fix(ui): panels froze during play (only refreshed on interaction)"); no remote/PR yet.
- Related session work: the `window.__game` debug hook and `?seed` / `?nopause` URL flags were added to make this class of browser verification reliable, which is how the discrepancy (hook state vs DOM text) was spotted.
