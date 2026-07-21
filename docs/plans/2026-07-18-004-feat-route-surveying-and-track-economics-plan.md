---
title: Route Surveying and Track Economics - Plan
type: feat
date: 2026-07-18
topic: route-surveying-and-track-economics
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
origin: docs/plans/2026-07-18-001-feat-two-scale-world-and-districts-plan.md
execution: code
---

# Route Surveying and Track Economics - Plan

Milestone 3 of 6. Depends on milestone 2 (`docs/plans/2026-07-18-003-feat-procedural-terrain-substrate-plan.md`).

## Goal Capsule

- **Objective:** Replace tile-by-tile track clicking with route surveying, and make the cost of a route depend on the terrain it crosses — so choosing where a line goes becomes the decision the player deliberates over.
- **Product authority:** Solo creator / product owner (mikejestes@gmail.com).
- **Open blockers:** None for planning. Enrichment requires milestone 2's elevation field and terrain palette to exist, because the cost model is defined in their terms.

---

## Product Contract

### Summary

The player picks two points; the game surveys a route across the elevation and cost fields, shows its price and grade profile, and lets the player adjust it before committing. Track cost becomes a function of terrain, grade, and the structures required to cross obstacles.

### Problem Frame

Track laying today chains individual adjacent tile clicks (`src/main.ts:62-76`), and cost is a flat $50 per segment plus $100 when either endpoint is mountain (`src/sim/model/track.ts:31-62`). Two things break at once after milestone 2. Clicking becomes unusable, because a continental line at finer resolution is thousands of segments rather than five. And the cost model becomes vestigial, because the terrain now carries elevation and eight biome types that the two-term formula cannot see.

Those failures share a fix. Surveying is not only the replacement interaction — it is the surface where terrain cost becomes legible, because the survey is where the player sees a number and reacts to it.

### Requirements

**Surveying**

- R1. The player lays track by choosing endpoints; the game proposes a route between them.
- R2. The proposed route is visible on the map before the player commits, with its total cost and its grade profile.
- R3. The player can adjust a proposed route — at minimum by adding intermediate waypoints — and see cost and grade update.
- R4. Committing a route is a distinct act, separate from proposing it.
- R5. A route that cannot be built is refused with a legible reason rather than silently failing.

**Cost and terrain**

- R6. Route cost varies with the terrain each segment crosses, across the full palette rather than a single mountain surcharge.
- R7. Steep grade costs more to build, so a route can trade length against gradient.
- R8. Crossing a river or a ravine requires a bridge; passing through high ground may require a tunnel or a cutting. Each is a priced choice surfaced during the survey.
- R9. Track cost includes the cost of the land it crosses, so routing through valuable land is more expensive than routing through hinterland.
- R10. Track carries no recurring maintenance cost. All track decisions are paid at build time.

**Operations**

- R11. Grade affects what a train can haul and how fast, so a cheap steep route has a standing operational consequence even though it has no standing financial one.
- R12. Existing track and stations remain valid — this milestone changes how track is created, not what track is.

### Acceptance Examples

- AE1. Neither route dominates. **Covers R6, R7, R9.** **Given** two candidate routes between the same cities, one short and steep across cheap land and one long and flat across developed land, **when** the player surveys both, **then** the costs and grade profiles differ and neither is strictly better.
- AE2. Grade has a running cost in kind. **Covers R11.** **Given** two completed routes of equal length, one flat and one steep, **when** the same train runs each with the same cargo, **then** the steep route is slower or carries less.
- AE3. Obstacles surface as choices. **Covers R8.** **Given** a proposed route crossing a river, **when** the player views the survey, **then** the bridge is itemized in the cost rather than folded invisibly into a per-segment rate.
- AE4. Refusal is legible. **Covers R5.** **Given** endpoints with no buildable path between them, **when** the player surveys, **then** the game says why rather than producing an empty route.

### Success Criteria

- Choosing a route is a decision the player hesitates over.
- A player can explain, from the survey alone, why one route costs more than another.
- Laying a continental line takes seconds, not hundreds of clicks.

### Scope Boundaries

- No district or land-value simulation. R9 consumes a land-value field; milestone 5 produces it. Until then, land cost derives from terrain alone and R9 is partially satisfied.
- No double track, gauge, signalling, or capacity modeling.
- No recurring maintenance — declined in the origin brainstorm and restated here as R10.
- No automatic route optimization beyond the proposed path; the player adjusts, the game does not re-plan around them.

### Dependencies / Assumptions

- Requires milestone 2's `elevationAt` and terrain palette.
- Assumes the existing track graph representation survives — segments remain adjacent-tile pairs, and surveying emits many of them rather than replacing the model. `src/sim/pathfinding.ts` operates on the segment graph and should be unaffected.
- Assumes route commitment becomes a visible act, which milestone 6 depends on for speculation rights.

### Outstanding Questions

**Resolve before enrichment**

- Whether a surveyed route is stored as a first-class entity or only as the segments it produces. Milestone 6's speculation rights attach to committed-but-unbuilt routes, which argues for the former.

**Deferred to planning**

- Pathfinding across a continuous cost field rather than the existing segment graph, and how waypoints constrain it.
- How grade is derived from elevation at a given resolution, and the interaction with engine power in `src/sim/model/trains.ts`.
- Whether structures are separate entities or segment attributes.
- Interaction shape for waypoint editing.
