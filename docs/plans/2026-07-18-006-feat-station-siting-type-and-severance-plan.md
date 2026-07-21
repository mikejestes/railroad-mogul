---
title: Station Siting, Type, and Severance - Plan
type: feat
date: 2026-07-18
topic: station-siting-type-and-severance
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
origin: docs/plans/2026-07-18-001-feat-two-scale-world-and-districts-plan.md
execution: code
---

# Station Siting, Type, and Severance - Plan

Milestone 5 of 6. Depends on milestone 4 (`docs/plans/2026-07-18-005-feat-city-districts-and-organic-growth-plan.md`) — a district must exist before it can be severed.

## Goal Capsule

- **Objective:** Make station siting a decision with a permanent consequence. The depot that creates land value also cuts the neighborhood, and moving it later leaves both scars.
- **Product authority:** Solo creator / product owner (mikejestes@gmail.com).
- **Open blockers:** None for planning.

---

## Product Contract

### Summary

Introduce a land-value field over districts, station type as a second axis alongside catchment size, and severance — the border vacuum a station and its approach create in the district they enter. Stations can be relocated; severance and the derelict site they leave behind cannot be undone.

### Problem Frame

Station siting today is nearly free of consequence. A station is a position and a Chebyshev radius (`src/sim/model/track.ts:19-25`), costed by tier, and placing it well versus badly differs only in which tiles fall inside the catchment. There is no upside beyond coverage and no downside at all.

That is the opposite of what railroads actually did to cities. Jane Jacobs named rail lines as the archetypal *border vacuum* — hard infrastructure that creates a dead edge and hollows out the blocks beside it. The same depot that made land valuable also cut the neighborhood in half. Without that tension, the district simulation from milestone 4 is something the player feeds rather than something they shape.

### Requirements

**Land value**

- R1. Districts carry a land-value field that varies spatially within the district.
- R2. Siting a station raises land value in its catchment.
- R3. Land value influences what the district builds where, so value and built form are coupled rather than parallel.

**Station type**

- R4. Station type — at minimum freight yard, passenger terminal, and mixed depot — is chosen at siting time.
- R5. Station type shapes what kind of district grows around it, independently of catchment size.
- R6. Station type is visible on the map without opening a panel.

**Severance**

- R7. A station, its yards, and the track approaching it sever the district they pass through, depressing the blocks along that edge.
- R8. Severance is spatial — it follows the line of the infrastructure, not the whole district uniformly.
- R9. Severance damage reduces district health and therefore the traffic the player earns from.
- R10. A route that enters a district at its edge severs less than one that cuts through its middle.

**Relocation**

- R11. The player can move a station after siting it.
- R12. Severance persists after relocation. The player can move infrastructure; they cannot undo the cut.
- R13. An abandoned station site becomes derelict land that depresses what surrounds it, so relocation leaves a second vacuum rather than a clean slate.
- R14. The district keeps the development it already has when its station moves; it does not decay wholesale.

### Acceptance Examples

- AE1. Siting creates value. **Covers R1, R2.** **Given** an unserved city, **when** the player sites a station, **then** land value rises in its catchment and falls off with distance from it.
- AE2. Type shapes the district. **Covers R4, R5.** **Given** two cities served identically in goods and volume, one through a freight yard and one through a passenger terminal, **when** both districts mature, **then** they differ in built form and in what they generate.
- AE3. The cut costs money. **Covers R7, R9, R10.** **Given** a district, **when** the player routes the approach through its middle rather than around its edge, **then** the blocks along that line decline and the district generates measurably less traffic than the edge-served alternative.
- AE4. Relocation does not heal. **Covers R11, R12, R13.** **Given** a district cut by a badly sited station, **when** the player moves that station elsewhere in the city, **then** the original severance remains, the damaged blocks do not recover, and the abandoned site depresses its own surroundings.
- AE5. Development survives the move. **Covers R14.** **Given** a well-developed district, **when** its station relocates within the same city, **then** the existing built form remains rather than reverting.

### Success Criteria

- Where to bring a line into a city is a decision players hesitate over.
- A player who sites badly can see the cost on the map, not only in a number.
- Relocation reads as a real correction with a real price, rather than as either a free undo or a punishment.

### Scope Boundaries

- No land acquisition, purchase, or speculation. Milestone 6 owns the player's ability to trade land; this milestone only produces the value field it trades on.
- No clearance or demolition rights. Explicitly outside the product's identity — the player is never a planner.
- No compulsory purchase, eminent domain, or political mechanics.
- No station capacity, platform, or throughput modeling.

### Dependencies / Assumptions

- Requires milestone 4's district state and street rendering.
- Requires milestone 3's route commitment if severance is to be previewed during surveying rather than discovered after building. If milestone 3 has not landed, severance is evaluated at build time and R10 is satisfied only retrospectively.
- Assumes `Station.radius` gains a `type` sibling rather than being overloaded, keeping catchment size and district effect as independent axes.
- Assumes severance is stored per district as part of its aggregate, consistent with milestone 4's R3, rather than as per-tile damage records.
- Assumes derelict sites are a small stored list, not a per-tile field.

### Outstanding Questions

**Resolve before enrichment**

- How severance is represented spatially inside a compact district aggregate. A polyline with a falloff radius is the obvious candidate, but it must survive milestone 4's no-per-building-storage rule.
- Whether land value is derived from district state each tick or stored alongside it. Derived keeps the save flat; stored is easier to make path-dependent.

**Deferred to planning**

- Land value falloff shape and how it composes across overlapping catchments.
- Whether station type affects catchment radius, cost, or only district response.
- Relocation cost, and whether track approaching the old site is automatically removed.
- How derelict decay behaves over long time horizons, and whether it ever bottoms out.
